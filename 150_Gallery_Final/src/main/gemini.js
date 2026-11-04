const fs = require("fs");
const path = require("path");
const { sanitizeFilePart } = require("./fsutils");

// Gemini image-edit client with retry/fallback policy and payload mode switching.
// Keep inline payload under practical limit; switch to Files API for larger inputs.
const INLINE_PAYLOAD_LIMIT_BYTES = 20 * 1024 * 1024;
const INLINE_SAFE_RAW_BYTES = 14 * 1024 * 1024;

// Output aspect ratios accepted by both image models (generationConfig.imageConfig.aspectRatio).
const SUPPORTED_ASPECT_RATIOS = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"];

function closestAspectRatio(width, height) {
  const w = Number(width);
  const h = Number(height);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
  // Compare in log space so 2:1 vs 1:2 count as equally far from 1:1.
  const target = Math.log(w / h);
  let best = null;
  let bestDiff = Infinity;
  for (const ratio of SUPPORTED_ASPECT_RATIOS) {
    const [rw, rh] = ratio.split(":").map(Number);
    const diff = Math.abs(Math.log(rw / rh) - target);
    if (diff < bestDiff) {
      best = ratio;
      bestDiff = diff;
    }
  }
  return best;
}

function extFromMime(mime) {
  if (!mime) return null;
  const lookup = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/webp": "webp",
    "image/heic": "heic",
    "image/heif": "heif"
  };
  return lookup[mime.toLowerCase()] || null;
}

function mimeFromExt(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".heic") return "image/heic";
  if (ext === ".heif") return "image/heif";
  return "application/octet-stream";
}

function detectMimeFromMagic(buffer) {
  // Gemini sometimes returns mime hints, but magic bytes are more trustworthy.
  if (!buffer || buffer.length < 12) return null;
  const sig = buffer.slice(0, 12);
  if (sig[0] === 0x89 && sig[1] === 0x50 && sig[2] === 0x4e && sig[3] === 0x47) return "image/png";
  if (sig[0] === 0xff && sig[1] === 0xd8 && sig[2] === 0xff) return "image/jpeg";
  if (sig[0] === 0x52 && sig[1] === 0x49 && sig[2] === 0x46 && sig[3] === 0x46 && sig[8] === 0x57 && sig[9] === 0x45 && sig[10] === 0x42 && sig[11] === 0x50) return "image/webp";
  return null;
}

function timeoutSignal(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, cancel: () => clearTimeout(timer) };
}

async function fetchJsonWithTimeout(url, options, timeoutMs = 60000) {
  const timer = timeoutSignal(timeoutMs);
  try {
    const response = await fetch(url, {
      ...options,
      signal: timer.signal
    });
    const rawText = await response.text();
    let data;
    try {
      data = JSON.parse(rawText);
    } catch {
      data = null;
    }
    return { response, data, rawText };
  } finally {
    timer.cancel();
  }
}

async function uploadBytesAsGeminiFile({ apiKey, bytes, mimeType, displayName, timeoutMs = 60000 }) {
  // Files API is resumable; upload in one finalize call for simplicity.
  const startUrl = `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${encodeURIComponent(apiKey)}`;
  const startBody = {
    file: {
      display_name: displayName
    }
  };

  const start = await fetch(startUrl, {
    method: "POST",
    headers: {
      "x-goog-api-key": apiKey,
      "Content-Type": "application/json",
      "X-Goog-Upload-Protocol": "resumable",
      "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(bytes.length),
      "X-Goog-Upload-Header-Content-Type": mimeType
    },
    body: JSON.stringify(startBody)
  });

  if (!start.ok) {
    const msg = await start.text();
    throw new Error(`Gemini file upload start failed (${start.status}): ${msg.slice(0, 400)}`);
  }

  const uploadUrl = start.headers.get("x-goog-upload-url");
  if (!uploadUrl) {
    throw new Error("Gemini file upload start succeeded but missing x-goog-upload-url header");
  }

  const finalize = await fetchJsonWithTimeout(
    uploadUrl,
    {
      method: "POST",
      headers: {
        "Content-Length": String(bytes.length),
        "Content-Type": mimeType,
        "X-Goog-Upload-Offset": "0",
        "X-Goog-Upload-Command": "upload, finalize"
      },
      body: bytes
    },
    timeoutMs
  );

  if (!finalize.response.ok) {
    const msg = finalize.data?.error?.message || finalize.rawText || "";
    throw new Error(`Gemini file upload finalize failed (${finalize.response.status}): ${msg.slice(0, 400)}`);
  }

  const file = finalize.data?.file;
  if (!file?.uri) {
    throw new Error("Gemini file upload did not return file.uri");
  }

  return {
    uri: file.uri,
    mimeType: file.mimeType || mimeType
  };
}

