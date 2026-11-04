const fs = require("fs");
const path = require("path");
const EventEmitter = require("events");
const { ensureDir, nowIso } = require("./fsutils");
const { PATHS } = require("./paths");

// Simple file logger + in-memory fanout for SSE/UI.
class Logger extends EventEmitter {
  constructor() {
    super();
    // Single rolling file is enough here; UI already streams live logs over SSE.
    this.logPath = path.join(PATHS.RUNTIME_LOGS, "app.log");
    this.maxBytes = 5 * 1024 * 1024;
    this.initialized = false;
  }

  async init() {
    if (this.initialized) return;
    await ensureDir(PATHS.RUNTIME_LOGS);
    await this.rotateIfNeeded();
    this.initialized = true;
  }

  async rotateIfNeeded() {
    try {
      const stat = await fs.promises.stat(this.logPath);
      if (stat.size < this.maxBytes) return;
      // Keep just one previous file. Simpler for event ops than deep rotations.
      const rotatedPath = `${this.logPath}.1`;
      try {
        await fs.promises.unlink(rotatedPath);
      } catch (err) {
        if (err?.code !== "ENOENT") {
          console.warn(`[logger] failed deleting rotated log: ${err.message}`);
        }
      }
      await fs.promises.rename(this.logPath, rotatedPath);
    } catch (err) {
      if (err?.code !== "ENOENT") {
        console.warn(`[logger] rotate check failed: ${err.message}`);
      }
    }
  }

  async write(level, module, message, meta = {}) {
    await this.init();
    const entry = {
      ts: nowIso(),
      level,
      module,
      message,
      ...meta
    };
    const uuidTag = meta.job_uuid ? ` [job:${meta.job_uuid}]` : "";
    const line = `${entry.ts} [${level.toUpperCase()}] [${module}]${uuidTag} ${message}${Object.keys(meta).length ? " " + JSON.stringify(meta) : ""}\n`;
    await fs.promises.appendFile(this.logPath, line, "utf8");
    // Push same entry to in-memory listeners so operator UI updates instantly.
    this.emit("log", entry);
  }

  info(module, message, meta) {
    return this.write("info", module, message, meta);
  }

  warn(module, message, meta) {
    return this.write("warn", module, message, meta);
  }

  success(module, message, meta) {
    return this.write("success", module, message, meta);
  }

  error(module, message, meta) {
    return this.write("error", module, message, meta);
  }
}

module.exports = { Logger };
