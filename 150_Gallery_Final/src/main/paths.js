const path = require("path");
const fs = require("fs");

// All canonical app paths live here.
const ROOT = path.resolve(__dirname, "../..");
const isPackaged = ROOT.toLowerCase().endsWith("app.asar");
const PACKAGED_BASE_DIR = process.env.PORTABLE_EXECUTABLE_DIR
  ? process.env.PORTABLE_EXECUTABLE_DIR
  : path.dirname(process.execPath);
// In packaged mode keep mutable data outside asar so ops can edit/recover files.
const DATA_ROOT = isPackaged ? path.join(PACKAGED_BASE_DIR, "gallery-composer-data") : ROOT;

const RESOURCES_ROOT = process.resourcesPath || path.dirname(process.execPath);
const EXTERNAL_ASSETS_ROOT = path.join(RESOURCES_ROOT, "assets");
const INTERNAL_ASSETS_ROOT = path.join(ROOT, "assets");
const BUNDLED_ASSETS_ROOT = isPackaged && fs.existsSync(EXTERNAL_ASSETS_ROOT)
  ? EXTERNAL_ASSETS_ROOT
  : INTERNAL_ASSETS_ROOT;
const EXTERNAL_CONFIG_ROOT = path.join(RESOURCES_ROOT, "config");
const INTERNAL_CONFIG_ROOT = path.join(ROOT, "config");
const BUNDLED_CONFIG_ROOT = isPackaged && fs.existsSync(EXTERNAL_CONFIG_ROOT)
  ? EXTERNAL_CONFIG_ROOT
  : INTERNAL_CONFIG_ROOT;

const PATHS = {
  ROOT,
  DATA_ROOT,
  IS_PACKAGED: isPackaged,
  ASSETS_BUNDLED_DEFAULTS: path.join(BUNDLED_ASSETS_ROOT, "defaults"),
  ASSETS_DEFAULTS: path.join(DATA_ROOT, "assets", "defaults"),
  MP4_OVERLAY: path.join(BUNDLED_ASSETS_ROOT, "MP4_Overlay.png"),
  BUNDLED_CONFIG_DIR: BUNDLED_CONFIG_ROOT,
  BUNDLED_PROMPT_PREAMBLE: path.join(BUNDLED_CONFIG_ROOT, "prompt_preamble.txt"),
  BUNDLED_LAYOUT_GALLERY1: path.join(BUNDLED_CONFIG_ROOT, "layout.gallery1.json"),
  BUNDLED_LAYOUT_GALLERY2: path.join(BUNDLED_CONFIG_ROOT, "layout.gallery2.json"),
  RUNTIME: path.join(DATA_ROOT, "runtime"),
  RUNTIME_CURRENT: path.join(DATA_ROOT, "runtime", "current"),
  RUNTIME_INCOMING: path.join(DATA_ROOT, "runtime", "incoming_selfies"),
  RUNTIME_WORK: path.join(DATA_ROOT, "runtime", "work"),
  RUNTIME_JOBS: path.join(DATA_ROOT, "runtime", "work", "jobs"),
  RUNTIME_SELFIES: path.join(DATA_ROOT, "runtime", "work", "selfies"),
  RUNTIME_GENAI_RESULTS: path.join(DATA_ROOT, "runtime", "work", "genai_results"),
  RUNTIME_SLOTMETA: path.join(DATA_ROOT, "runtime", "work", "slotmeta.json"),
  RUNTIME_MANUAL: path.join(DATA_ROOT, "runtime", "manual"),
  RUNTIME_ACCEPTED: path.join(DATA_ROOT, "runtime", "accepted"),
  RUNTIME_OUTGOING: path.join(DATA_ROOT, "runtime", "outgoing_for_other_app"),
  RUNTIME_LOGS: path.join(DATA_ROOT, "runtime", "logs"),
  CONFIG_DIR: path.join(DATA_ROOT, "config"),
  CONFIG_GALLERY_BACKGROUNDS_DIR: path.join(DATA_ROOT, "config", "gallery_backgrounds"),
  APP_CONFIG: path.join(DATA_ROOT, "config", "app.config.json"),
  PROMPT_PREAMBLE: path.join(DATA_ROOT, "config", "prompt_preamble.txt"),
  LAYOUT_GALLERY1: path.join(DATA_ROOT, "config", "layout.gallery1.json"),
  LAYOUT_GALLERY2: path.join(DATA_ROOT, "config", "layout.gallery2.json"),
  PUBLIC_DIR: path.join(ROOT, "public")
};

function toAbsoluteMaybeRelative(p) {
  if (!p) return p;
  // Config often stores relative paths; resolve from DATA_ROOT consistently.
  return path.isAbsolute(p) ? p : path.join(DATA_ROOT, p);
}

function toRelativeIfInsideRoot(absPath) {
  if (!absPath) return absPath;
  const bases = [DATA_ROOT, ROOT];
  for (const base of bases) {
    const rel = path.relative(base, absPath);
    if (!rel.startsWith("..") && !path.isAbsolute(rel)) {
      return rel.replace(/\\/g, "/");
    }
  }
  return absPath;
}

module.exports = {
  PATHS,
  toAbsoluteMaybeRelative,
  toRelativeIfInsideRoot
};
