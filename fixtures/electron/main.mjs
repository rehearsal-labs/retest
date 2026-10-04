// A task list for Retest's Electron tests. The tasks live in this process's memory, so every launch starts empty and
// a reload of the window keeps them. Every control the tests use has a data-testid. With `--service=<url>` the window
// works on the cross-platform fixture's service instead: see service-mode.mjs.
import { app, BrowserWindow, ipcMain } from 'electron'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { serviceOrigin, startServiceMode } from './service-mode.mjs'

const here = (path) => fileURLToPath(new URL(path, import.meta.url))
const tasks = []
let nextId = 1

// `--echo-typed` prints each title the window adds to stdout, as an app that logs what it was given would, for the test
// that checks such output is redacted before it reaches Retest's log.
const echoTyped = process.argv.includes('--echo-typed')

// `--show-variables=A,B` names environment variables whose presence the window shows, never their values.
const shown = process.argv.find((argument) => argument.startsWith('--show-variables='))
const variables = shown === undefined ? [] : shown.slice('--show-variables='.length).split(',').filter((name) => name !== '')

// `--serve=<port>` serves the window's pages from http://127.0.0.1:<port>/ instead of their files, for a test that needs
// a web origin, as a secret does. Only the pages and the script are served.
const serving = process.argv.find((argument) => argument.startsWith('--serve='))
const port = serving === undefined ? undefined : Number(serving.slice('--serve='.length))
const pages = new Map([
  ['/index.html', 'text/html'],
  ['/about.html', 'text/html'],
  ['/second.html', 'text/html'],
  ['/renderer.js', 'text/javascript'],
])

function serve() {
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    const type = pages.get(path)
    if (type === undefined) return void response.writeHead(404).end()
    readFile(here(`./renderer${path}`)).then(
      (body) => response.writeHead(200, { 'content-type': `${type}; charset=utf-8` }).end(body),
      () => response.writeHead(500).end(),
    )
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
}

// `--service=<url>` signs in to that service, a loopback http address, and `--account=<name>` fills in the account to
// sign in with. The password is never an argument: it is typed into the window.
const serviceArgument = process.argv.find((argument) => argument.startsWith('--service='))
const service = serviceArgument === undefined ? undefined : serviceOrigin(serviceArgument.slice('--service='.length))
const account = process.argv.find((argument) => argument.startsWith('--account='))?.slice('--account='.length) ?? ''

function load(window, page) {
  return port === undefined ? window.loadFile(here(`./renderer/${page}`)) : window.loadURL(`http://127.0.0.1:${port}/${page}`)
}

ipcMain.handle('tasks:list', () => tasks.map((task) => ({ ...task })))
ipcMain.handle('tasks:add', (_event, title) => {
  if (echoTyped) console.log(`typed: ${String(title)}`)
  const task = { id: `t${nextId}`, title: String(title).trim(), done: false }
  nextId += 1
  if (task.title !== '') tasks.push(task)
  return tasks.map((entry) => ({ ...entry }))
})
ipcMain.handle('tasks:toggle', (_event, id, done) => {
  const task = tasks.find((entry) => entry.id === id)
  if (task !== undefined) task.done = done === true
  return tasks.map((entry) => ({ ...entry }))
})
ipcMain.handle('environment:variables', () => variables.map((name) => ({ name, present: process.env[name] !== undefined })))
ipcMain.handle('window:open-second', () => {
  // Small and to one side, so it never covers the first window whole.
  const second = new BrowserWindow({ width: 360, height: 200, x: 40, y: 40, title: 'Second window' })
  void load(second, 'second.html')
})

function openFirstWindow(address) {
  const window = new BrowserWindow({
    width: 720,
    height: 640,
    x: 440,
    y: 80,
    webPreferences: { preload: here('./preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  })
  void (address === undefined ? load(window, 'index.html') : window.loadURL(address))
}

// The folder the app keeps its data in, for the tests that check what becomes of it once the app quits.
app.whenReady().then(async () => {
  console.log(`user data in ${app.getPath('userData')}`)
  if (serviceArgument !== undefined && service === undefined) {
    console.error('--service takes a plain http address on a loopback name, such as http://127.0.0.1:4310')
    return app.exit(2)
  }
  if (port !== undefined) await serve()
  openFirstWindow(service === undefined ? undefined : startServiceMode(service, account))
})
app.on('window-all-closed', () => app.quit())
