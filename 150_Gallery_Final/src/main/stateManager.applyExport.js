const fs = require("fs");
const path = require("path");
const { SLOT_IDS, JOB_STATES } = require("./constants");
const { PATHS } = require("./paths");
const { ensureDir, fileExists, atomicWriteJson, atomicWriteFile, nowIso } = require("./fsutils");
const { saveJob } = require("./jobStore");
const { probeImageResolution, normalizeImageToPng, generateCompositeImage } = require("./media");

// Accept/apply/export logic. This is intentionally chunky but grouped in sections.
function installStateManagerApplyExportMethods(StateManager) {
  // ---------- Slot apply helpers ----------
  StateManager.prototype.normalizeAndApplyToSlot = async function normalizeAndApplyToSlot({ inputPath, slotId, jobUuid = null }) {
    const outputPath = path.join(this.getSlotRuntimeDir(slotId), "background.png");
    await ensureDir(path.dirname(outputPath));

    let srcRes = null;
    if (this.mediaTools.ffprobe) {
      try {
        srcRes = await probeImageResolution(inputPath);
      } catch (err) {
        await this.logger.warn("apply", "Could not probe input image resolution before apply", {
          job_uuid: jobUuid,
          slot: slotId,
          input: inputPath,
          error: err.message
        });
      }
    }

    await this.logger.info("apply", "Applying selected background without resize normalization", {
      job_uuid: jobUuid,
      slot: slotId,
      input: inputPath,
      source_resolution: srcRes
    });

    const ext = path.extname(inputPath).toLowerCase();
    if (ext === ".png") {
      // Fast path: preserve png bytes exactly and swap atomically.
      const tmpPath = path.join(path.dirname(outputPath), "background.tmp.png");
      await fs.promises.copyFile(inputPath, tmpPath);
      try {
        await fs.promises.unlink(outputPath);
      } catch (err) {
        if (err?.code !== "ENOENT") {
          await this.logger.warn("apply", "Failed removing previous background before atomic swap", {
            job_uuid: jobUuid,
            slot: slotId,
            path: outputPath,
            error: err.message
          });
        }
      }
      await fs.promises.rename(tmpPath, outputPath);
    } else {
      if (!this.mediaTools.ffmpeg) {
        throw new Error("ffmpeg is required to convert non-PNG inputs to background.png");
      }
      // Non-png candidates are normalized to background.png for runtime consistency.
      await normalizeImageToPng({
        inputPath,
        outputFinalPath: outputPath
      });
    }

    await this.logger.info("apply", "Applied background.png", {
      job_uuid: jobUuid,
      slot: slotId,
      output: outputPath
    });
    this.emitState();
    return outputPath;
  };

  // ---------- Accepted history helpers ----------
  StateManager.prototype.ensureAcceptedMeta = async function ensureAcceptedMeta(job) {
    const acceptedDir = path.join(PATHS.RUNTIME_ACCEPTED, job.uuid);
    await ensureDir(acceptedDir);
    const metaPath = path.join(acceptedDir, "meta.json");
    await atomicWriteJson(metaPath, {
      uuid: job.uuid,
      created_at: job.created_at,
      selected_slots: job.selected_slots,
      accepted: job.accepted,
      state: job.state,
      selfie_path: job.selfie_path,
      export: job.export,
      updated_at: nowIso()
    });
  };

  // ---------- Accept / export flow ----------
  StateManager.prototype.acceptCandidate = async function acceptCandidate(uuid, group, candidatePath, candidateType = "genai", options = {}) {
    const job = this.jobs.get(uuid);
    if (!job) throw new Error(`Job ${uuid} not found`);

    const slotId = job.selected_slots[group];
    if (!slotId) throw new Error(`No slot assigned for ${group}`);

    let chosenPath = candidatePath;
    if (!chosenPath) {
      const latest = this.getLatestCandidate(job, group);
      if (!latest) throw new Error(`No candidate available for ${group}`);
      chosenPath = latest.path;
      candidateType = latest.type || candidateType;
    }
    if (!(await fileExists(chosenPath))) throw new Error(`Candidate file does not exist: ${chosenPath}`);

    let shouldAutoExport = false;
    const applyAcceptance = async () => {
      const normalizedPath = await this.normalizeAndApplyToSlot({ inputPath: chosenPath, slotId, jobUuid: uuid });
      const acceptedDir = path.join(PATHS.RUNTIME_ACCEPTED, uuid);
      await ensureDir(acceptedDir);
      const acceptedCopy = path.join(acceptedDir, `${group}_${slotId}.png`);
      await fs.promises.copyFile(normalizedPath, acceptedCopy);

      job.accepted[group] = {
        slot: slotId,
        source_path: chosenPath,
        normalized_path: normalizedPath,
        accepted_copy_path: acceptedCopy,
        type: candidateType,
        accepted_at: nowIso()
      };

      if (!job.export) job.export = this.createDefaultExportState();

      if (job.accepted.group1 && job.accepted.group2) {
        job.state = JOB_STATES.ACCEPTED_BOTH;
        job.export.status = "READY";
      } else {
        job.state = JOB_STATES.ACCEPTED_PARTIAL;
        job.export.status = "NOT_READY";
      }

      job.error = null;
      await saveJob(job);
      await this.ensureAcceptedMeta(job);
      this.emitState();
      shouldAutoExport = !!(
        !options.suppressAutoExport &&
        this.config?.automation?.auto_export_enabled &&
        job.accepted.group1 &&
        job.accepted.group2 &&
        !["PENDING", "DONE"].includes(job.export?.status || "NOT_READY")
      );
    };

    if (options.skipLock) {
      await applyAcceptance();
    } else {
      await this.withJobLock(uuid, applyAcceptance);
    }

    if (!options.skipLock && shouldAutoExport) {
      this.generateOutgoingMedia(uuid).catch((err) => {
        this.logger.error("ffmpeg", `Auto export failed: ${err.message}`, { job_uuid: uuid }).catch(() => {});
      });
    }

    await this.scheduleAutoRevertForSlot(slotId, {
      job_uuid: uuid,
      group,
      source: candidateType
    });
  };

  StateManager.prototype.generateOutgoingMedia = async function generateOutgoingMedia(uuid) {
    const job = this.jobs.get(uuid);
    if (!job) throw new Error(`Job ${uuid} not found`);
    if (!job.accepted.group1 || !job.accepted.group2) {
      throw new Error("Both gallery outputs must be accepted before export");
    }

    await this.withJobLock(uuid, async () => {
      if (!job.export) job.export = this.createDefaultExportState();
      job.export.status = "PENDING";
      await saveJob(job);
      this.emitState();
      if (!this.mediaTools.ffmpeg || !this.mediaTools.ffprobe) {
        job.export.status = "FAILED";
        job.error = { ts: nowIso(), message: "ffmpeg/ffprobe not available. Image export failed." };
        await saveJob(job);
        await this.ensureAcceptedMeta(job);
        this.emitState();
        return;
      }

      const outBaseDir = path.join(this.getOutgoingDirAbs(), uuid);
      await ensureDir(outBaseDir);

      try {
        const g1bg = job.accepted.group1.accepted_copy_path;
        const g2bg = job.accepted.group2.accepted_copy_path;
        const overlayPath = PATHS.MP4_OVERLAY;
        if (!(await fileExists(g1bg))) throw new Error(`Accepted background missing: ${g1bg}`);
        if (!(await fileExists(g2bg))) throw new Error(`Accepted background missing: ${g2bg}`);
        if (!(await fileExists(overlayPath))) {
          throw new Error(`Overlay not found: ${overlayPath}`);
        }

        // Each export keeps its background's OWN native resolution, so backgrounds
        // of any size/aspect ratio export correctly. The overlay is cover-fitted.
        const r1 = await probeImageResolution(g1bg);
        const r2 = await probeImageResolution(g2bg);

        const png1 = path.join(outBaseDir, `${uuid}_1.png`);
        const png2 = path.join(outBaseDir, `${uuid}_2.png`);

        // Use accepted copies + static overlay so export mirrors gallery pairing.
        await this.logger.info("ffmpeg", "Generating image 1", { job_uuid: uuid, output: png1, overlay: overlayPath, width: r1.width, height: r1.height });
        await generateCompositeImage({
          backgroundPath: g1bg,
          overlayPath,
          outputImagePath: png1,
          width: r1.width,
          height: r1.height
        });
        await this.logger.info("ffmpeg", "Generating image 2", { job_uuid: uuid, output: png2, overlay: overlayPath, width: r2.width, height: r2.height });
        await generateCompositeImage({
          backgroundPath: g2bg,
          overlayPath,
          outputImagePath: png2,
          width: r2.width,
          height: r2.height
        });

        job.export = { status: "DONE", output_dir: outBaseDir, files: [png1, png2], generated_at: nowIso(), format: "png" };
        job.state = JOB_STATES.DELIVERED;
        job.error = null;
        await saveJob(job);
        await this.ensureAcceptedMeta(job);
        this.emitState();
      } catch (err) {
        job.export.status = "FAILED";
        job.export.format = "png";
        job.error = { ts: nowIso(), message: err.message };
        await this.logger.error("ffmpeg", `Image export failed: ${err.message}`, { job_uuid: uuid });
        await saveJob(job);
        await this.ensureAcceptedMeta(job);
        this.emitState();
      }
    });
  };

  StateManager.prototype.retryExport = async function retryExport(uuid) {
    await this.generateOutgoingMedia(uuid);
  };

  // ---------- Cleanup actions ----------
  StateManager.prototype.deleteJob = async function deleteJob(uuid, options = {}) {
    if (this.jobLocks.has(uuid)) throw new Error(`Job ${uuid} is busy`);

    const removeArtifacts = options.removeArtifacts !== false;
    const jobFile = path.join(PATHS.RUNTIME_JOBS, `${uuid}.json`);
    const artifacts = [
      path.join(PATHS.RUNTIME_GENAI_RESULTS, uuid),
      path.join(PATHS.RUNTIME_MANUAL, uuid),
      path.join(PATHS.RUNTIME_ACCEPTED, uuid),
      path.join(this.getOutgoingDirAbs(), uuid)
    ];

    this.stopManualWatcher(uuid);
    this.jobs.delete(uuid);
    this.autoGenerationPaused.delete(uuid);

    try {
      await fs.promises.unlink(jobFile);
    } catch (err) {
      if (err?.code !== "ENOENT") {
        await this.logger.warn("queue", "Could not delete job file while deleting job", {
          job_uuid: uuid,
          path: jobFile,
          error: err.message
        });
      }
    }

    if (removeArtifacts) {
      for (const artifactPath of artifacts) {
        try {
          await fs.promises.rm(artifactPath, { recursive: true, force: true });
        } catch (err) {
          await this.logger.warn("queue", "Could not delete one artifact path during job delete", {
            job_uuid: uuid,
            path: artifactPath,
            error: err.message
          });
        }
      }
    }

    await this.logger.info("queue", "Job deleted", { job_uuid: uuid, remove_artifacts: removeArtifacts });
    this.emitState();
  };

  StateManager.prototype.deleteHistoryEntry = async function deleteHistoryEntry(uuid, options = {}) {
    const removeOutgoing = options.removeOutgoing !== false;
    const acceptedDir = path.join(PATHS.RUNTIME_ACCEPTED, uuid);
    const outgoingDir = path.join(this.getOutgoingDirAbs(), uuid);

    try {
      await fs.promises.rm(acceptedDir, { recursive: true, force: true });
    } catch (err) {
      await this.logger.warn("history", "Could not delete accepted history folder", {
        job_uuid: uuid,
        path: acceptedDir,
        error: err.message
      });
    }

    if (removeOutgoing) {
      try {
        await fs.promises.rm(outgoingDir, { recursive: true, force: true });
      } catch (err) {
        await this.logger.warn("history", "Could not delete outgoing export folder", {
          job_uuid: uuid,
          path: outgoingDir,
          error: err.message
        });
      }
    }

    const job = this.jobs.get(uuid);
    if (job && !this.jobLocks.has(uuid)) {
      job.accepted = { group1: null, group2: null };
      job.export = this.createDefaultExportState();
      const hasAnyCandidates = this.hasAnyCandidate(job, "group1") || this.hasAnyCandidate(job, "group2");
      job.state = hasAnyCandidates ? JOB_STATES.AWAITING_REVIEW : JOB_STATES.FAILED;
      await saveJob(job);
    }

    await this.logger.info("history", "Accepted history entry deleted", {
      job_uuid: uuid,
      remove_outgoing: removeOutgoing
    });
    this.emitState();
  };

  StateManager.prototype.revertSlotToDefault = async function revertSlotToDefault(slotId, options = {}) {
    const defaultDir = this.getSlotDefaultsDir(slotId);
    const defaultBg = path.join(defaultDir, "background.png");
    if (!(await fileExists(defaultBg))) throw new Error(`Default background missing: ${defaultBg}`);

    await this.normalizeAndApplyToSlot({ inputPath: defaultBg, slotId });
    // Revert clears pending auto-revert deadline for this slot.
    await this.clearAutoRevertDeadline(slotId, { save: true });
    await this.logger.info("slots", "Slot reverted to defaults", { slot: slotId, reason: options.reason || "manual" });
    this.emitState();
  };

  StateManager.prototype.startManualEdit = async function startManualEdit(uuid) {
    const job = this.jobs.get(uuid);
    if (!job) throw new Error(`Job ${uuid} not found`);

    const manualDir = path.join(PATHS.RUNTIME_MANUAL, uuid);
    await ensureDir(manualDir);

    try {
      await fs.promises.copyFile(job.selfie_path, path.join(manualDir, "selfie_original.jpg"));
    } catch (err) {
      await this.logger.warn("manual", "Could not copy selfie into manual workspace", {
        job_uuid: uuid,
        source: job.selfie_path,
        error: err.message
      });
    }
    const originalName = path.basename(job.selfie_path);
    const readme = [
      "Manual Edit Workspace",
      "",
      `Job UUID: ${uuid}`,
      `Original selfie file: ${originalName}`,
      "",
      "Save outputs as:",
      "- group1.png",
      "- group2.png",
      "",
      "The app watches this folder and will auto-show these files as manual candidates.",
      "",
      "Tip: keep the framing similar to the slot template so compositing looks clean."
    ].join("\n");
    await atomicWriteFile(path.join(manualDir, "README.txt"), readme);

    job.manual = {
      ...(job.manual || {}),
      folder: manualDir,
      original_name: originalName,
      candidates: {
        group1: job.manual?.candidates?.group1 || null,
        group2: job.manual?.candidates?.group2 || null
      }
    };
    await saveJob(job);
    await this.startManualWatcher(uuid, manualDir);
    this.emitState();
    await this.logger.info("manual", "Manual workspace initialized", { job_uuid: uuid, folder: manualDir });
    return manualDir;
  };

}

module.exports = { installStateManagerApplyExportMethods };
