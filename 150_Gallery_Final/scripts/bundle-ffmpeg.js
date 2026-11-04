const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

// Build-time helper to bundle ffmpeg/ffprobe into build/bin for packaging.
function findBinaryOnPath(name) {
  const cmd = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(cmd, [name], { encoding: "utf8" });
  if (result.status === 0) {
    const lines = String(result.stdout || "")
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    const found = lines.find((p) => fs.existsSync(p));
    if (found) return found;
  }

  if (process.platform === "win32") {
    // WinGet shims are common on fresh Windows installs.
    const aliasPath = path.join(
      process.env.LOCALAPPDATA || "",
      "Microsoft",
      "WinGet",
      "Links",
      `${name}.exe`
    );
    if (fs.existsSync(aliasPath)) return aliasPath;
  }
  return null;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function copyBinary(srcPath, destPath) {
  fs.copyFileSync(srcPath, destPath);
  console.log(`[bundle-ffmpeg] Copied ${srcPath} -> ${destPath}`);
}

function main() {
  const ffmpegSrc = findBinaryOnPath("ffmpeg");
  const ffprobeSrc = findBinaryOnPath("ffprobe");
  if (!ffmpegSrc || !ffprobeSrc) {
    throw new Error("ffmpeg/ffprobe not found on PATH. Install ffmpeg first.");
  }

  const outDir = path.join(process.cwd(), "build", "bin");
  ensureDir(outDir);

  const ffmpegName = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  const ffprobeName = process.platform === "win32" ? "ffprobe.exe" : "ffprobe";
  copyBinary(ffmpegSrc, path.join(outDir, ffmpegName));
  copyBinary(ffprobeSrc, path.join(outDir, ffprobeName));
}

try {
  main();
} catch (err) {
  console.error(`[bundle-ffmpeg] ${err.message}`);
  process.exit(1);
}
