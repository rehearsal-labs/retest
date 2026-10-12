import type { Failure } from './failures.ts'
import type { TextPattern } from './locator.ts'
import { failureSchema } from './failures.ts'
import { describeTextMatch, patternProblem, textPatternSchema } from './locator.ts'
import { s, type Schema } from './schema.ts'

/**
 * Which requests a route answers: a glob of the whole address, where `**` matches any run of characters and `*` any run
 * without a `/`, or a regular expression searched for in the address, with its own flags.
 */
export type RoutePattern = string | TextPattern

/**
 * Why a refused request failed, as a page reads it: the names of Chrome's network errors, in lower case.
 */
export const abortReasons = [
  'aborted',
  'accessdenied',
  'addressunreachable',
  'blockedbyclient',
  'blockedbyresponse',
  'connectionaborted',
  'connectionclosed',
  'connectionfailed',
  'connectionrefused',
  'connectionreset',
  'failed',
  'internetdisconnected',
  'namenotresolved',
  'timedout',
] as const

export type AbortReason = (typeof abortReasons)[number]

/**
 * What a route answers each request it matches with, as the wire carries it: a response, whose `status` is 200 unless
 * given, with its `headers`, a `contentType` that sets the `Content-Type` header, and a body as text, written as UTF-8,
 * or as bytes in base64; or a refusal, which fails the request as Chrome's error `abort` names.
 */
export type RouteAnswerRecord =
  | { status?: number; headers?: Record<string, string>; contentType?: string; body?: string; base64?: string }
  | { abort: AbortReason }

/**
 * A change to an app's routes: `add` a route, which answers before every route added earlier, or `remove` every route
 * added with the same pattern.
 */
export type RouteRequest = { kind: 'add'; pattern: RoutePattern; answer: RouteAnswerRecord } | { kind: 'remove'; pattern: RoutePattern }

/** The parent's answer: the route is in place, or how many routes went, or why nothing changed. */
export type RouteReply = { ok: true; kind: 'added' } | { ok: true; kind: 'removed'; removed: number } | { ok: false; failure: Failure }

/**
 * What a `route` event records of an added route's answer: its status, its content type, the names of its headers and
 * the size of its body, never the body or a header's value; or the error it refuses requests with.
 */
export type RouteAnswerSummary = { status: number; contentType?: string; headers?: string[]; bodyBytes: number } | { abort: AbortReason }

export const routeAnswerSummarySchema: Schema<RouteAnswerSummary> = s.union([
  s.object({ abort: s.enum(abortReasons) }),
  s.object({ status: s.number({ integer: true }), contentType: s.optional(s.string()), headers: s.optional(s.array(s.string())), bodyBytes: s.number({ integer: true, min: 0 }) }),
])

/**
 * An added route's answer as its event records it.
 *
 * @example summarizeRouteAnswer({ contentType: 'application/json', body: '[]' }) // { status: 200, contentType: 'application/json', bodyBytes: 2 }
 */
export function summarizeRouteAnswer(answer: RouteAnswerRecord): RouteAnswerSummary {
  if ('abort' in answer) return { abort: answer.abort }
  const headers = Object.keys(answer.headers ?? {})
  return {
    status: answer.status ?? 200,
    ...(answer.contentType === undefined ? {} : { contentType: answer.contentType }),
    ...(headers.length === 0 ? {} : { headers }),
    bodyBytes: routeBodyBytes(answer),
  }
}

/**
 * A route's answer as a report reads it: the status, the content type and the body's size, or the error it refuses
 * requests with.
 *
 * @example describeRouteSummary({ status: 404, bodyBytes: 9 }) // '404, 9 bytes'
 */
export function describeRouteSummary(summary: RouteAnswerSummary): string {
  if ('abort' in summary) return `refuses requests as ${summary.abort}`
  return [String(summary.status), ...(summary.contentType === undefined ? [] : [summary.contentType]), `${summary.bodyBytes} ${summary.bodyBytes === 1 ? 'byte' : 'bytes'}`].join(', ')
}

const routePatternSchema: Schema<RoutePattern> = s.union([s.string(), textPatternSchema])

export const routeAnswerRecordSchema: Schema<RouteAnswerRecord> = s.union([
  s.object({ abort: s.enum(abortReasons) }),
  s.object({
    status: s.optional(s.number({ integer: true })),
    headers: s.optional(s.record(s.string())),
    contentType: s.optional(s.string()),
    body: s.optional(s.string()),
    base64: s.optional(s.string()),
  }),
])

export const routeRequestSchema: Schema<RouteRequest> = s.discriminatedUnion('kind', [
  s.object({ kind: s.literal('add'), pattern: routePatternSchema, answer: routeAnswerRecordSchema }),
  s.object({ kind: s.literal('remove'), pattern: routePatternSchema }),
])

export const routeReplySchema: Schema<RouteReply> = s.union([
  s.object({ ok: s.literal(true), kind: s.literal('added') }),
  s.object({ ok: s.literal(true), kind: s.literal('removed'), removed: s.number({ integer: true, min: 0 }) }),
  s.object({ ok: s.literal(false), failure: failureSchema }),
])

// A header's name is a token; its value holds no line break or NUL, which would end the header early.
const headerName = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
const headerValue = /^[^\r\n\0]*$/
const scheme = /^[a-z][a-z0-9+.-]*:\/\//i
const base64Text = /^[A-Za-z0-9+/]*={0,2}$/

