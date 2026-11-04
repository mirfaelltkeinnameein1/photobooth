const fs = require("fs");
const path = require("path");
const { SLOT_IDS, SLOT_GROUPS, JOB_STATES } = require("./constants");
const { fileExists, nowIso } = require("./fsutils");
const { saveJob } = require("./jobStore");

// Filesystem watchers used for incoming files, runtime slots, and manual folders.
function installStateManagerWatcherMethods(StateManager) {
  // ---------- Incoming selfie watcher ----------
  StateManager.prototype.startIncomingWatcher = function startIncomingWatcher() {
    const dir = this.getIncomingDirAbs();
    try {
      fs.mkdirSync(dir, { recursive: true });

      if (this.incomingWatcher) {
        this.incomingWatcher.close();
        this.incomingWatcher = null;
      }

      this.incomingWatcher = fs.watch(dir, (eventType, filename) => {
        if (!filename) return;
        const ext = path.extname(filename).toLowerCase();
        if (![".jpg", ".jpeg", ".png"].includes(ext)) return;
        const fullPath = path.join(dir, filename);
        // Never ingest immediately; wait for copy to fully finish.
        this.trackStableIncomingFile(fullPath);
      });

      this.incomingWatcher.on("error", (err) => {
        this.logger.error("watcher", "Incoming watcher error", { path: dir, error: err.message }).catch(() => {});
      });

      this.logger.info("watcher", "Watching incoming selfies folder", { path: dir }).catch(() => {});
    } catch (err) {
      this.incomingWatcher = null;
      this.logger.error("watcher", "Failed to watch incoming selfies folder", { path: dir, error: err.message }).catch(() => {});
    }
  };

  // ---------- Health heartbeat ----------
  StateManager.prototype.startIncomingHealthMonitor = function startIncomingHealthMonitor() {
    if (this.incomingHealthTimer) {
      clearInterval(this.incomingHealthTimer);
      this.incomingHealthTimer = null;
    }

    this.checkIncomingHealth().catch((err) => {
      this.logger.warn("watcher", "Initial incoming health check failed", { error: err.message }).catch(() => {});
    });
    this.incomingHealthTimer = setInterval(() => {
      this.checkIncomingHealth().catch((err) => {
        this.logger.warn("watcher", "Periodic incoming health check failed", { error: err.message }).catch(() => {});
      });
    }, 60_000);
  };

  StateManager.prototype.checkIncomingHealth = async function checkIncomingHealth() {
    const dir = this.getIncomingDirAbs();
    const withTimeout = (p, ms, msg) => Promise.race([
      p,
      new Promise((_, reject) => setTimeout(() => reject(new Error(msg)), ms))
    ]);

    try {
      await withTimeout(fs.promises.access(dir, fs.constants.R_OK), 5000, "access timeout");
      const entries = await withTimeout(fs.promises.readdir(dir), 5000, "readdir timeout");
      await this.logger.success("watcher", "Incoming watcher health OK", {
        path: dir,
        watch_active: !!this.incomingWatcher,
        entries: Array.isArray(entries) ? entries.length : 0
      });
    } catch (err) {
      await this.logger.error("watcher", "Incoming watcher health FAILED", {
        path: dir,
        watch_active: !!this.incomingWatcher,
        error: err.message
      });
    }
  };

  // ---------- Stable size ingestion gate ----------
  StateManager.prototype.trackStableIncomingFile = function trackStableIncomingFile(filePath) {
    const trackerKey = path.resolve(filePath).toLowerCase();
    if (this.ingestTrackers.has(trackerKey)) return;
    const startedAt = Date.now();
    let lastSize = -1;
    let stableSince = null;
    let missingCount = 0;

    const timer = setInterval(async () => {
      const elapsed = Date.now() - startedAt;
      if (elapsed > 30000) {
        clearInterval(timer);
        this.ingestTrackers.delete(trackerKey);
        await this.logger.error("ingest", "Incoming file never stabilized within timeout", {
          path: filePath,
          last_known_size: lastSize
        });
        return;
      }

      let stat;
      try {
        stat = await fs.promises.stat(filePath);
      } catch {
        missingCount += 1;
        if (missingCount >= 5) {
          clearInterval(timer);
          this.ingestTrackers.delete(trackerKey);
          await this.logger.warn("ingest", "Incoming file disappeared before stabilization; skipping", { path: filePath });
        }
        return;
      }
      missingCount = 0;
      if (!stat.isFile()) return;

      if (stat.size === lastSize) {
        if (!stableSince) stableSince = Date.now();
        if (Date.now() - stableSince >= 3000) {
          // 3s stable -> treat as complete file and enqueue once.
          clearInterval(timer);
          this.ingestTrackers.delete(trackerKey);
          await this.enqueueIncomingSelfie(filePath);
        }
      } else {
        lastSize = stat.size;
        stableSince = null;
      }
    }, 1000);

    this.ingestTrackers.set(trackerKey, timer);
  };

  // ---------- Runtime/current slot watchers ----------
  StateManager.prototype.startCurrentBackgroundWatchers = function startCurrentBackgroundWatchers() {
    for (const w of this.currentWatchers) {
      try {
        w.close();
      } catch (err) {
        this.logger.warn("watcher", "Failed closing previous slot watcher", { error: err.message }).catch(() => {});
      }
    }
    this.currentWatchers = [];

    for (const slotId of SLOT_IDS) {
      const dir = this.getSlotRuntimeDir(slotId);
      try {
        const watcher = fs.watch(dir, (eventType, filename) => {
          if (filename && filename.toLowerCase() === "background.png") {
            this.emitState();
          }
        });
        this.currentWatchers.push(watcher);
      } catch (err) {
        this.logger.warn("watcher", "Failed to start slot background watcher", {
          slot: slotId,
          path: dir,
          error: err.message
        }).catch(() => {});
      }
    }
  };

  StateManager.prototype.stopManualWatcher = function stopManualWatcher(uuid) {
    const watcher = this.manualWatchers.get(uuid);
    if (!watcher) return;
    try {
      watcher.close();
    } catch (err) {
      this.logger.warn("manual", "Failed to close manual folder watcher", {
        job_uuid: uuid,
        error: err.message
      }).catch(() => {});
    }
    this.manualWatchers.delete(uuid);
  };

  // ---------- Manual workspace watcher ----------
  StateManager.prototype.startManualWatcher = async function startManualWatcher(uuid, folder) {
    if (this.manualWatchers.has(uuid)) return;

    if (!(await fileExists(folder))) {
      await this.logger.warn("manual", "Manual workspace folder missing; watcher not started", {
        job_uuid: uuid,
        folder
      });
      return;
    }

    const refreshManual = async () => {
      const job = this.jobs.get(uuid);
      if (!job) return;
      let changed = false;
      const byGroup = {
        group1: [path.join(folder, "group1.png")],
        group2: [path.join(folder, "group2.png")]
      };
      for (const group of SLOT_GROUPS) {
        const candidates = byGroup[group];
        let expected = null;
        for (const p of candidates) {
          if (await fileExists(p)) {
            expected = p;
            break;
          }
        }
        if (!expected) continue;
        if (await fileExists(expected)) {
          const stat = await fs.promises.stat(expected);
          const existing = job.manual?.candidates?.[group];
          if (!existing || existing.mtime_ms !== stat.mtimeMs) {
            job.manual.candidates[group] = {
              path: expected,
              created_at: nowIso(),
              mtime_ms: stat.mtimeMs,
              type: "manual"
            };
            changed = true;
            await this.logger.info("manual", "Manual candidate detected/updated", { job_uuid: uuid, group, path: expected });
          }
        }
      }
      if (changed) {
        if (![JOB_STATES.ACCEPTED_BOTH, JOB_STATES.DELIVERED].includes(job.state)) job.state = JOB_STATES.AWAITING_REVIEW;
        await saveJob(job);
        this.emitState();
      }
    };

    try {
      const watcher = fs.watch(folder, () => refreshManual().catch((err) => {
        this.logger.warn("manual", "Manual workspace refresh failed after file event", {
          job_uuid: uuid,
          folder,
          error: err.message
        }).catch(() => {});
      }));
      this.manualWatchers.set(uuid, watcher);
      await refreshManual();
    } catch (err) {
      await this.logger.warn("manual", "Failed to start manual folder watcher", {
        job_uuid: uuid,
        folder,
        error: err.message
      });
    }
  };

}

module.exports = { installStateManagerWatcherMethods };
