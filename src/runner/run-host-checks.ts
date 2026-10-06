import type { PageReading } from '../browser/contract.ts'
import type { Failure } from '../protocol/failures.ts'
import type { HostCheck, HostCheckActual, HostCheckResult, TextQuery } from '../protocol/host-check.ts'
import type { TestHostCheck } from './host-checks.ts'
import type { AppPage, PagesContext } from './test-pages.ts'
import { setTimeout as sleep } from 'node:timers/promises'
import { Deadline, elapsedMs, monotonicClock, smallestBudget } from '../protocol/deadline.ts'
import { errorMessage, failure, failureSchema, truncateText, withAlso } from '../protocol/failures.ts'
import { hostCheckRecord, matchesAddress } from '../protocol/host-check.ts'
import { parse } from '../protocol/schema.ts'
import { quoteText } from '../protocol/text.ts'
import { readOrigin } from '../protocol/url.ts'
import { bounded } from './bounded.ts'
import { notRunHostChecks } from './host-checks.ts'
import { isOurs } from './outcome.ts'
import { abortGraceMs } from './running-test.ts'
import { timerMs } from './timer.ts'

/**
 * Every check's result, in order, and the test's failure: a failure of ours if there is one, as when the browser
 * was lost after a check had failed, and otherwise the first check that failed, with the others in `also`.
 */
export type CheckedPages = { results: HostCheckResult[]; failure?: Failure }

type Read =
  | { status: 'read'; reading: PageReading }
  /** The page took longer than the look's time to answer; the check looks again while it has time. */
  | { status: 'late' }
  /** The page could not be read, as when it or its browser has gone; the check stops. */
  | { status: 'unread'; failure: Failure }
  | { status: 'stopped' }

type CheckOutcome = { kind: 'done'; result: HostCheckResult; stops: boolean } | { kind: 'stopped'; failure: Failure }

// Looks come quickly at first, then settle at twice a second, as an assertion's do.
const lookDelays = [0, 50, 100, 250, 500]

/**
 * Runs a test's host checks, in order, against the pages its body left. A failed check does not stop the next;
 * a page that could not be read stops the checks after it, and so does an interrupted run. The test's failure is
 * the first check that failed on the app, and one of ours only when no check did, since a page lost after a failed
 * check does not undo what that check read; the other failures stay in `also`, in order. Each check writes
 * `host_check.passed` or `host_check.failed`, and the pages are only read.
 *
 * @example const { results, failure } = await runHostChecks(context, pages, checks)
 */
export async function runHostChecks(context: PagesContext, pages: readonly AppPage[], checks: readonly TestHostCheck[]): Promise<CheckedPages> {
  const results: HostCheckResult[] = []
  const failures: Failure[] = []
  for (const [index, entry] of checks.entries()) {
    const outcome = await runCheck(context, pages.find((page) => page.app === entry.app), entry)
    if (outcome.kind === 'stopped') {
      results.push(...notRunHostChecks(checks.slice(index)))
      failures.push(outcome.failure)
      break
    }
    results.push(outcome.result)
    if (outcome.result.failure !== undefined) failures.push(outcome.result.failure)
    if (outcome.stops) {
      results.push(...notRunHostChecks(checks.slice(index + 1)))
      break
    }
  }
  // The application failing comes first, as for the AI checks: a check that read the page and found it wrong is the
  // test's failure, and a page lost after it does not replace it. One of ours leads only when no check failed on the app.
  const first = failures.find((each) => !isOurs(each)) ?? failures[0]
  return first === undefined ? { results } : { results, failure: withAlso(first, failures.filter((each) => each !== first)) }
}

// Looks until the check passes or its time runs out, as `decideHostCheck` decides it, and writes what it decided.
async function runCheck(context: PagesContext, page: AppPage | undefined, { check, app }: TestHostCheck): Promise<CheckOutcome> {
  const timeoutMs = check.timeoutMs ?? context.timeouts.assertion
  const read = page === undefined ? undefined : { readPage: (queries: readonly TextQuery[], readMs: number) => page.page.readPage(queries, readMs), connected: () => context.connected(page.browser) }
  const decided = await decideHostCheck({ check, app, page: read, timeoutMs, stopped: context.stopped, interruption: context.interruption, redact: context.redact })
  if (decided.kind === 'stopped') return decided
  const record = hostCheckRecord(check)
  // The session of the page it read; a check of an app the test does not have read no page and names no session.
  const session = page === undefined ? {} : { sessionId: page.session.sessionId }
  const fields = { testId: context.testId, attemptId: context.attemptId, session: app, ...session, check: record, actual: decided.actual, attempts: decided.attempts, timeoutMs: decided.timeoutMs, durationMs: decided.durationMs }
  if (decided.failure === undefined) {
    context.emit({ type: 'host_check.passed', ...fields })
    return { kind: 'done', result: { check: record, app, status: 'passed' }, stops: false }
  }
  context.emit({ type: 'host_check.failed', ...fields, failure: decided.failure })
  return { kind: 'done', result: { check: record, app, status: 'failed', failure: decided.failure }, stops: decided.lost }
}

