const path = require("path");
const { SLOT_GROUPS, MODELS, JOB_STATES } = require("./constants");
const { PATHS } = require("./paths");
const { ensureDir, fileExists, nowIso } = require("./fsutils");
const { saveJob } = require("./jobStore");
const { probeImageResolution } = require("./media");
const { generateWithRetry } = require("./gemini");

// Queue generation engine (slot assignment, model calls, auto-accept/export hooks).
function installStateManagerQueueGenerationMethods(StateManager) {
  StateManager.prototype.runInitialGenerationForJob = async function runInitialGenerationForJob(uuid) {
    const job = this.jobs.get(uuid);
    if (!job) throw new Error(`Job ${uuid} not found`);

    let halted = false;
    let shouldAutoExport = false;

    try {
      await this.withJobLock(uuid, async () => {
        this.activeJobId = uuid;
        try {
          this.assignSelectedSlotsToJob(job);
        } catch (err) {
          job.error = { ts: nowIso(), message: err.message };
          await saveJob(job);
          await this.logger.warn("queue", "Queue paused: invalid slot group configuration", {
            reason: err.message
          });
          this.emitState();
          halted = true;
          return;
        }

        job.state = JOB_STATES.GENERATING;
        await saveJob(job);
        this.emitState();

        const tasks = [];
        if (this.groupNeedsCandidate(job, "group1")) tasks.push(this.generateForGroup(uuid, "group1"));
        if (this.groupNeedsCandidate(job, "group2")) tasks.push(this.generateForGroup(uuid, "group2"));
        // Run both groups together so latency per selfie stays low.
        await Promise.allSettled(tasks);

        let updated = this.jobs.get(uuid);
        if (!updated) return;

        if (this.config?.automation?.auto_accept_enabled && updated.state !== JOB_STATES.BLOCKED) {
          for (const group of SLOT_GROUPS) {
            if (updated.accepted?.[group]) continue;
            const latestGenerated = this.getLatestGeneratedCandidate(updated, group);
            if (!latestGenerated?.path) continue;
            try {
              await this.acceptCandidate(uuid, group, latestGenerated.path, "genai", {
                skipLock: true,
                suppressAutoExport: true
              });
              updated = this.jobs.get(uuid) || updated;
            } catch (err) {
              await this.logger.error("queue", "Auto-accept failed", {
                job_uuid: uuid,
                group,
                error: err.message
              });
            }
          }
        }

        updated = this.jobs.get(uuid);
        if (!updated) return;

        if (updated.state !== JOB_STATES.BLOCKED) {
          const hasAcceptedG1 = !!updated.accepted?.group1;
          const hasAcceptedG2 = !!updated.accepted?.group2;
          const hasG1 = this.hasAnyCandidate(updated, "group1") || hasAcceptedG1;
          const hasG2 = this.hasAnyCandidate(updated, "group2") || hasAcceptedG2;
          if (hasAcceptedG1 && hasAcceptedG2) {
            updated.state = JOB_STATES.ACCEPTED_BOTH;
            updated.export = updated.export || this.createDefaultExportState();
            if (updated.export.status === "NOT_READY") updated.export.status = "READY";
          } else if (hasAcceptedG1 || hasAcceptedG2) {
            updated.state = JOB_STATES.ACCEPTED_PARTIAL;
            updated.export = updated.export || this.createDefaultExportState();
            if (updated.export.status === "READY") updated.export.status = "NOT_READY";
          } else {
            updated.state = hasG1 || hasG2 ? JOB_STATES.AWAITING_REVIEW : JOB_STATES.FAILED;
          }
          await saveJob(updated);
          this.emitState();
        }

        shouldAutoExport = !!(
          this.config?.automation?.auto_export_enabled &&
          updated?.accepted?.group1 &&
          updated?.accepted?.group2 &&
          !["PENDING", "DONE"].includes(updated?.export?.status || "NOT_READY")
        );
      });
    } finally {
      if (this.activeJobId === uuid) this.activeJobId = null;
    }

    if (shouldAutoExport) {
      this.generateOutgoingMedia(uuid).catch((err) => {
        this.logger.error("ffmpeg", `Auto export failed: ${err.message}`, { job_uuid: uuid }).catch(() => {});
      });
    }

    return { halted };
  };

  StateManager.prototype.getDefaultTemplatePath = function getDefaultTemplatePath(slotId) {
    return path.join(this.getSlotDefaultsDir(slotId), "background.png");
  };

  StateManager.prototype.assignSelectedSlotsToJob = function assignSelectedSlotsToJob(job) {
    if (job.selected_slots?.group1 && job.selected_slots?.group2) return;
    const pair = this.getNextSlotPair();
    job.selected_slots = pair;
    job.state = JOB_STATES.SLOTTED;
    job.error = null;
  };

  StateManager.prototype.generateForGroup = async function generateForGroup(uuid, group) {
    const job = this.jobs.get(uuid);
    if (!job) throw new Error(`Job ${uuid} not found`);

    const slot = job.selected_slots[group];
    const promptText = this.buildPrompt(slot);
    const templatePath = this.getDefaultTemplatePath(slot);

    if (!(await fileExists(templatePath))) {
      const msg = `Missing default template background for ${slot}: ${templatePath}`;
      job.error = { ts: nowIso(), message: msg };
      job.state = JOB_STATES.FAILED;
      await saveJob(job);
      await this.logger.error("gemini", msg, { job_uuid: uuid, group, slot });
      this.emitState();
      return;
    }

    const outDir = path.join(PATHS.RUNTIME_GENAI_RESULTS, uuid);
    await ensureDir(outDir);
    const version = (job.candidates[group]?.length || 0) + 1;

    try {
      const result = await generateWithRetry({
        apiKey: this.apiKey,
        selectedModel: this.config.selected_model,
        allowFallbackModel: this.config.model_fallback_enabled !== false,
        primaryModel: MODELS[0],
        backupModel: MODELS[1],
        promptText,
        templatePath,
        selfiePath: job.selfie_path,
        outputDir: outDir,
        outputPrefix: `${group}_${slot}_v${version}`,
        logger: this.logger,
        jobUuid: uuid,
        gallery: group,
        slot
      });

      let srcRes = null;
      if (this.mediaTools.ffprobe) {
        try {
          srcRes = await probeImageResolution(result.filePath);
        } catch (err) {
          await this.logger.warn("normalize", "Could not probe generated image resolution", {
            job_uuid: uuid,
            group,
            slot,
            path: result.filePath,
            error: err.message
          });
        }
      }

      await this.logger.info("normalize", "Raw GenAI image saved", {
        job_uuid: uuid,
        gallery: group,
        slot,
        path: result.filePath,
        mime: result.mime,
        source_resolution: srcRes || null
      });

      job.candidates[group].push({
        id: `v${version}`,
        path: result.filePath,
        type: "genai",
        model: result.model,
        mime: result.mime,
        created_at: nowIso(),
        source_resolution: srcRes
      });

      job.model_used_current = result.model;
      job.attempts[group][result.model] = (job.attempts[group][result.model] || 0) + Number(result.attempt || 1);
      job.error = null;
      await saveJob(job);
      this.emitState();
    } catch (err) {
      job.error = { ts: nowIso(), group, message: err.message };
      if (err.blocked) {
        // Safety block is terminal for this job unless operator does manual flow.
        job.state = JOB_STATES.BLOCKED;
        await this.logger.error("gemini", "Job blocked by Gemini safety", { job_uuid: uuid, group, slot, error: err.message });
      } else {
        await this.logger.error("gemini", "Generation failed for slot", { job_uuid: uuid, group, slot, error: err.message });
      }
      await saveJob(job);
      this.emitState();
    }
  };

  StateManager.prototype.getLatestCandidate = function getLatestCandidate(job, group) {
    const manualCandidate = job.manual?.candidates?.[group];
    if (manualCandidate) return { ...manualCandidate, type: "manual", id: "manual" };
    const arr = job.candidates?.[group] || [];
    return arr.length ? arr[arr.length - 1] : null;
  };

  StateManager.prototype.regenerateSlot = async function regenerateSlot(uuid, group) {
    const job = this.jobs.get(uuid);
    if (!job) throw new Error(`Job ${uuid} not found`);
    let shouldAutoExport = false;
    await this.withJobLock(uuid, async () => {
      if (!job.selected_slots?.group1 || !job.selected_slots?.group2) {
        this.assignSelectedSlotsToJob(job);
      }
      job.state = JOB_STATES.GENERATING;
      await saveJob(job);
      this.emitState();
      await this.generateForGroup(uuid, group);
      let updated = this.jobs.get(uuid);
      if (!updated) return;
      if (this.config?.automation?.auto_accept_enabled && updated.state !== JOB_STATES.BLOCKED) {
        const latestGenerated = this.getLatestGeneratedCandidate(updated, group);
        if (latestGenerated?.path && !updated.accepted?.[group]) {
          await this.acceptCandidate(uuid, group, latestGenerated.path, "genai", {
            skipLock: true,
            suppressAutoExport: true
          });
          updated = this.jobs.get(uuid) || updated;
        }
      }
      if (updated.state !== JOB_STATES.BLOCKED) {
        if (updated.accepted?.group1 && updated.accepted?.group2) {
          updated.state = JOB_STATES.ACCEPTED_BOTH;
          updated.export = updated.export || this.createDefaultExportState();
          if (updated.export.status === "NOT_READY") updated.export.status = "READY";
        } else if (updated.accepted?.group1 || updated.accepted?.group2) {
          updated.state = JOB_STATES.ACCEPTED_PARTIAL;
          updated.export = updated.export || this.createDefaultExportState();
          if (updated.export.status === "READY") updated.export.status = "NOT_READY";
        } else {
          updated.state = JOB_STATES.AWAITING_REVIEW;
        }
      }
      await saveJob(updated);
      this.emitState();
      shouldAutoExport = !!(
        this.config?.automation?.auto_export_enabled &&
        updated?.accepted?.group1 &&
        updated?.accepted?.group2 &&
        !["PENDING", "DONE"].includes(updated?.export?.status || "NOT_READY")
      );
    });
    if (shouldAutoExport) {
      this.generateOutgoingMedia(uuid).catch((err) => {
        this.logger.error("ffmpeg", `Auto export failed: ${err.message}`, { job_uuid: uuid }).catch(() => {});
      });
    }
  };
}

module.exports = { installStateManagerQueueGenerationMethods };
