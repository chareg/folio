const { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme } = require("electron");
const path = require("path");
const fs = require("fs");
const { autoUpdater } = require("electron-updater");

let win = null;
let pending = null; // a file asked for before the window was ready
let ready = false;

function docxFromArgs(argv) {
  return argv.slice(1).find((a) => /\.(docx|docm|dotx)$/i.test(a) && fs.existsSync(a)) || null;
}

function sendFile(file) {
  if (!file) return;
  if (!win || !ready) { pending = file; return; }
  try {
    const bytes = fs.readFileSync(file);
    win.webContents.send("open-file", { name: path.basename(file), path: file, bytes });
    app.addRecentDocument && app.addRecentDocument(file);
  } catch (e) {
    dialog.showErrorBox("Folio couldn't open that file", String(e.message || e));
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
else {
  app.on("second-instance", (_e, argv) => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
    sendFile(docxFromArgs(argv));
  });

  app.whenReady().then(() => {
    const dark = nativeTheme.shouldUseDarkColors;
    win = new BrowserWindow({
      width: 1280, height: 860, minWidth: 420, minHeight: 360,
      title: "Folio",
      backgroundColor: dark ? "#15131b" : "#fbfafc",
      titleBarStyle: "hidden",
      titleBarOverlay: { color: dark ? "#15131b" : "#fbfafc", symbolColor: dark ? "#c3bccd" : "#4a4557", height: 56 },
      icon: path.join(__dirname, "app", "icon.png"),
      show: false,
      webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false }
    });
    win.setMenu(null);
    win.once("ready-to-show", () => win.show());
    win.loadFile(path.join(__dirname, "app", "index.html"));
    win.webContents.on("did-finish-load", () => {
      ready = true;
      const f = pending || docxFromArgs(process.argv);
      pending = null;
      if (f) sendFile(f);
    });
    // Links in documents open in the normal browser; Folio never navigates away.
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^(https?|mailto):/i.test(url)) shell.openExternal(url);
      return { action: "deny" };
    });
    win.webContents.on("will-navigate", (e, url) => {
      if (!url.startsWith("file:")) { e.preventDefault(); if (/^(https?|mailto):/i.test(url)) shell.openExternal(url); }
    });
    win.on("page-title-updated", (e, title) => { /* keep document titles in the taskbar */ });
  });

  ipcMain.handle("open-dialog", async () => {
    const r = await dialog.showOpenDialog(win, {
      title: "Open a Word document",
      properties: ["openFile"],
      filters: [{ name: "Word documents", extensions: ["docx", "docm", "dotx"] }]
    });
    if (!r.canceled && r.filePaths[0]) sendFile(r.filePaths[0]);
  });
  ipcMain.on("title-colors", (_e, c) => {
    if (!win || !c) return;
    try { win.setTitleBarOverlay({ color: c.color, symbolColor: c.symbolColor, height: c.height || 56 }); win.setBackgroundColor(c.color); } catch (e) {}
  });
  /* ---------- updates from GitHub Releases ---------- */
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  const updateStatus = (s) => { if (win && !win.isDestroyed()) win.webContents.send("update-status", s); };
  let available = null;
  autoUpdater.on("checking-for-update", () => updateStatus({ state: "checking" }));
  autoUpdater.on("update-available", (info) => { available = info.version; updateStatus({ state: "downloading", version: info.version }); });
  autoUpdater.on("update-not-available", () => updateStatus({ state: "current" }));
  autoUpdater.on("download-progress", (p) => updateStatus({ state: "downloading", version: available, percent: p.percent }));
  autoUpdater.on("update-downloaded", (info) => updateStatus({ state: "ready", version: info.version }));
  autoUpdater.on("error", (e) => updateStatus({ state: "error", message: String((e && e.message) || e) }));
  const checkForUpdates = () => {
    if (!app.isPackaged) { updateStatus({ state: "dev" }); return; }
    autoUpdater.checkForUpdates().catch((e) => updateStatus({ state: "error", message: String(e && e.message || e) }));
  };
  ipcMain.on("update-check", checkForUpdates);
  ipcMain.on("update-install", () => autoUpdater.quitAndInstall(false, true));
  ipcMain.handle("app-version", () => app.getVersion());
  app.whenReady().then(() => setTimeout(() => { if (app.isPackaged) checkForUpdates(); }, 4000));

  ipcMain.on("toggle-fullscreen", () => { if (win) win.setFullScreen(!win.isFullScreen()); });

  app.on("window-all-closed", () => app.quit());
}
