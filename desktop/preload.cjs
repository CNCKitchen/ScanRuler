// SPDX-License-Identifier: AGPL-3.0-only
// Preload of the Hardware panel only: the main window gets none, so the
// ScanRuler page has no path to Node.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('hw', {
  info: () => ipcRenderer.invoke('hw:info'),
  setBackend: (backend) => ipcRenderer.invoke('hw:set-backend', backend),
  restart: () => ipcRenderer.invoke('hw:restart'),
})
