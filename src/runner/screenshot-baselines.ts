import type { OwnedPage, RuntimeIdentity, WebEngine } from '../browser/contract.ts'
import type { TakenPicture } from '../browser/screenshot.ts'
import type { PageCommand } from '../protocol/commands.ts'
import type { EventBody } from '../protocol/events.ts'
import type { Failure, SourceLocation } from '../protocol/failures.ts'
import type { CaptureSourceName, RecordIdentity } from '../protocol/identity.ts'
import type { LayoutBox } from '../protocol/layout.ts'
import type { LocatorRecipe } from '../protocol/locator.ts'
import type { PageFacts } from '../protocol/page-facts.ts'
import type { Attachment, BaselineComparison, ScreenshotCheckRecord, ScreenshotLook } from '../protocol/screenshot.ts'
import type { PngPicture, RgbaImage } from '../shared/png.ts'
import type { PagesContext } from './test-pages.ts'
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, posix } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { BrowserError } from '../browser/browser-error.ts'
import { monotonicClock } from '../protocol/deadline.ts'
import { formatSessionId } from '../protocol/evidence.ts'
import { errorMessage, failure } from '../protocol/failures.ts'
import { baselineFile, baselineHoldMs, defaultScreenshotThreshold, screenshotCheck, screenshotRequestProblem, settleGapMs } from '../protocol/screenshot.ts'
import { comparePixels, differencePicture, samePixels } from '../shared/image-diff.ts'
import { readPng, writePng } from '../shared/png.ts'
import { sha256Hex } from '../shared/sha256.ts'
import { artifactPath } from '../store/artifacts.ts'
import { screenshotSource } from './test-pages.ts'

// Screenshot baselines, and the pictures a test's screenshot checks take. The parent takes every picture through the
// pixel policy, keeps its pixels, tells the test process only sizes and counts, and once an assertion names a look,
// writes what that look's verdict needs: the picture, its baseline and their difference for a failure, or the baseline
// itself in a run that updates them.

/** The text chunk a baseline keeps its device scale factor in, so a picture taken at another scale fails by name. */
export const scaleKeyword = 'retest:scale'

/** A look's command, as the test process sent it. */
export type PictureCommand = Extract<PageCommand, { kind: 'observeScreenshot' }>

/** A baseline as read from the disk: its pixels and its scale, when it names one. */
type ReadBaseline = { ok: true; picture: PngPicture; scale?: number } | { ok: false; missing: true } | { ok: false; missing: false; problem: string }

/** What writing a baseline did: wrote a new one, replaced one, found this run had written the same already, or failed. */
type WrittenBaseline = { ok: true; replaced: boolean; again: boolean } | { ok: false; failure: Failure }

/**
 * The run's screenshot baselines. Each is a PNG beside its test file, `baselineFile` names it, and it keeps the device
 * scale factor it was taken at in a `tEXt` chunk. A run with `update` writes every baseline its checks compare against,
 * once each: a second picture for a baseline this run wrote must be the same, or the check that took it fails, so no
 * two checks silently share one file. `written` counts what it wrote.
 */
export class ScreenshotBaselines {
  readonly update: boolean
  readonly #root: string
  readonly #platform: string
  readonly #written = new Map<string, string>()
  readonly #cache = new Map<string, { size: number; modifiedMs: number; read: ReadBaseline }>()

  constructor(options: { rootDir: string; update: boolean; platform?: string }) {
    this.#root = options.rootDir
    this.update = options.update
    this.#platform = options.platform ?? `${process.platform}-${process.arch}`
  }

  /** How many baselines the run wrote. */
  get written(): number {
    return this.#written.size
  }

