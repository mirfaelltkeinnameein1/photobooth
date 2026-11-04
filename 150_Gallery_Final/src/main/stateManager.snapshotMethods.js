const fs = require("fs");
const path = require("path");
const { SLOT_IDS } = require("./constants");
const { PATHS, toRelativeIfInsideRoot, toAbsoluteMaybeRelative } = require("./paths");
const { nowIso } = require("./fsutils");

// Read-only snapshot builders consumed by SSE + API state endpoint.
function installStateManagerSnapshotMethods(StateManager) {
  StateManager.prototype.getSlotRuntime = function getSlotRuntime(slotId) {
    const safeMtime = (p) => {
      try {
        return fs.statSync(p).mtimeMs;
      } catch {
        return 0;
      }
    };

    const registry = this.normalizeSlotRegistry(this.config?.slot_registry);
    const slotCfg = registry[slotId];
    const runtimeDir = this.getSlotRuntimeDir(slotId);
    const bgRuntime = path.join(runtimeDir, "background.png");
    const bgDefault = path.join(this.getSlotDefaultsDir(slotId), "background.png");
    const bg = fs.existsSync(bgRuntime) ? bgRuntime : bgDefault;

    if (!fs.existsSync(bgRuntime)) {
      const key = `${slotId}:bg`;
      if (!this.missingWarned.has(key)) {
        this.missingWarned.add(key);
        this.logger.warn("gallery", "runtime/current slot background missing, using defaults fallback", {
          slot: slotId,
          path: bgRuntime
        }).catch(() => {});
      }
    }

    return {
      slot: slotId,
      active: !!slotCfg?.active,
      display_gallery: slotCfg?.display_gallery || "gallery1",
      generation_group: slotCfg?.generation_group || "group1",
      background_path: bg,
      background_rel: toRelativeIfInsideRoot(bg),
      background_mtime_ms: safeMtime(bg),
      has_background: fs.existsSync(bg),
      meta: this.getSlotMeta(slotId)
    };
  };

  StateManager.prototype.getJobSelfieAbsolutePath = function getJobSelfieAbsolutePath(job) {
    const selfiePath = job?.selfie_path;
    if (!selfiePath) return null;
    return path.isAbsolute(selfiePath) ? selfiePath : toAbsoluteMaybeRelative(selfiePath);
  };

  StateManager.prototype.serializeJobForSnapshot = function serializeJobForSnapshot(job) {
    const selfieAbs = this.getJobSelfieAbsolutePath(job);
    let selfieExists = false;
    let selfieMtimeMs = 0;
    if (selfieAbs) {
      try {
        const stat = fs.statSync(selfieAbs);
        selfieExists = stat.isFile();
        selfieMtimeMs = stat.mtimeMs;
      } catch (err) {
        // Missing selfie on disk is not fatal; preview just stays empty.
        selfieExists = false;
        selfieMtimeMs = 0;
      }
    }

    return {
      ...job,
      selfie_preview_url: selfieExists ? `/api/jobs/${encodeURIComponent(job.uuid)}/selfie` : "",
      selfie_exists: selfieExists,
      selfie_mtime_ms: selfieMtimeMs,
      auto_generation_paused: this.autoGenerationPaused.has(job.uuid)
    };
  };

  StateManager.prototype.snapshot = function snapshot() {
    const safeConfig = { ...this.config };
    // Never leak plaintext key over HTTP/SSE to renderer.
    delete safeConfig.api_key;
    const slotRegistry = this.normalizeSlotRegistry(this.config?.slot_registry);
    const slots = SLOT_IDS.map((slotId) => this.getSlotRuntime(slotId));
    const groupStatus = this.getGenerationGroupStatus();
    return {
      ts: nowIso(),
      active_job_uuid: this.activeJobId,
      media_tools: this.mediaTools,
      config: {
        ...safeConfig,
        slot_registry: slotRegistry,
        gallery_backgrounds: this.getGalleryBackgroundsForSnapshot(),
        group_status: groupStatus,
        api_key_set: !!this.apiKey,
        secure_store_available: this.secureStoreAvailable,
        root_dir: PATHS.DATA_ROOT,
        app_root_dir: PATHS.ROOT,
        incoming_selfies_dir_abs: this.getIncomingDirAbs(),
        outgoing_dir_abs: this.getOutgoingDirAbs()
      },
      layouts: this.layouts,
      slotmeta: this.slotMeta,
      slots,
      galleries: {
        gallery1: slots.filter((s) => s.active && s.display_gallery === "gallery1"),
        gallery2: slots.filter((s) => s.active && s.display_gallery === "gallery2")
      },
      jobs: this.getJobsSorted().map((job) => this.serializeJobForSnapshot(job)),
      logs: this.logs.slice(0, 300)
    };
  };

  StateManager.prototype.emitState = function emitState() {
    // Single place that fans state to SSE clients.
    this.emit("state", this.snapshot());
  };

}

module.exports = { installStateManagerSnapshotMethods };
