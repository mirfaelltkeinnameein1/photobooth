const { spawn } = require("child_process");

// Dev helper: runs css watcher + electron side by side.
function run(name, cmd, args, extra = {}) {
  const child = spawn(cmd, args, { stdio: "inherit", shell: false, ...extra });
  child.on("exit", (code) => {
    if (code !== 0) {
      console.error(`${name} exited with code ${code}`);
      process.exit(code || 1);
    }
  });
  return child;
}

const css = run("tailwind", "cmd", ["/c", "npm run watch:css"]);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
// Explicitly launch Electron in app mode so it doesn't inherit node-only behavior.
const app = run("electron", "cmd", ["/c", "npx electron ."], { env });

function stopAll() {
  if (!css.killed) css.kill();
  if (!app.killed) app.kill();
}

process.on("SIGINT", stopAll);
process.on("SIGTERM", stopAll);
