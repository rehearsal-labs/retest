import type { Counts, RunStatus, TestStatus } from '../protocol/events.ts'
import {
  truncateText,
  type FailureClass,
  type FailureDetail,
  type SourceLocation,
  type TruncatedText,
} from '../protocol/failures.ts'

/** How many characters of a recorded value a terminal report shows. `inspect --json` keeps them all. */
export const shownValueLength = 300

const failureLabels: Record<FailureClass, string> = {
  check_failed: 'Check failed',
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
  const quoted = JSON.stringify(shown.text)
  if (!shown.truncated && !value.truncated) return quoted
  return `${quoted}… (${shown.text.length} of ${value.length} characters)`
}

/** A failure detail as text. Text is quoted, so page text cannot pass for Retest's own words. */
export function formatDetail(value: FailureDetail): string {
  if (typeof value === 'string') return quoteRecorded(truncateText(value))
  if (value === null || typeof value !== 'object') return String(value)
  return quoteRecorded(value)
}

/** @example formatLocation({ file: 'a.retest.ts', line: 7, column: 3 }) // 'a.retest.ts:7:3' */
export function formatLocation(location: SourceLocation): string {
  return `${location.file}:${location.line}:${location.column}`
}

/** @example formatLine({ file: 'a.retest.ts', line: 7, column: 3 }) // 'a.retest.ts:7' */
export function formatLine(location: SourceLocation): string {
  return `${location.file}:${location.line}`
}

/** A test as a heading. Commands use the ASCII `>` of the test id instead. */
export function testTitle(file: string, name: string): string {
  return `${file} › ${name}`
}
