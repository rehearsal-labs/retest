import type { IncomingMessage, ServerResponse } from 'node:http'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { text } from 'node:stream/consumers'
import { ACTIONS_PAGE, renderSubmittedPage } from './actions-page.ts'
import { CHOICES_PAGE, TOGGLE_PATH } from './choices-page.ts'
import { CODE_PAGE, CODE_SIGN_IN_PAGE, CodeSignIns, renderRefusal } from './code-sign-in.ts'
import { renderDevicePage } from './device-page.ts'
import { KEY_DOWN_PATH, KEYS_PAGE } from './keys-page.ts'
import { LOCATORS_PAGE } from './locators-page.ts'
import { MODES, type Mode, type TaskAppMode } from './modes.ts'
import { renderPage } from './page.ts'
import { PROXY_CHECK_FRAME, PROXY_CHECK_PAGE, PROXY_CHECK_PATH, PROXY_CHECK_WORKER } from './proxy-page.ts'
import { MORE_PATH, SCROLL_PAGE } from './scroll-page.ts'
import { SERVICE_WORKER, SERVICE_WORKER_PAGE } from './service-worker.ts'
import { renderAccountPage, Sessions, SIGN_IN_PAGE } from './sign-in.ts'
import { GREETING_PAGE, NEXT_TITLE_PAGE, REDIRECTING_PAGE, renderTitledPage, TITLES_PAGE } from './titles-page.ts'

export type TaskAppOptions = {
  mode?: TaskAppMode
  /** How long the `delayed` mode waits before it answers a save. */
  delayMs?: number
  /** A header every request must carry, such as the one a proxy adds. Requests without it are refused with 403. */
  requireHeader?: string
  /** A file the app writes each one-time code it sends to, as a mail server would deliver it. */
  outbox?: string
}

