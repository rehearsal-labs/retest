// The fixture's service mode: the window signs in to the cross-platform fixture's service with a seeded account,
// creates tasks there and follows them, as the `electron` client. Every request to the service is the main process's,
// and names the client in `x-task-client`. The window's own page is shown under the service's origin, from this app's
// files, so a secret bound to that origin may be typed into it. Nothing here holds an account's password: it comes from
// the window, and goes only to the service.
import { ipcMain, net, protocol } from 'electron'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const here = (path) => fileURLToPath(new URL(path, import.meta.url))
const client = 'electron'
// The service answers only a loopback name, and the app reaches nothing else.
const loopback = /^(127\.\d{1,3}\.\d{1,3}\.\d{1,3}|localhost|\[::1\])$/

/** The service's origin, from `--service=<url>`, when it is a plain http address on a loopback name. */
export function serviceOrigin(text) {
  const url = URL.parse(text)
  if (url === null || url.protocol !== 'http:' || !loopback.test(url.hostname)) return undefined
  return url.origin
}

/**
 * Serves the window's page under the service's origin, at `/electron/`, and answers the window's calls through the
 * service. Returns the address the window opens. Call it once the app is ready.
 */
export function startServiceMode(origin, account) {
  let token = null
  protocol.handle('http', (request) => {
    const url = new URL(request.url)
    if (url.origin !== origin || !url.pathname.startsWith('/electron/')) return net.fetch(request, { bypassCustomProtocolHandlers: true })
    return page(url.pathname)
  })
  // A redirect is never followed, so a sign-in never goes on to another address.
  const call = async (method, path, body) => {
    const headers = { 'x-task-client': client, ...(token === null ? {} : { authorization: `Bearer ${token}` }), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }
    const response = await fetch(`${origin}${path}`, { method, headers, redirect: 'manual', ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    const data = await response.json().catch(() => ({}))
    return { ok: response.ok, status: response.status, data }
  }
  ipcMain.handle('service:account', () => account)
  ipcMain.handle('service:sign-in', async (_event, name, password) => {
    const result = await call('POST', '/api/sign-in', { account: String(name), password: String(password) })
    if (!result.ok) return { ok: false, error: result.status === 401 ? 'The account or the password is wrong.' : `The service answered ${result.status}.` }
    token = result.data.token
    return { ok: true, account: result.data.account.id }
  })
  ipcMain.handle('service:create', async (_event, title) => {
    const result = await call('POST', '/api/tasks', { title: String(title) })
    return result.ok ? { ok: true, task: result.data.task } : { ok: false, error: `The service answered ${result.status}.` }
  })
  ipcMain.handle('service:list', async () => {
    if (token === null) return []
    const result = await call('GET', '/api/tasks')
    return result.ok ? result.data.tasks : []
  })
  return `${origin}/electron/index.html`
}

// The page answers its own address and a task's, `/electron/tasks/<id>`, which names the task a test reads back.
async function page(pathname) {
  const file =
    pathname === '/electron/index.html' || /^\/electron\/tasks\/[^/]+$/.test(pathname)
      ? { name: 'service.html', type: 'text/html' }
      : pathname === '/electron/service.js'
        ? { name: 'service.js', type: 'text/javascript' }
        : undefined
  if (file === undefined) return new Response('', { status: 404 })
  const body = await readFile(here(`./renderer/${file.name}`))
  return new Response(body, { headers: { 'content-type': `${file.type}; charset=utf-8` } })
}
