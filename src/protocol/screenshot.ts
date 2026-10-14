import type { FailureClass } from './failures.ts'
import type { EmptyStep, LocatorRecipe } from './locator.ts'
import { describeEmptyStep, describeLocator, emptyStepSchema, stringLiteral } from './locator.ts'
import { s, type Schema } from './schema.ts'

// `toHaveScreenshot`: what its check records, what each look at the page answers, and the rule the test process polls
// with and the parent judges with. The parent takes every picture, keeps the pixels, and compares a settled picture
// with its baseline; a look carries only the sizes and the counts, never pixels.

/** The colour distance above which a pixel counts as different, when the test gives none: Playwright's default. */
export const defaultScreenshotThreshold = 0.2

/** The longest name a screenshot may have. */
export const screenshotNameLimit = 100

/**
 * How a check takes its pictures: the first at once, then each after these waits in milliseconds, the last repeating
 * until the assertion's time runs out. Two pictures in a row are never closer than the first wait.
 */
export const pictureWaits: readonly number[] = [0, 100, 250, 500, 1000]

/** How long, in milliseconds, a check's pictures must stay the same before the newest settles it. */
export const settleGapMs = 100

/**
 * How long, in milliseconds, a picture must stay the same before a run that writes baselines takes it as one, so a
 * page that shows a loading state for a moment never writes that state as its baseline.
 */
export const baselineHoldMs = 1000

/**
 * `toHaveScreenshot` and its options, whole: the name of its baseline, and each limit only when the test gave it.
 * `threshold` is a colour distance from 0 to 1; `maxDiffPixels` a whole number of pixels; `maxDiffPixelRatio` a part of
 * the baseline's pixels, from 0 to 1. The matcher has no `.not`.
 */
export type ScreenshotCheckRecord = {
  matcher: 'toHaveScreenshot'
  name: string
  threshold?: number
  maxDiffPixels?: number
  maxDiffPixelRatio?: number
}

export const screenshotCheckRecordSchema: Schema<ScreenshotCheckRecord> = s.object({
  matcher: s.literal('toHaveScreenshot'),
  name: s.string(),
  threshold: s.optional(s.number({ min: 0 })),
  maxDiffPixels: s.optional(s.number({ integer: true, min: 0 })),
  maxDiffPixelRatio: s.optional(s.number({ min: 0 })),
})

/** What a screenshot look was taken for: the element, when not the whole page, the baseline's name and the threshold. */
export type ScreenshotRequest = { locator?: LocatorRecipe; name: string; threshold?: number }

/**
 * The look a screenshot check needs, from its record and the locator it was called on.
 *
 * @example screenshotRequest({ matcher: 'toHaveScreenshot', name: 'chart', threshold: 0.1 }, chart) // { locator: chart, name: 'chart', threshold: 0.1 }
 */
export function screenshotRequest(record: ScreenshotCheckRecord, locator: LocatorRecipe | undefined): ScreenshotRequest {
  return { ...(locator === undefined ? {} : { locator }), name: record.name, ...(record.threshold === undefined ? {} : { threshold: record.threshold }) }
}

/** A picture's size in pixels, and the device scale factor it was taken at, when the browser told it. */
export type PictureSize = { width: number; height: number; scale?: number }

/**
 * How a settled picture stands against its baseline: there is none (`missing`), the baseline cannot be read
 * (`unreadable`, with the sentence that says why and names the file), the run writes the picture as the baseline
 * (`update`, with `--update-screenshots`), or it was `compared` with the baseline of size `expected`, with
 * `differentPixels` counted only when both have one size and record one scale.
 */
export type BaselineComparison =
  | { kind: 'missing' }
  | { kind: 'unreadable'; problem: string }
  | { kind: 'update' }
  | { kind: 'compared'; expected: PictureSize; differentPixels?: number }

/**
 * Why a look at an element took no picture: no element matched, several did, the one match is not shown, or it runs
 * past the viewport, which a picture of it cannot leave without scrolling.
 */
export type ScreenshotTarget = { count: number; emptyStep?: EmptyStep; refused?: 'hidden' | 'outside' }