export type TaskApp = {
  /** The app's origin, such as `http://127.0.0.1:53124`. */
  readonly url: string
  /** How many saves the server has accepted. */
  submissions(): number
  /** How many requests of any kind the server has received. */
  requests(): number
  /** How many requests the server refused for lacking the required header. */
  refused(): number
  /** How many searches the actions page submitted. */
  searches(): number
  /** How many presses of the actions page's count button reached the server. */
  clicks(): number
  /** How many clicks on the choices page's locked setting reached the server. */
  toggles(): number
  /** How many times the scroll page's feed asked for more items. */
  loads(): number
  /** How many key downs in the keys page's frozen field reached the server. */
  keyDowns(): number
  /** Every one-time code the app sent, oldest first. */
  sentCodes(): readonly string[]
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
  const codeSignIns = new CodeSignIns(options.outbox)
  let submissions = 0
  // Saves by the title received, so a test can count its own while other tests save theirs.
  const submissionsByTitle = new Map<string, number>()
  let requests = 0
  let refused = 0
  let searches = 0
  let clicks = 0
  let toggles = 0
  let loads = 0
  let keyDowns = 0
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

  async function sendCode(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const cookie = codeSignIns.send(new URLSearchParams(await text(request)))
    if (cookie === undefined) {
      respond(response, 401, HTML, renderRefusal('Wrong user name or password'))
      return
    }
    response.writeHead(303, { location: '/code/verify', 'set-cookie': cookie, 'cache-control': 'no-store' })
    response.end()
  }

  async function verifyCode(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const user = codeSignIns.verify(request.headers.cookie, new URLSearchParams(await text(request)))
    if (user === undefined) {
      respond(response, 401, HTML, renderRefusal('Wrong code'))
      return
    }
    response.writeHead(303, { location: '/account', 'set-cookie': sessions.open(user), 'cache-control': 'no-store' })
    response.end()
  }

  async function saveTask(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const title = readTitle(await text(request))
    if (title === undefined) {
      respond(response, 400, JSON_TYPE, JSON.stringify({ error: 'Send a JSON object with a string title.' }))
      return
    }
    submissions += 1
    submissionsByTitle.set(title, (submissionsByTitle.get(title) ?? 0) + 1)
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
    [
      'GET /api/submissions',
      (request, response) => {
        const title = new URL(request.url ?? '/', 'http://127.0.0.1').searchParams.get('title')
        const count = title === null ? submissions : (submissionsByTitle.get(title) ?? 0)
        respond(response, 200, JSON_TYPE, JSON.stringify({ count }))
      },
    ],
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
    ['GET /actions', (_request, response) => respond(response, 200, HTML, ACTIONS_PAGE)],
    [
      'POST /actions/submit',
      (request, response) => {
        searches += 1
        text(request)
          .then((body) => respond(response, 200, HTML, renderSubmittedPage(new URLSearchParams(body).get('query') ?? '')))
          .catch(() => response.destroy())
      },
    ],
    ['GET /actions/counts', (_request, response) => respond(response, 200, JSON_TYPE, JSON.stringify({ searches, clicks }))],
    [
      'POST /actions/click',
      (request, response) => {
        clicks += 1
        request.resume()
        respond(response, 204, 'text/plain; charset=utf-8', '')
      },
    ],
    ['GET /actions/choices', (_request, response) => respond(response, 200, HTML, CHOICES_PAGE)],
    [
      `POST ${TOGGLE_PATH}`,
      (request, response) => {
        toggles += 1
        request.resume()
        respond(response, 204, 'text/plain; charset=utf-8', '')
      },
    ],
    ['GET /actions/scroll', (_request, response) => respond(response, 200, HTML, SCROLL_PAGE)],
    [
      `POST ${MORE_PATH}`,
      (request, response) => {
        loads += 1
        request.resume()
        respond(response, 204, 'text/plain; charset=utf-8', '')
      },
    ],
    ['GET /titles', (_request, response) => respond(response, 200, HTML, TITLES_PAGE)],
    ['GET /titles/next', (_request, response) => respond(response, 200, HTML, NEXT_TITLE_PAGE)],
    ['GET /titles/redirect', (_request, response) => respond(response, 200, HTML, REDIRECTING_PAGE)],
    ['GET /titles/greeting', (_request, response) => respond(response, 200, HTML, GREETING_PAGE)],
    [
      'GET /titles/chain',
      (_request, response) => {
        response.writeHead(302, { location: '/titles/redirect', 'cache-control': 'no-store' })
        response.end()
      },
    ],
    [
      'GET /titles/echo',
      (request, response) => {
        const title = new URL(request.url ?? '/', 'http://127.0.0.1').searchParams.get('title') ?? ''
        respond(response, 200, HTML, renderTitledPage(title))
      },
    ],
    ['GET /keys', (_request, response) => respond(response, 200, HTML, KEYS_PAGE)],
    [
      `POST ${KEY_DOWN_PATH}`,
      (request, response) => {
        keyDowns += 1
        request.resume()
        respond(response, 204, 'text/plain; charset=utf-8', '')
      },
    ],
    ['GET /code/sign-in', (_request, response) => respond(response, 200, HTML, CODE_SIGN_IN_PAGE)],
    [
      'POST /code/send',
      (request, response) => {
        sendCode(request, response).catch(() => response.destroy())
      },
    ],
    ['GET /code/verify', (_request, response) => respond(response, 200, HTML, CODE_PAGE)],
    [
      'POST /code/verify',
      (request, response) => {
        verifyCode(request, response).catch(() => response.destroy())
      },
    ],
    [`GET ${PROXY_CHECK_PATH}`, (_request, response) => respond(response, 200, HTML, PROXY_CHECK_PAGE)],
    [`GET ${PROXY_CHECK_PATH}frame`, (_request, response) => respond(response, 200, HTML, PROXY_CHECK_FRAME)],
    [`GET ${PROXY_CHECK_PATH}data`, (_request, response) => respond(response, 200, 'text/plain; charset=utf-8', 'answered')],
    [`GET ${PROXY_CHECK_PATH}from-worker`, (_request, response) => respond(response, 200, 'text/plain; charset=utf-8', 'answered by the worker')],
    [`GET ${PROXY_CHECK_PATH}worker.js`, (_request, response) => respond(response, 200, 'text/javascript; charset=utf-8', PROXY_CHECK_WORKER)],
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
    if (options.requireHeader !== undefined && request.headers[options.requireHeader.toLowerCase()] === undefined) {
      refused += 1
      respond(response, 403, 'text/plain; charset=utf-8', `Refused: the request has no ${options.requireHeader} header.`)
      return
    }
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
    refused: () => refused,
    searches: () => searches,
    clicks: () => clicks,
    toggles: () => toggles,
    loads: () => loads,
    keyDowns: () => keyDowns,
    sentCodes: () => codeSignIns.sent(),
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
