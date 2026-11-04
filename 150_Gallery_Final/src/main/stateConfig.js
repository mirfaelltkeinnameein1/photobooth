const fs = require("fs");
const path = require("path");
const { GALLERIES, SLOT_IDS, SLOT_GROUPS } = require("./constants");
const { toAbsoluteMaybeRelative, toRelativeIfInsideRoot } = require("./paths");

// Pure config defaults/normalizers (no side effects).
function getDefaultGalleryBackgrounds() {
  return {
    gallery1: { type: "color", color: "#050b17", image_rel: "" },
    gallery2: { type: "color", color: "#050b17", image_rel: "" }
  };
}

function getDefaultAutomationConfig() {
  return {
    auto_api_enabled: true,
    auto_accept_enabled: false,
    auto_export_enabled: false
  };
}

function normalizeAutomationConfig(input) {
  const defaults = getDefaultAutomationConfig();
  const source = input && typeof input === "object" ? input : {};
  return {
    auto_api_enabled: source.auto_api_enabled === undefined ? defaults.auto_api_enabled : !!source.auto_api_enabled,
    auto_accept_enabled: source.auto_accept_enabled === undefined ? defaults.auto_accept_enabled : !!source.auto_accept_enabled,
    auto_export_enabled: source.auto_export_enabled === undefined ? defaults.auto_export_enabled : !!source.auto_export_enabled
  };
}

function normalizeAutoRevertSeconds(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

function normalizeAutoRevertDeadlines(input) {
  const source = input && typeof input === "object" ? input : {};
  const out = {};
  for (const slotId of SLOT_IDS) {
    const raw = source[slotId];
    if (!raw) continue;
    const ts = new Date(raw).getTime();
    if (!Number.isFinite(ts)) continue;
    out[slotId] = new Date(ts).toISOString();
  }
  return out;
}

function getDefaultSlotRegistry() {
  const out = {};
  for (const slotId of SLOT_IDS) {
    const numeric = Number(String(slotId).replace("slot", "")) || 0;
    out[slotId] = {
      slot_id: slotId,
      active: true,
      display_gallery: numeric <= 6 ? "gallery1" : "gallery2",
      generation_group: numeric % 2 === 1 ? "group1" : "group2",
      order_index: numeric
    };
  }
  return out;
}

function normalizeSlotRegistry(input) {
  const defaults = getDefaultSlotRegistry();
  const source = input && typeof input === "object" ? input : {};
  const out = {};
  for (const slotId of SLOT_IDS) {
    const src = source[slotId] && typeof source[slotId] === "object" ? source[slotId] : {};
    const def = defaults[slotId];
    const displayGallery = GALLERIES.includes(src.display_gallery) ? src.display_gallery : def.display_gallery;
    const generationGroup = SLOT_GROUPS.includes(src.generation_group) ? src.generation_group : def.generation_group;
    out[slotId] = {
      slot_id: slotId,
      active: src.active === undefined ? def.active : !!src.active,
      display_gallery: displayGallery,
      generation_group: generationGroup,
      order_index: Number.isFinite(Number(src.order_index)) ? Number(src.order_index) : def.order_index
    };
  }
  return out;
}

function getGenerationGroupStatus(slotRegistryInput) {
  const registry = normalizeSlotRegistry(slotRegistryInput);
  const groups = { group1: [], group2: [] };
  for (const slotId of SLOT_IDS) {
    const row = registry[slotId];
    if (!row.active) continue;
    if (!SLOT_GROUPS.includes(row.generation_group)) continue;
    groups[row.generation_group].push(slotId);
  }
  const sorted = {
    group1: groups.group1.sort((a, b) => registry[a].order_index - registry[b].order_index),
    group2: groups.group2.sort((a, b) => registry[a].order_index - registry[b].order_index)
  };
  const valid = sorted.group1.length > 0 && sorted.group1.length === sorted.group2.length;
  const reason = valid
    ? ""
    : "Active slot groups must be equal and non-zero. Configure same count in group1 and group2.";
  return {
    valid,
    reason,
    counts: {
      group1: sorted.group1.length,
      group2: sorted.group2.length
    },
    slots: sorted
  };
}

function normalizeHexColor(value, fallback = "#050b17") {
  const raw = String(value || "").trim();
  return /^#[0-9a-fA-F]{6}$/.test(raw) ? raw.toLowerCase() : fallback;
}

function normalizeGalleryBackgrounds(value) {
  const defaults = getDefaultGalleryBackgrounds();
  const source = value && typeof value === "object" ? value : {};
  const out = {};

  for (const gallery of GALLERIES) {
    const item = source[gallery] && typeof source[gallery] === "object" ? source[gallery] : {};
    const fallback = defaults[gallery];
    const type = item.type === "image" ? "image" : "color";
    const color = normalizeHexColor(item.color, fallback.color);
    let imageRel = typeof item.image_rel === "string" ? item.image_rel.trim() : "";
    if (imageRel && path.isAbsolute(imageRel)) {
      imageRel = toRelativeIfInsideRoot(imageRel);
    }
    if (imageRel) imageRel = imageRel.replace(/\\/g, "/");

    out[gallery] = {
      type: type === "image" && imageRel ? "image" : "color",
      color,
      image_rel: imageRel
    };
  }

  return out;
}

function getGalleryBackgroundsForSnapshot(configGalleryBackgrounds) {
  const backgrounds = normalizeGalleryBackgrounds(configGalleryBackgrounds);
  const out = {};

  for (const gallery of GALLERIES) {
    const item = backgrounds[gallery];
    let imageMtime = 0;
    if (item.type === "image" && item.image_rel) {
      const abs = toAbsoluteMaybeRelative(item.image_rel);
      try {
        imageMtime = fs.statSync(abs).mtimeMs || 0;
      } catch {
        imageMtime = 0;
      }
    }
    out[gallery] = { ...item, image_mtime_ms: imageMtime };
  }

  return out;
}

module.exports = {
  getDefaultGalleryBackgrounds,
  getDefaultAutomationConfig,
  normalizeAutomationConfig,
  normalizeAutoRevertSeconds,
  normalizeAutoRevertDeadlines,
  getDefaultSlotRegistry,
  normalizeSlotRegistry,
  getGenerationGroupStatus,
  normalizeHexColor,
  normalizeGalleryBackgrounds,
  getGalleryBackgroundsForSnapshot
};