/**
 * What one screenshot look saw. `baseline` is where the check's baseline is, POSIX and relative to the project's root.
 * `target` is what the locator found, for a picture of an element. `picture` is the picture taken, absent when none
 * was. `settled` is true when the check's pictures, this one and those right before it, have been the same pixels at
 * the same place and scale for `settleGapMs`, or `baselineHoldMs` in a run that writes baselines. `first` marks a
 * picture with no earlier one of its check to compare it with; `steady` says, for a picture the same as the one before
 * it that has not settled yet, how long they have been the same and how long settling needs. `comparison` is present
 * on a settled look, and on any look whose picture no later one could change the verdict of: no baseline, one that
 * cannot be read, or one of another size or scale. `unreadable` says why the browser's picture could not be read.
 */
export type ScreenshotLook = {
  baseline: string
  target?: ScreenshotTarget
  picture?: PictureSize
  settled: boolean
  first?: true
  steady?: { forMs: number; neededMs: number }
  comparison?: BaselineComparison
  unreadable?: string
}

const pictureSizeSchema: Schema<PictureSize> = s.object({
  width: s.number({ integer: true, min: 1 }),
  height: s.number({ integer: true, min: 1 }),
  scale: s.optional(s.number({ min: 0 })),
})

export const screenshotLookSchema: Schema<ScreenshotLook> = s.object({
  baseline: s.string(),
  target: s.optional(s.object({ count: s.number({ integer: true, min: 0 }), emptyStep: s.optional(emptyStepSchema), refused: s.optional(s.enum(['hidden', 'outside'])) })),
  picture: s.optional(pictureSizeSchema),
  settled: s.boolean(),
  first: s.optional(s.literal(true)),
  steady: s.optional(s.object({ forMs: s.number({ min: 0 }), neededMs: s.number({ min: 0 }) })),
  unreadable: s.optional(s.string()),
  comparison: s.optional(
    s.union([
      s.object({ kind: s.literal('missing') }),
      s.object({ kind: s.literal('unreadable'), problem: s.string() }),
      s.object({ kind: s.literal('update') }),
      s.object({ kind: s.literal('compared'), expected: pictureSizeSchema, differentPixels: s.optional(s.number({ integer: true, min: 0 })) }),
    ]),
  ),
})

/**
 * What a screenshot assertion's event records of the look it rested on, as the parent judged it: the name, the
 * baseline's path, the threshold applied, whether the picture settled, its size and scale, how it stood against the
 * baseline, the baseline's size, and the pixels that differed with how many could.
 */
export type ScreenshotRecord = {
  name: string
  baseline: string
  threshold: number
  settled: boolean
  picture?: PictureSize
  baselineState?: BaselineComparison['kind']
  expected?: PictureSize
  differentPixels?: number
  allowedPixels?: number
}

export const screenshotRecordSchema: Schema<ScreenshotRecord> = s.object({
  name: s.string(),
  baseline: s.string(),
  threshold: s.number({ min: 0 }),
  settled: s.boolean(),
  picture: s.optional(pictureSizeSchema),
  baselineState: s.optional(s.enum(['missing', 'unreadable', 'update', 'compared'])),
  expected: s.optional(pictureSizeSchema),
  differentPixels: s.optional(s.number({ integer: true, min: 0 })),
  allowedPixels: s.optional(s.number({ min: 0 })),
})

/** A file an assertion left in the run folder: `path` is relative to it. A screenshot comparison leaves its pictures. */
export type Attachment = { name: 'expected' | 'actual' | 'diff'; path: string; contentType: 'image/png' }

export const attachmentSchema: Schema<Attachment> = s.object({
  name: s.enum(['expected', 'actual', 'diff']),
  path: s.string(),
  contentType: s.literal('image/png'),
})

/**
 * Why a screenshot's name cannot name a baseline file, or undefined when it can: lowercase letters, digits, dots,
 * dashes and underscores, starting with a letter or a digit, so it is one file name on every file system.
 *
 * @example screenshotNameProblem('Dashboard') // 'A screenshot's name is lowercase letters, …'
 */
