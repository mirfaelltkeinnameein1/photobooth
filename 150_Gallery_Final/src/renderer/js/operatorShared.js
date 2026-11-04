(function operatorSharedBootstrap(global) {
  // Shared tiny utils/state helpers so the renderer files stay split by concern.
  const GALLERY_BACKGROUND_PALETTE_GROUPS = [
    {
      label: "Ericsson Key Colors",
      colors: ["#1174e6", "#23969a", "#976cf4", "#e65d6a"]
    },
    {
      label: "Neutral tones",
      colors: ["#000000", "#242424", "#767676", "#a0a0a0", "#e0e0e0", "#f2f2f2", "#ffffff"]
    },
    {
      label: "Extended color palette",
      colors: ["#000082", "#0b2d2e", "#2d2049", "#3c2121", "#d6e2f5", "#bde0e1", "#e0d3fc", "#efd4d3", "#fad22d", "#e66e19", "#c52a32"]
    }
  ];

  function relToFileUrl(relPath, version = null) {
    if (!relPath) return "";
    const v = version === null || version === undefined ? Date.now() : version;
    return `/files/${encodeURI(relPath.replace(/\\/g, "/"))}?v=${encodeURIComponent(String(v))}`;
  }

  async function api(path, method = "GET", body = null) {
    const res = await fetch(path, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || `${method} ${path} failed`);
    }
    return data;
  }

  function setConfigModalOpen(els, open) {
    if (!els.configModal) return;
    const isOpen = !!open;
    els.configModal.classList.toggle("hidden", !isOpen);
    document.body.classList.toggle("overflow-hidden", isOpen);
  }

  function setSelfiePreviewOpen(els, open, src = "") {
    if (!els.selfiePreviewModal) return;
    const isOpen = !!open;
    if (isOpen && els.selfiePreviewImage) {
      els.selfiePreviewImage.src = src || "";
    } else if (els.selfiePreviewImage) {
      els.selfiePreviewImage.src = "";
    }
    els.selfiePreviewModal.classList.toggle("hidden", !isOpen);
  }

  function clearQuickDeleteArm(state, uuid) {
    const timer = state.quickDeleteTimersByUuid?.[uuid];
    if (timer) clearTimeout(timer);
    delete state.quickDeleteTimersByUuid[uuid];
    delete state.quickDeleteArmedUntilByUuid[uuid];
  }

  function armQuickDelete(state, uuid, rerender, ms = 3000) {
    // only one armed row at a time, keeps intent clear for the operator.
    const keys = Object.keys(state.quickDeleteArmedUntilByUuid || {});
    for (const key of keys) {
      if (key !== uuid) clearQuickDeleteArm(state, key);
    }
    clearQuickDeleteArm(state, uuid);
    state.quickDeleteArmedUntilByUuid[uuid] = Date.now() + ms;
    state.quickDeleteTimersByUuid[uuid] = setTimeout(() => {
      clearQuickDeleteArm(state, uuid);
      if (typeof rerender === "function") rerender();
    }, ms);
  }

  function isQuickDeleteArmed(state, uuid) {
    const expiry = Number(state.quickDeleteArmedUntilByUuid?.[uuid] || 0);
    return Number.isFinite(expiry) && expiry > Date.now();
  }

  function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(new Error("Failed reading file"));
      reader.readAsDataURL(file);
    });
  }

  function candidateRel(state, candidate) {
    if (!candidate?.path) return null;
    const root = state.snapshot?.config?.root_dir;
    if (!root) return null;
    return candidate.path.replace(root + "\\", "").replace(/\\/g, "/");
  }

  function candidateUrl(state, candidate) {
    const p = candidateRel(state, candidate);
    return p ? relToFileUrl(p) : "";
  }

  function latestCandidate(job, group) {
    const manual = job?.manual?.candidates?.[group];
    if (manual) return { ...manual, type: "manual", id: "manual" };
    const list = job?.candidates?.[group] || [];
    return list.length ? list[list.length - 1] : null;
  }

  function groupNeedsApiGeneration(job, group) {
    if (job?.accepted?.[group]) return false;
    if (job?.manual?.candidates?.[group]) return false;
    return (job?.candidates?.[group]?.length || 0) === 0;
  }

  function jobNeedsApiGeneration(job) {
    if (!job) return false;
    if (["BLOCKED", "DELIVERED", "ACCEPTED_BOTH"].includes(job.state)) return false;
    return groupNeedsApiGeneration(job, "group1") || groupNeedsApiGeneration(job, "group2");
  }

  function jobStatusUi(status) {
    const s = String(status || "").toUpperCase();
    switch (s) {
      case "NEW":
        return { badge: "border-sky-500/40 bg-sky-500/15 text-sky-200", border: "border-sky-500/35" };
      case "SLOTTED":
        return { badge: "border-indigo-500/40 bg-indigo-500/15 text-indigo-200", border: "border-indigo-500/35" };
      case "GENERATING":
        return { badge: "border-cyan-500/40 bg-cyan-500/15 text-cyan-200", border: "border-cyan-500/35" };
      case "AWAITING_REVIEW":
        return { badge: "border-amber-500/40 bg-amber-500/15 text-amber-200", border: "border-amber-500/35" };
      case "ACCEPTED_PARTIAL":
        return { badge: "border-violet-500/40 bg-violet-500/15 text-violet-200", border: "border-violet-500/35" };
      case "ACCEPTED_BOTH":
        return { badge: "border-emerald-500/40 bg-emerald-500/15 text-emerald-200", border: "border-emerald-500/35" };
      case "DELIVERED":
        return { badge: "border-green-500/40 bg-green-500/15 text-green-200", border: "border-green-500/35" };
      case "BLOCKED":
        return { badge: "border-red-500/40 bg-red-500/15 text-red-200", border: "border-red-500/35" };
      case "FAILED":
        return { badge: "border-rose-500/40 bg-rose-500/15 text-rose-200", border: "border-rose-500/35" };
      default:
        return { badge: "border-slate-500/40 bg-slate-500/15 text-slate-300", border: "border-slate-500/35" };
    }
  }

  global.OperatorShared = {
    GALLERY_BACKGROUND_PALETTE_GROUPS,
    relToFileUrl,
    api,
    setConfigModalOpen,
    setSelfiePreviewOpen,
    clearQuickDeleteArm,
    armQuickDelete,
    isQuickDeleteArmed,
    fileToDataUrl,
    candidateRel,
    candidateUrl,
    latestCandidate,
    groupNeedsApiGeneration,
    jobNeedsApiGeneration,
    jobStatusUi
  };
})(window);