  /**
   * Where a test file's baseline of a picture taken on `engine` is, relative to the run's root.
   *
   * @example baselines.path('tests/tasks.retest.ts', 'dashboard', 'chromium') // 'tests/__screenshots__/tasks.retest.ts/dashboard-chromium-darwin-arm64.png'
   */
  path(testFile: string, name: string, engine: string): string {
    return baselineFile({ testFile, name, engine, platform: this.#platform })
  }

  /** Reads a baseline, once for each version of the file on the disk. */
  read(path: string): ReadBaseline {
    const file = join(this.#root, ...path.split('/'))
    let stats
    try {
      stats = statSync(file)
    } catch (error) {
      return isMissing(error) ? { ok: false, missing: true } : { ok: false, missing: false, problem: `Retest could not read the baseline at ${path}: ${errorMessage(error)}` }
    }
    const cached = this.#cache.get(path)
    if (cached !== undefined && cached.size === stats.size && cached.modifiedMs === stats.mtimeMs) return cached.read
    const read = readBaseline(file, path)
    this.#cache.set(path, { size: stats.size, modifiedMs: stats.mtimeMs, read })
    return read
  }

  /** Writes a baseline in place of any there, from a settled picture and the scale it was taken at. */
  write(path: string, picture: RgbaImage, scale: number | undefined): WrittenBaseline {
    const digest = `${scale ?? ''}:${sha256Hex(picture.data)}:${picture.width}x${picture.height}`
    const earlier = this.#written.get(path)
    if (earlier !== undefined) {
      if (earlier === digest) return { ok: true, replaced: true, again: true }
      return { ok: false, failure: failure('usage', `Two checks in this run took different pictures for the baseline at ${path}, so Retest kept the first. Give each picture its own name.`) }
    }
    const file = join(this.#root, ...path.split('/'))
    const partial = `${file}.${process.pid}-${Date.now()}.partial`
    let replaced = false
    try {
      replaced = exists(file)
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(partial, writePng(picture, scale === undefined ? {} : { text: { [scaleKeyword]: String(scale) } }), { flag: 'wx' })
      renameSync(partial, file)
    } catch (error) {
      rmSync(partial, { force: true })
      return { ok: false, failure: failure('setup_failed', `Retest could not write the baseline at ${path}: ${errorMessage(error)}`) }
    }
    this.#written.set(path, digest)
    this.#cache.delete(path)
    return { ok: true, replaced, again: false }
  }
}

/**
 * One app's page as a screenshot check takes pictures of it: the page, the web engine it runs on, what takes its
 * pictures, and why none may be taken, for a page Retest compares no pictures of.
 */
export type PictureApp = { page: OwnedPage; engine: WebEngine | undefined; source: CaptureSourceName | undefined; refusal?: string }

/**
 * A picture a look took, as the parent keeps it: its bytes, scale, clip and pixels, when the parent asked for it on the
 * monotonic clock, and since when the check's pictures have been the same, from the first of the run of equal ones.
 */
export type KeptPicture = { png: Uint8Array; scale?: number; clip?: LayoutBox; decoded?: PngPicture; askedAt: number; sameSince: number }

/** What a look's picture came to: the look the test process is told of, the picture kept, and the page it looked at. */
export type TakenLook = { ok: true; look: ScreenshotLook; picture?: KeptPicture; page?: PageFacts } | { ok: false; failure: Failure; refused?: true }

/** What the parent does with a judged screenshot assertion: the files it left, and a failure that now stands in for it. */
export type SettledAssertion = { attachments?: Attachment[]; failure?: Failure }

/** A judged screenshot assertion, as the parent is about to write it. */
export type JudgedPicture = {
  passed: boolean
  check: ScreenshotCheckRecord
  observationId: string
  stepId?: string
  location?: SourceLocation
}

/** A look the parent served: its id, the app and command it answered, what the test process was told, and the picture. */
export type ServedPicture = { observationId: string; app: string; command: PictureCommand; look: ScreenshotLook; picture: KeptPicture | undefined }

/**
 * What the running test asks of an attempt's screenshot checks. A look `take` refuses, with `refused`, is refused
 * every time, so no check on it can pass.
 */
export type ScreenshotAccess = {
  take(app: string, command: PictureCommand, timeoutMs: number, signal: AbortSignal): Promise<TakenLook>
  keep(served: ServedPicture): void
  settle(judged: JudgedPicture): SettledAssertion
}

type Served = { app: string; key: string; command: PictureCommand; picture: KeptPicture | undefined; look: ScreenshotLook; followed: boolean }

/** Where a picture stands in its check: settled, the first with nothing before it, or the same as the one before for a while. */
type Chain = { settled: boolean; first: boolean; steady?: { forMs: number; neededMs: number } }

/**
 * The pictures one attempt's screenshot checks take. A look takes a picture through the page, asks the pixel policy
 * before and again once it is back, and keeps it under the look's id until its assertion is judged or the attempt
 * ends. A look names the look before it in its check; that earlier look is followed once, by one later look, so two
 * checks of one name each keep their own chain, and its pixels then go, since only the newest of a chain is judged.
 * The new picture has settled when the check's pictures have been the same pixels at the same place and scale for
 * `settleGapMs`, or `baselineHoldMs` in a run that writes baselines. Only a settled picture has its pixels counted, or is
 * set to be written as a baseline; a missing or unreadable baseline, or one of another size or scale, is told at once.
 */
export class AttemptScreenshots implements ScreenshotAccess {
  readonly #baselines: ScreenshotBaselines
  readonly #context: PagesContext
  readonly #app: (app: string) => PictureApp | undefined
  readonly #testFile: string
  readonly #served = new Map<string, Served>()

  /** `app` gives each app's page, a popup the test opened included, or undefined for a name the attempt has no page of. */
  constructor(options: { baselines: ScreenshotBaselines; context: PagesContext; app: (app: string) => PictureApp | undefined; testFile: string }) {
    this.#baselines = options.baselines
    this.#context = options.context
    this.#app = options.app
    this.#testFile = options.testFile
  }

  async take(app: string, command: PictureCommand, timeoutMs: number, signal: AbortSignal): Promise<TakenLook> {
    const named = screenshotRequestProblem(command)
    if (named !== undefined) return { ok: false, refused: true, failure: failure('usage', named) }
    const target = this.#app(app)
    if (target === undefined) return { ok: false, refused: true, failure: failure('usage', `The test has no page ${JSON.stringify(app)}.`) }
    if (target.refusal !== undefined) return { ok: false, refused: true, failure: failure('unsupported', target.refusal) }
    const { page, engine, source } = target
    if (engine === undefined) return { ok: false, refused: true, failure: failure('unsupported', `Retest compares pictures of web pages, and ${app} is not one, so it took no picture.`) }
    if (command.locator !== undefined && page.takePicture === undefined) {
      return { ok: false, refused: true, failure: failure('unsupported', `Retest takes a picture of one element on Chrome and Chromium only, and not on ${engineName(engine)} yet, so it took none. Compare the whole page instead.`) }
    }
    const identity = this.#identity(app)
    const askedUs = this.#context.pixels?.clock()
    const before = this.#withheld(identity, source)
    if (before !== undefined) return { ok: false, refused: true, failure: before }
    const askedAt = monotonicClock()
    const taken = await takeFrom(page, command.locator, timeoutMs, signal)
    if (!taken.ok) return taken
    const baseline = this.#baselines.path(this.#testFile, command.name, engine)
    const looked = taken.page === undefined ? {} : { page: taken.page }
    if (!('png' in taken)) return { ok: true, look: { baseline, target: taken.target, settled: false }, ...looked }
    // A picture asked for before a secret's stretch began and back after it may show the secret, so it is asked about again.
    const after = askedUs === undefined ? undefined : this.#withheld(identity, source, { earliestUs: askedUs, arrivedUs: this.#context.pixels?.clock() ?? askedUs })
    if (after !== undefined) return { ok: false, refused: true, failure: after }
    const elementTarget = command.locator === undefined ? {} : { target: { count: 1 } }
    let decoded: PngPicture
    try {
      decoded = readPng(taken.png)
    } catch (error) {
      // The check cannot be made on a picture that cannot be read, so the look says so and ends the check.
      return { ok: true, look: { baseline, ...elementTarget, settled: false, unreadable: `The browser's picture of ${app} is not a PNG Retest reads: ${errorMessage(error)}` }, ...looked }
    }
    const picture: KeptPicture = { png: taken.png, ...(taken.scale === undefined ? {} : { scale: taken.scale }), ...(taken.clip === undefined ? {} : { clip: taken.clip }), decoded, askedAt, sameSince: askedAt }
    const size = { width: decoded.width, height: decoded.height, ...(picture.scale === undefined ? {} : { scale: picture.scale }) }
    const chain = this.#settled(keyOf(app, command), command.previous, picture)
    const comparison = this.#compare({ baseline, decoded, scale: picture.scale, settled: chain.settled, threshold: command.threshold ?? defaultScreenshotThreshold })
    const shown = { ...(chain.first ? { first: true as const } : {}), ...(chain.steady === undefined ? {} : { steady: chain.steady }), ...(comparison === undefined ? {} : { comparison }) }
    return { ok: true, look: { baseline, ...elementTarget, picture: size, settled: chain.settled, ...shown }, picture, ...looked }
  }

  keep({ observationId, app, command, look, picture }: ServedPicture): void {
    this.#served.set(observationId, { app, key: keyOf(app, command), command, picture, look, followed: false })
  }

  settle(judged: JudgedPicture): SettledAssertion {
    const served = this.#served.get(judged.observationId)
    if (served === undefined) return {}
    const { picture, look, app } = served
    // The check is done with this look, so the pixels it held go; a later check of the same name starts afresh.
    this.#served.delete(judged.observationId)
    const decoded = picture?.decoded
    if (picture === undefined || decoded === undefined) return {}
    const rule = screenshotCheck(judged.check)
    if (judged.passed) {
      if (look.comparison?.kind !== 'update' || !rule.passes(look)) return {}
      return this.#writeBaseline(judged, served, decoded, picture.scale)
    }
    if (rule.passes(look)) return {}
    return this.#attach(judged, app, look, decoded, served.command.threshold ?? defaultScreenshotThreshold)
  }

  #writeBaseline(judged: JudgedPicture, served: Served, decoded: PngPicture, scale: number | undefined): SettledAssertion {
    const { look, app } = served
    const written = this.#baselines.write(look.baseline, decoded, scale)
    if (!written.ok) return { failure: written.failure }
    if (written.again) return {}
    const { testId, attemptId } = this.#context
    const body: EventBody = {
      type: 'baseline.written',
      testId,
      attemptId,
      ...(judged.stepId === undefined ? {} : { stepId: judged.stepId }),
      session: app,
      sessionId: this.#identity(app).sessionId,
      observationId: judged.observationId,
      name: judged.check.name,
      path: look.baseline,
      width: decoded.width,
      height: decoded.height,
      ...(scale === undefined ? {} : { scale }),
      replaced: written.replaced,
      ...(judged.location === undefined ? {} : { location: judged.location }),
    }
    this.#context.emit(body)
    return {}
  }

  // A failed comparison leaves the picture, and, when there is a baseline to compare it with, the baseline and the
  // difference between them; a picture with no baseline is the candidate `--update-screenshots` would write.
  #attach(judged: JudgedPicture, app: string, look: ScreenshotLook, decoded: PngPicture, threshold: number): SettledAssertion {
    const folder = posix.dirname(artifactPath({ kind: 'screenshot', identity: this.#identity(app), purpose: 'failure', sequence: 1, format: 'png' }))
    const named = `${folder}/${judged.check.name}-${judged.observationId}`
    const pictures: [Attachment['name'], RgbaImage][] = [['actual', decoded]]
    const baseline = look.comparison?.kind === 'compared' ? this.#baselines.read(look.baseline) : undefined
    if (baseline?.ok === true) pictures.unshift(['expected', baseline.picture])
    if (baseline?.ok === true) pictures.push(['diff', differencePicture(baseline.picture, decoded, threshold).picture])
    const attachments: Attachment[] = []
    for (const [name, image] of pictures) {
      const path = `${named}-${name}.png`
      try {
        this.#context.store.writeArtifact(path, writePng(image))
        attachments.push({ name, path, contentType: 'image/png' })
      } catch (error) {
        this.#context.emit({ type: 'evidence.failed', testId: this.#context.testId, attemptId: this.#context.attemptId, session: app, kind: 'screenshot', reason: 'failure', sessionId: this.#identity(app).sessionId, message: `Retest could not save the ${name} picture of ${judged.check.name}: ${errorMessage(error)}` })
      }
    }
    return attachments.length === 0 ? {} : { attachments }
  }

  // Where a new picture stands in its check, against the look its command names as the one before it: a look of the
  // same check this attempt served, followed by no other look yet, with a picture. That look is followed from now on,
  // and its pixels go. With none, the picture is the first. Equal pictures carry on the time their run began, and the
  // newest settles once the run has lasted `settleGapMs`, or `baselineHoldMs` in a run that writes baselines.
  #settled(key: string, previous: string | undefined, picture: KeptPicture): Chain {
    const earlier = previous === undefined ? undefined : this.#served.get(previous)
    if (earlier === undefined || earlier.key !== key || earlier.followed) return { settled: false, first: true }
    earlier.followed = true
    const before = earlier.picture
    earlier.picture = undefined
    if (before === undefined) return { settled: false, first: true }
    if (!samePicture(before, picture)) return { settled: false, first: false }
    picture.sameSince = before.sameSince
    const forMs = picture.askedAt - picture.sameSince
    const neededMs = this.#baselines.update ? baselineHoldMs : settleGapMs
    return forMs >= neededMs ? { settled: true, first: false } : { settled: false, first: false, steady: { forMs: Math.round(forMs), neededMs } }
  }

  // How a picture stands against its baseline. A run that writes baselines needs a settled picture and reads none. Any
  // other run decides at once what no later picture can change: no baseline, one that cannot be read, which fails with
  // the sentence that names the file, or one of another size or device scale factor, both of which a picture and its
  // baseline must share, the scale recorded by both or by neither. Pixels are counted on a settled picture only.
  #compare(options: { baseline: string; decoded: PngPicture; scale: number | undefined; settled: boolean; threshold: number }): BaselineComparison | undefined {
    const { baseline, decoded, scale, settled, threshold } = options
    if (this.#baselines.update) return settled ? { kind: 'update' } : undefined
    const read = this.#baselines.read(baseline)
    if (!read.ok) return read.missing ? { kind: 'missing' } : { kind: 'unreadable', problem: read.problem }
    const expected = { width: read.picture.width, height: read.picture.height, ...(read.scale === undefined ? {} : { scale: read.scale }) }
    if (expected.width !== decoded.width || expected.height !== decoded.height || read.scale !== scale) return { kind: 'compared', expected }
    if (!settled) return undefined
    return { kind: 'compared', expected, differentPixels: comparePixels(read.picture, decoded, threshold).differentPixels }
  }

  #withheld(identity: RecordIdentity, source: CaptureSourceName | undefined, span?: { earliestUs: number; arrivedUs: number }): Failure | undefined {
    const { pixels } = this.#context
    if (pixels === undefined) return undefined
    if (source === undefined) return failure('unsupported', `Retest does not know what takes a picture of ${identity.app}, so its capture policy withheld it.`)
    const decision = pixels.decide({ identity, use: 'comparison', source, ...(span === undefined ? {} : { span }) })
    return decision.capture ? undefined : failure('unsupported', this.#context.redact(decision.message))
  }

  #identity(app: string): RecordIdentity {
    const { testId, attemptId } = this.#context
    return { testId, attemptId, app, sessionId: formatSessionId(attemptId, app) }
  }
}

// Two pictures are the same when they were clipped to one place at one scale and hold the same pixels.
function samePicture(before: KeptPicture, picture: KeptPicture): boolean {
  if (before.scale !== picture.scale || !isDeepStrictEqual(before.clip, picture.clip)) return false
  if (Buffer.from(before.png).equals(Buffer.from(picture.png))) return true
  return before.decoded !== undefined && picture.decoded !== undefined && samePixels(before.decoded, picture.decoded)
}

// A picture through the page's own comparison capture, or, for the viewport of a page without one, its screenshot,
// whose scale the page does not say.
async function takeFrom(page: OwnedPage, locator: LocatorRecipe | undefined, timeoutMs: number, signal: AbortSignal): Promise<TakenPicture> {
  if (page.takePicture !== undefined) return page.takePicture(locator === undefined ? {} : { locator }, timeoutMs, signal)
  try {
    return { ok: true, png: await page.screenshot(timeoutMs) }
  } catch (error) {
    if (error instanceof BrowserError) return { ok: false, failure: error.failure }
    throw error
  }
}

function keyOf(app: string, command: PictureCommand): string {
  return JSON.stringify([app, command.locator ?? null, command.name, command.threshold ?? null])
}

function readBaseline(file: string, path: string): ReadBaseline {
  try {
    const picture = readPng(readFileSync(file))
    const stated = picture.text[scaleKeyword]
    const scale = stated === undefined ? undefined : Number(stated)
    return { ok: true, picture, ...(scale === undefined || !Number.isFinite(scale) || scale <= 0 ? {} : { scale }) }
  } catch (error) {
    return { ok: false, missing: false, problem: `The baseline at ${path} is not a picture Retest reads: ${errorMessage(error)}` }
  }
}

function exists(file: string): boolean {
  try {
    statSync(file)
    return true
  } catch (error) {
    if (isMissing(error)) return false
    throw error
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')
}

function engineName(engine: WebEngine): string {
  return engine === 'chromium' ? 'Chromium' : engine === 'firefox' ? 'Firefox' : 'WebKit'
}

/**
 * How a test's app takes pictures for its screenshot checks: a web page on its engine, with what its screenshots are
 * recorded as taken by. An Electron window and a native app's screen are refused by name, since Retest has compared
 * pictures of neither.
 *
 * @example pictureApp(page, session.runtime, false).engine // 'chromium'
 */
export function pictureApp(page: OwnedPage, runtime: RuntimeIdentity, electron: boolean): PictureApp {
  const engine = runtime.kind === 'web' ? runtime.engine : undefined
  const app = { page, engine, source: screenshotSource(runtime) }
  if (electron) return { ...app, refusal: 'Retest compares pictures of browser pages, and not of an Electron window yet, so it took no picture.' }
  if (runtime.kind !== 'web') return { ...app, refusal: 'Retest compares pictures of web pages, and not of a native app yet, so it took no picture.' }
  return app
}
