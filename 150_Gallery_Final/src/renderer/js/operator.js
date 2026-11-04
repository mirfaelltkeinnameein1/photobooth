const state = {
  // UI-only state. Server snapshot stays the source of truth.
  snapshot: null,
  expandedJobUuid: null,
  jobPage: 1,
  // quick-delete is two-step by design to avoid accidental taps during live ops.
  quickDeleteArmedUntilByUuid: {},
  quickDeleteTimersByUuid: {},
  // While typing prompt text we pause full rerenders so cursor/focus doesn't jump.
  pauseRenderWhileEditingPrompt: false,
  promptGuardUntil: 0,
  slotGridSignature: "",
  bgPaletteRendered: false
};

const els = {
  serverHealth: document.getElementById("server-health"),
  openConfigModal: document.getElementById("open-config-modal"),
  closeConfigModal: document.getElementById("close-config-modal"),
  configModal: document.getElementById("config-modal"),
  configModalBackdrop: document.getElementById("config-modal-backdrop"),
  toolWarning: document.getElementById("tool-warning"),
  incomingDir: document.getElementById("incoming-dir"),
  outgoingDir: document.getElementById("outgoing-dir"),
  pickIncoming: document.getElementById("pick-incoming"),
  pickOutgoing: document.getElementById("pick-outgoing"),
  modelSelect: document.getElementById("model-select"),
  modelFallbackEnabled: document.getElementById("model-fallback-enabled"),
  autoRevertSeconds: document.getElementById("auto-revert-seconds"),
  apiKey: document.getElementById("api-key"),
  apiKeyStatus: document.getElementById("api-key-status"),
  clearApiKey: document.getElementById("clear-api-key"),
  bgGallerySelect: document.getElementById("bg-gallery-select"),
  bgCurrentMode: document.getElementById("bg-current-mode"),
  bgCurrentPreview: document.getElementById("bg-current-preview"),
  bgCurrentValue: document.getElementById("bg-current-value"),
  bgPalette: document.getElementById("bg-palette"),
  bgColorPicker: document.getElementById("bg-color-picker"),
  bgApplyColor: document.getElementById("bg-apply-color"),
  bgImageFile: document.getElementById("bg-image-file"),
  bgApplyImage: document.getElementById("bg-apply-image"),
  bgImageName: document.getElementById("bg-image-name"),
  saveConfig: document.getElementById("save-config"),
  autoApiToggle: document.getElementById("auto-api-toggle"),
  autoAcceptToggle: document.getElementById("auto-accept-toggle"),
  autoExportToggle: document.getElementById("auto-export-toggle"),
  jobList: document.getElementById("job-list"),
  jobPagination: document.getElementById("job-pagination"),
  logConsole: document.getElementById("log-console"),
  logLevel: document.getElementById("log-level"),
  logModule: document.getElementById("log-module"),
  slotFilter: document.getElementById("slot-filter"),
  groupStatus: document.getElementById("group-status"),
  slotGrid: document.getElementById("slot-grid"),
  promptSlot: document.getElementById("prompt-slot"),
  loadPrompt: document.getElementById("load-prompt"),
  savePrompt: document.getElementById("save-prompt"),
  promptStatus: document.getElementById("prompt-status"),
  promptText: document.getElementById("prompt-text"),
  preambleText: document.getElementById("preamble-text"),
  savePreamble: document.getElementById("save-preamble"),
  historyList: document.getElementById("history-list"),
  selfiePreviewModal: document.getElementById("selfie-preview-modal"),
  selfiePreviewBackdrop: document.getElementById("selfie-preview-backdrop"),
  selfiePreviewImage: document.getElementById("selfie-preview-image"),
  selfiePreviewClose: document.getElementById("selfie-preview-close")
};

const JOBS_PER_PAGE = 5;
const {
  GALLERY_BACKGROUND_PALETTE_GROUPS,
  relToFileUrl,
  api,
  setConfigModalOpen: sharedSetConfigModalOpen,
  setSelfiePreviewOpen: sharedSetSelfiePreviewOpen,
  clearQuickDeleteArm: sharedClearQuickDeleteArm,
  armQuickDelete: sharedArmQuickDelete,
  isQuickDeleteArmed: sharedIsQuickDeleteArmed,
  fileToDataUrl,
  candidateUrl: sharedCandidateUrl,
  latestCandidate,
  jobNeedsApiGeneration,
  jobStatusUi
} = window.OperatorShared;

function setConfigModalOpen(open) {
  sharedSetConfigModalOpen(els, open);
}

function setSelfiePreviewOpen(open, src = "") {
  sharedSetSelfiePreviewOpen(els, open, src);
}

function clearQuickDeleteArm(uuid) {
  sharedClearQuickDeleteArm(state, uuid);
}

function armQuickDelete(uuid, ms = 3000) {
  sharedArmQuickDelete(state, uuid, () => renderer.renderJobs(), ms);
}

