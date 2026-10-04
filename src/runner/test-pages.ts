import { NativePageAdapter } from './native-pool.ts'
import { NativeError } from '../native/session.ts'
import type { NewPageOptions, OwnedBrowser, OwnedPage, RuntimeIdentity, SessionIdentity } from '../browser/contract.ts'
import type { EventBody } from '../protocol/events.ts'
import type { EvidenceReference } from '../protocol/evidence.ts'
import type { Failure } from '../protocol/failures.ts'
import type { CaptureSourceName } from '../protocol/identity.ts'
import type { Evidence } from '../protocol/result.ts'
import type { Timeouts } from '../protocol/timeouts.ts'
import type { RunStore } from '../store/run-store.ts'
import type { Opened } from './browser-pool.ts'
import { BrowserError } from '../browser/browser-error.ts'
import { errorMessage, failure } from '../protocol/failures.ts'
import { failureScreenshotFile, stateFile } from '../protocol/run-folder.ts'
import { bounded } from './bounded.ts'
import { abortGraceMs } from './running-test.ts'
import { timerMs } from './timer.ts'

/**
 * One app's page in a test, the browser it belongs to, whether it emulates a touch screen, and the session it is:
 * its id, the run, test, attempt and app that hold it, and the browser it runs on.
 */
export type AppPage = { app: string; page: OwnedPage; browser: OwnedBrowser; touch: boolean; session: SessionIdentity }

/** What the pages of a test need from the run. */
export type PagesContext = {
  store: RunStore
  timeouts: Timeouts
  /** Settles when the run is interrupted. */
  stopped: Promise<void>
  interruption: () => Failure | undefined
  connected: (browser: OwnedBrowser) => boolean
  /** Keeps work the run gave up waiting for, so the run can wait for it before it ends. */
  release: (work: Promise<unknown>) => void
  /** Whether screenshots and evidence name their app, as in a run from a config. */
  named: boolean
  /** Emits one of the test's events. */
  emit: (body: EventBody) => void
  /** Hides every secret value the run has read in text, before the text is quoted or cut for an event. */
  redact: (text: string) => string
  testId: string
  attemptId: string
}

/** Opens a page within the setup budget; one the run gave up on is disposed when it arrives. */
export async function openPage(context: PagesContext, browser: OwnedBrowser, options: NewPageOptions): Promise<Opened<OwnedPage>> {
  const { setup, cleanup } = context.timeouts
  const opening = browser.newPage(options, setup)
  const opened = await bounded(opening, timerMs(setup + abortGraceMs), context.stopped)
  if (opened.status === 'done') return { ok: true, value: opened.value }
  if (opened.status !== 'failed') context.release(opening.then((page) => page.dispose(cleanup)))
  const interruption = context.interruption()
  if (opened.status === 'stopped' && interruption !== undefined) return { ok: false, failure: interruption }
  if (opened.status === 'timed_out') {
    return { ok: false, failure: failure('setup_failed', `Opening a new page took longer than the ${setup} ms setup budget.`) }
  }
  const lost = !browser.connected
  const detail = opened.status === 'failed' ? errorMessage(opened.error) : 'the run stopped'
  // A page the target cannot give with these options, as an Electron app's cannot take a saved state, is refused as
  // something the target does not do, not as a setup that failed.
  const refused = opened.status === 'failed' && isUnsupported(opened.error)
  return { ok: false, failure: failure(lost ? 'session_lost' : refused ? 'unsupported' : 'setup_failed', `Retest could not open a page: ${detail}`) }
}

/**
 * Takes a screenshot of each page still reachable. Evidence never replaces the failure it illustrates; when it
 * cannot be taken, the reason is recorded.
 */
export async function captureFailure(context: PagesContext, pages: readonly AppPage[]): Promise<Evidence[]> {
  const evidence: Evidence[] = []
  for (const page of pages) evidence.push(...(await screenshot(context, page)))
  return evidence
}

/**
 * Saves the setup page's sign-in state for the target it ran on. Returns why it could not, as a failure of the
 * setup, since no test that needs the state can start from it.
 */
export async function saveState(context: PagesContext, { app, page, session }: AppPage, state: string, target: string): Promise<Failure | undefined> {
  const { setup } = context.timeouts
  const captured = await bounded(page.captureState(setup), timerMs(setup + abortGraceMs), context.stopped)
  if (captured.status === 'stopped') return context.interruption()
  const unsaved = (detail: string): Failure => failure('setup_failed', `Retest could not save the state ${JSON.stringify(state)}: ${detail}`)
  if (captured.status === 'timed_out') return unsaved(`reading it took longer than the ${setup} ms setup budget.`)
  if (captured.status === 'failed' && isUnsupported(captured.error)) {
    return failure('unsupported', `Retest could not save the state ${JSON.stringify(state)}: ${errorMessage(captured.error)}`)
  }
  if (captured.status === 'failed') return unsaved(errorMessage(captured.error))
  try {
    context.store.writeState(stateFile(state, target), captured.value)
  } catch (error) {
    return unsaved(errorMessage(error))
  }
  context.emit({ type: 'state.saved', testId: context.testId, attemptId: context.attemptId, state, app, target, sessionId: session.sessionId })
  return undefined
}

