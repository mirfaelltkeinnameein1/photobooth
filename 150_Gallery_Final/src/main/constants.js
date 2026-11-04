// App-wide constants. Keep this tiny and boring on purpose.
const GALLERIES = ["gallery1", "gallery2"];

// 12 global slots. UI can distribute them across either gallery at runtime.
const SLOT_IDS = [
  "slot01",
  "slot02",
  "slot03",
  "slot04",
  "slot05",
  "slot06",
  "slot07",
  "slot08",
  "slot09",
  "slot10",
  "slot11",
  "slot12"
];

const SLOT_GROUPS = ["group1", "group2"];

const MODELS = ["gemini-3-pro-image-preview", "gemini-2.5-flash-image"];

// Keep job states explicit (instead of bool flags) so UI/debug logs stay readable.
const JOB_STATES = {
  NEW: "NEW",
  SLOTTED: "SLOTTED",
  GENERATING: "GENERATING",
  AWAITING_REVIEW: "AWAITING_REVIEW",
  ACCEPTED_PARTIAL: "ACCEPTED_PARTIAL",
  ACCEPTED_BOTH: "ACCEPTED_BOTH",
  DELIVERED: "DELIVERED",
  BLOCKED: "BLOCKED",
  FAILED: "FAILED"
};

module.exports = {
  GALLERIES,
  SLOT_IDS,
  SLOT_GROUPS,
  MODELS,
  JOB_STATES
};