export function screenshotNameProblem(name: string): string | undefined {
  if (name.length > screenshotNameLimit) return `A screenshot's name is at most ${screenshotNameLimit} characters, and this one has ${name.length}.`
  if (/^[a-z0-9][a-z0-9._-]*$/.test(name)) return undefined
  return "A screenshot's name is lowercase letters, digits, dots, dashes and underscores, starting with a letter or a digit, such as 'dashboard' or 'chart-empty'."
}

/**
 * The sentence for a name that cannot name a baseline, quoting it as the test wrote it, or undefined when it can. The
 * test process and the parent both refuse with it, the parent before it reads any file.
 *
 * @example screenshotNameRefusal('../x') // "toHaveScreenshot() received the name '../x'. A screenshot's name is …"
 */
export function screenshotNameRefusal(name: string): string | undefined {
  const problem = screenshotNameProblem(name)
  return problem === undefined ? undefined : `toHaveScreenshot() received the name ${stringLiteral(name)}. ${problem}`
}

/**
 * The sentence for a threshold outside 0 to 1, which the test process and the parent both refuse with.
 *
 * @example thresholdRefusal(5) // 'The threshold option of toHaveScreenshot() is a colour distance from 0 to 1, received 5.'
 */
export function thresholdRefusal(threshold: string): string {
  return `The threshold option of toHaveScreenshot() is a colour distance from 0 to 1, received ${threshold}.`
}

/**
 * Why the parent refuses a screenshot look the test process sent, before it takes a picture or reads a file: a name
 * that cannot name a baseline, or a threshold outside 0 to 1. The test's own API never sends one.
 *
 * @example screenshotRequestProblem({ name: 'page', threshold: 5 }) // 'The threshold option of toHaveScreenshot() is …'
 */
export function screenshotRequestProblem(request: { name: string; threshold?: number | undefined }): string | undefined {
  const named = screenshotNameRefusal(request.name)
  if (named !== undefined) return named
  return request.threshold === undefined || isFraction(request.threshold) ? undefined : thresholdRefusal(String(request.threshold))
}

/**
 * Why the parent cannot judge a screenshot check a test process sent, or undefined when it can. The test's own API
 * never sends one that fails.
 *
 * @example screenshotCheckProblem({ matcher: 'toHaveScreenshot', name: 'a', threshold: 2 }) // 'The threshold option …'
 */
export function screenshotCheckProblem(record: ScreenshotCheckRecord): string | undefined {
  const request = screenshotRequestProblem(record)
  if (request !== undefined) return request
  if (record.maxDiffPixelRatio !== undefined && !isFraction(record.maxDiffPixelRatio)) return `The maxDiffPixelRatio option of toHaveScreenshot() is a part of the pixels from 0 to 1, received ${record.maxDiffPixelRatio}.`
  return undefined
}

function isFraction(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1
}

/**
 * Where a test file's baseline of a screenshot is, POSIX and relative to the project's root: beside the test file,
 * in `__screenshots__/<file name>/`, named with the engine and the platform, since their pixels differ.
 *
 * @example baselineFile({ testFile: 'tests/tasks.retest.ts', name: 'dashboard', engine: 'chromium', platform: 'darwin-arm64' }) // 'tests/__screenshots__/tasks.retest.ts/dashboard-chromium-darwin-arm64.png'
 */
export function baselineFile(options: { testFile: string; name: string; engine: string; platform: string }): string {
  const { testFile, name, engine, platform } = options
  const cut = testFile.lastIndexOf('/')
  const folder = cut === -1 ? '' : `${testFile.slice(0, cut)}/`
  return `${folder}__screenshots__/${testFile.slice(cut + 1)}/${name}-${engine}-${platform}.png`
}

/**
 * How many pixels may differ from a baseline of `total` pixels. A limit the test did not give does not count; with
 * both, the smaller wins, so each one holds, as Playwright 1.63 reads them; with neither, no pixel may differ.
 *
 * @example allowedPixels({ matcher: 'toHaveScreenshot', name: 'a', maxDiffPixels: 50 }, 1000) // 50
 */
