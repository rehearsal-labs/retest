import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { text } from 'node:stream/consumers'
import { escapeHtml } from './html.ts'
import { HTML_TYPE, JSON_TYPE, queryOf, respondWith } from './route.ts'

/**
 * The cookie that tells one browser context from another. Every test gets a new context, so every test starts
 * with the data a new visitor gets, and keeps it across its own reloads.
 */
export const VISITOR_COOKIE = 'workflow-visitor'

/** The longest a delayed answer waits, so a page that asks for more still gets one before the app is closed. */
const longestDelayMs = 15_000

/**
 * A page of the workflow cases: `title` as its title and as the heading a test reads with
 * `getByTestId('heading')`, `main` as written, and `script` at the end of the body.
 */
export function workflowPage(title: string, main: string, script = ''): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<link rel="icon" href="data:,">
</head>
<body>
<main>
<h1 data-testid="heading">${escapeHtml(title)}</h1>
${main}
</main>
<script>${script}</script>
</body>
</html>
`
}

/** A value written as a JavaScript expression inside a `<script>`, which no `</script>` in its text can close. */
export function scriptValue(value: unknown): string {
  return JSON.stringify(value).replaceAll('<', '\\u003c')
}

/**
 * Script that defines `byTestId(id)`, and `withDefect(path)`, which carries the page's own `defect` query on to
 * the address it is given, so a deliberately broken page sends its requests to the broken server path too.
 */
export const PAGE_HELPERS = `
const byTestId = (testId) => document.querySelector('[data-testid="' + testId + '"]')
const pageDefect = new URLSearchParams(location.search).get('defect')
const withDefect = (path) => pageDefect === null ? path : path + (path.includes('?') ? '&' : '?') + 'defect=' + encodeURIComponent(pageDefect)
`

/** The defect a request asks for with `?defect=name`, if any. Each family names the ones it has. */
export function defectOf(request: IncomingMessage): string | undefined {
  return queryOf(request).get('defect') ?? undefined
}

/** Data kept for each visitor, made new for a visitor the app has not seen. */
export class Visitors<Data> {
  readonly #create: () => Data
  readonly #data = new Map<string, Data>()

  constructor(create: () => Data) {
    this.#create = create
  }

  /** The data of the request's visitor. A request without the visitor cookie gets one on its response. */
  of(request: IncomingMessage, response: ServerResponse): Data {
    const id = visitorId(request, response)
    const known = this.#data.get(id)
    if (known !== undefined) return known
    const data = this.#create()
    this.#data.set(id, data)
    return data
  }
}

function visitorId(request: IncomingMessage, response: ServerResponse): string {
  const known = cookieOf(request, VISITOR_COOKIE)
  if (known !== undefined) return known
  const id = randomUUID()
  response.appendHeader('set-cookie', `${VISITOR_COOKIE}=${id}; Path=/; HttpOnly; SameSite=Lax`)
  return id
}

/** The value of one cookie a request carries. */
export function cookieOf(request: IncomingMessage, name: string): string | undefined {
  for (const pair of (request.headers.cookie ?? '').split(';')) {
    const [key, value] = pair.trim().split('=')
    if (key === name && value !== undefined) return value
  }
  return undefined
}

/** Answers with a whole page. */
export function sendPage(response: ServerResponse, page: string): void {
  respondWith(response, 200, HTML_TYPE, page)
}

/** Answers with JSON. */
export function sendJson(response: ServerResponse, status: number, value: unknown): void {
  respondWith(response, status, JSON_TYPE, JSON.stringify(value))
}

/** Sends the browser on to `location` with a 303, as a form's answer does. */
export function redirect(response: ServerResponse, location: string): void {
  if (response.destroyed) return
  response.writeHead(303, { location, 'cache-control': 'no-store' })
  response.end()
}

/** The request body read as JSON, or undefined when it is not JSON. */
export async function readJson(request: IncomingMessage): Promise<unknown> {
  try {
    const parsed: unknown = JSON.parse(await text(request))
    return parsed
  } catch {
    return undefined
  }
}

/** A string field of a JSON body, or undefined when the body has no such string. */
export function stringField(body: unknown, name: string): string | undefined {
  if (typeof body !== 'object' || body === null || !(name in body)) return undefined
  const value: unknown = Reflect.get(body, name)
  return typeof value === 'string' ? value : undefined
}

/** A whole-number field of a JSON body, or undefined when the body has no such number. */
export function numberField(body: unknown, name: string): number | undefined {
  if (typeof body !== 'object' || body === null || !(name in body)) return undefined
  const value: unknown = Reflect.get(body, name)
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined
}

/**
 * Runs `answer` after `delayMs`, as a slow server would, unless the browser has gone by then. Never waits longer
 * than fifteen seconds, and never keeps the process alive.
 */
export function answerLater(response: ServerResponse, delayMs: number, answer: () => void): void {
  const timer = setTimeout(answer, Math.min(delayMs, longestDelayMs))
  timer.unref()
  response.on('close', () => clearTimeout(timer))
}

/** Answers a route whose work is asynchronous, closing the connection when the work fails. */
export function handled(work: Promise<void>, response: ServerResponse): void {
  work.catch(() => response.destroy())
}
