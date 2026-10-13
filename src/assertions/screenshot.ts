import type { TestRun } from '../api/test-run.ts'
import type { Failure, SourceLocation, TruncatedText } from '../protocol/failures.ts'
import type { LocatorRecipe } from '../protocol/locator.ts'
import type { ScreenshotCheck, ScreenshotCheckRecord, ScreenshotLook } from '../protocol/screenshot.ts'
import { formatValue } from '../api/format-value.ts'
import { elapsedMs } from '../protocol/deadline.ts'
import { failure, truncateText } from '../protocol/failures.ts'
import { pictureWaits, screenshotCheck, screenshotNameRefusal, screenshotRequest, thresholdRefusal } from '../protocol/screenshot.ts'
import { maxTimeout } from '../protocol/timeouts.ts'
import { lookUntil } from './look-until.ts'
import { assertionTime, lookOf, lookReference } from './poll-locator.ts'
import { reportAssertion } from './report.ts'

/** A screenshot check as the test called it: its record, and its own `timeout`, when it gave one. */
export type ScreenshotCall = { record: ScreenshotCheckRecord; timeoutMs?: number }

const optionNames = ['threshold', 'maxDiffPixels', 'maxDiffPixelRatio', 'timeout']

/**
 * Reads what a test passed `toHaveScreenshot`: the baseline's name, with a `.png` it ends in left off, and the options.
 * Answers with a sentence for anything else, which the caller throws as misuse.
 *
 * @example readScreenshotCall('dashboard.png', { maxDiffPixels: 50 }) // { record: { matcher: 'toHaveScreenshot', name: 'dashboard', maxDiffPixels: 50 } }
 */
export function readScreenshotCall(name: unknown, options: unknown): ScreenshotCall | string {
  if (typeof name !== 'string') return `toHaveScreenshot() takes the name of its baseline, such as 'dashboard', received ${formatValue(name)}.`
  const named = name.endsWith('.png') ? name.slice(0, -'.png'.length) : name
  const refused = screenshotNameRefusal(named)
  if (refused !== undefined) return name === named ? refused : `${refused} A .png at the end of ${formatValue(name)} is left off.`
  if (options === undefined) return { record: { matcher: 'toHaveScreenshot', name: named } }
  const shape = `toHaveScreenshot() takes options such as { maxDiffPixels: 50 }, received ${formatValue(options)}.`
  if (typeof options !== 'object' || options === null || Array.isArray(options)) return shape
  const given = Object.entries(options).filter(([, value]) => value !== undefined)
  if (given.some(([key]) => !optionNames.includes(key))) return `${shape} Its options are threshold, maxDiffPixels, maxDiffPixelRatio and timeout.`
  const read = (key: string): unknown => given.find(([option]) => option === key)?.[1]
  const threshold = read('threshold')
  const maxDiffPixels = read('maxDiffPixels')
  const maxDiffPixelRatio = read('maxDiffPixelRatio')
  const timeout = read('timeout')
  if (threshold !== undefined && !isFraction(threshold)) return thresholdRefusal(formatValue(threshold))
  if (maxDiffPixels !== undefined && !isCount(maxDiffPixels)) return `The maxDiffPixels option of toHaveScreenshot() is a whole number of pixels from 0, received ${formatValue(maxDiffPixels)}.`
  if (maxDiffPixelRatio !== undefined && !isFraction(maxDiffPixelRatio)) return `The maxDiffPixelRatio option of toHaveScreenshot() is a part of the pixels from 0 to 1, received ${formatValue(maxDiffPixelRatio)}.`
  if (timeout !== undefined && !(isCount(timeout) && timeout >= 1 && timeout <= maxTimeout)) return `The timeout option of toHaveScreenshot() must be a whole number of milliseconds from 1 to ${maxTimeout}, received ${formatValue(timeout)}.`
  const record: ScreenshotCheckRecord = {
    matcher: 'toHaveScreenshot',
    name: named,
    ...(threshold === undefined ? {} : { threshold }),
    ...(maxDiffPixels === undefined ? {} : { maxDiffPixels }),
    ...(maxDiffPixelRatio === undefined ? {} : { maxDiffPixelRatio }),
  }
  return timeout === undefined ? { record } : { record, timeoutMs: timeout }
}