function isQuickDeleteArmed(uuid) {
  return sharedIsQuickDeleteArmed(state, uuid);
}

function candidateUrl(candidate) {
  return sharedCandidateUrl(state, candidate);
}

const renderer = window.createOperatorRenderer({
  state,
  els,
  JOBS_PER_PAGE,
  GALLERY_BACKGROUND_PALETTE_GROUPS,
  relToFileUrl,
  api,
  candidateUrl,
  latestCandidate,
  jobNeedsApiGeneration,
  jobStatusUi,
  setSelfiePreviewOpen,
  clearQuickDeleteArm,
  armQuickDelete,
  isQuickDeleteArmed
});

function isPromptEditorFocused() {
  const active = document.activeElement;
  return active === els.promptText || active === els.preambleText;
}

function isPromptGuardActive() {
  return isPromptEditorFocused() || Date.now() < state.promptGuardUntil;
}

function bumpPromptGuard(ms = 1500) {
  // Short grace period after button clicks/network writes to prevent "stuck caret" UX.
  state.promptGuardUntil = Date.now() + ms;
}

function focusPromptTextarea() {
  els.promptText.focus();
  const len = els.promptText.value.length;
  els.promptText.setSelectionRange(len, len);
}

let promptStatusTimer = null;
function setPromptStatus(msg, type = "info") {
  if (!els.promptStatus) return;
  els.promptStatus.textContent = msg || "";
  els.promptStatus.className =
    `mb-2 text-xs ${type === "error" ? "text-red-300" : type === "success" ? "text-emerald-300" : "text-slate-300"}`;
  if (promptStatusTimer) clearTimeout(promptStatusTimer);
  if (msg) {
    promptStatusTimer = setTimeout(() => {
      els.promptStatus.textContent = "";
    }, 2500);
  }
}