async function callGeminiGenerate({
  apiKey,
  model,
  promptText,
  templatePath,
  selfiePath,
  aspectRatio = null,
  timeoutMs = 60000
}) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;

  const templateBytes = await fs.promises.readFile(templatePath);
  const selfieBytes = await fs.promises.readFile(selfiePath);
  const templateMime = detectMimeFromMagic(templateBytes) || mimeFromExt(templatePath);
  const selfieMime = detectMimeFromMagic(selfieBytes) || mimeFromExt(selfiePath);

  const approxInlinePayloadBytes = Math.ceil((templateBytes.length + selfieBytes.length) * 4 / 3) + Buffer.byteLength(promptText, "utf8");
  const shouldUseFileApi =
    templateBytes.length + selfieBytes.length > INLINE_SAFE_RAW_BYTES ||
    approxInlinePayloadBytes > INLINE_PAYLOAD_LIMIT_BYTES;
  const inputMeta = {
    template_mime: templateMime,
    template_size_bytes: templateBytes.length,
    selfie_mime: selfieMime,
    selfie_size_bytes: selfieBytes.length,
    approx_inline_payload_bytes: approxInlinePayloadBytes,
    aspect_ratio: aspectRatio
  };

  let parts;
  if (shouldUseFileApi) {
    // Upload both images first, then reference by URI in the prompt payload.
    const [templateFile, selfieFile] = await Promise.all([
      uploadBytesAsGeminiFile({
        apiKey,
        bytes: templateBytes,
        mimeType: templateMime,
        displayName: `template_${Date.now()}`
      }),
      uploadBytesAsGeminiFile({
        apiKey,
        bytes: selfieBytes,
        mimeType: selfieMime,
        displayName: `selfie_${Date.now()}`
      })
    ]);

    parts = [
      {
        file_data: {
          mime_type: templateFile.mimeType,
          file_uri: templateFile.uri
        }
      },
      {
        file_data: {
          mime_type: selfieFile.mimeType,
          file_uri: selfieFile.uri
        }
      },
      {
        text: `${promptText}\n\nImage A is the slot template background. Image B is the selfie. Output exactly one edited final background image only.`
      }
    ];
  } else {
    parts = [
      {
        inline_data: {
          mime_type: templateMime,
          data: templateBytes.toString("base64")
        }
      },
      {
        inline_data: {
          mime_type: selfieMime,
          data: selfieBytes.toString("base64")
        }
      },
      {
        text: `${promptText}\n\nImage A is the slot template background. Image B is the selfie. Output exactly one edited final background image only.`
      }
    ];
  }

  const payload = {
    contents: [
      {
        parts
      }
    ],
    generationConfig: {
      responseModalities: ["IMAGE"],
      // Pin output to the template's shape; unset, the model may follow the selfie's aspect ratio.
      ...(aspectRatio ? { imageConfig: { aspectRatio } } : {})
    }
  };

  const { response, data, rawText } = await fetchJsonWithTimeout(
    endpoint,
    {
      method: "POST",
      headers: {
        "x-goog-api-key": apiKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    },
    timeoutMs
  );

  if (!data) {
    throw new Error(`Gemini returned non-JSON response: ${String(rawText || "").slice(0, 500)}`);
  }

  if (!response.ok) {
    // Keep the raw API message in logs; that's usually what helps debug fast.
    const msg = data?.error?.message || rawText;
    const blocked = /safety|blocked/i.test(msg || "");
    const status = data?.error?.status ? ` (${data.error.status})` : "";
    const error = new Error(`Gemini HTTP ${response.status}${status}: ${msg}`);
    error.blocked = blocked;
    error.raw = data;
    error.input_meta = inputMeta;
    error.request_mode = shouldUseFileApi ? "file_api" : "inline";
    throw error;
  }

  if (data?.promptFeedback?.blockReason) {
    const error = new Error(`Gemini blocked prompt: ${JSON.stringify(data.promptFeedback)}`);
    error.blocked = true;
    throw error;
  }

  const partsOut = data?.candidates?.[0]?.content?.parts || [];
  let imagePart = partsOut.find((p) => p.inlineData || p.inline_data);
  if (!imagePart) {
    const text = partsOut.map((p) => p.text).filter(Boolean).join(" ");
    const blocked = /safety|blocked/i.test(text || "");
    const error = new Error(`Gemini did not return image content. Text: ${text || "<empty>"}`);
    error.blocked = blocked;
    throw error;
  }

  imagePart = imagePart.inlineData || imagePart.inline_data;
  const base64 = imagePart.data;
  if (!base64) {
    throw new Error("Gemini image content missing base64 data");
  }

  const bytes = Buffer.from(base64, "base64");
  const mimeFromPart = imagePart.mimeType || imagePart.mime_type || null;
  const mime = mimeFromPart || detectMimeFromMagic(bytes) || "image/png";
  const ext = extFromMime(mime) || "png";

  return {
    bytes,
    mime,
    ext,
    raw: data,
    request_mode: shouldUseFileApi ? "file_api" : "inline",
    input_meta: inputMeta
  };
}