export function allowedPixels(record: ScreenshotCheckRecord, total: number): number {
  const byRatio = record.maxDiffPixelRatio === undefined ? undefined : total * record.maxDiffPixelRatio
  if (record.maxDiffPixels !== undefined && byRatio !== undefined) return Math.min(record.maxDiffPixels, byRatio)
  return record.maxDiffPixels ?? byRatio ?? 0
}

/**
 * Why a look did not pass: as a check about one element, `not_found` or `ambiguous`; `setup_failed` for a picture or a
 * baseline that cannot be read, since the check could not be made; else `check_failed`.
 */
export type ScreenshotUnmet = { class: Extract<FailureClass, 'not_found' | 'ambiguous' | 'check_failed' | 'setup_failed'>; message: string }

/** What a screenshot assertion looks for in each look, and how it says what it saw. */
export type ScreenshotCheck = {
  readonly matcher: 'toHaveScreenshot'
  readonly expected: string
  readonly comparison: string
  /**
   * Whether a look is the last one the check needs: it passes, or nothing a later look shows can change the verdict,
   * since the picture or the baseline cannot be read, there is no baseline, or the picture is not the baseline's
   * scale, or, for the page, its size.
   */
  done(look: ScreenshotLook): boolean
  passes(look: ScreenshotLook): boolean
  actual(look: ScreenshotLook): string | null
  measured(look: ScreenshotLook): ScreenshotRecord
  /** Why the look did not pass, naming `locator`, the element the check was called on, or the page without one. */
  unmet(look: ScreenshotLook, locator: LocatorRecipe | undefined): ScreenshotUnmet
}

/**
 * The rule the test process polls a screenshot check with, and the parent judges it with. A look passes once its
 * picture has settled and, against the baseline, the run writes it as the baseline, or the two have one size and one
 * scale and no more pixels differ than `allowedPixels` lets. A look with no baseline never passes. A settled picture
 * that does not pass is looked at again until the time runs out, as other matchers look, so a page still loading
 * passes once it shows its baseline. Settling is only for a picture that could match: no baseline, one that cannot be
 * read, or a picture of another scale, or a page's picture of another size, ends the check on the picture at hand,
 * since no later one can change it. An element's box can still grow or shrink, so its picture is looked at again.
 *
 * @example screenshotCheck({ matcher: 'toHaveScreenshot', name: 'dashboard' }).passes(look)
 */
export function screenshotCheck(record: ScreenshotCheckRecord): ScreenshotCheck {
  const threshold = record.threshold ?? defaultScreenshotThreshold
  const named = `the baseline ${JSON.stringify(record.name)}`
  return {
    matcher: 'toHaveScreenshot',
    expected: `matches ${named}${describeLimits(record)}`,
    comparison: `each pixel's colour against the baseline's once two pictures in a row were the same, a distance above ${threshold} counted, anti-aliasing left out`,
    done: (look) => look.unreadable !== undefined || verdict(record, look).passes || cannotMatch(look),
    passes: (look) => verdict(record, look).passes,
    actual: (look) => actualOf(look),
    measured: (look) => measuredOf(record, look, threshold),
    unmet: (look, locator) => unmetOf(record, look, locator),
  }
}

// Whether no later picture of the check can match its baseline: there is none, it cannot be read, or the picture is of
// another scale, or, for the page, whose size the viewport fixes for the whole check, of another size.
function cannotMatch(look: ScreenshotLook): boolean {
  const { comparison, picture } = look
  if (comparison === undefined || comparison.kind === 'update') return false
  if (comparison.kind === 'missing' || comparison.kind === 'unreadable') return true
  if (picture === undefined) return false
  if (comparison.expected.scale !== picture.scale) return true
  const sized = comparison.expected.width === picture.width && comparison.expected.height === picture.height
  return !sized && look.target === undefined
}

