const params = new URLSearchParams(window.location.search);
const gallery = params.get("gallery") || "gallery1";
// Gallery renderer for one window (gallery1 or gallery2).

const state = {
  snapshot: null,
  layout: null,
  editMode: false,
  drag: null,
  slotEls: new Map(),
  menuVisible: true,
  menuHideTimer: null
};

const els = {
  title: document.getElementById("gallery-title"),
  toggleEdit: document.getElementById("toggle-edit"),
  saveLayout: document.getElementById("save-layout"),
  stage: document.getElementById("stage"),
  menu: document.getElementById("layout-menu")
};

const MENU_HIDE_DELAY_MS = 2200;
const MENU_REVEAL_ZONE_X = 220;
const MENU_REVEAL_ZONE_Y = 150;

function relToFileUrl(relPath, version = "") {
  // tiny cache-bust query so img/video swaps happen without hard page reloads.
  const base = `/files/${encodeURI(String(relPath || "").replace(/\\/g, "/"))}`;
  return version ? `${base}?v=${encodeURIComponent(String(version))}` : base;
}

async function api(path, method = "GET", body = null) {
  const res = await fetch(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw new Error(data.error || `${method} ${path} failed`);
  return data;
}

function getGallerySlots() {
  return state.snapshot?.galleries?.[gallery] || [];
}

function applyStageBackground() {
  const bgConfig = state.snapshot?.config?.gallery_backgrounds?.[gallery] || {};
  const color = /^#[0-9a-fA-F]{6}$/.test(String(bgConfig.color || ""))
    ? String(bgConfig.color).toLowerCase()
    : "#050b17";

  els.stage.style.backgroundColor = color;
  els.stage.style.backgroundSize = "cover";
  els.stage.style.backgroundPosition = "center";
  els.stage.style.backgroundRepeat = "no-repeat";

  if (bgConfig.type === "image" && bgConfig.image_rel) {
    const version = bgConfig.image_mtime_ms || 0;
    const src = relToFileUrl(bgConfig.image_rel, version);
    if (els.stage.dataset.bgSrc !== src) {
      els.stage.dataset.bgSrc = src;
      els.stage.style.backgroundImage = `url("${src}")`;
    }
  } else {
    els.stage.dataset.bgSrc = "";
    els.stage.style.backgroundImage = "none";
  }
}

function clearMenuHideTimer() {
  if (!state.menuHideTimer) return;
  clearTimeout(state.menuHideTimer);
  state.menuHideTimer = null;
}

function setMenuVisible(visible) {
  state.menuVisible = !!visible;
  if (!els.menu) return;
  els.menu.classList.toggle("gallery-menu-hidden", !state.menuVisible);
}

function scheduleMenuAutoHide() {
  clearMenuHideTimer();
  if (state.editMode) return;
  // In locked mode we hide controls after a short idle window.
  state.menuHideTimer = setTimeout(() => {
    if (!state.editMode) setMenuVisible(false);
  }, MENU_HIDE_DELAY_MS);
}

function revealMenuTemporarily() {
  if (state.editMode) return;
  setMenuVisible(true);
  scheduleMenuAutoHide();
}

function applyMenuVisibilityForMode() {
  if (state.editMode) {
    clearMenuHideTimer();
    setMenuVisible(true);
  } else {
    revealMenuTemporarily();
  }
}

function normalizeBox(layoutSlot) {
  // Slots are free-form boxes; images of any aspect ratio are fitted inside (see fitBoxToImage).
  return {
    ...layoutSlot,
    width: Math.max(60, Number(layoutSlot.width || 300)),
    height: Math.max(60, Number(layoutSlot.height || 300))
  };
}

function fitBoxToImage(box, img) {
  // Shrink the layout box to the image's aspect ratio (centered) so nothing is cropped
  // and the slot frame hugs the picture. Size is unknown until the image has loaded.
  const nw = img.naturalWidth;
  const nh = img.naturalHeight;
  if (!nw || !nh) return box;
  const scale = Math.min(box.width / nw, box.height / nh);
  const width = nw * scale;
  const height = nh * scale;
  return {
    x: box.x + (box.width - width) / 2,
    y: box.y + (box.height - height) / 2,
    width,
    height
  };
}

function normalizeRightAngle(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const snapped = Math.round(n / 90) * 90;
  return ((snapped % 360) + 360) % 360;
}

function ensureSlotLayoutRef(slotId) {
  if (!state.layout.slots) state.layout.slots = [];
  let found = state.layout.slots.find((s) => s.slot === slotId);
  if (!found) {
    // New slot got activated but layout had no row for it yet.
    found = { slot: slotId, x: 100, y: 100, width: 300, height: 300, z: 1, rotation: 0 };
    state.layout.slots.push(found);
  }

  const normalized = normalizeBox(found);
  found.x = Number(normalized.x || 0);
  found.y = Number(normalized.y || 0);
  found.width = Number(normalized.width || 300);
  found.height = Number(normalized.height || 300);
  found.z = Number(normalized.z || 1);
  found.rotation = normalizeRightAngle(found.rotation || 0);
  return found;
}

function updateLayoutFromElement(el) {
  const slot = el.dataset.slot;
  const layoutSlot = ensureSlotLayoutRef(slot);
  layoutSlot.x = Number(el.style.left.replace("px", ""));
  layoutSlot.y = Number(el.style.top.replace("px", ""));
  layoutSlot.width = Math.max(60, Number(el.style.width.replace("px", "")));
  layoutSlot.height = Math.max(60, Number(el.style.height.replace("px", "")));
}

function setupDragHandlers(el, handle) {
  el.onpointerdown = (ev) => {
    if (!state.editMode) return;
    if (ev.target === handle) return;
    state.drag = {
      mode: "move",
      el,
      startX: ev.clientX,
      startY: ev.clientY,
      startLeft: Number(el.style.left.replace("px", "")),
      startTop: Number(el.style.top.replace("px", ""))
    };
    el.classList.add("dragging");
    el.setPointerCapture(ev.pointerId);
  };

  handle.onpointerdown = (ev) => {
    if (!state.editMode) return;
    ev.stopPropagation();
    state.drag = {
      mode: "resize",
      el,
      startX: ev.clientX,
      startY: ev.clientY,
      startWidth: Number(el.style.width.replace("px", "")),
      startHeight: Number(el.style.height.replace("px", ""))
    };
    el.classList.add("dragging");
    el.setPointerCapture(ev.pointerId);
  };

  el.onpointermove = (ev) => {
    if (!state.editMode) return;
    if (!state.drag || state.drag.el !== el) return;
    if (state.drag.mode === "move") {
      const dx = ev.clientX - state.drag.startX;
      const dy = ev.clientY - state.drag.startY;
      el.style.left = `${Math.max(0, state.drag.startLeft + dx)}px`;
      el.style.top = `${Math.max(0, state.drag.startTop + dy)}px`;
    } else {
      const dx = ev.clientX - state.drag.startX;
      const dy = ev.clientY - state.drag.startY;
      let width = Math.max(60, state.drag.startWidth + dx);
      let height = Math.max(60, state.drag.startHeight + dy);
      if (ev.shiftKey) {
        // Shift keeps the box proportions (e.g. to stay square).
        const scale = Math.max(width / state.drag.startWidth, height / state.drag.startHeight);
        width = Math.max(60, state.drag.startWidth * scale);
        height = Math.max(60, state.drag.startHeight * scale);
      }
      el.style.width = `${width}px`;
      el.style.height = `${height}px`;
    }
  };

  el.onpointerup = (ev) => {
    if (!state.drag || state.drag.el !== el) return;
    state.drag = null;
    el.classList.remove("dragging");
    el.releasePointerCapture(ev.pointerId);
    updateLayoutFromElement(el);
  };
}

function ensureSlotElement(slotObj) {
  const slotId = slotObj.slot;
  if (state.slotEls.has(slotId)) return state.slotEls.get(slotId);

  const container = document.createElement("div");
  container.className = "slot";
  container.dataset.slot = slotId;

  const bg = document.createElement("img");
  bg.className = "layer";
  bg.alt = `${slotId} bg`;
  // Re-fit the slot once the real image size is known (first load and every swap).
  bg.addEventListener("load", () => render());

  const label = document.createElement("div");
  label.textContent = slotId;
  label.style.position = "absolute";
  label.style.left = "6px";
  label.style.top = "6px";
  label.style.background = "rgba(0,0,0,0.45)";
  label.style.color = "#f8fafc";
  label.style.fontSize = "11px";
  label.style.padding = "2px 6px";
  label.style.borderRadius = "6px";
  label.style.pointerEvents = "none";

  const handle = document.createElement("div");
  handle.className = "handle";

  const rotateBtn = document.createElement("button");
  rotateBtn.type = "button";
  rotateBtn.className = "rotate-btn";
  rotateBtn.textContent = "Rotate +90";
  rotateBtn.title = "Rotate slot by 90 degrees";
  rotateBtn.onpointerdown = (ev) => {
    ev.stopPropagation();
  };
  rotateBtn.onclick = (ev) => {
    if (!state.editMode) return;
    ev.stopPropagation();
    const l = ensureSlotLayoutRef(slotId);
    l.rotation = normalizeRightAngle((l.rotation || 0) + 90);
    container.style.transform = `rotate(${l.rotation}deg)`;
  };

  container.appendChild(bg);
  container.appendChild(label);
  container.appendChild(handle);
  container.appendChild(rotateBtn);
  els.stage.appendChild(container);

  setupDragHandlers(container, handle);

  const refs = { container, bg, label, handle, rotateBtn };
  state.slotEls.set(slotId, refs);
  return refs;
}

function syncSlotElement(slotObj) {
  const refs = ensureSlotElement(slotObj);
  const l = ensureSlotLayoutRef(slotObj.slot);

  // Edit mode shows the full layout box so drag/resize work on the stored values;
  // locked mode shrinks it to the image's shape.
  const box = { x: l.x, y: l.y, width: l.width, height: l.height };
  const rect = state.editMode ? box : fitBoxToImage(box, refs.bg);
  refs.container.style.left = `${rect.x}px`;
  refs.container.style.top = `${rect.y}px`;
  refs.container.style.width = `${rect.width}px`;
  refs.container.style.height = `${rect.height}px`;
  refs.container.style.zIndex = String(l.z || 1);
  refs.container.style.transformOrigin = "center center";
  refs.container.style.transform = `rotate(${normalizeRightAngle(l.rotation || 0)}deg)`;

  const bgVersion = slotObj.background_mtime_ms || 0;
  const bgSrc = relToFileUrl(slotObj.background_rel, bgVersion);

  if (refs.bg.dataset.src !== bgSrc) {
    refs.bg.dataset.src = bgSrc;
    refs.bg.src = bgSrc;
  }

  refs.label.style.display = state.editMode ? "block" : "none";
  refs.handle.style.display = state.editMode ? "block" : "none";
  refs.rotateBtn.style.display = state.editMode ? "block" : "none";
}

function pruneMissingSlots(activeSlotIds) {
  for (const [slotId, refs] of state.slotEls.entries()) {
    if (activeSlotIds.has(slotId)) continue;
    refs.container.remove();
    state.slotEls.delete(slotId);
  }
}

function render() {
  if (!state.snapshot || !state.layout) return;
  applyStageBackground();
  els.title.textContent = `${gallery.toUpperCase()} (${state.editMode ? "EDIT MODE" : "LOCKED"})`;
  els.toggleEdit.textContent = state.editMode ? "Disable Layout Edit" : "Enable Layout Edit";

  if (state.editMode) {
    clearMenuHideTimer();
    setMenuVisible(true);
  } else if (state.menuVisible) {
    scheduleMenuAutoHide();
  }

  const slots = getGallerySlots();
  const active = new Set();
  for (const slotObj of slots) {
    active.add(slotObj.slot);
    syncSlotElement(slotObj);
  }
  pruneMissingSlots(active);
}

async function saveLayout() {
  // Store sane box sizes + 90deg steps so the gallery stays predictable.
  state.layout.slots = (state.layout.slots || []).map((slot) => ({
    ...normalizeBox(slot),
    rotation: normalizeRightAngle(slot.rotation || 0)
  }));
  await api(`/api/layout/${gallery}`, "POST", state.layout);
  state.layout = await api(`/api/layout/${gallery}`);
  state.editMode = !!state.layout.edit_mode;
  render();
}

async function bootstrap() {
  state.snapshot = await api("/api/state");
  state.layout = await api(`/api/layout/${gallery}`);
  state.editMode = !!state.layout.edit_mode;
  render();

  const es = new EventSource("/api/events");
  es.addEventListener("state", (ev) => {
    state.snapshot = JSON.parse(ev.data);
    if (state.snapshot?.layouts?.[gallery]) {
      // Server remains source of truth for edit-mode + coordinates.
      state.layout = state.snapshot.layouts[gallery];
      state.editMode = !!state.layout.edit_mode;
    }
    render();
  });

  els.toggleEdit.onclick = async () => {
    const targetEditMode = !state.editMode;
    els.toggleEdit.disabled = true;
    try {
      // Persist mode instantly, so random later state pushes don't flip it back.
      await api(`/api/layout/${gallery}/edit-mode`, "POST", { edit_mode: targetEditMode });
      state.editMode = targetEditMode;
      if (state.layout) state.layout.edit_mode = targetEditMode;
      applyMenuVisibilityForMode();
      render();
    } catch (err) {
      alert(err.message);
    } finally {
      els.toggleEdit.disabled = false;
    }
  };

  els.saveLayout.onclick = async () => {
    try {
      await saveLayout();
      alert("Layout saved.");
    } catch (err) {
      alert(err.message);
    }
  };

  window.addEventListener("mousemove", (ev) => {
    if (state.editMode) return;
    if (ev.clientX <= MENU_REVEAL_ZONE_X && ev.clientY <= MENU_REVEAL_ZONE_Y) {
      revealMenuTemporarily();
    }
  });

  window.addEventListener("beforeunload", () => {
    clearMenuHideTimer();
  });
}

bootstrap().catch((err) => {
  console.error(err);
  alert(err.message);
});
