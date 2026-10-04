import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Session } from './accounts.ts'
import type { KnownClient } from './clients.ts'
import type { RequestRecord } from './request-log.ts'
import type { BrokenSync, SyncLink, SyncPolicy, TaskChange } from './store.ts'
import { once } from 'node:events'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { accountName, Sessions } from './accounts.ts'
import { CLIENT_HEADER, clientOf, KNOWN_CLIENTS } from './clients.ts'
import { formatRequestLine, loggedMethod, loggedPath } from './request-log.ts'
import { TaskStore } from './store.ts'

/** The port the service takes when none is given. */
export const DEFAULT_PORT = 4310

/** How long a change takes to reach the other clients when no delay is given. */
export const DEFAULT_SYNC_DELAY_MS = 1000

/** The longest title a task may have. */
export const TITLE_LIMIT = 200

export type TaskServiceOptions = {
  /** A port on 127.0.0.1, or 0 to take any free one. Default: `DEFAULT_PORT`. */
  port?: number
  /** Default: `DEFAULT_SYNC_DELAY_MS`. */
  syncDelayMs?: number
  /**
   * Acknowledge changes and never pass them on: `true` to every other client, a list to those clients only, and
   * `{ links }` from each link's `from` client to its `to` client only.
   */
  brokenSync?: boolean | readonly KnownClient[] | { readonly links: readonly SyncLink[] }
  /** How long each task read is held before its answer is sent, as a slow network would. The answer is taken first. */
  readDelayMs?: number
  /** A JSON file that keeps the tasks across restarts. Without one they live in memory. */
  stateFile?: string
  /** A file that receives one JSON line per request, replaced at start. */
  networkLog?: string
  /** Receives the plain line for each request. */
  printLine?: (line: string) => void
  /** Receives a line for each failure the service survives, such as a file it could not write. */
  reportError?: (line: string) => void
}

export type TaskService = {
  /** Such as `http://127.0.0.1:4310`. */
  readonly url: string
  readonly sync: SyncPolicy
  close(): Promise<void>
}

type StaticFile = { body: string; contentType: string }

type Parsed<T> = { ok: true; value: T } | { ok: false; status: number; error: string }

const JSON_TYPE = 'application/json; charset=utf-8'
const BODY_LIMIT = 16 * 1024
const TASK_PATH = /^\/api\/tasks\/([^/]+)$/
const PAGE_TASK_PATH = /^\/tasks\/[^/]+$/
const LOOPBACK_HOST = /^(?:127\.\d{1,3}\.\d{1,3}\.\d{1,3}|localhost|\[::1\])$/

const webFolder = new URL('../web/', import.meta.url)
const staticFiles: ReadonlyArray<readonly [path: string, file: string, contentType: string]> = [
  ['/', 'index.html', 'text/html; charset=utf-8'],
  ['/app.js', 'app.js', 'text/javascript; charset=utf-8'],
  ['/styles.css', 'styles.css', 'text/css; charset=utf-8'],
]

/**
 * Starts the cross-platform fixture service on 127.0.0.1: the web front end, the task API the three clients share, and
 * the reset route a test prepares with. It answers only requests addressed to a loopback name, takes a write only from
 * a request naming a known client, and sends no CORS headers, so another site's page in a browser cannot change it.
 *
 * @example const service = await startTaskService({ port: 0, syncDelayMs: 500 })
 */
