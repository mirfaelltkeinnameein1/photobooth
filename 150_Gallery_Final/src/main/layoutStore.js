const { SLOT_IDS } = require("./constants");
const { PATHS } = require("./paths");
const { readJsonSafe, atomicWriteJson } = require("./fsutils");

// Layout persistence per gallery window.
function defaultLayout(slotIds) {
  // Reasonable fallback grid for a 1080p stage; operator can tweak and save later.
  const width = 1920;
  const height = 1080;
  const count = Math.max(1, Array.isArray(slotIds) ? slotIds.length : 0);
  const cols = Math.max(1, Math.ceil(Math.sqrt(count)));
  const rows = Math.max(1, Math.ceil(count / cols));
  const marginX = 40;
  const marginY = 40;
  const slotW = Math.floor((width - marginX * 2 - 40) / cols);
  const slotH = Math.floor((height - marginY * 2 - 20) / rows);

  return slotIds.map((slot, idx) => {
    const row = Math.floor(idx / cols);
    const col = idx % cols;
    return {
      slot,
      x: marginX + col * (slotW + 20),
      y: marginY + row * (slotH + 20),
      width: slotW,
      height: slotH,
      z: 1
    };
  });
}

function layoutPathForGallery(gallery) {
  return gallery === "gallery1" ? PATHS.LAYOUT_GALLERY1 : PATHS.LAYOUT_GALLERY2;
}

async function loadLayout(gallery) {
  const filePath = layoutPathForGallery(gallery);
  const layout = await readJsonSafe(filePath, null);
  // Keep all 12 global slots addressable in each gallery layout.
  const fallbackSlots = SLOT_IDS;
  if (!layout || !Array.isArray(layout.slots)) {
    // First run (or bad file): write defaults so next boot is deterministic.
    const fallback = { edit_mode: false, slots: defaultLayout(fallbackSlots) };
    await atomicWriteJson(filePath, fallback);
    return fallback;
  }
  return layout;
}

async function saveLayout(gallery, layout) {
  const filePath = layoutPathForGallery(gallery);
  await atomicWriteJson(filePath, layout);
}

module.exports = {
  loadLayout,
  saveLayout,
  defaultLayout
};