function describeLimits(record: ScreenshotCheckRecord): string {
  const { maxDiffPixels, maxDiffPixelRatio } = record
  if (maxDiffPixels === undefined && maxDiffPixelRatio === undefined) return ', pixel for pixel'
  const pixels = maxDiffPixels === undefined ? undefined : `${maxDiffPixels} ${maxDiffPixels === 1 ? 'pixel' : 'pixels'}`
  const ratio = maxDiffPixelRatio === undefined ? undefined : `a ratio of ${maxDiffPixelRatio} of its pixels`
  return `, with at most ${[pixels, ratio].filter((part) => part !== undefined).join(' and ')} different`
}

type Verdict = { passes: boolean; allowed?: number }

function verdict(record: ScreenshotCheckRecord, look: ScreenshotLook): Verdict {
  const { picture, comparison } = look
  if (!look.settled || picture === undefined || comparison === undefined) return { passes: false }
  if (comparison.kind === 'update') return { passes: true }
  if (comparison.kind === 'missing' || comparison.kind === 'unreadable' || comparison.differentPixels === undefined) return { passes: false }
  const { expected } = comparison
  if (expected.width !== picture.width || expected.height !== picture.height || expected.scale !== picture.scale) return { passes: false }
  const allowed = allowedPixels(record, comparison.expected.width * comparison.expected.height)
  return { passes: comparison.differentPixels <= allowed, allowed }
}

function actualOf(look: ScreenshotLook): string | null {
  const { picture, comparison } = look
  if (picture === undefined) return null
  const size = describeSize(picture)
  if (comparison === undefined) return look.first === true ? `${size}, the only picture` : `${size}, not settled`
  if (comparison.kind === 'missing') return `${size}, no baseline`
  if (comparison.kind === 'unreadable') return `${size}, the baseline cannot be read`
  if (comparison.kind === 'update') return `${size}, written as the baseline`
  if (comparison.differentPixels === undefined) return `${size}${describeScale(picture)}, the baseline ${describeSize(comparison.expected)}${describeScale(comparison.expected)}`
  if (!look.settled) return `${size}, not settled`
  return `${comparison.differentPixels} of ${picture.width * picture.height} pixels different`
}

function measuredOf(record: ScreenshotCheckRecord, look: ScreenshotLook, threshold: number): ScreenshotRecord {
  const { picture, comparison } = look
  const allowed = verdict(record, look).allowed
  return {
    name: record.name,
    baseline: look.baseline,
    threshold,
    settled: look.settled,
    ...(picture === undefined ? {} : { picture }),
    ...(comparison === undefined ? {} : { baselineState: comparison.kind }),
    ...(comparison?.kind === 'compared' ? { expected: comparison.expected } : {}),
    ...(comparison?.kind === 'compared' && comparison.differentPixels !== undefined ? { differentPixels: comparison.differentPixels } : {}),
    ...(allowed === undefined ? {} : { allowedPixels: allowed }),
  }
}