export type ScreenshotPollOptions = {
  run: TestRun
  stepId: string | undefined
  app: string
  /** The element the matcher was called on; absent for the page. */
  recipe: LocatorRecipe | undefined
  record: ScreenshotCheckRecord
  location: SourceLocation | undefined
  soft: boolean
  timeoutMs?: number | undefined
}

/**
 * Takes pictures of an app's page, or of one element, at the waits `pictureWaits` lists, until a picture has settled
 * and passes against its baseline, the baseline is missing or cannot be read, or the assertion's time runs out, then
 * judges the last. It only reads, and never repeats the action before it, so a page still loading passes once it
 * shows its baseline, and a page that never stops moving fails as one that did not settle. The event names the look
 * its verdict rested on and carries the check whole; the parent records what the picture showed.
 */
export async function pollScreenshot(options: ScreenshotPollOptions): Promise<void> {
  const { run, app, recipe, record, location } = options
  const check = screenshotCheck(record)
  const request = screenshotRequest(record, recipe)
  const timeoutMs = assertionTime(run, options.timeoutMs)
  let previous: string | undefined
  const looked = await lookUntil<ScreenshotLook>({
    run,
    timeoutMs,
    location,
    look: (lookMs) => run.observeScreenshot(app, request, previous, lookMs, location),
    read: (result) => {
      if (result.kind !== 'observeScreenshot') return undefined
      previous = result.observationId
      return lookOf(result.observation, result)
    },
    passes: check.done,
    delays: pictureWaits,
  })
  const { stopped, attempts } = looked
  const last = looked.last?.observation
  const passed = stopped === undefined && last !== undefined && check.passes(last)
  const fields = {
    testId: run.testId,
    attemptId: run.attemptId,
    ...(options.stepId === undefined ? {} : { stepId: options.stepId }),
    session: app,
    matcher: check.matcher,
    ...(recipe === undefined ? {} : { locator: recipe }),
    expected: truncateText(check.expected),
    actual: last === undefined ? null : nullableText(check.actual(last)),
    comparison: check.comparison,
    attempts,
    timeoutMs,
    durationMs: elapsedMs(looked.startedAt, run.time.now),
    ...(location === undefined ? {} : { location }),
    ...lookReference(looked.last),
    check: record,
  }
  if (passed) return reportAssertion(run, fields, undefined, false)
  // Only the check's own verdict is softened; a page that could not be pictured stops the test as usual.
  if (stopped !== undefined) return reportAssertion(run, fields, stopped, false)
  reportAssertion(run, fields, unmet({ check, recipe, last, attempts, timeoutMs, location }), options.soft)
}

type Unmet = { check: ScreenshotCheck; recipe: LocatorRecipe | undefined; last: ScreenshotLook | undefined; attempts: number; timeoutMs: number; location: SourceLocation | undefined }

function unmet({ check, recipe, last, attempts, timeoutMs, location }: Unmet): Failure {
  if (last === undefined) return failure('timeout', `The page answered no look within ${timeoutMs} ms.`, location)
  const looked = `Looked ${attempts} ${attempts === 1 ? 'time' : 'times'} in ${timeoutMs} ms.`
  const details = { expected: truncateText(check.expected), received: nullableText(check.actual(last)), attempts, timeoutMs, comparison: check.comparison }
  const reason = check.unmet(last, recipe)
  // A picture or a baseline that cannot be read says all there is, as the parent's own judgement says it.
  const message = reason.class === 'setup_failed' ? reason.message : `${reason.message} ${looked}`
  return { ...failure(reason.class, message, location), details }
}

function nullableText(text: string | null): TruncatedText | null {
  return text === null ? null : truncateText(text)
}

function isFraction(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}
