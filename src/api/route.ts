import type { RouteAnswerRecord, RoutePattern as RoutePatternRecord } from '../protocol/routes.ts'
import type { TestRun } from './test-run.ts'
import { textPatternOf } from '../protocol/locator.ts'
import { abortReasons, describeRoutePattern, routeAnswerProblem, routePatternProblem } from '../protocol/routes.ts'
import { isPlainObject } from '../protocol/schema.ts'
import { listWords } from '../shared/list-words.ts'
import { formatValue } from './format-value.ts'
import { misuse } from './misuse.ts'

/** The test and app behind a page. */
type PageTarget = { readonly run: TestRun; readonly app: string }

const fulfilKeys: ReadonlySet<string> = new Set(['status', 'headers', 'contentType', 'body'])

/**
 * Adds a route to the app's page: from now on every request of the page whose address `pattern` matches is answered
 * with `answer`, before any route added earlier. Resolves once the page holds it.
 *
 * @example await route(page, 'http://127.0.0.1:4173/api/tasks', { status: 200, contentType: 'application/json', body: '[]' })
 */
export function route({ run, app }: PageTarget, pattern: unknown, answer: unknown): Promise<void> {
  const location = run.location()
  const read = readPattern(pattern, 'route', run)
  const record = readAnswer(answer, run)
  return run.changeRoutes({ app, label: `page.route(${describeRoutePattern(read)})`, request: { kind: 'add', pattern: read, answer: record }, location })
}

/**
 * Removes every route of the app's page added with `pattern`, written as it was. Resolves once the page holds the change.
 *
 * @example await unroute(page, 'http://127.0.0.1:4173/api/tasks')
 */
export function unroute({ run, app }: PageTarget, pattern: unknown): Promise<void> {
  const location = run.location()
  const read = readPattern(pattern, 'unroute', run)
  return run.changeRoutes({ app, label: `page.unroute(${describeRoutePattern(read)})`, request: { kind: 'remove', pattern: read }, location })
}

function readPattern(pattern: unknown, method: 'route' | 'unroute', run: TestRun): RoutePatternRecord {
  const read = typeof pattern === 'string' ? pattern : pattern instanceof RegExp ? textPatternOf(pattern) : undefined
  if (read === undefined) throw misuse(`page.${method}() takes a glob of the whole address, such as '**/api/tasks', or a RegExp, received ${formatValue(pattern)}.`, run)
  const problem = routePatternProblem(read, method)
  if (problem !== undefined) throw misuse(problem, run)
  return read
}

// An answer is data, since no function crosses to the process that runs the browser: each part is read as the wire
// carries it, and a body of bytes goes as base64.
function readAnswer(answer: unknown, run: TestRun): RouteAnswerRecord {
  if (!isPlainObject(answer)) throw misuse(`page.route() takes an answer such as { status: 200, body: 'ok' } or { abort: 'connectionrefused' }, received ${formatValue(answer)}.`, run)
  const given = Object.entries(answer).filter(([, value]) => value !== undefined)
  const unknown = given.find(([key]) => key !== 'abort' && !fulfilKeys.has(key))
  if (unknown !== undefined) throw misuse(`page.route() has no answer option ${JSON.stringify(unknown[0])}. An answer takes status, headers, contentType and body, or abort.`, run)
  const parts = Object.fromEntries(given)
  if ('abort' in parts) {
    if (given.length > 1) throw misuse('page.route() takes an answer that gives a response or one that aborts the request, not both.', run)
    const reason = abortReasons.find((each) => each === parts['abort'])
    if (reason === undefined) throw misuse(`page.route() takes abort as one of ${listWords(abortReasons.map((each) => `'${each}'`), 'or')}, received ${formatValue(parts['abort'])}.`, run)
    return { abort: reason }
  }
  const record = { ...status(parts['status'], run), ...headers(parts['headers'], run), ...contentType(parts['contentType'], run), ...body(parts['body'], run) }
  const problem = routeAnswerProblem(record)
  if (problem !== undefined) throw misuse(problem, run)
  return record
}

function status(value: unknown, run: TestRun): { status?: number } {
  if (value === undefined) return {}
  if (typeof value !== 'number') throw misuse(`page.route() takes status as a number, such as 404, received ${formatValue(value)}.`, run)
  return { status: value }
}

function headers(value: unknown, run: TestRun): { headers?: Record<string, string> } {
  if (value === undefined) return {}
  const refused = (): Error => misuse(`page.route() takes headers as names with text values, such as { 'x-total': '3' }, received ${formatValue(value)}.`, run)
  if (!isPlainObject(value)) throw refused()
  const read: Record<string, string> = {}
  for (const [name, header] of Object.entries(value)) {
    if (typeof header !== 'string') throw refused()
    read[name] = header
  }
  return { headers: read }
}

function contentType(value: unknown, run: TestRun): { contentType?: string } {
  if (value === undefined) return {}
  if (typeof value !== 'string') throw misuse(`page.route() takes contentType as text, such as 'application/json', received ${formatValue(value)}.`, run)
  return { contentType: value }
}

function body(value: unknown, run: TestRun): { body?: string; base64?: string } {
  if (value === undefined) return {}
  if (typeof value === 'string') return { body: value }
  if (value instanceof Uint8Array) return { base64: Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('base64') }
  throw misuse(`page.route() takes a body as text or bytes, received ${formatValue(value)}.`, run)
}
