// An Electron app for Retest's download tests. Its window starts downloads from a loopback server the test runs, and
// its main process handles each download in its will-download handler as the window last asked: it leaves it alone,
// gives it a path of its own, asks for a save dialog, cancels it, prevents it, or pauses it. The main process can also
// start a download itself, for the window or for no window. It prints what its handler did and how each download
// ended, so a test reads in the app's log what the app believed.
import { app, BrowserWindow, ipcMain, session } from 'electron'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = (path) => fileURLToPath(new URL(path, import.meta.url))
const argument = (name) => process.argv.find((entry) => entry.startsWith(`--${name}=`))?.slice(name.length + 3)

// `--files=<origin>`: the loopback http server whose files the window downloads.
const files = argument('files') ?? ''
// `--save-dir=<folder>`: where the `save-path` handling saves each download, as an app that picks its own path does.
const saveDir = argument('save-dir')
// `--partition=<name>`: opens the window in a session of its own instead of the app's default session.
const partition = argument('partition')
const handlings = new Set(['none', 'save-path', 'save-dialog', 'cancel', 'prevent', 'pause'])
let handling = 'none'

ipcMain.handle('downloads:handle', (_event, chosen) => {
  if (handlings.has(chosen)) handling = chosen
  return handling
})
// The main process downloads for the window, as an app that fetches a file a click asked for does.
ipcMain.handle('downloads:for-window', (event, path) => event.sender.downloadURL(`${files}${path}`))
// The main process downloads for no window, through the window's session.
ipcMain.handle('downloads:for-session', (event, path) => event.sender.session.downloadURL(`${files}${path}`))

function handle(downloads) {
  downloads.on('will-download', (event, item) => {
    const name = item.getFilename()
    console.log(`will-download ${name}: ${handling}`)
    // Heard before the handling, since a download cancelled here ends at once.
    item.once('done', (_event, state) => console.log(`done ${name}: ${state}, save path ${JSON.stringify(item.getSavePath())}`))
    if (handling === 'save-path') item.setSavePath(join(saveDir ?? app.getPath('temp'), name))
    else if (handling === 'save-dialog') item.setSaveDialogOptions({ title: `Save ${name}` })
    else if (handling === 'cancel') item.cancel()
    else if (handling === 'prevent') event.preventDefault()
    else if (handling === 'pause') item.pause()
  })
}

app.whenReady().then(() => {
  const downloads = partition === undefined ? session.defaultSession : session.fromPartition(partition)
  handle(downloads)
  const window = new BrowserWindow({
    width: 560,
    height: 420,
    x: 60,
    y: 60,
    webPreferences: { preload: here('./preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, ...(partition === undefined ? {} : { partition }) },
  })
  void window.loadFile(here('./index.html'), { query: { files } })
})
app.on('window-all-closed', () => app.quit())
