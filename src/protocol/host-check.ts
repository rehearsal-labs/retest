import type { Failure } from './failures.ts'
import { failureSchema } from './failures.ts'
import { describeChoices, describeValue, formatPath, isArray, isPlainObject, s, type Path, type Schema } from './schema.ts'
import { normalizeText } from './text.ts'
import { maxTimeout } from './timeouts.ts'
import { isWebUrl, readOrigin } from './url.ts'

/**
 * A check the parent runs after a test's body, against the final page of one of its apps: `app`, or the
 * test's first app. It looks again until it passes or `timeoutMs` runs out, the assertion budget by default.
 *
 * - `address`: the page's origin is `origin`. With `path`, a string equals the page's path as the URL standard
 *   writes it, and a `RegExp` matches it. The query and the fragment are never read.
 * - `text`: the page's visible text holds `text`, whitespace normalised as locators normalise it, and
 *   case-sensitive unless `ignoreCase`. With `absent`, it does not hold it.
 */
export type HostCheck =
  | {
      readonly kind: 'address'
      readonly app?: string
      readonly origin: string
      readonly path?: string | RegExp
      readonly name?: string
      readonly timeoutMs?: number
    }
  | {
      readonly kind: 'text'
      readonly app?: string
      readonly text: string
      readonly ignoreCase?: boolean
      readonly absent?: boolean
      readonly name?: string
      readonly timeoutMs?: number
    }

/** A host check as events and results record it. A `RegExp` path is its source and flags; the origin is written as the URL standard writes it. */
export type HostCheckRecord =
  | { kind: 'address'; name?: string; origin: string; path?: string | { pattern: string; flags: string } }
  | { kind: 'text'; name?: string; text: string; ignoreCase?: true; absent?: true }

/**
 * What a check saw on its last look: the page's origin and path and its title, and for a text check whether the
 * text was there. The title is the page's own text, present only when the page has one.
 */
export type HostCheckActual = { url?: string; title?: string; found?: boolean }

export type HostCheckStatus = 'passed' | 'failed' | 'not_run'

/** One of a test's host checks in its result, in the order given. `app` is the app whose page it read. */
export type HostCheckResult = { check: HostCheckRecord; app: string; status: HostCheckStatus; failure?: Failure }

/** Text a page is asked whether its visible text holds. */
export type TextQuery = { text: string; ignoreCase: boolean }

/** A selected test, as host check keys name it: by its id, or by its file, POSIX and relative to the root. */
export type HostCheckSubject = { readonly testId: string; readonly file: string }

export const hostCheckRecordSchema: Schema<HostCheckRecord> = s.discriminatedUnion('kind', [
  s.object({
    kind: s.literal('address'),
    name: s.optional(s.string()),
    origin: s.string(),
    path: s.optional(s.union([s.string(), s.object({ pattern: s.string(), flags: s.string() })])),
  }),
  s.object({
    kind: s.literal('text'),
    name: s.optional(s.string()),
    text: s.string(),
    ignoreCase: s.optional(s.literal(true)),
    absent: s.optional(s.literal(true)),
  }),
])

export const hostCheckActualSchema: Schema<HostCheckActual> = s.object({
  url: s.optional(s.string()),
  title: s.optional(s.string()),
  found: s.optional(s.boolean()),
})

export const hostCheckResultSchema: Schema<HostCheckResult> = s.object({
  check: hostCheckRecordSchema,
  app: s.string(),
  status: s.enum(['passed', 'failed', 'not_run']),
  failure: s.optional(failureSchema),
})

/**
 * A check as events and results record it.
 *
 * @example hostCheckRecord({ kind: 'address', origin: 'https://App.example/', path: /^\/done/ }) // { kind: 'address', origin: 'https://app.example', path: { pattern: '^\\/done', flags: '' } }
 */
export function hostCheckRecord(check: HostCheck): HostCheckRecord {
  const name = check.name === undefined ? {} : { name: check.name }
  if (check.kind === 'text') {
    const ignoreCase = check.ignoreCase === true ? { ignoreCase: true as const } : {}
    const absent = check.absent === true ? { absent: true as const } : {}
    return { kind: 'text', ...name, text: check.text, ...ignoreCase, ...absent }
  }
  const { path } = check
  const recorded = path === undefined ? {} : { path: typeof path === 'string' ? path : { pattern: path.source, flags: path.flags } }
  return { kind: 'address', ...name, origin: readOrigin(check.origin) ?? check.origin, ...recorded }
}

/**
 * Whether a page address passes an address check: its origin is the check's, and its path, when the check has
 * one, equals the string or matches the `RegExp`. Anything that is not an http or https address passes nothing.
 *
 * @example matchesAddress('https://app.example/done', { origin: 'https://app.example', path: '/done' }) // true
 */
export function matchesAddress(url: string | undefined, check: { readonly origin: string; readonly path?: string | RegExp }): boolean {
  const page = url === undefined ? null : URL.parse(url)
  if (!isWebUrl(page) || page.origin !== readOrigin(check.origin)) return false
  const { path } = check
  if (path === undefined) return true
  return typeof path === 'string' ? page.pathname === path : page.pathname.search(path) !== -1
}

/**
 * Text as a text check compares it: whitespace normalised as locators normalise it, and lowercased when the
 * check ignores case. The page reads its visible text by the same rule.
 *
 * @example normalizePageText('  Order\n  PLACED ', true) // 'order placed'
 */
export function normalizePageText(text: string, ignoreCase: boolean): string {
  const normalized = normalizeText(text)
  return ignoreCase ? normalized.toLowerCase() : normalized
}

/**
 * Whether a page's visible text holds the query's text, both read by `normalizePageText`.
 *
 * @example pageTextHolds('Thank you.\nYour order is placed.', { text: 'order is placed', ignoreCase: false }) // true
 */
