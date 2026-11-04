const SERVICE_NAME = "gallery-composer";
const ACCOUNT_NAME = "gemini-api-key";

let keytar = null;
try {
  keytar = require("keytar");
} catch (err) {
  // Keep app running even if keytar isn't available on this machine.
  keytar = null;
}

// Windows Credential Manager bridge (keytar).
function ensureKeytar() {
  if (!keytar) {
    throw new Error("Secure key storage unavailable: keytar is not installed. Run npm install.");
  }
}

async function getApiKey() {
  ensureKeytar();
  const value = await keytar.getPassword(SERVICE_NAME, ACCOUNT_NAME);
  return value || "";
}

async function setApiKey(value) {
  ensureKeytar();
  // Blank is still a valid write, caller decides whether to clear or set.
  await keytar.setPassword(SERVICE_NAME, ACCOUNT_NAME, String(value || ""));
}

async function clearApiKey() {
  ensureKeytar();
  await keytar.deletePassword(SERVICE_NAME, ACCOUNT_NAME);
}

module.exports = {
  getApiKey,
  setApiKey,
  clearApiKey
};
