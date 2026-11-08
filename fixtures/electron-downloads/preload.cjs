// The only bridge between the window and the main process: how the main process handles the next download, and the
// downloads it starts itself.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('fixture', {
  handle: (handling) => ipcRenderer.invoke('downloads:handle', handling),
  downloadForWindow: (path) => ipcRenderer.invoke('downloads:for-window', path),
  downloadForSession: (path) => ipcRenderer.invoke('downloads:for-session', path),
})