export async function startTaskService(options: TaskServiceOptions = {}): Promise<TaskService> {
  const sync: SyncPolicy = { delayMs: wholeNumber(options.syncDelayMs ?? DEFAULT_SYNC_DELAY_MS, 'syncDelayMs'), broken: brokenSync(options.brokenSync) }
  const readDelayMs = wholeNumber(options.readDelayMs ?? 0, 'readDelayMs')
  const port = wholeNumber(options.port ?? DEFAULT_PORT, 'port')
  const store = new TaskStore({ sync, ...(options.stateFile === undefined ? {} : { stateFile: options.stateFile }) })
  const sessions = new Sessions()
  const files = new Map(staticFiles.map(([path, file, contentType]) => [path, { body: readFileSync(new URL(file, webFolder), 'utf8'), contentType }]))
  const page = files.get('/')
  if (page === undefined) throw new Error('The web front end has no page')
  const { printLine, reportError } = options
  let networkLog = options.networkLog
  if (networkLog !== undefined) writeFileSync(networkLog, '')
  const timers = new Set<NodeJS.Timeout>()
  let sequence = 0

  function log(record: RequestRecord): void {
    printLine?.(formatRequestLine(record))
    if (networkLog === undefined) return
    try {
      appendFileSync(networkLog, `${JSON.stringify(record)}\n`)
    } catch (error) {
      // Said once: the service keeps answering, and the network log stays as far as it got.
      reportError?.(`The network log ${networkLog} could not be written (${describe(error)}); no further requests are written to it.`)
      networkLog = undefined
    }
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const method = request.method ?? 'GET'
    const path = URL.parse(request.url ?? '/', 'http://fixture.invalid')?.pathname ?? '/'
    if (!isLoopbackHost(request.headers.host)) return sendJson(response, 403, { error: 'This service answers only requests addressed to a loopback name.' })
    const file = files.get(path) ?? (PAGE_TASK_PATH.test(path) ? page : undefined)
    if (file !== undefined) return method === 'GET' ? sendFile(response, file) : notAllowed(response, 'GET')
    const isWrite = method !== 'GET' && method !== 'HEAD'
    const isApi = path.startsWith('/api/') || path.startsWith('/admin/')
    if (isApi && isWrite && clientOf(request.headers[CLIENT_HEADER]) === 'unknown') {
      return sendJson(response, 403, { error: `Send the ${CLIENT_HEADER} header with one of: ${KNOWN_CLIENTS.join(', ')}.` })
    }
    if (path === '/api/health') {
      if (method !== 'GET') return notAllowed(response, 'GET')
      return sendJson(response, 200, { status: 'ok', syncDelayMs: sync.delayMs, brokenSync: sync.broken, readDelayMs })
    }
    if (path === '/api/sign-in') return method === 'POST' ? signIn(request, response) : notAllowed(response, 'POST')
    if (path === '/api/sign-out') {
      if (method !== 'POST') return notAllowed(response, 'POST')
      if (!sessions.signOut(request.headers.authorization)) return signInFirst(response)
      return sendJson(response, 200, { signedOut: true })
    }
    if (path === '/admin/reset') {
      if (method !== 'POST') return notAllowed(response, 'POST')
      store.reset()
      sessions.clear()
      return sendJson(response, 200, { reset: true })
    }
    if (path === '/api/tasks') return tasks(request, response, method)
    const taskId = TASK_PATH.exec(path)?.[1]
    if (taskId !== undefined) return task(request, response, method, decodeId(taskId))
    sendJson(response, 404, { error: 'Not found.' })
  }

  async function signIn(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const client = clientOf(request.headers[CLIENT_HEADER])
    if (client === 'unknown') return sendJson(response, 403, { error: `Send the ${CLIENT_HEADER} header.` })
    const body = await readJson(request)
    const credentials = body.ok ? parseCredentials(body.value) : body
    if (!credentials.ok) return sendJson(response, credentials.status, { error: credentials.error })
    const signedIn = sessions.signIn(credentials.value.account, credentials.value.password, client)
    if (signedIn === undefined) return sendJson(response, 401, { error: 'Wrong account or password.' })
    sendJson(response, 200, { token: signedIn.token, account: { id: signedIn.session.account, name: signedIn.name } })
  }

  async function tasks(request: IncomingMessage, response: ServerResponse, method: string): Promise<void> {
    const session = sessions.fromAuthorization(request.headers.authorization)
    if (method !== 'GET' && method !== 'POST') return notAllowed(response, 'GET, POST')
    if (session === undefined) return signInFirst(response)
    if (method === 'GET') return sendRead(response, 200, { account: { id: session.account, name: accountName(session.account) }, tasks: store.list(session) })
    const body = await readJson(request)
    const title = body.ok ? parseNewTask(body.value) : body
    if (!title.ok) return sendJson(response, title.status, { error: title.error })
    sendJson(response, 201, { task: store.create(session, title.value) })
  }

  async function task(request: IncomingMessage, response: ServerResponse, method: string, id: string | undefined): Promise<void> {
    const session = sessions.fromAuthorization(request.headers.authorization)
    if (method !== 'GET' && method !== 'PATCH') return notAllowed(response, 'GET, PATCH')
    if (session === undefined) return signInFirst(response)
    if (id === undefined) return notVisible(response)
    if (method === 'GET') return readTask(response, session, id)
    const body = await readJson(request)
    const change = body.ok ? parseChange(body.value) : body
    if (!change.ok) return sendJson(response, change.status, { error: change.error })
    const updated = store.update(session, id, change.value)
    if (updated === undefined) return notVisible(response)
    sendJson(response, 200, { task: updated })
  }

  function readTask(response: ServerResponse, session: Session, id: string): void {
    const found = store.read(session, id)
    if (found === undefined) return sendRead(response, 404, { error: 'No task with this id is visible to you.' })
    sendRead(response, 200, { task: found })
  }

  // A task read is answered with the state as it stood when the request arrived, after the read delay.
  function sendRead(response: ServerResponse, status: number, body: object): void {
    if (readDelayMs === 0) return sendJson(response, status, body)
    const timer = setTimeout(() => {
      timers.delete(timer)
      sendJson(response, status, body)
    }, readDelayMs)
    timers.add(timer)
  }

  const server = createServer((request, response) => {
    sequence += 1
    const startedAt = new Date().toISOString()
    const start = performance.now()
    const method = loggedMethod(request.method)
    const path = loggedPath(request.url)
    const fields = { sequence, startedAt, method, path, client: clientOf(request.headers[CLIENT_HEADER]) }
    let logged = false
    const finish = (completed: boolean): void => {
      if (logged) return
      logged = true
      const durationMs = Math.round((performance.now() - start) * 10) / 10
      log({ schemaVersion: 1, type: 'http.request', ...fields, status: response.statusCode, durationMs, completed })
    }
    response.once('finish', () => finish(true))
    response.once('close', () => finish(response.writableFinished))
    handle(request, response).catch((error: unknown) => {
      reportError?.(`${method} ${path} failed, and nothing it asked for was kept: ${describe(error)}`)
      if (response.headersSent) response.destroy()
      else sendJson(response, 500, { error: 'The service failed, and kept nothing of this request.' })
    })
  })

  server.listen(port, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('The task service is not listening on a TCP port')
  let closing: Promise<void> | undefined

  async function stop(): Promise<void> {
    for (const timer of timers) clearTimeout(timer)
    timers.clear()
    const closed = new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    server.closeAllConnections()
    await closed
  }

  return { url: `http://127.0.0.1:${address.port}`, sync, close: () => (closing ??= stop()) }
}

function brokenSync(option: TaskServiceOptions['brokenSync']): BrokenSync {
  if (option === undefined || option === false) return { kind: 'off' }
  if (option === true) return { kind: 'every-other-client' }
  if ('links' in option) {
    if (option.links.length === 0) throw new RangeError('brokenSync lists no link; give { links: [{ from, to }] }')
    const links = new Map(option.links.map((link) => [`${link.from}:${link.to}`, { from: link.from, to: link.to }]))
    return { kind: 'links', links: [...links.values()] }
  }
  if (option.length === 0) throw new RangeError('brokenSync lists no client; give true to break sync for every other client')
  return { kind: 'clients', clients: [...new Set(option)] }
}

function isLoopbackHost(host: string | undefined): boolean {
  const hostname = host === undefined ? undefined : URL.parse(`http://${host}`)?.hostname
  return hostname !== undefined && LOOPBACK_HOST.test(hostname)
}

function parseCredentials(value: unknown): Parsed<{ account: string; password: string }> {
  if (!isRecord(value)) return badRequest('Send a JSON object with account and password.')
  const { account, password } = value
  if (typeof account !== 'string' || typeof password !== 'string') return badRequest('Send a JSON object with account and password.')
  return { ok: true, value: { account, password } }
}

function parseNewTask(value: unknown): Parsed<string> {
  if (!isRecord(value)) return badRequest('Send a JSON object with a title.')
  const unknownKey = Object.keys(value).find((key) => key !== 'title')
  if (unknownKey !== undefined) return badRequest(`A new task takes only a title, not ${unknownKey}. The service assigns the id.`)
  return parseTitle(value['title'])
}

function parseChange(value: unknown): Parsed<TaskChange> {
  if (!isRecord(value)) return badRequest('Send a JSON object with title, done or both.')
  const unknownKey = Object.keys(value).find((key) => key !== 'title' && key !== 'done')
  if (unknownKey !== undefined) return badRequest(`A change takes title and done, not ${unknownKey}.`)
  const { title, done } = value
  if (title === undefined && done === undefined) return badRequest('Send title, done or both.')
  if (done !== undefined && typeof done !== 'boolean') return badRequest('done must be true or false.')
  const change: TaskChange = done === undefined ? {} : { done }
  if (title === undefined) return { ok: true, value: change }
  const parsedTitle = parseTitle(title)
  return parsedTitle.ok ? { ok: true, value: { ...change, title: parsedTitle.value } } : parsedTitle
}

function parseTitle(value: unknown): Parsed<string> {
  if (typeof value !== 'string') return badRequest('title must be text.')
  const title = value.trim()
  if (title === '') return badRequest('A task needs a title.')
  if (title.length > TITLE_LIMIT) return badRequest(`A title has at most ${TITLE_LIMIT} characters.`)
  if (/[\u0000-\u001f\u007f]/.test(title)) return badRequest('A title is one line of text.')
  return { ok: true, value: title }
}

async function readJson(request: IncomingMessage): Promise<Parsed<unknown>> {
  const body = await readBody(request)
  if (body === undefined) return { ok: false, status: 413, error: `A request body has at most ${BODY_LIMIT} bytes.` }
  try {
    return { ok: true, value: JSON.parse(body) }
  } catch {
    return badRequest('The body is not JSON.')
  }
}

// Reads the whole body, and undefined when it is longer than the limit; the rest is still drained.
function readBody(request: IncomingMessage): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    request.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size <= BODY_LIMIT) chunks.push(chunk)
    })
    request.on('end', () => resolve(size > BODY_LIMIT ? undefined : Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}

function decodeId(text: string): string | undefined {
  try {
    return decodeURIComponent(text)
  } catch {
    return undefined
  }
}

// An error's code and message. Errors here come from the file system and this service, never from a request's body.
function describe(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const code = 'code' in error && typeof error.code === 'string' ? `${error.code}: ` : ''
  return `${code}${error.message}`
}

function badRequest(error: string): { ok: false; status: number; error: string } {
  return { ok: false, status: 400, error }
}

function signInFirst(response: ServerResponse): void {
  sendJson(response, 401, { error: 'Sign in first.' })
}

// The same answer whether the task does not exist, belongs to another account or has not reached this client yet.
function notVisible(response: ServerResponse): void {
  sendJson(response, 404, { error: 'No task with this id is visible to you.' })
}

function notAllowed(response: ServerResponse, allowed: string): void {
  response.setHeader('allow', allowed)
  sendJson(response, 405, { error: `Use ${allowed}.` })
}

function sendJson(response: ServerResponse, status: number, body: object): void {
  if (response.destroyed) return
  response.writeHead(status, { 'content-type': JSON_TYPE, 'cache-control': 'no-store' })
  response.end(JSON.stringify(body))
}

function sendFile(response: ServerResponse, file: StaticFile): void {
  if (response.destroyed) return
  response.writeHead(200, { 'content-type': file.contentType, 'cache-control': 'no-store' })
  response.end(file.body)
}

function wholeNumber(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0) throw new RangeError(`${name} must be a whole number, received ${value}`)
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