/**
 * What takes a page's screenshot: its engine's own capture, which for Chromium, Electron's included, is the DevTools
 * protocol's. A runtime whose capture Retest does not take this way names no source, rather than one it did not use.
 *
 * @example screenshotSource(page.session.runtime) // 'chromium'
 */
export function screenshotSource(runtime: RuntimeIdentity): CaptureSourceName | undefined {
  return runtime.kind === 'web' ? runtime.engine === 'chromium' ? 'chromium' : undefined : runtime.kind === 'macos' ? 'window-crop' : 'executor-screen'
}

/** Disposes each page's browser context. A browser that is gone, or about to be closed, takes its contexts with it. */
export async function disposePages(context: PagesContext, pages: readonly AppPage[]): Promise<Failure[]> {
  if (context.interruption() !== undefined) return []
  const cleanup = context.timeouts.cleanup
  const failures: Failure[] = []
  for (const { page, browser, app, session } of pages) {
    if (!context.connected(browser)) continue
    const disposed = await bounded(page.dispose(cleanup), timerMs(cleanup + abortGraceMs), context.stopped)
    if (disposed.status === 'timed_out') failures.push(failure('cleanup_failed', `Closing the test's ${page instanceof NativePageAdapter ? 'native session' : 'browser context'} took longer than ${cleanup} ms.`))
    if (disposed.status === 'done' && page instanceof NativePageAdapter) context.emit({ type: 'native.ended', testId: context.testId, attemptId: context.attemptId, session: app, sessionId: session.sessionId, unknownOutcomes: page.recordedOutcomes })
    if (disposed.status === 'failed') failures.push(failure('cleanup_failed', `Closing the test's ${page instanceof NativePageAdapter ? 'native session' : 'browser context'} failed: ${errorMessage(disposed.error)}`))
  }
  return failures
}

// The screenshot's event and its entry in the result name the session that took it, what took it, and when it came
// back, as an ISO time and on the run's clock.
async function screenshot(context: PagesContext, { app, page, browser, session }: AppPage): Promise<Evidence[]> {
  if (context.interruption() !== undefined) return []
  const { testId, attemptId, named } = context
  const { sessionId } = session
  const cleanup = context.timeouts.cleanup
  const source = screenshotSource(session.runtime)
  const scope = { testId, attemptId, session: app, kind: 'screenshot', reason: 'failure', sessionId, ...(source === undefined ? {} : { source }) } as const
  const unavailable = (message: string): Evidence[] => {
    context.emit({ type: 'evidence.failed', ...scope, message })
    return []
  }
  if (!context.connected(browser)) return unavailable(`The ${page instanceof NativePageAdapter ? 'native target' : 'browser'} was gone, so Retest took no screenshot.`)
  let nativeCapture: Awaited<ReturnType<NativePageAdapter['capture']>> | undefined
  const capturing = page instanceof NativePageAdapter ? page.capture(cleanup).then((captured) => { nativeCapture = captured; if (!captured.ok) throw new NativeError(captured.failure); return captured.capture.png }) : page.screenshot(cleanup)
  const shot = await bounded(capturing, timerMs(cleanup + abortGraceMs), context.stopped)
  if (shot.status === 'stopped') return []
  if (shot.status === 'timed_out') return unavailable(`Taking a screenshot took longer than ${cleanup} ms.`)
  if (shot.status === 'failed') return unavailable(`Retest could not take a screenshot: ${errorMessage(shot.error)}`)
  const capturedAt = nativeCapture?.ok === true ? nativeCapture.capture.capturedAt : new Date().toISOString()
  const capturedElapsedMs = context.store.elapsedMs()
  const path = named ? failureScreenshotFile(testId, attemptId, app) : failureScreenshotFile(testId, attemptId)
  try {
    context.store.writeArtifact(path, shot.value)
  } catch (error) {
    return unavailable(`Retest could not save the screenshot: ${errorMessage(error)}`)
  }
  const clock = capturedElapsedMs === undefined ? {} : { capturedElapsedMs }
  const captureReference = nativeCapture?.ok === true ? { captureReference: { instance: nativeCapture.capture.reference.instance, generation: nativeCapture.capture.reference.generation, observationId: nativeCapture.capture.reference.observationId } } : {}
  const reference: EvidenceReference = { kind: 'screenshot', path, app, sessionId, testId, attemptId, capturedAt, ...clock, ...captureReference, ...(source === undefined ? {} : { source }) }
  context.emit(capturedEvent(reference))
  return [resultEvidence(reference, named)]
}

// The app is the event's `session`, as on every event about an app.
function capturedEvent({ kind, path, app, sessionId, testId, attemptId, ...captured }: EvidenceReference): EventBody {
  return { type: 'evidence.captured', testId, attemptId, session: app, kind, path, reason: 'failure', sessionId, ...captured }
}

// Only a run from a config names the app a screenshot shows.
function resultEvidence({ kind, path, app, sessionId, attemptId, testId: _testId, ...captured }: EvidenceReference, named: boolean): Evidence {
  return { kind, path, ...(named ? { app } : {}), sessionId, attemptId, ...captured }
}

function isUnsupported(error: unknown): boolean {
  return (error instanceof BrowserError || error instanceof NativeError) && error.failure.class === 'unsupported'
}
