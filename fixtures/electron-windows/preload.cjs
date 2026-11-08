// The only bridge between the windows and the main process: the settings window, and the theme it saves.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('fixture', {
  openSettings: () => ipcRenderer.invoke('settings:open'),
  openSettingsLater: () => ipcRenderer.invoke('settings:open-later'),
  theme: () => ipcRenderer.invoke('settings:theme'),
  saveTheme: (theme) => ipcRenderer.invoke('settings:save', theme),
  onThemeChanged: (listener) => ipcRenderer.on('settings:changed', (_event, theme) => listener(theme)),
})