export function pageTextHolds(pageText: string, query: TextQuery): boolean {
  return normalizePageText(pageText, query.ignoreCase).includes(normalizePageText(query.text, query.ignoreCase))
}

/**
 * A test's host checks, in the order they run: those keyed by its file, then those keyed by its id.
 *
 * @example hostChecksFor(hostChecks, { testId: 'a.retest.ts > saves', file: 'a.retest.ts' })
 */
export function hostChecksFor<Check>(hostChecks: Readonly<Record<string, readonly Check[]>>, test: HostCheckSubject): Check[] {
  return [...listed(hostChecks, test.file), ...listed(hostChecks, test.testId)]
}

/**
 * The keys that name no selected test and no file a selected test comes from, in the order given. Each is a
 * usage failure of the run, so a typo never leaves a test without its checks.
 *
 * @example unmatchedHostCheckKeys({ 'b.retest.ts': [] }, [{ testId: 'a.retest.ts > saves', file: 'a.retest.ts' }]) // ['b.retest.ts']
 */
export function unmatchedHostCheckKeys(hostChecks: Readonly<Record<string, unknown>>, tests: readonly HostCheckSubject[]): string[] {
  const named = new Set(tests.flatMap((test) => [test.testId, test.file]))
  return Object.keys(hostChecks).filter((key) => !named.has(key))
}

const checkKinds = ['address', 'text']
const allowedKeys: Readonly<Record<string, readonly string[]>> = {
  address: ['kind', 'app', 'origin', 'path', 'name', 'timeoutMs'],
  text: ['kind', 'app', 'text', 'ignoreCase', 'absent', 'name', 'timeoutMs'],
}

type AddProblem = (path: Path, message: string) => void

/**
 * Everything wrong with a `hostChecks` option that can be told without the tests, each naming its key, such as
 * `hostChecks["a.retest.ts"][0].origin`. A key set to undefined counts as absent; any key a check does not
 * have is refused, so a misspelt one never drops a condition. Which tests and apps the keys name is for the
 * caller to check, with `unmatchedHostCheckKeys`.
 *
 * @example hostCheckProblems({ 'a.retest.ts': [{ kind: 'text', text: ' ' }] }) // ['hostChecks["a.retest.ts"][0].text: expected text to look for, received " "']
 */
export function hostCheckProblems(hostChecks: unknown): string[] {
  const problems: string[] = []
  const add: AddProblem = (path, message) => problems.push(`${formatPath(path).slice(2)}: ${message}`)
  if (!isPlainObject(hostChecks)) {
    add(['hostChecks'], `expected lists of checks by test id or file, received ${describeValue(hostChecks)}`)
    return problems
  }
  for (const [key, list] of Object.entries(hostChecks)) {
    const path = ['hostChecks', key]
    if (!isArray(list)) add(path, `expected a list of checks, received ${describeValue(list)}`)
    else for (const [index, check] of list.entries()) checkProblems(check, [...path, index], add)
  }
  return problems
}

function checkProblems(value: unknown, path: Path, add: AddProblem): void {
  if (!isPlainObject(value)) return add(path, `expected a check, received ${describeValue(value)}`)
  const check = Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined))
  const kind = check['kind']
  if (typeof kind !== 'string' || !checkKinds.includes(kind)) {
    return add([...path, 'kind'], kind === undefined ? 'missing required key' : `expected ${describeChoices(checkKinds)}, received ${describeValue(kind)}`)
  }
  for (const key of Object.keys(check)) if (!allowedKeys[kind]?.includes(key)) add([...path, key], 'unknown key')
  for (const key of ['app', 'name']) if (key in check && typeof check[key] !== 'string') add([...path, key], `expected string, received ${describeValue(check[key])}`)
  if ('timeoutMs' in check && !isBudget(check['timeoutMs'])) {
    add([...path, 'timeoutMs'], `expected a whole number of milliseconds from 1 to ${maxTimeout}, received ${describeValue(check['timeoutMs'])}`)
  }
  if (kind === 'address') addressProblems(check, path, add)
  else textProblems(check, path, add)
}

function addressProblems(check: Record<string, unknown>, path: Path, add: AddProblem): void {
  const { origin, path: pagePath } = check
  if (origin === undefined) add([...path, 'origin'], 'missing required key')
  else if (typeof origin !== 'string' || readOrigin(origin) === undefined) {
    add([...path, 'origin'], `expected an http or https origin such as https://example.com, received ${describeValue(origin)}`)
  }
  if (pagePath === undefined || typeof pagePath === 'string') return
  if (!(pagePath instanceof RegExp)) add([...path, 'path'], `expected a string or a RegExp, received ${describeValue(pagePath)}`)
  else if (/[gy]/.test(pagePath.flags)) add([...path, 'path'], `expected a RegExp without the g or y flag, received ${String(pagePath)}`)
}

function textProblems(check: Record<string, unknown>, path: Path, add: AddProblem): void {
  const { text } = check
  if (text === undefined) add([...path, 'text'], 'missing required key')
  else if (typeof text !== 'string' || normalizeText(text) === '') add([...path, 'text'], `expected text to look for, received ${describeValue(text)}`)
  for (const key of ['ignoreCase', 'absent']) if (key in check && typeof check[key] !== 'boolean') add([...path, key], `expected boolean, received ${describeValue(check[key])}`)
}

function isBudget(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= maxTimeout
}

function listed<Check>(hostChecks: Readonly<Record<string, readonly Check[]>>, key: string): readonly Check[] {
  return Object.hasOwn(hostChecks, key) ? (hostChecks[key] ?? []) : []
}
