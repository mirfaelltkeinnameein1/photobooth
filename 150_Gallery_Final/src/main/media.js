const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { ensureDir } = require("./fsutils");

// ffmpeg/ffprobe wrappers used by normalize + final export flows.
function resolveMediaBinary(binary) {
  // Optional explicit override for kiosk deployments.
  const envPath = binary === "ffmpeg" ? process.env.GALLERY_FFMPEG_PATH : process.env.GALLERY_FFPROBE_PATH;
  if (envPath && fs.existsSync(envPath)) return envPath;

  const exe = process.platform === "win32" ? `${binary}.exe` : binary;
  const candidates = [];
  if (process.resourcesPath) {
    // packaged build: binaries live in resources/bin
    candidates.push(path.join(process.resourcesPath, "bin", exe));
  }
  // dev fallback
  candidates.push(path.join(__dirname, "..", "..", "build", "bin", exe));

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return binary;
}

function runProcess(cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      ...options
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });

    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr, code });
      } else {
        // ffmpeg/ffprobe usually explain exact failure in stderr.
        reject(new Error(`${cmd} exited with code ${code}. ${stderr || stdout}`));
      }
    });
  });
}

async function checkBinary(binary) {
  try {
    await runProcess(resolveMediaBinary(binary), ["-version"]);
    return true;
  } catch {
    return false;
  }
}

async function checkMediaTooling() {
  const ffmpeg = await checkBinary("ffmpeg");
  const ffprobe = await checkBinary("ffprobe");
  return { ffmpeg, ffprobe };
}

async function probeImageResolution(filePath) {
  const args = [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=width,height",
    "-of",
    "json",
    filePath
  ];
  const { stdout } = await runProcess(resolveMediaBinary("ffprobe"), args);
  const parsed = JSON.parse(stdout);
  const stream = parsed.streams && parsed.streams[0];
  if (!stream || !stream.width || !stream.height) {
    throw new Error(`No image resolution from ffprobe for ${filePath}`);
  }
  return { width: Number(stream.width), height: Number(stream.height) };
}

async function normalizeImageToPng({
  inputPath,
  outputFinalPath,
  width,
  height
}) {
  const outputDir = path.dirname(outputFinalPath);
  await ensureDir(outputDir);

  // temp swap avoids partial reads in gallery windows.
  const tmpPath = path.join(outputDir, "background.tmp.png");
  const args = ["-y", "-i", inputPath];

  if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
    const vf = `scale=${width}:${height}:force_original_aspect_ratio=increase:flags=lanczos,crop=${width}:${height}`;
    args.push("-vf", vf);
  }

  args.push("-frames:v", "1", tmpPath);

  await runProcess(resolveMediaBinary("ffmpeg"), args);

  try {
    await fs.promises.unlink(outputFinalPath);
  } catch (err) {
    if (err?.code !== "ENOENT") {
      throw err;
    }
  }
  await fs.promises.rename(tmpPath, outputFinalPath);
  return outputFinalPath;
}

async function generateCompositeImage({
  backgroundPath,
  overlayPath = null,
  outputImagePath,
  width,
  height
}) {
  await ensureDir(path.dirname(outputImagePath));

  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error("generateCompositeImage requires a valid target width/height");
  }

  // Static composite: background -> optional static overlay. No animation layer.
  // Target size comes from the background's native resolution (resolved by caller),
  // so backgrounds of ANY resolution/aspect ratio work.
  // The overlay (logo in its bottom-right corner) is fitted inside the target without
  // cropping and anchored bottom-right, so the logo survives non-square backgrounds.
  const useOverlay = !!overlayPath;
  const filter = useOverlay
    ? `[0:v]scale=${width}:${height}:flags=lanczos,format=rgba[bg];` +
      `[1:v]scale=${width}:${height}:force_original_aspect_ratio=decrease:flags=lanczos,format=rgba[ov];` +
      `[bg][ov]overlay=main_w-overlay_w:main_h-overlay_h:format=auto[v]`
    : `[0:v]scale=${width}:${height}:flags=lanczos,format=rgba[v]`;

  const args = ["-y", "-i", backgroundPath];

  if (useOverlay) {
    args.push("-i", overlayPath);
  }

  args.push(
    "-filter_complex",
    filter,
    "-map",
    "[v]",
    "-frames:v",
    "1",
    outputImagePath
  );

  await runProcess(resolveMediaBinary("ffmpeg"), args);
  return outputImagePath;
}

module.exports = {
  runProcess,
  checkMediaTooling,
  probeImageResolution,
  normalizeImageToPng,
  generateCompositeImage
};
