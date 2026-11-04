(function operatorQueueRenderBootstrap(global) {
  const { bindAsyncButtons } = global.OperatorDom;

  // Queue rendering + job card actions. This is the busiest UI block by far.
  function createOperatorQueueRenderer(ctx) {
    const {
      state,
      els,
      JOBS_PER_PAGE,
      api,
      candidateUrl,
      latestCandidate,
      jobNeedsApiGeneration,
      jobStatusUi,
      setSelfiePreviewOpen,
      clearQuickDeleteArm,
      armQuickDelete,
      isQuickDeleteArmed
    } = ctx;

    function bindSelfieLongPressHandlers() {
      const HOLD_MS = 350;
      const MOVE_CANCEL_PX = 8;
      // Long-press opens preview. Click should still just toggle card as normal.
      els.jobList.querySelectorAll(".selfie-thumb[data-selfie-url]").forEach((thumb) => {
        let holdTimer = null;
        let startX = 0;
        let startY = 0;
        let longPressOpened = false;

        const clearHold = () => {
          if (!holdTimer) return;
          clearTimeout(holdTimer);
          holdTimer = null;
        };

        thumb.onpointerdown = (ev) => {
          longPressOpened = false;
          startX = ev.clientX;
          startY = ev.clientY;
          clearHold();
          holdTimer = setTimeout(() => {
            holdTimer = null;
            longPressOpened = true;
            setSelfiePreviewOpen(true, thumb.dataset.selfieUrl || "");
          }, HOLD_MS);
        };

        thumb.onpointermove = (ev) => {
          if (!holdTimer) return;
          if (Math.abs(ev.clientX - startX) > MOVE_CANCEL_PX || Math.abs(ev.clientY - startY) > MOVE_CANCEL_PX) {
            clearHold();
          }
        };

        thumb.onpointerup = () => clearHold();
        thumb.onpointercancel = () => clearHold();
        thumb.onpointerleave = () => clearHold();
        thumb.oncontextmenu = (ev) => ev.preventDefault();
        thumb.onclick = (ev) => {
          if (!longPressOpened) return;
          ev.preventDefault();
          ev.stopPropagation();
          longPressOpened = false;
        };
      });
    }

    function renderGroupAction(job, group) {
      const slot = job.selected_slots?.[group];
      const candidate = latestCandidate(job, group);
      const candidatePath = candidate?.path || "";
      const img = candidate
        ? `<div class="aspect-square w-full overflow-hidden rounded border border-slate-700"><img src="${candidateUrl(candidate)}" class="h-full w-full object-cover" /></div>`
        : `<div class="aspect-square w-full rounded border border-slate-700 bg-slate-900 p-2 text-xs text-slate-500">No candidate yet</div>`;

      return `<div class="rounded border border-slate-700 p-2">
        <div class="mb-2 text-sm font-semibold">${group.toUpperCase()} -> ${slot || "unassigned"}</div>
        ${img}
        <div class="mt-2 text-xs text-slate-400">Latest: ${candidate?.id || "n/a"} (${candidate?.type || "none"})</div>
        <div class="mt-2 flex flex-wrap gap-2">
          <button class="btn-primary accept-btn" data-uuid="${job.uuid}" data-group="${group}" data-path="${candidatePath}" data-type="${candidate?.type || "genai"}">Accept</button>
          <button class="btn-ghost regen-btn" data-uuid="${job.uuid}" data-group="${group}">Regenerate</button>
        </div>
      </div>`;
    }

    function renderJobSettings(job) {
      const manualDir = job.manual?.folder || "";
      const canExport = !!(job.accepted?.group1 && job.accepted?.group2);
      const exportStatus = job.export?.status || "NOT_READY";
      const autoApiEnabled = state.snapshot?.config?.automation?.auto_api_enabled !== false;
      const showSendToApi = !autoApiEnabled && jobNeedsApiGeneration(job);
      const err = job.error ? `<div class="rounded border border-red-500/40 bg-red-900/20 p-2 text-xs text-red-200">${job.error.message || ""}</div>` : "";
      return `
        <div class="mb-2 text-xs text-slate-400">UUID: ${job.uuid}</div>
        <div class="text-xs text-slate-400">Export: <span class="font-semibold text-slate-200">${exportStatus}</span></div>
        ${err}
        <div class="mt-2 grid grid-cols-1 gap-2 md:grid-cols-2">
          ${renderGroupAction(job, "group1")}
          ${renderGroupAction(job, "group2")}
        </div>
        <div class="mt-2 grid grid-cols-1 gap-2 md:grid-cols-2">
          <div class="rounded border border-slate-700 p-2">
            <div class="mb-2 text-sm font-semibold">Manual Edit</div>
            <div class="text-xs text-slate-400 break-all">${manualDir || "not started"}</div>
            <div class="mt-2 flex flex-wrap gap-2">
              <button class="btn-ghost manual-start-btn" data-uuid="${job.uuid}">Create Manual Folder</button>
              <button class="btn-ghost manual-open-btn" data-uuid="${job.uuid}">Open Folder</button>
            </div>
          </div>
          <div class="rounded border border-slate-700 p-2">
            <div class="mb-2 text-sm font-semibold">Job Actions</div>
            ${showSendToApi ? `<div class="mb-2"><button class="btn-ghost job-send-api-btn w-full" data-uuid="${job.uuid}">Send To API</button></div>` : ""}
            <div class="mb-2">
              <button class="btn-primary job-export-btn w-full ${canExport ? "" : "opacity-50 cursor-not-allowed"}" data-uuid="${job.uuid}" ${canExport ? "" : "disabled"}>Export MP4s</button>
            </div>
            <button class="btn-primary job-delete-btn w-full" data-uuid="${job.uuid}">Delete Job</button>
          </div>
        </div>`;
    }

    function renderJobs() {
      const jobs = state.snapshot.jobs || [];
      if (!jobs.length) {
        const msg = "No jobs yet.";
        els.jobList.innerHTML = `<div class="rounded border border-slate-700 p-2 text-xs text-slate-400">${msg}</div>`;
        if (els.jobPagination) els.jobPagination.innerHTML = "";
        state.expandedJobUuid = null;
        state.jobPage = 1;
        Object.keys(state.quickDeleteArmedUntilByUuid || {}).forEach((uuid) => clearQuickDeleteArm(uuid));
        return;
      }

      const validUuidSet = new Set(jobs.map((j) => j.uuid));
      Object.keys(state.quickDeleteArmedUntilByUuid || {}).forEach((uuid) => {
        if (!validUuidSet.has(uuid) || !isQuickDeleteArmed(uuid)) {
          clearQuickDeleteArm(uuid);
        }
      });

      if (state.expandedJobUuid && !jobs.find((j) => j.uuid === state.expandedJobUuid)) {
        state.expandedJobUuid = null;
      }

      const totalPages = Math.max(1, Math.ceil(jobs.length / JOBS_PER_PAGE));
      if (!Number.isFinite(state.jobPage) || state.jobPage < 1) state.jobPage = 1;
      if (state.jobPage > totalPages) state.jobPage = totalPages;
      const startIndex = (state.jobPage - 1) * JOBS_PER_PAGE;
      const pageJobs = jobs.slice(startIndex, startIndex + JOBS_PER_PAGE);

      els.jobList.innerHTML = pageJobs
        .map((j) => {
          const statusUi = jobStatusUi(j.state);
          const expanded = j.uuid === state.expandedJobUuid;
          const deleteArmed = isQuickDeleteArmed(j.uuid);
          const headerClass = expanded
            ? `border-amber-300 bg-slate-700/70`
            : `${statusUi.border} bg-slate-800`;
          const selfieVersion = j.selfie_mtime_ms || j.created_at || Date.now();
          const selfieUrl = j.selfie_preview_url ? `${j.selfie_preview_url}?v=${encodeURIComponent(String(selfieVersion))}` : "";
          const selfiePreview = selfieUrl
            ? `<img src="${selfieUrl}" class="h-full w-full object-cover" />`
            : `<div class="flex h-full w-full items-center justify-center bg-slate-900 text-[10px] text-slate-500">No selfie</div>`;
          const selfieDataAttr = selfieUrl ? ` data-selfie-url="${selfieUrl}"` : "";
          const quickDeleteControls = deleteArmed
            ? `<div class="flex items-center gap-1">
                <button class="btn-primary !px-2 !py-1 text-[11px] job-quick-delete-confirm" data-uuid="${j.uuid}">Delete</button>
                <button class="btn-ghost !px-2 !py-1 text-[11px] job-quick-delete-cancel" data-uuid="${j.uuid}">Cancel</button>
              </div>`
            : `<button class="btn-ghost !px-2 !py-1 text-[11px] job-quick-delete" data-uuid="${j.uuid}">Delete</button>`;
          return `<div class="rounded border ${headerClass}">
            <div class="flex w-full items-center gap-2 p-2">
              <button data-job-toggle="${j.uuid}" class="flex min-w-0 flex-1 items-center gap-3 text-left">
                <div class="selfie-thumb h-14 w-14 shrink-0 overflow-hidden rounded border border-slate-700"${selfieDataAttr}>${selfiePreview}</div>
                <div class="min-w-0 flex-1 text-xs">
                  <div class="truncate font-semibold">${j.uuid}</div>
                  <div><span class="inline-flex items-center rounded border px-2 py-0.5 text-[11px] font-medium ${statusUi.badge}">${j.state}</span></div>
                  <div class="text-[11px] text-slate-400">${new Date(j.created_at).toLocaleString()}</div>
                </div>
                <div class="text-[11px] text-slate-300">${expanded ? "Hide" : "Show"}</div>
              </button>
              <div class="shrink-0">${quickDeleteControls}</div>
            </div>
            <div class="${expanded ? "block" : "hidden"} border-t border-slate-700 p-2">
              ${expanded ? renderJobSettings(j) : ""}
            </div>
          </div>`;
        })
        .join("");

      if (els.jobPagination) {
        const from = startIndex + 1;
        const to = Math.min(startIndex + JOBS_PER_PAGE, jobs.length);
        const prevDisabled = state.jobPage <= 1;
        const nextDisabled = state.jobPage >= totalPages;
        els.jobPagination.innerHTML = `
          <div>Showing ${from}-${to} of ${jobs.length}</div>
          <div class="flex items-center gap-2">
            <button class="btn-ghost !px-2 !py-1 ${prevDisabled ? "opacity-50 cursor-not-allowed" : ""}" data-page-action="prev" ${prevDisabled ? "disabled" : ""}>Prev</button>
            <span>Page ${state.jobPage} / ${totalPages}</span>
            <button class="btn-ghost !px-2 !py-1 ${nextDisabled ? "opacity-50 cursor-not-allowed" : ""}" data-page-action="next" ${nextDisabled ? "disabled" : ""}>Next</button>
          </div>
        `;
        els.jobPagination.querySelectorAll("[data-page-action]").forEach((btn) => {
          btn.onclick = () => {
            if (btn.dataset.pageAction === "prev" && state.jobPage > 1) state.jobPage -= 1;
            if (btn.dataset.pageAction === "next" && state.jobPage < totalPages) state.jobPage += 1;
            renderJobs();
          };
        });
      }

      els.jobList.querySelectorAll("[data-job-toggle]").forEach((b) => {
        b.onclick = () => {
          state.expandedJobUuid = state.expandedJobUuid === b.dataset.jobToggle ? null : b.dataset.jobToggle;
          renderJobs();
        };
      });

      els.jobList.querySelectorAll(".job-quick-delete").forEach((btn) => {
        btn.onclick = (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          armQuickDelete(btn.dataset.uuid, 3000);
          renderJobs();
        };
      });

      els.jobList.querySelectorAll(".job-quick-delete-cancel").forEach((btn) => {
        btn.onclick = (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          clearQuickDeleteArm(btn.dataset.uuid);
          renderJobs();
        };
      });

      bindAsyncButtons(els.jobList, ".job-quick-delete-confirm", async (btn, ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const uuid = btn.dataset.uuid;
        clearQuickDeleteArm(uuid);
        await api(`/api/jobs/${uuid}`, "DELETE", { remove_artifacts: true });
      });

      bindSelfieLongPressHandlers();

      bindAsyncButtons(els.jobList, ".accept-btn", (btn) =>
        api(`/api/jobs/${btn.dataset.uuid}/accept`, "POST", {
          group: btn.dataset.group,
          path: btn.dataset.path || null,
          type: btn.dataset.type || "genai"
        })
      );
      bindAsyncButtons(els.jobList, ".regen-btn", (btn) =>
        api(`/api/jobs/${btn.dataset.uuid}/regenerate`, "POST", { group: btn.dataset.group })
      );
      bindAsyncButtons(els.jobList, ".manual-start-btn", (btn) =>
        api(`/api/jobs/${btn.dataset.uuid}/manual-start`, "POST", {})
      );
      bindAsyncButtons(els.jobList, ".manual-open-btn", (btn) =>
        api(`/api/jobs/${btn.dataset.uuid}/open-manual-folder`, "POST", {})
      );
      bindAsyncButtons(els.jobList, ".job-send-api-btn", (btn) =>
        api(`/api/jobs/${btn.dataset.uuid}/send`, "POST", {})
      );
      bindAsyncButtons(els.jobList, ".job-export-btn", (btn) =>
        api(`/api/jobs/${btn.dataset.uuid}/retry-export`, "POST", {})
      );
      bindAsyncButtons(els.jobList, ".job-delete-btn", async (btn) => {
        if (!confirm(`Delete job ${btn.dataset.uuid} and related artifacts? This cannot be undone.`)) return;
        await api(`/api/jobs/${btn.dataset.uuid}`, "DELETE", { remove_artifacts: true });
      });
    }

    return { renderJobs };
  }

  global.createOperatorQueueRenderer = createOperatorQueueRenderer;
})(window);
