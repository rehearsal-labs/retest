import type { Failure } from '../protocol/failures.ts'
import type { HostCheckActual, HostCheckRecord, HostCheckStatus } from '../protocol/host-check.ts'
import type { TestResult } from '../protocol/result.ts'
import type { TestEvent } from './run-record.ts'
import { truncateText } from '../protocol/failures.ts'
import { describePage, plural, printable, quoteRecorded } from './format.ts'

/** How a host check looked at the page, and what it saw last. Only its event knows. */
export type HostCheckLooks = { actual: HostCheckActual; attempts: number; timeoutMs: number; durationMs: number }

/**
 * A host check that failed, as a report shows it. `app` is present for a test run with a config, whose lines name
 * the app each check read, as they name the app of each action.
 */
export type FailedHostCheck = { check: HostCheckRecord; app?: string; failure: Failure; looked?: HostCheckLooks }

/** A host check that never ran, because the test's body failed or the test did not run. */
export type NotRunHostCheck = { check: HostCheckRecord; app?: string }

/**
 * What a check asks of the page.
 *
 * @example hostCheckExpectation({ kind: 'address', origin: 'https://app.example', path: { pattern: '^/done', flags: 'i' } }) // 'https://app.example, path matching /^/done/i'
 * @example hostCheckExpectation({ kind: 'text', text: 'Error', absent: true }) // 'no "Error"'
 */
export function hostCheckExpectation(check: HostCheckRecord): string {
  if (check.kind === 'text') {
    const text = `${check.absent === true ? 'no ' : ''}${quote(check.text)}`
    return check.ignoreCase === true ? `${text}, any case` : text
  }
  const { path } = check
  if (path === undefined) return printable(`${check.origin}, any path`)
  if (typeof path === 'string') return printable(`${check.origin}${path}`)
  return printable(`${check.origin}, path matching /${path.pattern}/${path.flags}`)
}

/**
 * A check as a heading names it: its kind, the name the caller gave it, and the app whose page it read when there
 * is one to name.
 *
 * @example hostCheckHeading({ kind: 'text', name: 'order confirmed', text: 'Order placed' }, 'web') // 'text named "order confirmed" on web'
 */
export function hostCheckHeading(check: HostCheckRecord, app?: string): string {
  const named = check.name === undefined ? '' : ` named ${quote(check.name)}`
  return `${check.kind}${named}${app === undefined ? '' : ` on ${app}`}`
}

/**
 * A check on one line: its heading and what it asks.
 *
 * @example describeHostCheck({ kind: 'address', origin: 'https://app.example', path: '/done' }, 'web') // 'address on web: https://app.example/done'
 */
export function describeHostCheck(check: HostCheckRecord, app?: string): string {
  return `${hostCheckHeading(check, app)}: ${hostCheckExpectation(check)}`
}

/**
 * What the page showed a check on its last look: its address, after its title when it had one, and for a text check
 * whether the text was there, or that the page had no body to read.
 *
 * @example hostCheckPage({ kind: 'text', text: 'Order placed' }, { url: 'https://app.example/cart', title: 'Your cart', found: false }) // '"Your cart" at https://app.example/cart, text not found'
 */
export function hostCheckPage(check: HostCheckRecord, actual: HostCheckActual): string {
  const page = actual.url === undefined ? '(no web address)' : describePage(actual.url, actual.title)
  if (check.kind !== 'text') return page
  if (actual.body === false) return `${page}, no body to read`
  return actual.found === undefined ? page : `${page}, ${actual.found ? 'text found' : 'text not found'}`
}

/**
 * How long a check looked, with durations written by `duration`.
 *
 * @example describeHostCheckWait(looked, formatDuration) // '5s, looked 14 times, limit 5s'
 */
export function describeHostCheckWait(looked: HostCheckLooks, duration: (milliseconds: number) => string): string {
  return `${duration(looked.durationMs)}, looked ${plural(looked.attempts, 'time')}, limit ${duration(looked.timeoutMs)}`
}

/**
 * Whether a check's failure message only says what its expectation and its page already show. Any other failure,
 * such as a page that could not be read, says something they do not.
 */
export function hostCheckMessageRepeats(check: FailedHostCheck): boolean {
  return check.failure.class === 'host_check_failed' && check.looked !== undefined
}

/**
 * A test's failed host checks, in the order they ran. Its events say what each saw; a result read without its
 * events still lists them, without what they saw.
 *
 * @example failedHostChecks(record.events, test)[0]?.looked?.actual.url // 'https://app.example/cart'
 */
export function failedHostChecks(events: readonly TestEvent[], test: TestResult): FailedHostCheck[] {
  if (events.length === 0) {
    return (test.hostChecks ?? []).flatMap(({ check, app, status, failure }) =>
      status === 'failed' && failure !== undefined ? [{ check, ...shownApp(test, app), failure }] : [],
    )
  }
  return events.flatMap((event) => {
    if (event.type !== 'host_check.failed') return []
    const { check, session, failure, actual, attempts, timeoutMs, durationMs } = event
    return [{ check, ...shownApp(test, session), failure, looked: { actual, attempts, timeoutMs, durationMs } }]
  })
}

/** The host checks a test listed as not run. */
export function notRunHostChecks(test: TestResult): NotRunHostCheck[] {
  return (test.hostChecks ?? []).flatMap(({ check, app, status }) => (status === 'not_run' ? [{ check, ...shownApp(test, app) }] : []))
}

/**
 * The host checks of every test, counted by status, worst first. Empty when no test had any.
 *
 * @example countHostChecks(tests) // ['1 failed', '3 passed', '2 not run']
 */
export function countHostChecks(tests: readonly TestResult[]): string[] {
  const statuses = tests.flatMap((test) => (test.hostChecks ?? []).map((check) => check.status))
  const parts: [HostCheckStatus, string][] = [
    ['failed', 'failed'],
    ['passed', 'passed'],
    ['not_run', 'not run'],
  ]
  return parts.flatMap(([status, label]) => {
    const count = statuses.filter((found) => found === status).length
    return count === 0 ? [] : [`${count} ${label}`]
  })
}

// Milestone 1's mode has one app, `page`, and its tests have no variant; there is no app to name.
function shownApp(test: TestResult, app: string): { app?: string } {
  return test.variant === undefined ? {} : { app }
}

function quote(text: string): string {
  return quoteRecorded(truncateText(text))
}