/** One read of an app's page for a host check, and whether its browser is still there, asked before every look. */
export type HostCheckPage = {
  readonly readPage: (queries: readonly TextQuery[], timeoutMs: number) => Promise<PageReading>
  readonly connected: () => boolean
}

/**
 * One host check to decide: the check, the app it names, that app's page, absent when the caller has none for it, its
 * time, the caller's stop and why it stopped, and the redaction of every value the caller has read.
 */
export type HostCheckCall = {
  readonly check: HostCheck
  readonly app: string
  readonly page: HostCheckPage | undefined
  readonly timeoutMs: number
  readonly stopped: Promise<unknown>
  readonly interruption: () => Failure | undefined
  readonly redact: (text: string) => string
}

/**
 * One host check decided: stopped by the caller, or done with its status, its failure when it failed, what the last look
 * saw, how many looks it took in how long, and `lost` when the page could not be read, which stops the checks after it.
 */
export type DecidedHostCheck =
  | { readonly kind: 'stopped'; readonly failure: Failure }
  | { readonly kind: 'done'; readonly status: 'passed' | 'failed'; readonly failure?: Failure; readonly actual: HostCheckActual; readonly attempts: number; readonly timeoutMs: number; readonly durationMs: number; readonly lost: boolean }

/**
 * Looks at the page until the check passes or its time runs out, waiting for any document the frame is opening, and
 * decides it. It writes nothing: the runner writes `host_check.passed` or `host_check.failed` from the answer, and an
 * agent session's check reads the same answer, so both decide a check one way.
 *
 * @example const decided = await decideHostCheck({ check, app: 'web', page, timeoutMs: 5000, stopped, interruption, redact })
 */
export async function decideHostCheck(call: HostCheckCall): Promise<DecidedHostCheck> {
  const { check, app, timeoutMs } = call
  const deadline = new Deadline(timeoutMs)
  const startedAt = monotonicClock()
  const queries: TextQuery[] = check.kind === 'text' ? [{ text: check.text, ignoreCase: check.ignoreCase === true }] : []
  let attempts = 0
  let last: PageReading | undefined
  let unread: Failure | undefined
  for (;;) {
    const waitToEndMs = deadline.waitToEndMs
    const delay = smallestBudget(lookDelays[Math.min(attempts, lookDelays.length - 1)] ?? 0, waitToEndMs)
    if (delay > 0 && (await bounded(sleep(delay), timerMs(delay + abortGraceMs), call.stopped)).status === 'stopped') return stopped(call)
    if (delay > 0 && delay === waitToEndMs) {
      while (!deadline.reached) {
        const pause = deadline.waitToEndMs
        if ((await bounded(sleep(pause), timerMs(pause + abortGraceMs), call.stopped)).status === 'stopped') return stopped(call)
      }
    }
    const read = await readOnce(call, queries, deadline)
    attempts++
    if (read.status === 'stopped') return stopped(call)
    if (read.status === 'unread') unread = read.failure
    if (read.status === 'read') last = read.reading
    if (unread !== undefined || passes(check, last) || deadline.reached) break
  }
  const looked = { attempts, timeoutMs }
  // A page that answered no read in the whole time could not be read, which says nothing about the app.
  const lost = unread ?? (last === undefined ? failure('session_lost', `The page of ${app} did not answer a host check within ${timeoutMs} ms, so Retest could not read it.`) : undefined)
  const problem = passes(check, last) ? undefined : (lost ?? checkFailure({ check, app, last, looked, redact: call.redact }))
  const decided = { actual: actualOf(check, last), ...looked, durationMs: elapsedMs(startedAt) }
  if (problem === undefined) return { kind: 'done', status: 'passed', ...decided, lost: false }
  return { kind: 'done', status: 'failed', failure: problem, ...decided, lost: lost !== undefined }
}

