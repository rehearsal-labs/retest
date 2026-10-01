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
import { abortGraceMs } from './running-test.ts'

/** Every check's result, in order, and the test's failure: the first check that failed, the others in `also`. */
export type CheckedPages = { results: HostCheckResult[]; failure?: Failure }

type Read =
  | { status: 'read'; reading: PageReading }
  /** The page took longer than the look's time to answer; the check looks again while it has time. */
  | { status: 'late'; failure: Failure }
  /** The page could not be read, as when it or its browser has gone; the check stops. */
  | { status: 'unread'; failure: Failure }
  | { status: 'stopped' }

type CheckOutcome = { kind: 'done'; result: HostCheckResult; stops: boolean } | { kind: 'stopped'; failure: Failure }

// Looks come quickly at first, then settle at twice a second, as an assertion's do.
const lookDelays = [0, 50, 100, 250, 500]

/**
 * Runs a test's host checks, in order, against the pages its body left. A failed check does not stop the next;
 * a page that could not be read stops the checks after it, and so does an interrupted run, whose failure then
 * is the test's. Each check writes `host_check.passed` or `host_check.failed`, and the pages are only read.
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
      failures.unshift(outcome.failure)
      break
    }
    results.push(outcome.result)
    if (outcome.result.failure !== undefined) failures.push(outcome.result.failure)
    if (outcome.stops) {
      results.push(...notRunHostChecks(checks.slice(index + 1)))
      break
    }
  }
  const [first, ...rest] = failures
  return first === undefined ? { results } : { results, failure: withAlso(first, rest) }
}

// Looks until the check passes or its time runs out, and waits for any document the frame is opening.
async function runCheck(context: PagesContext, page: AppPage | undefined, { check, app }: TestHostCheck): Promise<CheckOutcome> {
  const timeoutMs = check.timeoutMs ?? context.timeouts.assertion
  const deadline = new Deadline(timeoutMs)
  const startedAt = monotonicClock()
  const queries: TextQuery[] = check.kind === 'text' ? [{ text: check.text, ignoreCase: check.ignoreCase === true }] : []
  let attempts = 0
  let last: PageReading | undefined
  let late: Failure | undefined
  let unread: Failure | undefined
  for (;;) {
    const delay = smallestBudget(lookDelays[Math.min(attempts, lookDelays.length - 1)] ?? 0, deadline.remainingMs)
    if (delay > 0 && (await bounded(sleep(delay), delay + abortGraceMs, context.stopped)).status === 'stopped') return stopped(context)
    const read = await readOnce(context, page, app, queries, deadline)
    attempts++
    if (read.status === 'stopped') return stopped(context)
    if (read.status === 'unread') unread = read.failure
    if (read.status === 'late') late = read.failure
    if (read.status === 'read') last = read.reading
    if (unread !== undefined || passes(check, last) || deadline.expired) break
  }
  const looked = { attempts, timeoutMs }
  const unanswered = last === undefined ? late : undefined
  const problem = unread ?? (passes(check, last) ? undefined : (unanswered ?? checkFailure(check, app, last, looked)))
  const record = hostCheckRecord(check)
  const fields = { testId: context.testId, attemptId: context.attemptId, session: app, check: record, actual: actualOf(check, last), ...looked, durationMs: elapsedMs(startedAt) }
  if (problem === undefined) {
    context.emit({ type: 'host_check.passed', ...fields })
    return { kind: 'done', result: { check: record, app, status: 'passed' }, stops: false }
  }
  context.emit({ type: 'host_check.failed', ...fields, failure: problem })
  return { kind: 'done', result: { check: record, app, status: 'failed', failure: problem }, stops: unread !== undefined }
}

async function readOnce(context: PagesContext, page: AppPage | undefined, app: string, queries: readonly TextQuery[], deadline: Deadline): Promise<Read> {
  if (context.interruption() !== undefined) return { status: 'stopped' }
  if (page === undefined) return { status: 'unread', failure: failure('test_error', `The host check reads the page of ${app}, which this test does not have.`) }
  if (!context.connected(page.browser)) return { status: 'unread', failure: failure('session_lost', `The browser of ${app} was gone, so Retest could not run the host check.`) }
  const timeoutMs = deadline.commandTimeoutMs
  const read = await bounded(page.page.readPage(queries, timeoutMs), timeoutMs + abortGraceMs, context.stopped)
  if (read.status === 'stopped') return { status: 'stopped' }
  if (read.status === 'done') return { status: 'read', reading: read.value }
  const late = failure('timeout', `The page of ${app} did not answer a host check within ${timeoutMs} ms.`)
  if (read.status === 'timed_out') return { status: 'late', failure: late }
  const problem = readFailure(read.error, app, context.connected(page.browser))
  return problem.class === 'timeout' ? { status: 'late', failure: problem } : { status: 'unread', failure: problem }
}

// The browser says how a read failed; a page whose browser has gone, or an error with no account of itself, is lost.
function readFailure(error: unknown, app: string, connected: boolean): Failure {
  const reported = error instanceof Error && 'failure' in error ? parse(failureSchema, error.failure) : undefined
  if (connected && reported?.ok === true) return reported.value
  const where = connected ? `Retest could not read the page of ${app} for a host check` : `The browser of ${app} was lost during a host check`
  return failure('session_lost', `${where}: ${errorMessage(error)}`)
}

// A look taken while the frame was opening another document judges nothing.
function passes(check: HostCheck, reading: PageReading | undefined): boolean {
  if (reading === undefined || reading.navigating) return false
  if (check.kind === 'address') return matchesAddress(reading.url, check)
  const found = reading.found[0] === true
  return check.absent === true ? !found : found
}

// What the last look saw: the page's address and title, and for a text check whether the text was there.
function actualOf(check: HostCheck, last: PageReading | undefined): HostCheckActual {
  if (last === undefined) return {}
  const page = { ...(last.url === undefined ? {} : { url: last.url }), ...(last.title === undefined ? {} : { title: last.title }) }
  return check.kind === 'text' ? { ...page, found: last.found[0] === true } : page
}

function checkFailure(check: HostCheck, app: string, last: PageReading | undefined, looked: { attempts: number; timeoutMs: number }): Failure {
  const named = check.name === undefined ? `The ${check.kind} check on ${app}` : `The host check ${quoteText(check.name)} on ${app}`
  const opening = last?.navigating === true ? ' The page was still opening another document.' : ''
  const times = `Looked ${looked.attempts} ${looked.attempts === 1 ? 'time' : 'times'} in ${looked.timeoutMs} ms.`
  const url = last?.url
  if (check.kind === 'address') {
    const expected = expectedAddress(check)
    const message = `${named} failed: the page is on ${url ?? 'no web address'}, expected ${expected}.${opening} ${times}`
    return { class: 'host_check_failed', message, details: { expected: truncateText(expected), received: url === undefined ? null : truncateText(url), ...looked } }
  }
  const ignoringCase = check.ignoreCase === true ? ', ignoring case' : ''
  const saw = check.absent === true ? `the page shows ${quoteText(check.text)}${ignoringCase}, which it should not` : `the page does not show ${quoteText(check.text)}${ignoringCase}`
  return { class: 'host_check_failed', message: `${named} failed: ${saw}.${opening} ${times}`, details: { expected: truncateText(check.text), ...looked } }
}

function expectedAddress(check: Extract<HostCheck, { kind: 'address' }>): string {
  const origin = readOrigin(check.origin) ?? check.origin
  const { path } = check
  if (path === undefined) return origin
  return typeof path === 'string' ? `${origin}${path}` : `${origin} with a path matching ${String(path)}`
}

function stopped(context: PagesContext): CheckOutcome {
  return { kind: 'stopped', failure: context.interruption() ?? failure('interrupted', 'The run was interrupted.') }
}
