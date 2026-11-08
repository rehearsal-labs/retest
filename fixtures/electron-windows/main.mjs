// Windows for Retest's tests of page.popup() in an Electron app. The first window opens the others in both ways an app
// can: its document opens a notes window by window.open and a help window by a link with a target, and the main
// process makes a settings window when the first window asks it to, at once or a moment later. The theme the settings
// window saves lives in this process's memory and is sent back to the first window.
import { app, BrowserWindow, ipcMain } from 'electron'
import { fileURLToPath } from 'node:url'

const here = (path) => fileURLToPath(new URL(path, import.meta.url))
const webPreferences = { preload: here('./preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true }
let theme = 'light'
let firstWindow

function openSettings() {
  // Small and to one side, so it never covers the first window whole.
  const settings = new BrowserWindow({ width: 380, height: 320, x: 40, y: 40, title: 'Settings', webPreferences })
  void settings.loadFile(here('./renderer/settings.html'))
}

ipcMain.handle('settings:open', () => openSettings())
ipcMain.handle('settings:open-later', () => {
  setTimeout(openSettings, 400)
})
ipcMain.handle('settings:theme', () => theme)
ipcMain.handle('settings:save', (_event, next) => {
  theme = next === 'dark' ? 'dark' : 'light'
  firstWindow?.webContents.send('settings:changed', theme)
  return theme
})

// A window a document opens is small and to one side too.
app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(() => ({ action: 'allow', overrideBrowserWindowOptions: { width: 380, height: 320, x: 60, y: 60 } }))
})

app.whenReady().then(() => {
  firstWindow = new BrowserWindow({ width: 720, height: 560, x: 440, y: 80, webPreferences })
  void firstWindow.loadFile(here('./renderer/index.html'))
})
app.on('window-all-closed', () => app.quit())