async function bootstrap() {
  try {
    await api("/api/health");
    els.serverHealth.textContent = "online";
  } catch {
    els.serverHealth.textContent = "offline";
  }

  const initial = await api("/api/state");
  state.snapshot = initial;
  renderer.renderAll();

  const preamble = await api("/api/prompts/preamble");
  els.preambleText.value = preamble.content || "";

  const es = new EventSource("/api/events");
  es.addEventListener("state", (ev) => {
    state.snapshot = JSON.parse(ev.data);
    if (state.pauseRenderWhileEditingPrompt && isPromptGuardActive()) {
      // Keep logs live while editing, but avoid replacing prompt DOM mid-typing.
      renderer.renderLogs();
      return;
    }
    renderer.renderAll();
  });
  es.addEventListener("log", (ev) => {
    const entry = JSON.parse(ev.data);
    if (!state.snapshot) return;
    if (!Array.isArray(state.snapshot.logs)) state.snapshot.logs = [];
    state.snapshot.logs.unshift(entry);
    if (state.snapshot.logs.length > 300) state.snapshot.logs.length = 300;
    renderer.renderLogs();
  });

  els.saveConfig.onclick = async () => {
    try {
      const autoRevertSeconds = Math.max(0, Math.floor(Number(els.autoRevertSeconds?.value || 0)));
      const payload = {
        incoming_selfies_dir: els.incomingDir.value,
        outgoing_dir: els.outgoingDir.value,
        selected_model: els.modelSelect.value,
        model_fallback_enabled: !!els.modelFallbackEnabled?.checked,
        auto_revert_seconds: autoRevertSeconds
      };
      const submittedKey = (els.apiKey.value || "").trim();
      if (submittedKey) payload.api_key = submittedKey;
      await api("/api/config", "POST", payload);
      if (submittedKey) {
        els.apiKey.value = "";
      }
    } catch (err) {
      alert(err.message);
    }
  };

  if (els.clearApiKey) {
    els.clearApiKey.onclick = async () => {
      try {
        await api("/api/config", "POST", { api_key: "" });
        els.apiKey.value = "";
      } catch (err) {
        alert(err.message);
      }
    };
  }

  if (els.openConfigModal) {
    els.openConfigModal.onclick = () => setConfigModalOpen(true);
  }
  if (els.closeConfigModal) {
    els.closeConfigModal.onclick = () => setConfigModalOpen(false);
  }
  if (els.configModalBackdrop) {
    els.configModalBackdrop.onclick = () => setConfigModalOpen(false);
  }
  if (els.selfiePreviewBackdrop) {
    els.selfiePreviewBackdrop.onclick = () => setSelfiePreviewOpen(false);
  }
  if (els.selfiePreviewClose) {
    els.selfiePreviewClose.onclick = () => setSelfiePreviewOpen(false);
  }
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") {
      setConfigModalOpen(false);
      setSelfiePreviewOpen(false);
    }
  });

  const saveAutomationConfig = async () => {
    try {
      await api("/api/config", "POST", {
        automation: {
          auto_api_enabled: !!els.autoApiToggle?.checked,
          auto_accept_enabled: !!els.autoAcceptToggle?.checked,
          auto_export_enabled: !!els.autoExportToggle?.checked
        }
      });
    } catch (err) {
      alert(err.message);
    }
  };
  if (els.autoApiToggle) els.autoApiToggle.onchange = saveAutomationConfig;
  if (els.autoAcceptToggle) els.autoAcceptToggle.onchange = saveAutomationConfig;
  if (els.autoExportToggle) els.autoExportToggle.onchange = saveAutomationConfig;

  els.pickIncoming.onclick = async () => {
    try { await api("/api/dialog/select-directory", "POST", { kind: "incoming" }); }
    catch (err) { alert(err.message); }
  };
  els.pickOutgoing.onclick = async () => {
    try { await api("/api/dialog/select-directory", "POST", { kind: "outgoing" }); }
    catch (err) { alert(err.message); }
  };

  if (els.bgGallerySelect) {
    els.bgGallerySelect.onchange = () => renderer.renderBackgroundEditor();
  }
  if (els.bgApplyColor) {
    els.bgApplyColor.onclick = async () => {
      try {
        await api("/api/gallery-background", "POST", {
          gallery: renderer.getSelectedBackgroundGallery(),
          type: "color",
          color: els.bgColorPicker.value
        });
      } catch (err) {
        alert(err.message);
      }
    };
  }
  if (els.bgImageFile) {
    els.bgImageFile.onchange = () => {
      const f = els.bgImageFile.files && els.bgImageFile.files[0];
      els.bgImageName.textContent = f ? f.name : "No image selected";
    };
  }
  if (els.bgApplyImage) {
    els.bgApplyImage.onclick = async () => {
      const file = els.bgImageFile.files && els.bgImageFile.files[0];
      if (!file) {
        alert("Select a PNG/JPEG image first.");
        return;
      }
      const t = String(file.type || "").toLowerCase();
      if (!["image/png", "image/jpeg"].includes(t) && !/\.(png|jpe?g)$/i.test(file.name || "")) {
        alert("Only .png or .jpeg/.jpg files are supported.");
        return;
      }
      try {
        const dataUrl = await fileToDataUrl(file);
        await api("/api/gallery-background/upload", "POST", {
          gallery: renderer.getSelectedBackgroundGallery(),
          filename: file.name,
          data_url: dataUrl
        });
        els.bgImageFile.value = "";
        els.bgImageName.textContent = "No image selected";
      } catch (err) {
        alert(err.message);
      }
    };
  }

  els.logLevel.onchange = () => renderer.renderLogs();
  els.logModule.oninput = () => renderer.renderLogs();
  if (els.slotFilter) {
    els.slotFilter.onchange = () => {
      state.slotGridSignature = "";
      renderer.renderSlotGrid();
    };
  }

  els.loadPrompt.onclick = async () => {
    try {
      bumpPromptGuard(2000);
      const d = await api(`/api/prompts/${els.promptSlot.value}`);
      els.promptText.value = d.content || "";
      els.promptText.readOnly = false;
      els.promptText.disabled = false;
      focusPromptTextarea();
      setPromptStatus(`Loaded ${els.promptSlot.value}`, "success");
    } catch (err) {
      setPromptStatus(err.message, "error");
    }
  };
  els.savePrompt.onclick = async () => {
    try {
      bumpPromptGuard(2000);
      await api(`/api/prompts/${els.promptSlot.value}`, "POST", { content: els.promptText.value });
      setPromptStatus(`Saved ${els.promptSlot.value}`, "success");
      focusPromptTextarea();
    } catch (err) {
      setPromptStatus(err.message, "error");
    }
  };
  els.savePreamble.onclick = async () => {
    try {
      bumpPromptGuard(2000);
      await api("/api/prompts/preamble", "POST", { content: els.preambleText.value });
      setPromptStatus("Saved preamble", "success");
    } catch (err) {
      setPromptStatus(err.message, "error");
    }
  };

  els.promptText.addEventListener("focus", () => {
    state.pauseRenderWhileEditingPrompt = true;
  });
  els.promptText.addEventListener("blur", () => {
    state.pauseRenderWhileEditingPrompt = false;
    bumpPromptGuard(300);
    renderer.renderAll();
  });
  els.promptText.addEventListener("input", () => bumpPromptGuard(1200));
  els.preambleText.addEventListener("focus", () => {
    state.pauseRenderWhileEditingPrompt = true;
  });
  els.preambleText.addEventListener("blur", () => {
    state.pauseRenderWhileEditingPrompt = false;
    bumpPromptGuard(300);
    renderer.renderAll();
  });
  els.preambleText.addEventListener("input", () => bumpPromptGuard(1200));
  els.promptSlot.addEventListener("change", () => bumpPromptGuard(1200));
}

bootstrap().catch((err) => {
  console.error(err);
  alert(err.message);
});
