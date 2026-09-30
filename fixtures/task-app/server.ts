import type { IncomingMessage, ServerResponse } from 'node:http'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { text } from 'node:stream/consumers'
import { renderDevicePage } from './device-page.ts'
import { LOCATORS_PAGE } from './locators-page.ts'
import { MODES, type Mode, type TaskAppMode } from './modes.ts'
import { renderPage } from './page.ts'
import { SERVICE_WORKER, SERVICE_WORKER_PAGE } from './service-worker.ts'
import { renderAccountPage, Sessions, SIGN_IN_PAGE } from './sign-in.ts'

export type TaskAppOptions = {
  mode?: TaskAppMode
  /** How long the `delayed` mode waits before it answers a save. */
  delayMs?: number
}

export type TaskApp = {
  /** The app's origin, such as `http://127.0.0.1:53124`. */
  readonly url: string
  /** How many saves the server has accepted. */
  submissions(): number
  /** How many requests of any kind the server has received. */
  requests(): number
  close(): Promise<void>
}

const HTML = 'text/html; charset=utf-8'
const JSON_TYPE = 'application/json; charset=utf-8'

/**
 * Starts the task app on an ephemeral loopback port.
 * @example const app = await startTaskApp({ mode: 'broken' })
 */
export async function startTaskApp(options: TaskAppOptions = {}): Promise<TaskApp> {
  const mode = MODES[options.mode ?? 'ok']
  const save = mode.save ?? ((title: string) => title)
  const delayMs = replyDelay(mode, options.delayMs)
  const page = renderPage(mode.page ?? {})
  const timers = new Set<NodeJS.Timeout>()
  const sessions = new Sessions()
  let submissions = 0
  let requests = 0
  let closing: Promise<void> | undefined

  async function signIn(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const cookies = sessions.signIn(parseJson(await text(request)))
    if (cookies === undefined) {
      respond(response, 401, JSON_TYPE, JSON.stringify({ error: 'Wrong user name or password.' }))
      return
    }
    response.setHeader('set-cookie', cookies)
    respond(response, 200, JSON_TYPE, JSON.stringify({ signedIn: true }))
  }

  async function saveTask(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const title = readTitle(await text(request))
    if (title === undefined) {
      respond(response, 400, JSON_TYPE, JSON.stringify({ error: 'Send a JSON object with a string title.' }))
      return
    }
    submissions += 1
    const reply = () => respond(response, 200, JSON_TYPE, JSON.stringify({ title: save(title) }))
    if (delayMs === undefined) {
      reply()
      return
    }
    const timer = setTimeout(() => {
      timers.delete(timer)
      reply()
    }, delayMs)
    timers.add(timer)
  }

  const routes = new Map<string, (request: IncomingMessage, response: ServerResponse) => void>([
    ['GET /', (_request, response) => respond(response, 200, HTML, page)],
    [
      'POST /api/tasks',
      (request, response) => {
        // An aborted request leaves nobody to answer.
        saveTask(request, response).catch(() => response.destroy())
      },
    ],
    ['GET /api/submissions', (_request, response) => respond(response, 200, JSON_TYPE, JSON.stringify({ count: submissions }))],
    ['GET /locators', (_request, response) => respond(response, 200, HTML, LOCATORS_PAGE)],
    [
      'GET /device',
      (request, response) => {
        const headers = { userAgent: request.headers['user-agent'], clientHints: headerText(request.headers['sec-ch-ua']) }
        respond(response, 200, HTML, renderDevicePage(headers))
      },
    ],
    ['GET /login', (_request, response) => respond(response, 200, HTML, SIGN_IN_PAGE)],
    [
      'POST /api/sign-in',
      (request, response) => {
        signIn(request, response).catch(() => response.destroy())
      },
    ],
    ['GET /account', (request, response) => respond(response, 200, HTML, renderAccountPage(sessions.userOf(request.headers.cookie)))],
    ['GET /service-worker', (_request, response) => respond(response, 200, HTML, SERVICE_WORKER_PAGE)],
    ['GET /service-worker.js', (_request, response) => respond(response, 200, 'text/javascript; charset=utf-8', SERVICE_WORKER)],
    [
      'GET /hang',
      (_request, response) => {
        writeHead(response, 200, HTML)
        response.write('<!doctype html><title>Loading</title><p>Loading')
      },
    ],
  ])

  const server = createServer((request, response) => {
    requests += 1
    const { pathname } = new URL(request.url ?? '/', 'http://127.0.0.1')
    const route = routes.get(`${request.method} ${pathname}`)
    if (route === undefined) respond(response, 404, 'text/plain; charset=utf-8', 'Not found')
    else route(request, response)
  })

  async function stop(): Promise<void> {
    for (const timer of timers) clearTimeout(timer)
    timers.clear()
    const closed = new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    server.closeAllConnections()
    await closed
  }

  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('The task app is not listening on a TCP port')

  return {
    url: `http://127.0.0.1:${address.port}`,
    submissions: () => submissions,
    requests: () => requests,
    close: () => (closing ??= stop()),
  }
}

function replyDelay(mode: Mode, requested: number | undefined): number | undefined {
  if (requested === undefined) return mode.replyDelayMs
  if (mode.replyDelayMs === undefined) throw new TypeError('delayMs applies only to the delayed mode')
  if (!Number.isInteger(requested) || requested < 0) {
    throw new RangeError(`delayMs must be a whole number of milliseconds, received ${requested}`)
  }
  return requested
}

function readTitle(body: string): string | undefined {
  const value = parseJson(body)
  return typeof value === 'object' && value !== null && 'title' in value && typeof value.title === 'string'
    ? value.title
    : undefined
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body)
  } catch {
    return undefined
  }
}

function headerText(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value.join(', ') : value
}

function writeHead(response: ServerResponse, status: number, contentType: string): void {
  response.writeHead(status, { 'content-type': contentType, 'cache-control': 'no-store' })
}

function respond(response: ServerResponse, status: number, contentType: string, body: string): void {
  writeHead(response, status, contentType)
  response.end(body)
}
