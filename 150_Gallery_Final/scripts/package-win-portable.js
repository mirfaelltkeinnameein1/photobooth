const path = require("path");
const pkg = require("../package.json");

// Portable unsigned packager wrapper used for client handoff builds.
// Workaround: some Windows environments block rcedit child process execution (spawn EPERM).
// For unsigned portable builds, metadata stamping is optional, so we skip it.
try {
  const win32 = require("electron-packager/src/win32");
  if (win32 && win32.App && win32.App.prototype) {
    win32.App.prototype.needsRcedit = function needsRceditPatched() {
      return false;
    };
  }
} catch (_) {}

const packager = require("electron-packager");

async function main() {
  const cacheRoot = path.join(process.cwd(), ".electron-cache");
  process.env.ELECTRON_CACHE = cacheRoot;

  const appPaths = await packager({
    dir: process.cwd(),
    out: path.join(process.cwd(), "dist"),
    overwrite: true,
    platform: "win32",
    arch: "x64",
    electronVersion: (pkg.devDependencies && pkg.devDependencies.electron || "").replace(/^\^/, ""),
    download: { cacheRoot },
    asar: true,
    prune: true,
    name: "Gallery Composer",
    executableName: "GalleryComposer",
    extraResource: [
      // Bundle runtime dependencies needed on target machine.
      path.join(process.cwd(), "build", "bin"),
      path.join(process.cwd(), "assets")
    ],
    ignore: [
      /^\/assets($|\/)/,
      /^\/runtime($|\/)/,
      /^\/dist($|\/)/,
      /^\/\.npm-cache($|\/)/,
      /^\/\.electron-cache($|\/)/,
      /^\/build($|\/)/,
      /^\/build\/bin($|\/)/
    ]
  });

  console.log(`[package-win-portable] Output: ${appPaths.join(", ")}`);
}

main().catch((err) => {
  console.error(`[package-win-portable] ${err.message}`);
  if (err.code) console.error(`[package-win-portable] code=${err.code}`);
  if (err.syscall) console.error(`[package-win-portable] syscall=${err.syscall}`);
  if (err.path) console.error(`[package-win-portable] path=${err.path}`);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
