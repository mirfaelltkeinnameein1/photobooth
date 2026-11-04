(function operatorRenderBootstrap(global) {
  // Main renderer composition: glue queue/slots/history + config + logs.
  function createOperatorRenderer(ctx) {
    const {
      state,
      els,
      GALLERY_BACKGROUND_PALETTE_GROUPS,
      relToFileUrl
    } = ctx;

    const queueRenderer = global.createOperatorQueueRenderer(ctx);
    const slotsRenderer = global.createOperatorSlotsRenderer(ctx);
    const historyRenderer = global.createOperatorHistoryRenderer(ctx);

    function renderBackgroundPalette() {
      if (state.bgPaletteRendered || !els.bgPalette) return;
      els.bgPalette.innerHTML = GALLERY_BACKGROUND_PALETTE_GROUPS
        .map((group) => `
          <div class="mb-2 w-full">
            <div class="mb-1 text-[11px] uppercase text-slate-400">${group.label}</div>
            <div class="flex flex-wrap gap-1">
              ${group.colors
                .map((c) => `<button type="button" class="h-6 w-6 rounded border border-slate-500" data-bg-color="${c}" style="background:${c}" title="${c}"></button>`)
                .join("")}
            </div>
          </div>
        `)
        .join("");
      els.bgPalette.querySelectorAll("[data-bg-color]").forEach((btn) => {
        btn.onclick = () => {
          els.bgColorPicker.value = btn.dataset.bgColor;
        };
      });
      state.bgPaletteRendered = true;
    }

    function getSelectedBackgroundGallery() {
      return els.bgGallerySelect?.value === "gallery2" ? "gallery2" : "gallery1";
    }

    function renderBackgroundEditor() {
      renderBackgroundPalette();
      if (!state.snapshot?.config) return;
      const gallery = getSelectedBackgroundGallery();
      const bg = state.snapshot.config.gallery_backgrounds?.[gallery] || { type: "color", color: "#050b17", image_rel: "" };

      els.bgCurrentMode.textContent = `Current background ${bg.type === "image" ? "image" : "color"}`;
      if (bg.type === "image" && bg.image_rel) {
        const imageUrl = relToFileUrl(bg.image_rel, bg.image_mtime_ms || 0);
        els.bgCurrentPreview.style.backgroundImage = `url("${imageUrl}")`;
        els.bgCurrentPreview.style.backgroundSize = "cover";
        els.bgCurrentPreview.style.backgroundPosition = "center";
        els.bgCurrentPreview.style.backgroundColor = "transparent";
        els.bgCurrentValue.textContent = bg.image_rel;
      } else {
        const c = bg.color || "#050b17";
        els.bgCurrentPreview.style.backgroundImage = "none";
        els.bgCurrentPreview.style.backgroundColor = c;
        els.bgCurrentValue.textContent = c;
        if (/^#[0-9a-fA-F]{6}$/.test(c)) {
          els.bgColorPicker.value = c.toLowerCase();
        }
      }
    }

    function renderConfig() {
      const cfg = state.snapshot.config;
      const automation = cfg.automation || {};
      els.incomingDir.value = cfg.incoming_selfies_dir;
      els.outgoingDir.value = cfg.outgoing_dir;
      if (els.apiKeyStatus) {
        if (cfg.secure_store_available === false) {
          els.apiKeyStatus.textContent = cfg.api_key_set
            ? "API key status: set for current session (not persisted)"
            : "API key status: missing (credential store unavailable)";
          els.apiKeyStatus.className = "text-[11px] text-red-300";
        } else {
          els.apiKeyStatus.textContent = cfg.api_key_set ? "API key status: stored" : "API key status: missing";
          els.apiKeyStatus.className = `text-[11px] ${cfg.api_key_set ? "text-emerald-300" : "text-amber-300"}`;
        }
      }
      const models = ["gemini-3-pro-image-preview", "gemini-2.5-flash-image"];
      els.modelSelect.innerHTML = models.map((m) => `<option value="${m}">${m}</option>`).join("");
      els.modelSelect.value = cfg.selected_model;
      if (els.modelFallbackEnabled) {
        els.modelFallbackEnabled.checked = cfg.model_fallback_enabled !== false;
      }
      if (els.autoRevertSeconds) {
        els.autoRevertSeconds.value = String(Number.isFinite(Number(cfg.auto_revert_seconds)) ? Number(cfg.auto_revert_seconds) : 0);
      }

      const tools = state.snapshot.media_tools || {};
      const ffmpegMissing = !tools.ffmpeg || !tools.ffprobe;
      els.toolWarning.classList.toggle("hidden", !ffmpegMissing);
      if (ffmpegMissing) {
        els.toolWarning.textContent = "Warning: ffmpeg/ffprobe not found in PATH. Image conversion/probing and MP4 export may fail.";
      }

      if (els.autoApiToggle) els.autoApiToggle.checked = automation.auto_api_enabled !== false;
      if (els.autoAcceptToggle) els.autoAcceptToggle.checked = !!automation.auto_accept_enabled;
      if (els.autoExportToggle) els.autoExportToggle.checked = !!automation.auto_export_enabled;

      renderBackgroundEditor();
    }

    function renderLogs() {
      const levelFilter = els.logLevel.value.trim();
      const moduleFilter = els.logModule.value.trim().toLowerCase();
      const logs = (state.snapshot.logs || [])
        .filter((l) => !levelFilter || l.level === levelFilter)
        .filter((l) => !moduleFilter || String(l.module || "").toLowerCase().includes(moduleFilter))
        .slice(0, 200);

      els.logConsole.innerHTML = logs
        .map((l) => {
          const color = l.level === "error"
            ? "text-red-300"
            : l.level === "warn"
              ? "text-amber-300"
              : l.level === "success"
                ? "text-emerald-300"
                : "text-slate-300";
          const job = l.job_uuid ? `[${l.job_uuid}] ` : "";
          const meta = [];
          if (l.gallery) meta.push(`gallery=${l.gallery}`);
          if (l.group) meta.push(`group=${l.group}`);
          if (l.slot) meta.push(`slot=${l.slot}`);
          if (l.model) meta.push(`model=${l.model}`);
          if (l.attempt) meta.push(`attempt=${l.attempt}`);
          if (l.request_mode) meta.push(`mode=${l.request_mode}`);
          if (l.path) meta.push(`path=${l.path}`);
          if (l.last_known_size !== undefined) meta.push(`last_size=${l.last_known_size}`);
          if (l.watch_active !== undefined) meta.push(`watch_active=${l.watch_active}`);
          if (l.entries !== undefined) meta.push(`entries=${l.entries}`);
          const metaText = meta.length ? ` {${meta.join(" ")}}` : "";
          return `<div class="${color}">${l.ts} [${l.level}] [${l.module}] ${job}${l.message}${metaText}</div>`;
        })
        .join("");
    }

    function renderAll() {
      if (!state.snapshot) return;
      renderConfig();
      queueRenderer.renderJobs();
      renderLogs();
      slotsRenderer.renderSlotGrid();
      historyRenderer.renderHistory().catch(() => {});
    }

    return {
      renderBackgroundEditor,
      renderConfig,
      renderJobs: queueRenderer.renderJobs,
      renderLogs,
      renderSlotGrid: slotsRenderer.renderSlotGrid,
      renderHistory: historyRenderer.renderHistory,
      renderAll,
      getSelectedBackgroundGallery
    };
  }

  global.createOperatorRenderer = createOperatorRenderer;
})(window);
