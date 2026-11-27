// SPDX-License-Identifier: AGPL-3.0-only
// Preload of the main window: one door, for a Creality project.obp the user drops or picks.
// The page gets no file paths and no Node; the main process only opens the .obp it is handed.
const { contextBridge, ipcRenderer, webUtils } = require('electron')

contextBridge.exposeInMainWorld('srProject', {
  open: (file) => ipcRenderer.invoke('project:open', webUtils.getPathForFile(file)),
})
