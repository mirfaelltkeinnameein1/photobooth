const fs = require("fs");
const path = require("path");
const { GALLERIES, SLOT_IDS, SLOT_GROUPS, MODELS } = require("./constants");
const { PATHS, toRelativeIfInsideRoot } = require("./paths");
const { ensureDir, readJsonSafe, atomicWriteFile, readTextSafe } = require("./fsutils");
const { loadLayout, saveLayout } = require("./layoutStore");
const { setApiKey, clearApiKey } = require("./secureStore");

// Config + prompt + history-facing mutators used by HTTP endpoints.
function installStateManagerConfigMethods(StateManager) {
  StateManager.prototype.getPrompt = async function getPrompt(slotId) {
    return readTextSafe(path.join(this.getSlotDefaultsDir(slotId), "prompt.txt"), "");
  };

  StateManager.prototype.savePrompt = async function savePrompt(slotId, content) {
    await atomicWriteFile(path.join(this.getSlotDefaultsDir(slotId), "prompt.txt"), content || "");
    await this.logger.info("prompt", "Slot prompt updated", { slot: slotId });
  };

  StateManager.prototype.getPreamble = async function getPreamble() {
    return readTextSafe(PATHS.PROMPT_PREAMBLE, "");
  };

  StateManager.prototype.savePreamble = async function savePreamble(content) {
    await atomicWriteFile(PATHS.PROMPT_PREAMBLE, content || "");
    await this.logger.info("prompt", "Global prompt preamble updated", {});
  };

  StateManager.prototype.setGalleryBackgroundColor = async function setGalleryBackgroundColor(gallery, color) {
    if (!GALLERIES.includes(gallery)) throw new Error(`Invalid gallery: ${gallery}`);
    const normalized = this.normalizeHexColor(color);
    const next = this.normalizeGalleryBackgrounds(this.config.gallery_backgrounds);
    next[gallery] = { ...next[gallery], type: "color", color: normalized };
    this.config.gallery_backgrounds = next;
    await this.saveConfig();
    await this.logger.info("config", "Gallery background color updated", {
      gallery,
      color: normalized
    });
  };

  StateManager.prototype.setGalleryBackgroundImage = async function setGalleryBackgroundImage(gallery, buffer, ext = ".png") {
    if (!GALLERIES.includes(gallery)) throw new Error(`Invalid gallery: ${gallery}`);
    if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error("Background image payload is empty");

    const normalizedExt = [".png", ".jpg", ".jpeg"].includes(String(ext || "").toLowerCase())
      ? String(ext).toLowerCase()
      : ".png";
    const targetPath = path.join(PATHS.CONFIG_GALLERY_BACKGROUNDS_DIR, `${gallery}_background${normalizedExt}`);
    const tempPath = `${targetPath}.tmp`;
    await ensureDir(PATHS.CONFIG_GALLERY_BACKGROUNDS_DIR);
    await fs.promises.writeFile(tempPath, buffer);
    await fs.promises.rename(tempPath, targetPath);

    const next = this.normalizeGalleryBackgrounds(this.config.gallery_backgrounds);
    next[gallery] = {
      ...next[gallery],
      type: "image",
      image_rel: toRelativeIfInsideRoot(targetPath)
    };
    this.config.gallery_backgrounds = next;
    await this.saveConfig();
    await this.logger.info("config", "Gallery background image updated", {
      gallery,
      path: targetPath
    });
  };

  StateManager.prototype.updateConfig = async function updateConfig(patch) {
    // Keep config patching strict so random payload keys don't silently persist.
    const allowed = [
      "incoming_selfies_dir",
      "outgoing_dir",
      "selected_model",
      "model_fallback_enabled",
      "window_bounds",
      "gallery_backgrounds",
      "slot_registry",
      "auto_revert_seconds"
    ];
    for (const key of allowed) {
      if (Object.prototype.hasOwnProperty.call(patch, key)) this.config[key] = patch[key];
    }
    if (Object.prototype.hasOwnProperty.call(patch, "automation")) {
      this.config.automation = {
        ...this.normalizeAutomationConfig(this.config.automation),
        ...(patch.automation || {})
      };
    }

    if (Object.prototype.hasOwnProperty.call(patch, "api_key")) {
      const nextKey = String(patch.api_key || "").trim();
      if (this.secureStoreAvailable) {
        if (nextKey) {
          await setApiKey(nextKey);
          this.apiKey = nextKey;
        } else {
          await clearApiKey();
          this.apiKey = "";
        }
      } else {
        // Runtime-only fallback: key works for this session, but won't persist.
        this.apiKey = nextKey;
        await this.logger.warn("security", "Credential Manager unavailable; API key set for current session only.");
      }
      // A bad key is the most common reason jobs got parked; give them another go.
      this.autoGenerationPaused.clear();
    }

    if (!MODELS.includes(this.config.selected_model)) this.config.selected_model = MODELS[0];
    this.config.model_fallback_enabled = this.config.model_fallback_enabled !== false;
    this.config.slot_registry = this.normalizeSlotRegistry(this.config.slot_registry);
    this.config.gallery_backgrounds = this.normalizeGalleryBackgrounds(this.config.gallery_backgrounds);
    this.config.automation = this.normalizeAutomationConfig(this.config.automation);
    this.config.auto_revert_seconds = this.normalizeAutoRevertSeconds(this.config.auto_revert_seconds);
    this.config.auto_revert_deadlines = this.normalizeAutoRevertDeadlines(this.config.auto_revert_deadlines);
    if (this.config.auto_revert_seconds <= 0) {
      this.config.auto_revert_deadlines = {};
    }
    await this.saveConfig();
    await this.syncAutoRevertTimersFromConfig({ save: false });
    if (Object.prototype.hasOwnProperty.call(patch, "incoming_selfies_dir")) this.startIncomingWatcher();
    this.maybeAutoProcessQueue();
    await this.logger.info("config", "Configuration updated", {
      selected_model: this.config.selected_model,
      model_fallback_enabled: this.config.model_fallback_enabled,
      incoming: this.config.incoming_selfies_dir,
      outgoing: this.config.outgoing_dir,
      group_counts: this.getGenerationGroupStatus().counts,
      gallery1_bg: this.config.gallery_backgrounds?.gallery1?.type || "color",
      gallery2_bg: this.config.gallery_backgrounds?.gallery2?.type || "color",
      auto_api_enabled: !!this.config.automation?.auto_api_enabled,
      auto_accept_enabled: !!this.config.automation?.auto_accept_enabled,
      auto_export_enabled: !!this.config.automation?.auto_export_enabled,
      auto_revert_seconds: this.config.auto_revert_seconds,
      api_key_set: !!this.apiKey
    });
  };

  StateManager.prototype.updateLayout = async function updateLayout(gallery, layout) {
    if (!GALLERIES.includes(gallery)) throw new Error(`Invalid gallery: ${gallery}`);
    const cleaned = {
      edit_mode: !!layout.edit_mode,
      slots: Array.isArray(layout.slots)
        ? layout.slots
            .filter((s) => SLOT_IDS.includes(s.slot))
            .map((s) => ({
              slot: s.slot,
              x: Number(s.x || 0),
              y: Number(s.y || 0),
              width: Math.max(50, Number(s.width || 100)),
              height: Math.max(50, Number(s.height || 100)),
              z: Number(s.z || 1),
              rotation: (() => {
                const raw = Number(s.rotation || 0);
                if (!Number.isFinite(raw)) return 0;
                const snapped = Math.round(raw / 90) * 90;
                return ((snapped % 360) + 360) % 360;
              })()
            }))
        : []
    };
    await saveLayout(gallery, cleaned);
    this.layouts[gallery] = cleaned;
    this.emitState();
  };

  StateManager.prototype.setLayoutEditMode = async function setLayoutEditMode(gallery, editMode) {
    if (!GALLERIES.includes(gallery)) throw new Error(`Invalid gallery: ${gallery}`);
    const existing = this.layouts[gallery] || (await loadLayout(gallery));
    const cleaned = {
      edit_mode: !!editMode,
      slots: Array.isArray(existing?.slots) ? existing.slots : []
    };
    await saveLayout(gallery, cleaned);
    this.layouts[gallery] = cleaned;
    this.emitState();
  };

  StateManager.prototype.reapplyFromHistory = async function reapplyFromHistory(uuid, gallery, targetSlot = null) {
    const group = gallery === "gallery1" ? "group1" : gallery === "gallery2" ? "group2" : gallery;
    if (!SLOT_GROUPS.includes(group)) throw new Error(`Invalid group: ${group}`);
    const metaPath = path.join(PATHS.RUNTIME_ACCEPTED, uuid, "meta.json");
    const meta = await readJsonSafe(metaPath, null);
    if (!meta) throw new Error(`Accepted meta not found for ${uuid}`);
    const originalSlot = meta.selected_slots?.[group];
    const source = meta.accepted?.[group]?.accepted_copy_path || path.join(PATHS.RUNTIME_ACCEPTED, uuid, `${group}_${originalSlot}.png`);
    const slot = targetSlot || originalSlot;
    if (!slot || !SLOT_IDS.includes(slot)) throw new Error(`Invalid target slot ${slot}`);
    await this.normalizeAndApplyToSlot({ inputPath: source, slotId: slot });
    await this.scheduleAutoRevertForSlot(slot, {
      history_uuid: uuid,
      group
    });
    await this.logger.info("history", "Reapplied accepted image", { uuid, group, source, slot });
  };

  StateManager.prototype.getAcceptedHistory = async function getAcceptedHistory() {
    const entries = await fs.promises.readdir(PATHS.RUNTIME_ACCEPTED, { withFileTypes: true });
    const history = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const uuid = entry.name;
      const meta = await readJsonSafe(path.join(PATHS.RUNTIME_ACCEPTED, uuid, "meta.json"), null);
      if (!meta) continue;
      history.push({
        uuid,
        created_at: meta.created_at,
        selected_slots: meta.selected_slots || {},
        accepted: meta.accepted || {},
        state: meta.state,
        export: meta.export || this.createDefaultExportState()
      });
    }
    history.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    return history;
  };
}

module.exports = { installStateManagerConfigMethods };
