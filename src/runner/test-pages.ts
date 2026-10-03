import type { NewPageOptions, OwnedBrowser, OwnedPage, SessionIdentity } from '../browser/contract.ts'
import type { EventBody } from '../protocol/events.ts'
import type { EvidenceReference } from '../protocol/evidence.ts'
import type { Failure } from '../protocol/failures.ts'
import type { Evidence } from '../protocol/result.ts'
import type { Timeouts } from '../protocol/timeouts.ts'
import type { RunStore } from '../store/run-store.ts'
import type { Opened } from './browser-pool.ts'
import { errorMessage, failure } from '../protocol/failures.ts'
import { failureScreenshotFile, stateFile } from '../protocol/run-folder.ts'
import { bounded } from './bounded.ts'
import { abortGraceMs } from './running-test.ts'

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
  const opened = await bounded(opening, setup + abortGraceMs, context.stopped)
  if (opened.status === 'done') return { ok: true, value: opened.value }
  if (opened.status !== 'failed') context.release(opening.then((page) => page.dispose(cleanup)))
  const interruption = context.interruption()
  if (opened.status === 'stopped' && interruption !== undefined) return { ok: false, failure: interruption }
  if (opened.status === 'timed_out') {
    return { ok: false, failure: failure('setup_failed', `Opening a new page took longer than the ${setup} ms setup budget.`) }
  }
  const lost = !browser.connected
  const detail = opened.status === 'failed' ? errorMessage(opened.error) : 'the run stopped'
  return { ok: false, failure: failure(lost ? 'session_lost' : 'setup_failed', `Retest could not open a page: ${detail}`) }
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
export async function saveState(context: PagesContext, { app, page }: AppPage, state: string, target: string): Promise<Failure | undefined> {
  const { setup } = context.timeouts
  const captured = await bounded(page.captureState(setup), setup + abortGraceMs, context.stopped)
  if (captured.status === 'stopped') return context.interruption()
  const unsaved = (detail: string): Failure => failure('setup_failed', `Retest could not save the state ${JSON.stringify(state)}: ${detail}`)
  if (captured.status === 'timed_out') return unsaved(`reading it took longer than the ${setup} ms setup budget.`)
  if (captured.status === 'failed') return unsaved(errorMessage(captured.error))
  try {
    context.store.writeState(stateFile(state, target), captured.value)
  } catch (error) {
    return unsaved(errorMessage(error))
  }
  context.emit({ type: 'state.saved', testId: context.testId, attemptId: context.attemptId, state, app, target })
  return undefined
}

/** Disposes each page's browser context. A browser that is gone, or about to be closed, takes its contexts with it. */
export async function disposePages(context: PagesContext, pages: readonly AppPage[]): Promise<Failure[]> {
  if (context.interruption() !== undefined) return []
  const cleanup = context.timeouts.cleanup
  const failures: Failure[] = []
  for (const { page, browser } of pages) {
    if (!context.connected(browser)) continue
    const disposed = await bounded(page.dispose(cleanup), cleanup + abortGraceMs, context.stopped)
    if (disposed.status === 'timed_out') failures.push(failure('cleanup_failed', `Closing the test's browser context took longer than ${cleanup} ms.`))
    if (disposed.status === 'failed') failures.push(failure('cleanup_failed', `Closing the test's browser context failed: ${errorMessage(disposed.error)}`))
  }
  return failures
}

// The screenshot's event and its entry in the result name the session that took it, and when it came back.
async function screenshot(context: PagesContext, { app, page, browser, session }: AppPage): Promise<Evidence[]> {
  if (context.interruption() !== undefined) return []
  const { testId, attemptId, named } = context
  const { sessionId } = session
  const cleanup = context.timeouts.cleanup
  const scope = { testId, attemptId, session: app, kind: 'screenshot', reason: 'failure', sessionId } as const
  const unavailable = (message: string): Evidence[] => {
    context.emit({ type: 'evidence.failed', ...scope, message })
    return []
  }
  if (!context.connected(browser)) return unavailable('The browser was gone, so Retest took no screenshot.')
  const shot = await bounded(page.screenshot(cleanup), cleanup + abortGraceMs, context.stopped)
  if (shot.status === 'stopped') return []
  if (shot.status === 'timed_out') return unavailable(`Taking a screenshot took longer than ${cleanup} ms.`)
  if (shot.status === 'failed') return unavailable(`Retest could not take a screenshot: ${errorMessage(shot.error)}`)
  const capturedAt = new Date().toISOString()
  const path = named ? failureScreenshotFile(testId, attemptId, app) : failureScreenshotFile(testId, attemptId)
  try {
    context.store.writeArtifact(path, shot.value)
  } catch (error) {
    return unavailable(`Retest could not save the screenshot: ${errorMessage(error)}`)
  }
  const reference: EvidenceReference = { kind: 'screenshot', path, app, sessionId, testId, attemptId, capturedAt }
  context.emit(capturedEvent(reference))
  return [resultEvidence(reference, named)]
}

// The app is the event's `session`, as on every event about an app.
function capturedEvent({ kind, path, app, sessionId, testId, attemptId, capturedAt }: EvidenceReference): EventBody {
  return { type: 'evidence.captured', testId, attemptId, session: app, kind, path, reason: 'failure', sessionId, capturedAt }
}

// Only a run from a config names the app a screenshot shows.
function resultEvidence({ kind, path, app, sessionId, attemptId, capturedAt }: EvidenceReference, named: boolean): Evidence {
  return { kind, path, ...(named ? { app } : {}), sessionId, attemptId, capturedAt }
}