async function generateWithRetry({
  apiKey,
  selectedModel,
  allowFallbackModel = true,
  primaryModel,
  backupModel,
  promptText,
  templatePath,
  selfiePath,
  aspectRatio = null,
  outputDir,
  outputPrefix,
  logger,
  jobUuid,
  gallery,
  slot
}) {
  if (!apiKey) {
    throw new Error("API key is empty");
  }

  const models = [];
  const fallback = selectedModel === primaryModel ? backupModel : primaryModel;
  models.push(selectedModel);
  if (allowFallbackModel) {
    models.push(fallback);
  }

  let lastErr = null;

  for (const model of models) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      await logger.info("gemini", `Attempt ${attempt}/3 using ${model}`, {
        job_uuid: jobUuid,
        gallery,
        slot,
        model,
        attempt
      });

      try {
        const result = await callGeminiGenerate({
          apiKey,
          model,
          promptText,
          templatePath,
          selfiePath,
          aspectRatio
        });

        const filename = `${sanitizeFilePart(outputPrefix)}_${sanitizeFilePart(model)}_a${attempt}.${result.ext}`;
        const filePath = path.join(outputDir, filename);
        await fs.promises.mkdir(outputDir, { recursive: true });
        await fs.promises.writeFile(filePath, result.bytes);

        await logger.info("gemini", "Image generation success", {
          job_uuid: jobUuid,
          gallery,
          slot,
          model,
          attempt,
          path: filePath,
          mime: result.mime,
          request_mode: result.request_mode,
          input_meta: result.input_meta
        });

        return {
          model,
          filePath,
          mime: result.mime,
          attempt,
          raw: result.raw,
          request_mode: result.request_mode,
          input_meta: result.input_meta
        };
      } catch (err) {
        lastErr = err;
        await logger.error("gemini", `Attempt failed: ${err.message}`, {
          job_uuid: jobUuid,
          gallery,
          slot,
          model,
          attempt,
          blocked: !!err.blocked,
          request_mode: err.request_mode,
          input_meta: err.input_meta || null
        });

        if (err.blocked) {
          // Safety block is terminal; don't burn retries on it.
          const blockedErr = new Error(err.message);
          blockedErr.blocked = true;
          throw blockedErr;
        }
      }
    }
  }

  throw lastErr || new Error("Gemini generation failed after retries");
}

module.exports = {
  generateWithRetry,
  detectMimeFromMagic,
  closestAspectRatio
};