function unmetOf(record: ScreenshotCheckRecord, look: ScreenshotLook, locator: LocatorRecipe | undefined): ScreenshotUnmet {
  const subject = locator === undefined ? 'The page' : describeLocator(locator)
  const named = `the baseline ${JSON.stringify(record.name)}`
  const { target, picture, comparison } = look
  if (look.unreadable !== undefined) return { class: 'setup_failed', message: look.unreadable }
  if (target !== undefined && locator !== undefined && target.count === 0) {
    const step = target.emptyStep === undefined ? undefined : describeEmptyStep(locator, target.emptyStep)
    return { class: 'not_found', message: `${subject} matched no element.${step === undefined ? '' : ` ${step}`}` }
  }
  if (target !== undefined && target.count > 1) return { class: 'ambiguous', message: `${subject} matched ${target.count} elements, and toHaveScreenshot needs exactly one.` }
  if (target?.refused === 'hidden') return { class: 'check_failed', message: `${subject} is not shown, so Retest took no picture of it.` }
  if (target?.refused === 'outside') return { class: 'check_failed', message: `${subject} runs past the viewport, so Retest took no picture of it. Scroll it into view first.` }
  if (picture === undefined) return { class: 'check_failed', message: `Retest took no picture of ${locator === undefined ? 'the page' : subject}.` }
  if (comparison === undefined || (!look.settled && comparison.kind === 'compared' && sameShape(picture, comparison.expected))) return unsettled(look, subject, named)
  if (comparison.kind === 'missing') {
    return { class: 'check_failed', message: `No baseline named ${JSON.stringify(record.name)} exists at ${look.baseline}. Run with --update-screenshots to save this picture as the baseline.` }
  }
  if (comparison.kind === 'unreadable') return { class: 'setup_failed', message: comparison.problem }
  if (comparison.kind === 'update') return { class: 'check_failed', message: `The picture was written as ${named}.` }
  const { expected, differentPixels } = comparison
  if (expected.width !== picture.width || expected.height !== picture.height) {
    return { class: 'check_failed', message: `The picture is ${describeSize(picture)}, and ${named} is ${describeSize(expected)}.${scaleSentence(picture, expected, named)}` }
  }
  if (differentPixels === undefined) return { class: 'check_failed', message: scaleSentence(picture, expected, named).trimStart() || `Retest could not compare the picture with ${named}.` }
  const total = picture.width * picture.height
  const allowed = allowedPixels(record, total)
  const ratio = differentPixels / total
  const limit = `At most ${formatCount(allowed)} may differ.`
  return { class: 'check_failed', message: `${differentPixels} ${differentPixels === 1 ? 'pixel differs' : 'pixels differ'} from ${named}, a ratio of ${formatRatio(ratio)} of its ${total} pixels. ${limit}` }
}

function sameShape(picture: PictureSize, expected: PictureSize): boolean {
  return picture.width === expected.width && picture.height === expected.height && picture.scale === expected.scale
}

// Why a picture that could match its baseline was compared with nothing: no second picture came in time, the pictures
// stayed the same for less than settling needs, or no two in a row were the same.
function unsettled(look: ScreenshotLook, subject: string, named: string): ScreenshotUnmet {
  const lowered = subject === 'The page' ? 'the page' : subject
  if (look.first === true) {
    return { class: 'check_failed', message: `Only one picture of ${lowered} was taken in the time allowed, so Retest could not tell whether it had settled, and compared none with ${named}.` }
  }
  if (look.steady !== undefined) {
    return { class: 'check_failed', message: `${subject} had stayed the same for ${Math.round(look.steady.forMs)} ms when the time ran out, and a picture settles after ${look.steady.neededMs} ms, so Retest compared none with ${named}.` }
  }
  return { class: 'check_failed', message: `${subject} never settled. No two pictures in a row were the same, so Retest compared none with ${named}. An animation that never stops cannot be compared.` }
}

// The sentence for a picture whose device scale factor is not its baseline's, or that one of them does not record.
function scaleSentence(picture: PictureSize, expected: PictureSize, named: string): string {
  if (picture.scale === expected.scale) return ''
  if (expected.scale === undefined) return ` ${capitalized(named)} records no device scale factor, and the picture was taken at ${picture.scale ?? 'one this browser does not tell'}. Rewrite it with --update-screenshots.`
  if (picture.scale === undefined) return ` ${capitalized(named)} was taken at a device scale factor of ${expected.scale}, and this browser does not tell the scale of its picture. Rewrite it with --update-screenshots.`
  return ` The picture was taken at a device scale factor of ${picture.scale}, and ${named} at ${expected.scale}.`
}

function capitalized(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`
}

function describeSize(size: PictureSize): string {
  return `${size.width} by ${size.height} pixels`
}

function describeScale(size: PictureSize): string {
  return size.scale === undefined ? '' : ` at scale ${size.scale}`
}

function formatCount(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Math.floor(value * 100) / 100)
}

// A ratio to four places, never rounded to 0 while a pixel differs.
function formatRatio(ratio: number): string {
  if (ratio === 0) return '0'
  const shown = Math.round(ratio * 10_000) / 10_000
  return shown === 0 ? 'under 0.0001' : String(shown)
}
