const { SLOT_IDS } = require("./constants");

// Auto-revert scheduler for slots that should roll back to defaults after N sec.
function installStateManagerAutoRevertMethods(StateManager) {
  StateManager.prototype.clearAutoRevertTimer = function clearAutoRevertTimer(slotId) {
    const existing = this.autoRevertTimers.get(slotId);
    if (!existing) return;
    clearTimeout(existing);
    this.autoRevertTimers.delete(slotId);
  };

  StateManager.prototype.clearAutoRevertDeadline = async function clearAutoRevertDeadline(slotId, options = {}) {
    this.clearAutoRevertTimer(slotId);
    if (!this.config) return;
    if (!this.config.auto_revert_deadlines || typeof this.config.auto_revert_deadlines !== "object") {
      this.config.auto_revert_deadlines = {};
    }
    if (!this.config.auto_revert_deadlines[slotId]) return;
    delete this.config.auto_revert_deadlines[slotId];
    if (options.save !== false) {
      await this.saveConfig();
    }
  };

  StateManager.prototype.scheduleAutoRevertForSlot = async function scheduleAutoRevertForSlot(slotId, meta = {}) {
    if (!SLOT_IDS.includes(slotId)) return;
    const seconds = this.normalizeAutoRevertSeconds(this.config?.auto_revert_seconds);
    if (seconds <= 0) {
      await this.clearAutoRevertDeadline(slotId, { save: true });
      return;
    }

    const deadlineTs = Date.now() + seconds * 1000;
    const deadlineIso = new Date(deadlineTs).toISOString();
    if (!this.config.auto_revert_deadlines || typeof this.config.auto_revert_deadlines !== "object") {
      this.config.auto_revert_deadlines = {};
    }
    this.config.auto_revert_deadlines[slotId] = deadlineIso;

    this.clearAutoRevertTimer(slotId);
    const delayMs = Math.max(0, deadlineTs - Date.now());
    const timer = setTimeout(() => {
      this.executeAutoRevert(slotId).catch((err) => {
        this.logger.error("autorevert", `Auto revert execution failed: ${err.message}`, { slot: slotId }).catch(() => {});
      });
    }, delayMs);
    this.autoRevertTimers.set(slotId, timer);

    await this.saveConfig();
    await this.logger.info("autorevert", "Auto revert scheduled", {
      slot: slotId,
      seconds,
      deadline: deadlineIso,
      ...meta
    });
  };

  StateManager.prototype.executeAutoRevert = async function executeAutoRevert(slotId) {
    if (!SLOT_IDS.includes(slotId)) return;
    this.clearAutoRevertTimer(slotId);
    const deadlineIso = this.config?.auto_revert_deadlines?.[slotId];
    if (!deadlineIso) return;
    const deadlineTs = new Date(deadlineIso).getTime();
    if (!Number.isFinite(deadlineTs)) {
      await this.clearAutoRevertDeadline(slotId, { save: true });
      return;
    }

    const remainingMs = deadlineTs - Date.now();
    if (remainingMs > 250) {
      const timer = setTimeout(() => {
        this.executeAutoRevert(slotId).catch((err) => {
          this.logger.error("autorevert", `Auto revert execution failed: ${err.message}`, { slot: slotId }).catch(() => {});
        });
      }, remainingMs);
      this.autoRevertTimers.set(slotId, timer);
      return;
    }

    try {
      await this.logger.info("autorevert", "Auto revert triggered", { slot: slotId, deadline: deadlineIso });
      await this.revertSlotToDefault(slotId, { reason: "auto_revert" });
    } catch (err) {
      await this.logger.error("autorevert", `Auto revert failed: ${err.message}`, { slot: slotId });
      await this.clearAutoRevertDeadline(slotId, { save: true });
    }
  };

  StateManager.prototype.syncAutoRevertTimersFromConfig = async function syncAutoRevertTimersFromConfig(options = {}) {
    for (const slotId of SLOT_IDS) {
      this.clearAutoRevertTimer(slotId);
    }
    if (!this.config) return;

    this.config.auto_revert_seconds = this.normalizeAutoRevertSeconds(this.config.auto_revert_seconds);
    this.config.auto_revert_deadlines = this.normalizeAutoRevertDeadlines(this.config.auto_revert_deadlines);

    if (this.config.auto_revert_seconds <= 0) {
      if (Object.keys(this.config.auto_revert_deadlines).length) {
        this.config.auto_revert_deadlines = {};
        if (options.save !== false) await this.saveConfig();
      }
      return;
    }

    const now = Date.now();
    for (const slotId of SLOT_IDS) {
      const deadlineIso = this.config.auto_revert_deadlines?.[slotId];
      if (!deadlineIso) continue;
      const deadlineTs = new Date(deadlineIso).getTime();
      if (!Number.isFinite(deadlineTs)) continue;
      const delayMs = Math.max(0, deadlineTs - now);
      const timer = setTimeout(() => {
        this.executeAutoRevert(slotId).catch((err) => {
          this.logger.error("autorevert", `Auto revert execution failed: ${err.message}`, { slot: slotId }).catch(() => {});
        });
      }, delayMs);
      this.autoRevertTimers.set(slotId, timer);
    }
  };

}

module.exports = { installStateManagerAutoRevertMethods };