async function readOnce(call: HostCheckCall, queries: readonly TextQuery[], deadline: Deadline): Promise<Read> {
  const { app, page } = call
  if (call.interruption() !== undefined) return { status: 'stopped' }
  if (page === undefined) return { status: 'unread', failure: failure('test_error', `The host check reads the page of ${app}, which this test does not have.`) }
  if (!page.connected()) return { status: 'unread', failure: failure('session_lost', `The browser of ${app} was gone, so Retest could not run the host check.`) }
  const timeoutMs = deadline.commandTimeoutMs
  const read = await bounded(page.readPage(queries, timeoutMs), timerMs(timeoutMs + abortGraceMs), call.stopped)
  if (read.status === 'stopped') return { status: 'stopped' }
  if (read.status === 'done') return { status: 'read', reading: read.value }
  if (read.status === 'timed_out') return { status: 'late' }
  const problem = readFailure(read.error, app, page.connected())
  return problem.class === 'timeout' ? { status: 'late' } : { status: 'unread', failure: problem }
}

// The browser says how a read failed; a page whose browser has gone, or an error with no account of itself, is lost.
function readFailure(error: unknown, app: string, connected: boolean): Failure {
  const reported = error instanceof Error && 'failure' in error ? parse(failureSchema, error.failure) : undefined
  if (connected && reported?.ok === true) return reported.value
  const where = connected ? `Retest could not read the page of ${app} for a host check` : `The browser of ${app} was lost during a host check`
  return failure('session_lost', `${where}: ${errorMessage(error)}`)
}

// A look taken while the frame was opening another document judges nothing, and nor does a text check's look at a
// document with no body, which has no visible text.
function passes(check: HostCheck, reading: PageReading | undefined): boolean {
  if (reading === undefined || reading.navigating) return false
  if (check.kind === 'address') return matchesAddress(reading.url, check)
  if (reading.body === false) return false
  const found = reading.found[0] === true
  return check.absent === true ? !found : found
}

// What the last look saw: the page's address and title, and for a text check whether the text was there, or that
// the document had no body to read.
function actualOf(check: HostCheck, last: PageReading | undefined): HostCheckActual {
  if (last === undefined) return {}
  const page = { ...(last.url === undefined ? {} : { url: last.url }), ...(last.title === undefined ? {} : { title: last.title }) }
  if (check.kind === 'address') return page
  return last.body === false ? { ...page, body: false } : { ...page, found: last.found[0] === true }
}

type FailedCheck = {
  check: HostCheck
  app: string
  last: PageReading | undefined
  looked: { attempts: number; timeoutMs: number }
  /** Hides every value the run has read. Each value is hidden in the whole text before it is quoted or cut. */
  redact: (text: string) => string
}

// A check with an id carries it in its failure's details, so a caller can tell which required check failed without
// reading the message.
function checkFailure({ check, app, last, looked, redact }: FailedCheck): Failure {
  const label = check.name === undefined ? check.id : redact(check.name)
  const named = label === undefined ? `The ${check.kind} check on ${app}` : `The host check ${quoteText(label)} on ${app}`
  const identified = check.id === undefined ? {} : { checkId: check.id }
  const opening = last?.navigating === true ? ' The page was still opening another document.' : ''
  const times = `Looked ${looked.attempts} ${looked.attempts === 1 ? 'time' : 'times'} in ${looked.timeoutMs} ms.`
  const url = last?.url === undefined ? undefined : redact(last.url)
  if (check.kind === 'address') {
    const expected = redact(expectedAddress(check))
    const message = `${named} failed: the page is on ${url ?? 'no web address'}, expected ${expected}.${opening} ${times}`
    return { class: 'host_check_failed', message, details: { ...identified, expected: truncateText(expected), received: url === undefined ? null : truncateText(url), ...looked } }
  }
  const text = redact(check.text)
  const ignoringCase = check.ignoreCase === true ? ', ignoring case' : ''
  const saw =
    last?.body === false
      ? 'the page has no body, so Retest could not read its text'
      : check.absent === true
        ? `the page shows ${quoteText(text)}${ignoringCase}, which it should not`
        : `the page does not show ${quoteText(text)}${ignoringCase}`
  return { class: 'host_check_failed', message: `${named} failed: ${saw}.${opening} ${times}`, details: { ...identified, expected: truncateText(text), ...looked } }
}

function expectedAddress(check: Extract<HostCheck, { kind: 'address' }>): string {
  const origin = readOrigin(check.origin) ?? check.origin
  const { path } = check
  if (path === undefined) return origin
  return typeof path === 'string' ? `${origin}${path}` : `${origin} with a path matching ${String(path)}`
}

function stopped(call: HostCheckCall): { readonly kind: 'stopped'; readonly failure: Failure } {
  return { kind: 'stopped', failure: call.interruption() ?? failure('interrupted', 'The run was interrupted.') }
}