/**
 * What the test process and the parent both refuse, as `usage`, in a route's pattern: an empty glob, a glob that is not a
 * whole address, which starts with `*` or a scheme such as `https://`, and a regular expression JavaScript cannot read.
 *
 * @example routePatternProblem('', 'unroute') // 'page.unroute() takes a pattern of the whole address, received an empty one.'
 */
export function routePatternProblem(pattern: RoutePattern, method: 'route' | 'unroute'): string | undefined {
  if (typeof pattern !== 'string') {
    const problem = patternProblem(pattern)
    return problem === undefined ? undefined : `page.${method}() takes a regular expression JavaScript can read: ${problem}`
  }
  if (pattern === '') return `page.${method}() takes a pattern of the whole address, received an empty one.`
  if (pattern.startsWith('*') || scheme.test(pattern)) return undefined
  return `page.${method}() matches the whole address, received ${describeRoutePattern(pattern)}. Start it with ** or a scheme, such as '**/${pattern.replace(/^\/+/, '')}'.`
}

/**
 * What the test process and the parent both refuse, as `usage`, in a route's answer: a status that is not a whole number
 * from 200 to 599, a header name that is not a token or a value with a line break, a body both as text and as bytes,
 * and bytes that are not base64.
 *
 * @example routeAnswerProblem({ status: 99 }) // 'page.route() takes status as a whole number from 200 to 599, received 99.'
 */
export function routeAnswerProblem(answer: RouteAnswerRecord): string | undefined {
  if ('abort' in answer) return undefined
  const { status, headers, contentType, body, base64 } = answer
  if (status !== undefined && (!Number.isInteger(status) || status < 200 || status > 599)) return `page.route() takes status as a whole number from 200 to 599, received ${status}.`
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (!headerName.test(name)) return `page.route() takes header names made of letters, digits and !#$%&'*+.^_\`|~-, received ${JSON.stringify(name)}.`
    if (!headerValue.test(value)) return `page.route() takes header values without a line break, received one for ${JSON.stringify(name)}.`
  }
  if (contentType !== undefined && (contentType === '' || !headerValue.test(contentType))) return 'page.route() takes contentType as a header value, such as \'application/json\'.'
  if (body !== undefined && base64 !== undefined) return 'page.route() takes a body as text or as bytes, not both.'
  if (base64 !== undefined && (base64.length % 4 !== 0 || !base64Text.test(base64))) return 'page.route() received bytes for a body that are not base64.'
  return undefined
}

/**
 * What both processes refuse in a change to the routes, as a failure, or undefined.
 *
 * @example routeRequestProblem({ kind: 'remove', pattern: '' })?.class // 'usage'
 */
export function routeRequestProblem(request: RouteRequest): Failure | undefined {
  const problem = routePatternProblem(request.pattern, request.kind === 'add' ? 'route' : 'unroute') ?? (request.kind === 'add' ? routeAnswerProblem(request.answer) : undefined)
  return problem === undefined ? undefined : { class: 'usage', message: problem }
}

/**
 * A route's pattern as a test writes it, whole: a glob as a string, a regular expression as its literal. Whoever writes it
 * down redacts it before cutting it, so no part of a secret is left behind at the cut.
 *
 * @example describeRoutePattern({ pattern: 'tasks\\/\\d+$', flags: 'i' }) // '/tasks\/\d+$/i'
 */
export function describeRoutePattern(pattern: RoutePattern): string {
  return describeTextMatch(pattern)
}

/**
 * How many bytes a route's response body holds: its text as UTF-8, or its bytes.
 *
 * @example routeBodyBytes({ body: 'héllo' }) // 6
 */
export function routeBodyBytes(answer: Exclude<RouteAnswerRecord, { abort: AbortReason }>): number {
  if (answer.base64 !== undefined) return Buffer.byteLength(answer.base64, 'base64')
  return Buffer.byteLength(answer.body ?? '', 'utf8')
}

/**
 * The regular expression source of a glob of the whole address: `**` matches any run of characters, `*` any run without
 * a `/`, and every other character itself.
 *
 * @example new RegExp(globSource('https://example.com/api/**')).test('https://example.com/api/tasks/7') // true
 */
export function globSource(glob: string): string {
  let source = '^'
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index] ?? ''
    if (character !== '*') {
      source += character.replace(/[\\^$.|?+()[\]{}/-]/g, '\\$&')
      continue
    }
    const deep = glob[index + 1] === '*'
    while (glob[index + 1] === '*') index += 1
    source += deep ? '.*' : '[^/]*'
  }
  return `${source}$`
}

/**
 * Whether a route's pattern matches an address: a glob the whole address, a regular expression anywhere in it.
 *
 * @example routeMatches({ pattern: '/tasks/\\d+$', flags: '' }, 'http://127.0.0.1:4173/api/tasks/7') // true
 */
export function routeMatches(pattern: RoutePattern, url: string): boolean {
  if (typeof pattern === 'string') return new RegExp(globSource(pattern)).test(url)
  return new RegExp(pattern.pattern, pattern.flags).test(url)
}

/**
 * Whether two patterns are the same, as `unroute` compares them: the same glob, or the same source and flags.
 *
 * @example samePattern({ pattern: 'a', flags: 'g' }, { pattern: 'a', flags: 'g' }) // true
 */
export function samePattern(first: RoutePattern, second: RoutePattern): boolean {
  if (typeof first === 'string' || typeof second === 'string') return first === second
  return first.pattern === second.pattern && first.flags === second.flags
}
