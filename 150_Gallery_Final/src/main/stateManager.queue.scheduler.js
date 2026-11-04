const fs = require("fs");
const path = require("path");
const { PATHS } = require("./paths");
const { ensureDir } = require("./fsutils");
const { saveJob } = require("./jobStore");

// Queue scheduler/plumbing around ingest, ordering, locking, and processing loop.
function installStateManagerQueueSchedulerMethods(StateManager) {
  StateManager.prototype.stageSelfieForJob = async function stageSelfieForJob(uuid, sourcePath) {
    try {
      const ext = path.extname(sourcePath).toLowerCase();
      const safeExt = [".jpg", ".jpeg", ".png", ".webp"].includes(ext) ? ext : ".jpg";
      await ensureDir(PATHS.RUNTIME_SELFIES);
      const targetPath = path.join(PATHS.RUNTIME_SELFIES, `${uuid}${safeExt}`);
      await fs.promises.copyFile(sourcePath, targetPath);
      return targetPath;
    } catch (err) {
      await this.logger.warn("ingest", "Failed to stage selfie in runtime/work/selfies; using source path directly", {
        job_uuid: uuid,
        path: sourcePath,
        error: err.message
      });
      return sourcePath;
    }
  };

  StateManager.prototype.getNextSlotPair = function getNextSlotPair() {
    const status = this.getGenerationGroupStatus();
    if (!status.valid) {
      throw new Error(status.reason || "Invalid slot group configuration");
    }
    const index = Number(this.config.group_cycle_index || 0) % status.slots.group1.length;
    const pair = {
      group1: status.slots.group1[index],
      group2: status.slots.group2[index]
    };
    // Persist cycle index so restart doesn't keep hammering same slot pair.
    this.config.group_cycle_index = (index + 1) % status.slots.group1.length;
    this.saveConfig().catch(() => {});
    return pair;
  };

  StateManager.prototype.maybeAutoProcessQueue = function maybeAutoProcessQueue() {
    if (this.config?.automation?.auto_api_enabled) {
      this.processQueue().catch(() => {});
    }
  };

  StateManager.prototype.enforceJobCapacity = async function enforceJobCapacity(maxJobs = 12, keepUuids = []) {
    const target = Number(maxJobs);
    if (!Number.isFinite(target) || target < 1) return;
    if (this.jobs.size <= target) return;

    const keep = new Set(Array.isArray(keepUuids) ? keepUuids : []);
    const oldestFirst = Array.from(this.jobs.values()).sort(
      (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    );

    for (const job of oldestFirst) {
      if (this.jobs.size <= target) break;
      if (!job?.uuid) continue;
      if (keep.has(job.uuid)) continue;
      if (this.activeJobId === job.uuid || this.jobLocks.has(job.uuid)) continue;

      try {
        await this.deleteJob(job.uuid, { removeArtifacts: true });
        await this.logger.warn("queue", "Job evicted due to max queue capacity", {
          job_uuid: job.uuid,
          max_jobs: target
        });
      } catch (err) {
        await this.logger.warn("queue", "Failed to evict job while enforcing queue capacity", {
          job_uuid: job.uuid,
          max_jobs: target,
          error: err.message
        });
      }
    }

    if (this.jobs.size > target) {
      await this.logger.warn("queue", "Queue capacity enforcement incomplete", {
        max_jobs: target,
        current_jobs: this.jobs.size
      });
    }
  };

  StateManager.prototype.enqueueIncomingSelfie = async function enqueueIncomingSelfie(selfiePath) {
    const ext = path.extname(selfiePath);
    const uuid = path.basename(selfiePath, ext);
    const stagedSelfiePath = await this.stageSelfieForJob(uuid, selfiePath);

    const job = this.buildEmptyJob(uuid, stagedSelfiePath, null);
    job.selfie_original_path = selfiePath;

    if (this.jobs.has(uuid)) {
      // Same filename/uuid means "replace current job" behavior by design.
      await this.logger.warn("queue", "Duplicate UUID detected. Replacing existing job.", { job_uuid: uuid });
    }

    this.jobs.set(uuid, job);
    // A replacement job starts fresh, even if the old one was parked after failures.
    this.autoGenerationPaused.delete(uuid);
    await saveJob(job);
    await this.enforceJobCapacity(12, [uuid]);

    await this.logger.info("queue", "Job enqueued from incoming selfie", {
      job_uuid: uuid,
      selfie_path: stagedSelfiePath,
      selfie_original_path: selfiePath
    });
    const groupStatus = this.getGenerationGroupStatus();
    if (!groupStatus.valid) {
      await this.logger.warn("queue", "Job queued but generation groups are invalid. Fix slot grouping to continue processing.", {
        job_uuid: uuid,
        reason: groupStatus.reason,
        counts: groupStatus.counts
      });
    }

    this.emitState();
    this.maybeAutoProcessQueue();
  };

  StateManager.prototype.getJobsSorted = function getJobsSorted() {
    return Array.from(this.jobs.values()).sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  };

  StateManager.prototype.withJobLock = async function withJobLock(uuid, fn) {
    if (this.jobLocks.has(uuid)) {
      throw new Error(`Job ${uuid} is busy`);
    }
    this.jobLocks.add(uuid);
    try {
      return await fn();
    } finally {
      this.jobLocks.delete(uuid);
    }
  };

  StateManager.prototype.processQueue = async function processQueue() {
    if (this.processing) return;
    // Single queue worker: avoids duplicate API sends for the same job.
    this.processing = true;
    try {
      while (true) {
        if (!this.config?.automation?.auto_api_enabled) break;
        const nextJob = this.getJobsSorted().find(
          (job) => !this.autoGenerationPaused.has(job.uuid) && this.jobNeedsInitialGeneration(job)
        );
        if (!nextJob) break;
        const { halted } = await this.runInitialGenerationForJob(nextJob.uuid);
        if (halted) break;
      }
    } catch (err) {
      await this.logger.error("queue", `Queue processing error: ${err.message}`);
    } finally {
      this.activeJobId = null;
      this.processing = false;
      this.emitState();
    }
  };

  StateManager.prototype.sendJobToApi = async function sendJobToApi(uuid) {
    const job = this.jobs.get(uuid);
    if (!job) throw new Error(`Job ${uuid} not found`);
    if (!this.jobNeedsInitialGeneration(job)) {
      throw new Error(`Job ${uuid} has no pending API generation work`);
    }
    const { halted } = await this.runInitialGenerationForJob(uuid);
    if (halted) {
      const updated = this.jobs.get(uuid);
      throw new Error(updated?.error?.message || "Invalid slot group configuration");
    }
  };
}

module.exports = { installStateManagerQueueSchedulerMethods };
