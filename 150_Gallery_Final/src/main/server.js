const path = require("path");
const fs = require("fs");
const express = require("express");
const { PATHS } = require("./paths");
const { GALLERIES, SLOT_IDS, SLOT_GROUPS } = require("./constants");

// Local control API + SSE bus for operator and gallery windows.
function normalizeGroupInput(v) {
  if (v === "gallery1") return "group1";
  if (v === "gallery2") return "group2";
  return v;
}

function makeSsePacket(type, payload) {
  return `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
}

async function startServer({ stateManager, logger, chooseDirectory, openPath }) {
  const app = express();
  // Base64 uploads for custom gallery backgrounds can be large.
  app.use(express.json({ limit: "50mb" }));

  const clients = new Set();

  stateManager.on("state", (snapshot) => {
    // Single SSE fanout channel for operator + gallery windows.
    const packet = makeSsePacket("state", snapshot);
    for (const res of clients) {
      try {
        res.write(packet);
      } catch (err) {
        logger.warn("server", "Failed pushing state packet to one SSE client", { error: err.message }).catch(() => {});
      }
    }
  });

  stateManager.on("log", (logEntry) => {
    const packet = makeSsePacket("log", logEntry);
    for (const res of clients) {
      try {
        res.write(packet);
      } catch (err) {
        logger.warn("server", "Failed pushing log packet to one SSE client", { error: err.message }).catch(() => {});
      }
    }
  });

  function onApiError(res, err) {
    res.status(400).json({ ok: false, error: err.message });
  }

  function post(pathname, handler) {
    app.post(pathname, async (req, res) => {
      try {
        await handler(req, res);
      } catch (err) {
        onApiError(res, err);
      }
    });
  }

  function del(pathname, handler) {
    app.delete(pathname, async (req, res) => {
      try {
        await handler(req, res);
      } catch (err) {
        onApiError(res, err);
      }
    });
  }

  app.get("/api/events", (req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive"
    });
    res.write(makeSsePacket("state", stateManager.snapshot()));
    clients.add(res);
    // Important: release dead socket or we leak handles over long event days.
    req.on("close", () => clients.delete(res));
  });

  app.get("/api/state", (req, res) => {
    res.json(stateManager.snapshot());
  });

  app.get("/api/models", (req, res) => {
    res.json({ models: ["gemini-3-pro-image-preview", "gemini-2.5-flash-image"] });
  });

  post("/api/config", async (req, res) => {
    await stateManager.updateConfig(req.body || {});
    res.json({ ok: true, config: stateManager.snapshot().config });
  });

  post("/api/gallery-background", async (req, res) => {
    const { gallery, type, color } = req.body || {};
    if (!GALLERIES.includes(gallery)) throw new Error("Invalid gallery");
    if (type !== "color") throw new Error("Only color updates are supported on this endpoint");
    await stateManager.setGalleryBackgroundColor(gallery, color);
    res.json({ ok: true, config: stateManager.snapshot().config });
  });

  post("/api/gallery-background/upload", async (req, res) => {
    const { gallery, data_url: dataUrl } = req.body || {};
    if (!GALLERIES.includes(gallery)) throw new Error("Invalid gallery");
    if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:")) {
      throw new Error("Invalid data URL");
    }
    const match = dataUrl.match(/^data:(image\/png|image\/jpeg);base64,([a-zA-Z0-9+/=\s]+)$/);
    if (!match) throw new Error("Only PNG/JPEG data URLs are allowed");
    const mime = match[1];
    const base64 = match[2].replace(/\s+/g, "");
    const buffer = Buffer.from(base64, "base64");
    if (!buffer.length) throw new Error("Uploaded image is empty");
    const ext = mime === "image/png" ? ".png" : ".jpg";
    await stateManager.setGalleryBackgroundImage(gallery, buffer, ext);
    res.json({ ok: true, config: stateManager.snapshot().config });
  });

  post("/api/dialog/select-directory", async (req, res) => {
    const { kind } = req.body || {};
    const selected = await chooseDirectory();
    if (!selected) return res.json({ ok: false, cancelled: true });
    if (kind === "incoming") {
      await stateManager.updateConfig({ incoming_selfies_dir: selected });
    } else if (kind === "outgoing") {
      await stateManager.updateConfig({ outgoing_dir: selected });
    }
    res.json({ ok: true, path: selected });
  });

  app.get("/api/prompts/preamble", async (req, res) => {
    res.json({ content: await stateManager.getPreamble() });
  });

  post("/api/prompts/preamble", async (req, res) => {
    await stateManager.savePreamble(String(req.body?.content || ""));
    res.json({ ok: true });
  });

  app.get("/api/prompts/:slot", async (req, res) => {
    const { slot } = req.params;
    if (!SLOT_IDS.includes(slot)) return res.status(404).json({ error: "invalid slot" });
    const content = await stateManager.getPrompt(slot);
    res.json({ content });
  });

  post("/api/prompts/:slot", async (req, res) => {
    const { slot } = req.params;
    if (!SLOT_IDS.includes(slot)) throw new Error("invalid slot");
    await stateManager.savePrompt(slot, String(req.body?.content || ""));
    res.json({ ok: true });
  });

  post("/api/slots/:slot/revert", async (req, res) => {
    if (!SLOT_IDS.includes(req.params.slot)) throw new Error("Invalid slot");
    await stateManager.revertSlotToDefault(req.params.slot);
    res.json({ ok: true });
  });

  post("/api/slots/:slot/config", async (req, res) => {
    const slotId = req.params.slot;
    if (!SLOT_IDS.includes(slotId)) throw new Error("Invalid slot");
    const registry = stateManager.normalizeSlotRegistry(stateManager.config.slot_registry);
    registry[slotId] = {
      ...registry[slotId],
      ...(req.body || {})
    };
    await stateManager.updateConfig({ slot_registry: registry });
    res.json({ ok: true, config: stateManager.snapshot().config });
  });

  post("/api/jobs/:uuid/send", async (req, res) => {
    await stateManager.sendJobToApi(req.params.uuid);
    res.json({ ok: true });
  });

  post("/api/jobs/:uuid/regenerate", async (req, res) => {
    const group = normalizeGroupInput(req.body?.group || req.body?.gallery);
    if (!SLOT_GROUPS.includes(group)) throw new Error("Invalid group");
    await stateManager.regenerateSlot(req.params.uuid, group);
    res.json({ ok: true });
  });

  post("/api/jobs/:uuid/accept", async (req, res) => {
    const group = normalizeGroupInput(req.body?.group || req.body?.gallery);
    if (!SLOT_GROUPS.includes(group)) throw new Error("Invalid group");
    await stateManager.acceptCandidate(
      req.params.uuid,
      group,
      req.body?.path || null,
      req.body?.type || "genai"
    );
    res.json({ ok: true });
  });

  app.get("/api/jobs/:uuid/selfie", async (req, res) => {
    try {
      const job = stateManager.jobs.get(req.params.uuid);
      if (!job) return res.status(404).json({ ok: false, error: "Job not found" });
      const selfiePath = stateManager.getJobSelfieAbsolutePath(job);
      if (!selfiePath || !fs.existsSync(selfiePath)) {
        return res.status(404).json({ ok: false, error: "Selfie file not found" });
      }
      res.sendFile(selfiePath, (err) => {
        if (err && !res.headersSent) {
          res.status(500).json({ ok: false, error: err.message });
        }
      });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  post("/api/jobs/:uuid/manual-start", async (req, res) => {
    const folder = await stateManager.startManualEdit(req.params.uuid);
    res.json({ ok: true, folder });
  });

  post("/api/jobs/:uuid/open-manual-folder", async (req, res) => {
    const job = stateManager.jobs.get(req.params.uuid);
    if (!job?.manual?.folder) throw new Error("Manual folder not initialized");
    await openPath(job.manual.folder);
    res.json({ ok: true });
  });

  post("/api/jobs/:uuid/retry-export", async (req, res) => {
    await stateManager.retryExport(req.params.uuid);
    res.json({ ok: true });
  });

  del("/api/jobs/:uuid", async (req, res) => {
    await stateManager.deleteJob(req.params.uuid, {
      removeArtifacts: req.body?.remove_artifacts !== false
    });
    res.json({ ok: true });
  });

  app.get("/api/history", async (req, res) => {
    res.json({ items: await stateManager.getAcceptedHistory() });
  });

  post("/api/history/:uuid/reapply", async (req, res) => {
    await stateManager.reapplyFromHistory(req.params.uuid, req.body?.gallery, req.body?.target_slot || null);
    res.json({ ok: true });
  });

  del("/api/history/:uuid", async (req, res) => {
    await stateManager.deleteHistoryEntry(req.params.uuid, {
      removeOutgoing: req.body?.remove_outgoing !== false
    });
    res.json({ ok: true });
  });

  app.get("/api/layout/:gallery", async (req, res) => {
    const gallery = req.params.gallery;
    const snap = stateManager.snapshot();
    if (!snap.layouts[gallery]) return res.status(404).json({ error: "invalid gallery" });
    res.json(snap.layouts[gallery]);
  });

  post("/api/layout/:gallery", async (req, res) => {
    await stateManager.updateLayout(req.params.gallery, req.body || {});
    res.json({ ok: true });
  });

  post("/api/layout/:gallery/edit-mode", async (req, res) => {
    await stateManager.setLayoutEditMode(req.params.gallery, !!req.body?.edit_mode);
    res.json({ ok: true });
  });

  app.get("/api/health", (req, res) => {
    res.json({ ok: true, ts: new Date().toISOString() });
  });

  // DATA_ROOT first (runtime/current, accepted, etc), then project root fallbacks.
  app.use("/files", express.static(PATHS.DATA_ROOT));
  app.use("/files", express.static(PATHS.ROOT));
  app.use("/js", express.static(path.join(PATHS.ROOT, "src", "renderer", "js")));
  app.use(express.static(PATHS.PUBLIC_DIR));

  app.get("/", (req, res) => res.sendFile(path.join(PATHS.PUBLIC_DIR, "operator.html")));
  app.get("/operator.html", (req, res) => res.sendFile(path.join(PATHS.PUBLIC_DIR, "operator.html")));
  app.get("/gallery.html", (req, res) => res.sendFile(path.join(PATHS.PUBLIC_DIR, "gallery.html")));

  const port = 4311;
  const server = await new Promise((resolve) => {
    const s = app.listen(port, "127.0.0.1", () => resolve(s));
  });

  await logger.info("server", "Local server started", { port, host: "127.0.0.1" });
  return {
    app,
    server,
    port
  };
}

module.exports = { startServer };
