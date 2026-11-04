const path = require("path");
const EventEmitter = require("events");
const {
  MODELS,
  JOB_STATES
} = require("./constants");
const { PATHS } = require("./paths");
const { nowIso } = require("./fsutils");
const {
  getDefaultGalleryBackgrounds,
  getDefaultAutomationConfig,
  normalizeAutomationConfig,
  normalizeAutoRevertSeconds,
  normalizeAutoRevertDeadlines,
  getDefaultSlotRegistry,
  normalizeSlotRegistry,
  getGenerationGroupStatus,
  normalizeHexColor,
  normalizeGalleryBackgrounds,
  getGalleryBackgroundsForSnapshot
} = require("./stateConfig");
const { installStateManagerConfigMethods } = require("./stateManager.configMethods");
const { installStateManagerLifecycleMethods } = require("./stateManager.lifecycle");
const { installStateManagerAutoRevertMethods } = require("./stateManager.autoRevert");
const { installStateManagerSnapshotMethods } = require("./stateManager.snapshotMethods");
const { installStateManagerWatcherMethods } = require("./stateManager.watchers");
const { installStateManagerQueueMethods } = require("./stateManager.queue");
const { installStateManagerApplyExportMethods } = require("./stateManager.applyExport");

// StateManager is the core app state holder + method namespace.
class StateManager extends EventEmitter {
  constructor(logger) {
    super();
    // Core mutable app state lives here; main process is the single source of truth.
    this.logger = logger;
    this.config = null;
    this.jobs = new Map();
    this.logs = [];
    this.layouts = { gallery1: null, gallery2: null };
    this.slotMeta = {};
    this.mediaTools = { ffmpeg: false, ffprobe: false };
    this.apiKey = "";
    this.secureStoreAvailable = true;

    this.incomingWatcher = null;
    this.incomingHealthTimer = null;
    this.currentWatchers = [];
    this.ingestTrackers = new Map();
    this.manualWatchers = new Map();
    this.autoRevertTimers = new Map();

    this.processing = false;
    this.activeJobId = null;
    this.jobLocks = new Set();
    this.missingWarned = new Set();

    this.logger.on("log", (entry) => {
      // Keep a short in-memory ring for operator UI; full history stays on disk.
      this.logs.unshift(entry);
      if (this.logs.length > 800) this.logs.length = 800;
      this.emit("log", entry);
    });
  }

  getDefaultConfig() {
    return {
      incoming_selfies_dir: "runtime/incoming_selfies",
      outgoing_dir: "runtime/outgoing_for_other_app",
      selected_model: MODELS[0],
      model_fallback_enabled: true,
      automation: this.getDefaultAutomationConfig(),
      auto_revert_seconds: 0,
      auto_revert_deadlines: {},
      group_cycle_index: 0,
      slot_registry: this.getDefaultSlotRegistry(),
      gallery_backgrounds: this.getDefaultGalleryBackgrounds(),
      window_bounds: {
        operator: { width: 1600, height: 980 },
        gallery1: { width: 1280, height: 720 },
        gallery2: { width: 1280, height: 720 }
      }
    };
  }

  getDefaultGalleryBackgrounds() {
    return getDefaultGalleryBackgrounds();
  }

  getDefaultAutomationConfig() {
    return getDefaultAutomationConfig();
  }

  normalizeAutomationConfig(input) {
    return normalizeAutomationConfig(input);
  }

  normalizeAutoRevertSeconds(value) {
    return normalizeAutoRevertSeconds(value);
  }

  normalizeAutoRevertDeadlines(input) {
    return normalizeAutoRevertDeadlines(input);
  }

  getDefaultSlotRegistry() {
    return getDefaultSlotRegistry();
  }

  normalizeSlotRegistry(input) {
    return normalizeSlotRegistry(input);
  }

  getSlotRuntimeDir(slotId) {
    return path.join(PATHS.RUNTIME_CURRENT, slotId);
  }

  getSlotDefaultsDir(slotId) {
    return path.join(PATHS.ASSETS_DEFAULTS, "slots", slotId);
  }

  getGenerationGroupStatus() {
    return getGenerationGroupStatus(this.config?.slot_registry);
  }

  normalizeHexColor(value, fallback = "#050b17") {
    return normalizeHexColor(value, fallback);
  }

  normalizeGalleryBackgrounds(value) {
    return normalizeGalleryBackgrounds(value);
  }

  getGalleryBackgroundsForSnapshot() {
    return getGalleryBackgroundsForSnapshot(this.config?.gallery_backgrounds);
  }

  createDefaultExportState() {
    return {
      status: "NOT_READY",
      output_dir: null,
      files: [],
      format: "png"
    };
  }

  buildEmptyJob(uuid, selfiePath, selectedSlots = null) {
    return {
      uuid,
      selfie_path: selfiePath,
      selfie_original_path: selfiePath,
      created_at: nowIso(),
      state: selectedSlots ? JOB_STATES.SLOTTED : JOB_STATES.NEW,
      selected_slots: selectedSlots,
      model_used_primary: MODELS[0],
      model_used_current: this.config.selected_model,
      attempts: {
        group1: { [MODELS[0]]: 0, [MODELS[1]]: 0 },
        group2: { [MODELS[0]]: 0, [MODELS[1]]: 0 }
      },
      candidates: {
        group1: [],
        group2: []
      },
      manual: {
        folder: null,
        candidates: {
          group1: null,
          group2: null
        },
        original_name: null
      },
      accepted: {
        group1: null,
        group2: null
      },
      error: null,
      export: this.createDefaultExportState()
    };
  }

}

installStateManagerConfigMethods(StateManager);
installStateManagerLifecycleMethods(StateManager);
installStateManagerAutoRevertMethods(StateManager);
installStateManagerSnapshotMethods(StateManager);
installStateManagerWatcherMethods(StateManager);
installStateManagerQueueMethods(StateManager);
installStateManagerApplyExportMethods(StateManager);

module.exports = { StateManager };
