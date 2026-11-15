const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("folioDesktop", {
  onOpenFile: (cb) => ipcRenderer.on("open-file", (_e, f) => cb({ name: f.name, path: f.path, bytes: f.bytes, mtimeMs: f.mtimeMs })),
  openDialog: () => ipcRenderer.invoke("open-dialog"),
  setTitleColors: (c) => ipcRenderer.send("title-colors", c),
  toggleFullscreen: () => ipcRenderer.send("toggle-fullscreen"),
  platform: process.platform,
  getVersion: () => ipcRenderer.invoke("app-version"),
  checkForUpdates: () => ipcRenderer.send("update-check"),
  installUpdate: () => ipcRenderer.send("update-install"),
  onUpdateStatus: (cb) => ipcRenderer.on("update-status", (_e, s) => cb(s)),
  saveDocx: (req) => ipcRenderer.invoke("save-docx", req),
  showInFolder: (p) => ipcRenderer.invoke("show-in-folder", p),
  setDirty: (v) => ipcRenderer.send("set-dirty", !!v),
  onConfirmClose: (cb) => ipcRenderer.on("confirm-close", () => cb()),
  closeNow: () => ipcRenderer.send("close-now")
});
