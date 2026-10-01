import type { Counts, RetestEvent, RunStatus, TestStatus } from '../protocol/events.ts'
import { truncateText, type FailureClass, type FailureDetail, type TruncatedText } from '../protocol/failures.ts'
import { listWords } from '../shared/list-words.ts'

/** How many characters of a recorded value a terminal report shows. `inspect --json` keeps them all. */
export const shownValueLength = 300

const failureLabels: Record<FailureClass, string> = {
  check_failed: 'Check failed',
  host_check_failed: 'Host check failed',
  not_found: 'Not found',
  ambiguous: 'Ambiguous',
  not_actionable: 'Not actionable',
  timeout: 'Timed out',
  session_lost: 'Browser lost',
  outcome_unknown: 'Outcome unknown',
  setup_failed: 'Setup failed',
  cleanup_failed: 'Cleanup failed',
  collection_failed: 'Collection failed',
  test_error: 'Test error',
  no_assertions: 'No assertions',
  not_awaited: 'Not awaited',
  concurrent_commands: 'Two commands at once',
  unsupported: 'Unsupported',
  usage: 'Usage error',
  interrupted: 'Interrupted',
  reporting_failed: 'Reporting failed',
}

export function failureLabel(failureClass: FailureClass): string {
  return failureLabels[failureClass]
}

const statusLabels: Record<TestStatus, string> = {
  passed: 'Passed',
  failed: 'Failed',
  error: 'Error',
  not_run: 'Not run',
  inconclusive: 'Inconclusive',
}

/** @example statusLabel('not_run') // 'Not run' */
export function statusLabel(status: TestStatus): string {
  return statusLabels[status]
}

/**
 * A duration as a person reads it.
 *
 * @example formatDuration(812) // '812 ms'
 * @example formatDuration(5600) // '5.6s'
 */
export function formatDuration(milliseconds: number): string {
  const rounded = Math.round(milliseconds)
  if (rounded < 1000) return `${rounded} ms`
  if (rounded < 60_000) return `${trimZero((rounded / 1000).toFixed(1))}s`
  const minutes = Math.floor(rounded / 60_000)
  const seconds = Math.round((rounded % 60_000) / 1000)
  return `${minutes}m ${seconds}s`
}

function trimZero(text: string): string {
  return text.endsWith('.0') ? text.slice(0, -2) : text
}

/** @example plural(2, 'test') // '2 tests' */
export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

/**
 * The non-zero counts, worst first.
 *
 * @example countParts({ passed: 2, failed: 1, error: 0, notRun: 0, inconclusive: 0 }) // ['1 failed', '2 passed']
 */
export function countParts(counts: Counts): string[] {
  const parts: [number, string][] = [
    [counts.failed, 'failed'],
    [counts.error, counts.error === 1 ? 'error' : 'errors'],
    [counts.inconclusive, 'inconclusive'],
    [counts.passed, 'passed'],
    [counts.notRun, 'not run'],
  ]
  return parts.filter(([count]) => count > 0).map(([count, label]) => `${count} ${label}`)
}

/** What a reader must know about how the run ended besides its exit code. */
export function runNotes(result: { status: RunStatus; complete: boolean }): string[] {
  return [...(result.status === 'interrupted' ? ['interrupted'] : []), ...(result.complete ? [] : ['incomplete'])]
}

export function totalTests(counts: Counts): number {
  return counts.passed + counts.failed + counts.error + counts.notRun + counts.inconclusive
}

/**
 * A recorded value in quotes, with escapes, cut for a terminal. The note gives the recorded length when
 * any part of it is missing.
 *
 * @example quoteRecorded({ text: 'Saving…', truncated: false, length: 7 }) // '"Saving…"'
 */
export function quoteRecorded(value: TruncatedText): string {
  const shown = truncateText(value.text, shownValueLength)
  const quoted = printable(JSON.stringify(shown.text))
  if (!shown.truncated && !value.truncated) return quoted
  return `${quoted}… (${shown.text.length} of ${value.length} characters)`
}

