const fs = require("fs");
const path = require("path");
const { SLOT_IDS, MODELS } = require("./constants");
const { PATHS, toAbsoluteMaybeRelative } = require("./paths");
const { ensureDir, fileExists, readJsonSafe, atomicWriteJson, atomicWriteFile, copyFileIfMissing, nowIso } = require("./fsutils");
const { loadAllJobs } = require("./jobStore");
const { loadLayout } = require("./layoutStore");
const { getApiKey } = require("./secureStore");
const { checkMediaTooling, probeImageResolution } = require("./media");

// Startup/bootstrap methods. Order matters here more than it looks.
function installStateManagerLifecycleMethods(StateManager) {
  StateManager.prototype.init = async function init() {
    // Boot order matters here: filesystem/config/layout first, watchers last.
    await this.ensureBaseStructure();
    await this.loadConfig();
    await this.syncDefaultsIntoRuntimeCurrent();

    this.layouts.gallery1 = await loadLayout("gallery1");
    this.layouts.gallery2 = await loadLayout("gallery2");
    this.slotMeta = (await readJsonSafe(PATHS.RUNTIME_SLOTMETA, this.slotMeta)) || this.slotMeta;

    this.mediaTools = await checkMediaTooling();
    if (!this.mediaTools.ffmpeg || !this.mediaTools.ffprobe) {
      await this.logger.warn("startup", "ffmpeg/ffprobe missing from PATH. Image conversion/probing and MP4 export may fail.", {
        ffmpeg: this.mediaTools.ffmpeg,
        ffprobe: this.mediaTools.ffprobe
      });
    }

    await this.refreshSlotMeta();

    const jobs = await loadAllJobs();
    for (const job of jobs) {
      if (!job?.uuid) continue;
      if (!job.export || typeof job.export !== "object") {
        job.export = this.createDefaultExportState();
      } else {
        job.export = {
          ...this.createDefaultExportState(),
          ...job.export
        };
      }
      this.jobs.set(job.uuid, job);
      if (job.manual?.folder) {
        // Resume manual folder watchers so pending PSD/manual flows survive restart.
        await this.startManualWatcher(job.uuid, job.manual.folder);
      }
    }
    await this.enforceJobCapacity(12, [this.activeJobId].filter(Boolean));

    this.startIncomingWatcher();
    this.startIncomingHealthMonitor();
    this.startCurrentBackgroundWatchers();
    await this.syncAutoRevertTimersFromConfig({ save: false });

    await this.logger.info("startup", "State manager initialized", {
      jobs: this.jobs.size,
      incoming: this.getIncomingDirAbs()
    });

    this.emitState();
    this.maybeAutoProcessQueue();
  };

  StateManager.prototype.ensureBaseStructure = async function ensureBaseStructure() {
    const dirs = [
      PATHS.ASSETS_DEFAULTS,
      path.join(PATHS.ASSETS_DEFAULTS, "slots"),
      PATHS.RUNTIME,
      PATHS.RUNTIME_CURRENT,
      PATHS.RUNTIME_INCOMING,
      PATHS.RUNTIME_WORK,
      PATHS.RUNTIME_JOBS,
      PATHS.RUNTIME_SELFIES,
      PATHS.RUNTIME_GENAI_RESULTS,
      PATHS.RUNTIME_MANUAL,
      PATHS.RUNTIME_ACCEPTED,
      PATHS.RUNTIME_OUTGOING,
      PATHS.RUNTIME_LOGS,
      PATHS.CONFIG_DIR,
      PATHS.CONFIG_GALLERY_BACKGROUNDS_DIR
    ];

    for (const d of dirs) {
      await ensureDir(d);
    }
    await this.syncBundledDefaultsIfMissing();
    await this.syncBundledConfigIfMissing();

    for (const slotId of SLOT_IDS) {
      await ensureDir(this.getSlotDefaultsDir(slotId));
      await ensureDir(this.getSlotRuntimeDir(slotId));
    }

    if (!(await fileExists(PATHS.PROMPT_PREAMBLE))) {
      await atomicWriteFile(
        PATHS.PROMPT_PREAMBLE,
        "You are editing an event template image. Replace subject with selfie person. Keep framing and lighting. No text, no logos."
      );
    }
  };

  StateManager.prototype.syncBundledDefaultsIfMissing = async function syncBundledDefaultsIfMissing() {
    const sourceRoot = PATHS.ASSETS_BUNDLED_DEFAULTS;
    const targetRoot = PATHS.ASSETS_DEFAULTS;
    if (sourceRoot === targetRoot) return;
    if (!(await fileExists(sourceRoot))) return;

    const copyMissingRec = async (srcDir, dstDir) => {
      await ensureDir(dstDir);
      const entries = await fs.promises.readdir(srcDir, { withFileTypes: true });
      for (const entry of entries) {
        const srcPath = path.join(srcDir, entry.name);
        const dstPath = path.join(dstDir, entry.name);
        if (entry.isDirectory()) {
          await copyMissingRec(srcPath, dstPath);
          continue;
        }
        if (entry.isFile() && !(await fileExists(dstPath))) {
          await fs.promises.copyFile(srcPath, dstPath);
        }
      }
    };

    const sourceSlotsDir = path.join(sourceRoot, "slots");
    if (!(await fileExists(sourceSlotsDir))) {
      await this.logger.warn("startup", "Bundled defaults/slots folder missing; skipping bundled copy", {
        path: sourceSlotsDir
      });
      return;
    }
    await copyMissingRec(sourceSlotsDir, path.join(targetRoot, "slots"));
  };

  StateManager.prototype.syncBundledConfigIfMissing = async function syncBundledConfigIfMissing() {
    const bundledPreamblePath = PATHS.BUNDLED_PROMPT_PREAMBLE;
    const targetPreamblePath = PATHS.PROMPT_PREAMBLE;

    if (await fileExists(bundledPreamblePath)) {
      await copyFileIfMissing(bundledPreamblePath, targetPreamblePath);
    }

    await copyFileIfMissing(PATHS.BUNDLED_LAYOUT_GALLERY1, PATHS.LAYOUT_GALLERY1);
    await copyFileIfMissing(PATHS.BUNDLED_LAYOUT_GALLERY2, PATHS.LAYOUT_GALLERY2);
  };

  StateManager.prototype.loadConfig = async function loadConfig() {
    const defaults = this.getDefaultConfig();
    let config = await readJsonSafe(PATHS.APP_CONFIG, null);
    if (!config) {
      config = defaults;
      await atomicWriteJson(PATHS.APP_CONFIG, config);
    }

    this.config = {
      ...defaults,
      ...config,
      window_bounds: {
        ...defaults.window_bounds,
        ...(config.window_bounds || {})
      }
    };

    if (!Number.isFinite(Number(this.config.group_cycle_index))) {
      this.config.group_cycle_index = 0;
    }

    if (!MODELS.includes(this.config.selected_model)) {
      this.config.selected_model = MODELS[0];
    }
    this.config.model_fallback_enabled = this.config.model_fallback_enabled !== false;
    this.config.slot_registry = this.normalizeSlotRegistry(this.config.slot_registry);
    this.config.gallery_backgrounds = this.normalizeGalleryBackgrounds(this.config.gallery_backgrounds);
    this.config.automation = this.normalizeAutomationConfig(this.config.automation);
    this.config.auto_revert_seconds = this.normalizeAutoRevertSeconds(this.config.auto_revert_seconds);
    this.config.auto_revert_deadlines = this.normalizeAutoRevertDeadlines(this.config.auto_revert_deadlines);
    if (this.config.auto_revert_seconds <= 0) {
      this.config.auto_revert_deadlines = {};
    }

    try {
      this.apiKey = (await getApiKey()) || "";
      this.secureStoreAvailable = true;
    } catch (err) {
      this.secureStoreAvailable = false;
      this.apiKey = "";
      await this.logger.error("security", `Credential Manager unavailable (${err.message}). API key updates will not persist.`);
    }
    await this.saveConfig();
  };

  StateManager.prototype.saveConfig = async function saveConfig() {
    const diskConfig = { ...this.config };
    delete diskConfig.api_key;
    await atomicWriteJson(PATHS.APP_CONFIG, diskConfig);
    this.emitState();
  };

  StateManager.prototype.getIncomingDirAbs = function getIncomingDirAbs() {
    return toAbsoluteMaybeRelative(this.config.incoming_selfies_dir);
  };

  StateManager.prototype.getOutgoingDirAbs = function getOutgoingDirAbs() {
    return toAbsoluteMaybeRelative(this.config.outgoing_dir);
  };

  StateManager.prototype.syncDefaultsIntoRuntimeCurrent = async function syncDefaultsIntoRuntimeCurrent() {
    for (const slotId of SLOT_IDS) {
      const defaultsDir = this.getSlotDefaultsDir(slotId);
      const sourceBg = path.join(defaultsDir, "background.png");
      const sourcePrompt = path.join(defaultsDir, "prompt.txt");
      const slotDir = this.getSlotRuntimeDir(slotId);
      const targetBg = path.join(slotDir, "background.png");

      if (!(await fileExists(sourcePrompt))) {
        await atomicWriteFile(
          sourcePrompt,
          "Create a clean replacement portrait background. Preserve framing and lighting. No text, no logos."
        );
      }

      await ensureDir(slotDir);
      await copyFileIfMissing(sourceBg, targetBg);
    }
  };

  StateManager.prototype.refreshSlotMeta = async function refreshSlotMeta() {
    if (!this.mediaTools.ffprobe) {
      return;
    }

    this.slotMeta = {};
    for (const slotId of SLOT_IDS) {
      const runtimeBg = path.join(this.getSlotRuntimeDir(slotId), "background.png");
      const defaultBg = path.join(this.getSlotDefaultsDir(slotId), "background.png");
      const bgPath = (await fileExists(runtimeBg)) ? runtimeBg : defaultBg;

      if (!(await fileExists(bgPath))) {
        await this.logger.warn("slotmeta", "Background file missing for slot", { slot: slotId, path: bgPath });
        continue;
      }

      try {
        const res = await probeImageResolution(bgPath);
        this.slotMeta[slotId] = {
          width: res.width,
          height: res.height,
          source: bgPath,
          updated_at: nowIso()
        };
      } catch (err) {
        await this.logger.error("slotmeta", `Failed to read background resolution: ${err.message}`, { slot: slotId, path: bgPath });
      }
    }

    await atomicWriteJson(PATHS.RUNTIME_SLOTMETA, this.slotMeta);
  };

  StateManager.prototype.getSlotMeta = function getSlotMeta(slotId) {
    return this.slotMeta?.[slotId] || null;
  };

  StateManager.prototype.buildPrompt = function buildPrompt(slotId) {
    const preamble = fs.readFileSync(PATHS.PROMPT_PREAMBLE, "utf8");
    const slotPromptPath = path.join(this.getSlotDefaultsDir(slotId), "prompt.txt");
    const slotPrompt = fs.existsSync(slotPromptPath) ? fs.readFileSync(slotPromptPath, "utf8") : "";
    const required = "Required: no text, no logos, keep same framing, match lighting, preserve template composition.";
    return `${preamble.trim()}\n\n${slotPrompt.trim()}\n\n${required}`.trim();
  };

}

module.exports = { installStateManagerLifecycleMethods };
