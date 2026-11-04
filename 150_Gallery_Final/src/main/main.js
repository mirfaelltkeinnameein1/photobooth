const { app, BrowserWindow, Menu, dialog, shell } = require("electron");
const path = require("path");
const { Logger } = require("./logger");
const { StateManager } = require("./stateManager");
const { startServer } = require("./server");

// Main process bootstrap. Keep it lean: init state, start server, create windows.
let logger;
let stateManager;
let httpServer;

let operatorWindow;
let gallery1Window;
let gallery2Window;

function bindF11(window) {
  // Keep fullscreen toggle local to each window so ops can quickly recover layout.
  window.webContents.on("before-input-event", (event, input) => {
    if (input.type === "keyDown" && input.key === "F11") {
      window.setFullScreen(!window.isFullScreen());
      event.preventDefault();
    }
  });
}

async function createWindows(port) {
  const cfg = stateManager.config.window_bounds || {};
  const common = {
    show: true,
    webPreferences: {
      // Renderer is plain browser JS; keep node off in renderer for safety.
      contextIsolation: true,
      nodeIntegration: false
    }
  };

  operatorWindow = new BrowserWindow({
    title: "Operator Panel",
    width: cfg.operator?.width || 1600,
    height: cfg.operator?.height || 980,
    ...common
  });
  operatorWindow.loadURL(`http://127.0.0.1:${port}/operator.html`);
  bindF11(operatorWindow);

  gallery1Window = new BrowserWindow({
    title: "Gallery 1",
    width: cfg.gallery1?.width || 1280,
    height: cfg.gallery1?.height || 720,
    ...common
  });
  gallery1Window.loadURL(`http://127.0.0.1:${port}/gallery.html?gallery=gallery1`);
  bindF11(gallery1Window);

  gallery2Window = new BrowserWindow({
    title: "Gallery 2",
    width: cfg.gallery2?.width || 1280,
    height: cfg.gallery2?.height || 720,
    ...common
  });
  gallery2Window.loadURL(`http://127.0.0.1:${port}/gallery.html?gallery=gallery2`);
  bindF11(gallery2Window);

  const persistBounds = async () => {
    // Save on close so relaunch comes back where the op left it.
    stateManager.config.window_bounds = {
      operator: operatorWindow && !operatorWindow.isDestroyed() ? operatorWindow.getBounds() : cfg.operator,
      gallery1: gallery1Window && !gallery1Window.isDestroyed() ? gallery1Window.getBounds() : cfg.gallery1,
      gallery2: gallery2Window && !gallery2Window.isDestroyed() ? gallery2Window.getBounds() : cfg.gallery2
    };
    await stateManager.saveConfig();
  };

  operatorWindow.on("close", persistBounds);
  gallery1Window.on("close", persistBounds);
  gallery2Window.on("close", persistBounds);
}

async function bootstrap() {
  // Kiosk-ish setup, we don't need native app menus.
  Menu.setApplicationMenu(null);
  logger = new Logger();
  await logger.init();

  stateManager = new StateManager(logger);
  await stateManager.init();

  httpServer = await startServer({
    stateManager,
    logger,
    chooseDirectory: async () => {
      const focused = BrowserWindow.getFocusedWindow() || operatorWindow || null;
      const result = await dialog.showOpenDialog(focused, {
        properties: ["openDirectory", "createDirectory"]
      });
      if (result.canceled || !result.filePaths?.length) return null;
      return result.filePaths[0];
    },
    openPath: async (target) => shell.openPath(target)
  });

  await createWindows(httpServer.port);
}

app.whenReady().then(bootstrap);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", async () => {
  if (BrowserWindow.getAllWindows().length === 0 && httpServer?.port) {
    await createWindows(httpServer.port);
  }
});