// JSON escapes the first 32 control characters; DEL and the C1 range, such as U+009B, can still start a terminal escape.
const controlCharacters = /[\u0000-\u001f\u007f-\u009f]/g

/**
 * Text a page or a test file wrote, with every control character written as its escape, so it cannot move the
 * cursor or change colours in a terminal.
 *
 * @example printable('Saved\u001b[2J') // 'Saved\\u001b[2J'
 */
export function printable(text: string): string {
  return text.replace(controlCharacters, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`)
}

/**
 * A page as reports name it: its address, after its title when it has one. A title is the page's own text, so it is
 * quoted and escaped, and it never stands in for the address.
 *
 * @example describePage('http://127.0.0.1:4173/cart', 'Your cart') // '"Your cart" at http://127.0.0.1:4173/cart'
 */
export function describePage(url: string, title?: string): string {
  const address = printable(url)
  return title === undefined || title === '' ? address : `${quoteRecorded(truncateText(title))} at ${address}`
}

/**
 * A failure message as the lines a report prints. A message may quote page text, so each line is printable.
 *
 * @example messageLines('Expected "Saved".\nLooked 3 times.') // ['Expected "Saved".', 'Looked 3 times.']
 */
export function messageLines(message: string): string[] {
  return message.split('\n').map(printable)
}

/** A failure detail as text. Text is quoted, so page text cannot pass for Retest's own words. */
export function formatDetail(value: FailureDetail): string {
  if (typeof value === 'string') return quoteRecorded(truncateText(value))
  if (value === null || typeof value !== 'object') return String(value)
  return quoteRecorded(value)
}

/**
 * A test's name inside its `test.describe` blocks, outermost first.
 *
 * @example titleWithin('archives a task', ['archive']) // 'archive › archives a task'
 */
export function titleWithin(name: string, describePath: readonly string[] = []): string {
  return [...describePath, name].join(' › ')
}

/** A test as a heading. Commands use the ASCII `>` of the test id instead. */
export function testTitle(file: string, name: string, describePath?: readonly string[]): string {
  return `${file} › ${titleWithin(name, describePath)}`
}

type AppEvent = Extract<RetestEvent, { type: 'app.started' | 'app.reused' | 'app.failed' }>
type StateEvent = Extract<RetestEvent, { type: 'state.saved' | 'state.restored' }>

/**
 * What happened to an app's server, in one line.
 *
 * @example describeAppEvent(started) // 'started, http://localhost:3000 answered after 2.1s'
 */
export function describeAppEvent(event: AppEvent): string {
  switch (event.type) {
    case 'app.started':
      return describeStarted(event.ready, event.durationMs)
    case 'app.reused':
      return describeRunning(event.ready)
    case 'app.failed':
      return event.failure.message.split('\n')[0] ?? ''
  }
}

/** @example describeStarted('http://localhost:3000', 2100) // 'started, http://localhost:3000 answered after 2.1s' */
export function describeStarted(ready: string, durationMs: number): string {
  return `started, ${ready} answered after ${formatDuration(durationMs)}`
}

/** @example describeRunning('http://localhost:3000', 200) // 'already running, http://localhost:3000 answered 200' */
export function describeRunning(ready: string, status?: number): string {
  return `already running, ${ready} answered${status === undefined ? '' : ` ${status}`}`
}

/**
 * A sign-in state saved or restored, by name and never by contents.
 *
 * @example describeStateEvent(saved) // 'saved state signed-in for web'
 */
export function describeStateEvent(event: StateEvent): string {
  return `${event.type === 'state.saved' ? 'saved' : 'restored'} state ${event.state} for ${event.app}`
}

/**
 * A setup the run took from a file it was not given, and the files it ran for.
 *
 * @example describeBorrowedSetup('signed-in', 'tests/sign-in.retest.ts', ['tests/archive.retest.ts']) // 'ran setup signed-in from tests/sign-in.retest.ts for tests/archive.retest.ts'
 */
export function describeBorrowedSetup(name: string, file: string, dependents: readonly string[]): string {
  return `ran setup ${name} from ${file} for ${listWords(dependents, 'and')}`
}
