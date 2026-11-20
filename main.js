const { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme, Menu } = require("electron");
const path = require("path");
const fs = require("fs");
const { autoUpdater } = require("electron-updater");

let win = null;
let pending = null; // a file asked for before the window was ready
let ready = false;
let dirty = false;      // unsaved edits in the window
let closing = false;    // the user already agreed to close

function docFromArgs(argv) {
  return argv.slice(1).find((a) => /\.(docx|docm|dotx|pdf)$/i.test(a) && fs.existsSync(a)) || null;
}

function sendFile(file) {
  if (!file) return;
  if (!win || !ready) { pending = file; return; }
  try {
    const bytes = fs.readFileSync(file);
    const mtimeMs = fs.statSync(file).mtimeMs;
    win.webContents.send("open-file", { name: path.basename(file), path: file, bytes, mtimeMs });
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
    sendFile(docFromArgs(argv));
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
      const f = pending || docFromArgs(process.argv);
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
    // Unsaved edits: let the page ask the user (it has a nicer dialog than we do).
    win.on("close", (e) => {
      if (dirty && !closing) { e.preventDefault(); win.webContents.send("confirm-close"); }
    });
    // Right-click: the usual editing commands.
    win.webContents.on("context-menu", (_e, params) => {
      const items = [];
      if (params.isEditable) {
        items.push({ role: "cut", enabled: params.editFlags.canCut }, { role: "copy", enabled: params.editFlags.canCopy },
          { role: "paste", enabled: params.editFlags.canPaste }, { type: "separator" }, { role: "selectAll" });
      } else if (params.selectionText) items.push({ role: "copy" });
      if (items.length) Menu.buildFromTemplate(items).popup({ window: win });
    });
  });

  ipcMain.handle("open-dialog", async () => {
    const r = await dialog.showOpenDialog(win, {
      title: "Open a document",
      properties: ["openFile"],
      filters: [
        { name: "Documents", extensions: ["docx", "docm", "dotx", "pdf"] },
        { name: "Word documents", extensions: ["docx", "docm", "dotx"] },
        { name: "PDFs", extensions: ["pdf"] }
      ]
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

  /* ---------- saving edits ---------- */
  ipcMain.on("set-dirty", (_e, v) => { dirty = !!v; if (win) win.setDocumentEdited && win.setDocumentEdited(dirty); });
  ipcMain.on("close-now", () => { closing = true; if (win) win.close(); });
  ipcMain.handle("show-in-folder", (_e, p) => { if (typeof p === "string" && fs.existsSync(p)) shell.showItemInFolder(p); });
  ipcMain.handle("save-docx", async (_e, req) => {
    try { return await saveDocx(req || {}); } catch (e) { return { error: String((e && e.message) || e) }; }
  });

  function uniquePath(dir, base) {
    let p = path.join(dir, base + ".docx");
    for (let n = 2; fs.existsSync(p) && n < 1000; n++) p = path.join(dir, base.replace(/\)$/, " " + n + ")") + ".docx");
    return p;
  }

  // Keep the version being replaced, so an overwrite is never the end of the world.
  function backup(file) {
    const dir = path.join(app.getPath("userData"), "Backups");
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:T]/g, "-").replace(/\..+$/, "");
    const dest = path.join(dir, path.basename(file, path.extname(file)) + " " + stamp + path.extname(file));
    fs.copyFileSync(file, dest);
    const all = fs.readdirSync(dir).map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t);
    all.slice(40).forEach((x) => { try { fs.unlinkSync(path.join(dir, x.f)); } catch (e) {} });
    return dest;
  }

  // Write next to the target, then swap it in, so a failed save never leaves half a file.
  function writeSafely(target, bytes) {
    const tmp = path.join(path.dirname(target), "." + path.basename(target) + "." + process.pid + ".folio-tmp");
    try {
      fs.writeFileSync(tmp, Buffer.from(bytes));
      fs.renameSync(tmp, target);
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch (e2) {}
      if (/EBUSY|EPERM|EACCES/.test(e.code || "")) return { error: "locked" };
      throw e;
    }
    return null;
  }

  async function saveDocx(req) {
    const bytes = req.bytes;
    if (!bytes || !bytes.length) return { error: "nothing to save" };
    let target;
    if (req.mode === "copy") {
      const dir = req.sourcePath ? path.dirname(req.sourcePath) : app.getPath("documents");
      const base = (req.suggestedName || "Document (edited).docx").replace(/\.docx$/i, "").replace(/[\\/:*?"<>|]+/g, "-");
      const r = await dialog.showSaveDialog(win, {
        title: "Save a copy", defaultPath: uniquePath(dir, base), buttonLabel: "Save copy",
        filters: [{ name: "Word document", extensions: ["docx"] }]
      });
      if (r.canceled || !r.filePath) return { canceled: true };
      target = /\.docx$/i.test(r.filePath) ? r.filePath : r.filePath + ".docx";
    } else {
      target = req.path;
      if (!target) return { error: "no file to replace" };
      if (fs.existsSync(target) && req.expectedMtimeMs && Math.abs(fs.statSync(target).mtimeMs - req.expectedMtimeMs) > 2) return { conflict: true };
    }
    if (fs.existsSync(target)) backup(target);
    const fail = writeSafely(target, bytes);
    if (fail) return fail;
    app.addRecentDocument && app.addRecentDocument(target);
    return { ok: true, path: target, name: path.basename(target), mtimeMs: fs.statSync(target).mtimeMs };
  }

  app.on("window-all-closed", () => app.quit());
}
