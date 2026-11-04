const fs = require("fs");
const path = require("path");

// Small filesystem helpers used all over the app.

async function ensureDir(dirPath) {
  await fs.promises.mkdir(dirPath, { recursive: true });
}

async function fileExists(filePath) {
  try {
    await fs.promises.access(filePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function readJsonSafe(filePath, fallback = null) {
  try {
    const raw = await fs.promises.readFile(filePath, "utf8");
    // Editors like Notepad/PowerShell may prepend a UTF-8 BOM, which JSON.parse rejects.
    return JSON.parse(raw.replace(/^﻿/, ""));
  } catch {
    return fallback;
  }
}

async function atomicWriteFile(filePath, content) {
  const dir = path.dirname(filePath);
  await ensureDir(dir);
  // Write + rename so readers never see half-written json/txt files.
  const tmpPath = `${filePath}.tmp`;
  await fs.promises.writeFile(tmpPath, content);
  await fs.promises.rename(tmpPath, filePath);
}

async function atomicWriteJson(filePath, data) {
  const content = JSON.stringify(data, null, 2);
  await atomicWriteFile(filePath, content);
}

async function copyFileIfMissing(source, destination) {
  // "seed once" helper used for defaults/runtime bootstrap.
  if (!(await fileExists(destination)) && (await fileExists(source))) {
    await ensureDir(path.dirname(destination));
    await fs.promises.copyFile(source, destination);
  }
}

async function readTextSafe(filePath, fallback = "") {
  try {
    return await fs.promises.readFile(filePath, "utf8");
  } catch {
    return fallback;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function sanitizeFilePart(v) {
  return String(v || "").replace(/[^a-zA-Z0-9._-]/g, "_");
}

module.exports = {
  ensureDir,
  fileExists,
  readJsonSafe,
  atomicWriteFile,
  atomicWriteJson,
  copyFileIfMissing,
  readTextSafe,
  nowIso,
  sanitizeFilePart
};
