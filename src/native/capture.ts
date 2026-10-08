import type { SessionIdentity } from '../browser/contract.ts'
import type { FrameFormat } from '../media/client.ts'
import type { GrabbedImage } from '../media/capture.ts'
import type { Failure } from '../protocol/failures.ts'
import type { RecordIdentity } from '../protocol/identity.ts'
import type { NativeTools, RecordedProcess } from './processes.ts'
import type { CaptureSource, DriverAnswer, NativeAppDriver, NativeCapture } from './session.ts'
import type { RequestBounds } from './webdriver-client.ts'
import { ScreenshotLoopSource } from '../media/capture.ts'
import { grabSimulatorDisplay } from './capture/simulator-display.ts'

// A native session's frame sources: screenshot loops, never live streams. The executor's own screen stream stays closed
// (its port is held while the runner starts), so every frame here is one capture Retest asked for.

/** What a native frame source needs of its session: its identity, app launch, lifecycle and captures. */
export type NativeCaptureSession = {
  readonly identity: SessionIdentity
  readonly ended: boolean
  readonly cancelled: boolean
  readonly appStatus: { readonly generation: number; readonly expectedRunning: boolean }
  capture(timeoutMs: number, options: { readonly source?: CaptureSource; readonly signal?: AbortSignal }): Promise<{ readonly ok: true; readonly capture: NativeCapture } | { readonly ok: false; readonly failure: Failure }>
}

/** How long one capture may take before it counts as failed. An unanswered capture ends the source without requesting another. */
export const nativeCaptureTimeoutMs = 5000

// Reserve part of the capture budget for a queued command's confirmed timeout reply.
const nativeCaptureReplyMarginMs = 500

/** How long the window's image command, screencapture, gets to end after SIGTERM: it holds nothing to clean up. */
export const windowImageGraceMs = 500

// What a window capture too short to keep its image's grace back still gives its commands, or all its time when less.
const shortWindowCommandMs = 500

// How much of a window capture's time goes to its commands. The image is the long step, and an image out of time is
// ended with its own grace, so that grace and the reply margin are kept back from whatever time the capture is given.
// Under 1.5 s that would leave the commands less than `shortWindowCommandMs`, and they get that much, so a short start
// still asks. The process readings keep the default grace, which this does not keep back: one that ignores its stop
// near the end may outlast the capture.
function windowCommandMs(timeoutMs: number): number {
  const timeMs = Math.max(1, Math.min(timeoutMs, nativeCaptureTimeoutMs))
  return Math.max(Math.min(timeMs, shortWindowCommandMs), timeMs - nativeCaptureReplyMarginMs - windowImageGraceMs)
}

/**
 * Why a native frame source hands over no pixels now. `gone` says the reading proved the target ended; a reading that
 * could not be taken, such as a host tool that answered too late, proves nothing about the app.
 */
export type NativeTargetProblem = { readonly problem: string; readonly gone: boolean }

/** Confirms the app's recorded processes without an executor request or input turn. No command lines leave this check. */
export function nativeCaptureTargetCheck(driver: Pick<NativeAppDriver, 'processState'>, owns: (entry: RecordedProcess) => boolean): (bounds: RequestBounds) => Promise<NativeTargetProblem | undefined> {
  return async (bounds) => {
    const reading = await driver.processState(bounds)
    if (!reading.ok) return { problem: `The frame source could not confirm its app processes: ${reading.problem}`, gone: false }
    if (!reading.running || reading.processes.length === 0) return { problem: 'The frame source\'s app processes are no longer running.', gone: true }
    if (!reading.processes.every(owns)) return { problem: 'The frame source found an app process outside this session\'s current launch, so it captures nothing.', gone: true }
    return undefined
  }
}

/**
 * The session hook's source. iOS uses its own simulator display through the driver's simctl capture, outside the
 * executor and request queue. macOS keeps the session's checked window crop. Both verify their app processes before
 * and after pixels: a check that finds the app gone ends the source, and one that could not be read drops that frame
 * and leaves the next tick, or the start within its budget, to ask again. Neither route is a pushed frame stream.
 */
export function nativeFrameSource(session: NativeCaptureSession, identity: RecordIdentity, display: (bounds: RequestBounds) => Promise<DriverAnswer<Uint8Array>>, checkTarget: (bounds: RequestBounds) => Promise<NativeTargetProblem | undefined>): ScreenshotLoopSource {
  const name = session.identity.runtime.kind === 'macos' ? 'window-crop' : 'simulator-display'
  const image: (bounds: RequestBounds) => Promise<DriverAnswer<Uint8Array>> = name === 'window-crop'
    ? async (bounds) => {
      const taken = await session.capture(bounds.timeoutMs, { source: 'window-crop', ...(bounds.signal === undefined ? {} : { signal: bounds.signal }) })
      return taken.ok ? { status: 'answered', value: taken.capture.png, durationMs: 0 } : { status: 'failed', failure: taken.failure, input: 'not_sent' }
    }
    : display
  const own = sessionRecordIdentity(session.identity)
  const refused = identityRefusal(own, identity)
  const generation = session.appStatus.generation
  return new ScreenshotLoopSource({
    name, identity: own, unavailable: () => refused ?? sessionOver(session, generation), grabTimeoutMs: nativeCaptureTimeoutMs,
    // A window capture cut short would stand in for what the start's last finished capture found, such as a window
    // not on screen, so the loop is told how much of a capture's time its commands get and asks again only with room.
    ...(name === 'window-crop' ? { captureCommandMs: windowCommandMs } : {}),
    grab: async (timeoutMs, signal, withheld) => {
      const started = performance.now()
      // No step of the window route starts once its commands' time is spent, so an image that runs over settles as a
      // dropped frame inside the time the capture was given, and the next tick asks again.
      const budgetMs = name === 'window-crop' ? windowCommandMs(timeoutMs) : Math.min(timeoutMs, nativeCaptureTimeoutMs - nativeCaptureReplyMarginMs)
      const leftMs = (): number => budgetMs - (performance.now() - started)
      const bounds = (): RequestBounds => ({ timeoutMs: Math.max(1, Math.floor(leftMs())), signal })
      const spent = (step: string): GrabbedImage | undefined => name === 'window-crop' && leftMs() <= 0 ? { ok: false, problem: `The ${name} capture used its ${budgetMs} ms before ${step}.`, ...(signal.aborted ? {} : { retryAtStart: true as const }) } : undefined
      const before = await checkTarget(bounds())
      if (before?.gone === true) return { ok: false, problem: before.problem, lost: true }
      const overBefore = sessionOver(session, generation)
      if (overBefore !== undefined) return { ok: false, problem: overBefore, lost: true }
      if (before !== undefined) return { ok: false, problem: before.problem, ...(signal.aborted ? {} : { retryAtStart: true as const }) }
      if (signal.aborted) return { ok: false, problem: `The ${name} capture was cancelled before asking for pixels.` }
      if (withheld()) return { ok: false, problem: 'Pixels were withheld while the target check was pending.', withheld: true }
      const late = spent('asking for pixels')
      if (late !== undefined) return late
      const answer = await image(bounds())
      const over = sessionOver(session, generation)
      if (over !== undefined) return { ok: false, problem: over, lost: true }
      if (signal.aborted) return { ok: false, problem: `The ${name} capture was cancelled before its target could be confirmed.` }
      if (answer.status === 'answered') {
        const lateCheck = spent('confirming its app processes again')
        if (lateCheck !== undefined) return lateCheck
        const after = await checkTarget(bounds())
        const ended = sessionOver(session, generation)
        if (after?.gone === true) return { ok: false, problem: after.problem, lost: true }
        if (ended !== undefined) return { ok: false, problem: ended, lost: true }
        if (after !== undefined) return { ok: false, problem: after.problem, ...(signal.aborted ? {} : { retryAtStart: true as const }) }
        return { ok: true, format: 'png', bytes: answer.value }
      }
      if (answer.status === 'failed') {
        // A window not there yet, as just after launch, may come within the start's budget; a running loop drops the frame.
        const startMayRetry = name === 'window-crop' && (answer.failure.class === 'timeout' || answer.failure.details?.['transient'] === true)
        return { ok: false, problem: answer.failure.message, ...(answer.failure.class === 'session_lost' ? { lost: true as const } : {}), ...(startMayRetry ? { retryAtStart: true as const } : {}) }
      }
      const lost = (answer.status === 'not_sent' && (answer.reason === 'session_ended' || answer.reason === 'connection_refused')) || (answer.status === 'refused' && answer.error === 'invalid session id') || (answer.status === 'unknown' && answer.reason === 'connection_lost')
      return { ok: false, problem: answer.message, ...(lost ? { lost: true as const } : {}) }
    },
  })
}

/**
 * A frame source over the session's own captures, `executor-screen` on iOS or `window-crop` on macOS: a
 * `screenshot-loop` of `NativeAppSession.capture`, so each capture takes its turn in the session's one request queue,
 * between actions, and waits while an action holds it. Frames are the session's PNG as it handed it out: the
 * executor's own encoding for `executor-screen`, and for `window-crop` the app's own window as the window server drew
 * it from its window number, which holds no other window's pixels. A capture that fails, such as one whose window
 * changed while it was taken, is a dropped frame named among the problems; a session that is lost, disposed or
 * cancelled ends capture.
 *
 * The caller names the session it means to record, and a session that is another one gives a source that is
 * unavailable and says which it is, so one session is never recorded as another.
 *
 * @example const source = sessionFrameSource(session, identity, 'executor-screen')
 */
export function sessionFrameSource(session: NativeCaptureSession, identity: RecordIdentity, source: CaptureSource): ScreenshotLoopSource {
  const own = sessionRecordIdentity(session.identity)
  const refused = identityRefusal(own, identity)
  const generation = session.appStatus.generation
  return new ScreenshotLoopSource({
    name: source,
    identity: own,
    unavailable: () => refused ?? sessionOver(session, generation),
    grab: async (timeoutMs, signal, withheld) => {
      const over = sessionOver(session, generation)
      if (over !== undefined) return { ok: false, problem: over, lost: true }
      if (withheld()) return { ok: false, problem: 'Pixels are withheld before the session capture request.', withheld: true }
      const taken = await session.capture(Math.min(timeoutMs, nativeCaptureTimeoutMs - nativeCaptureReplyMarginMs), { source, signal })
      const ended = sessionOver(session, generation)
      if (ended !== undefined) return { ok: false, problem: ended, lost: true }
      if (taken.ok) return { ok: true, format: 'png', bytes: taken.capture.png }
      const lost = session.ended || session.cancelled || taken.failure.class === 'session_lost'
      return lost ? { ok: false, problem: taken.failure.message, lost: true } : { ok: false, problem: taken.failure.message }
    },
    grabTimeoutMs: nativeCaptureTimeoutMs,
  })
}

/**
 * What a simulator display source is made of: the session it records, the simulator it runs on by its udid, the tools
 * that reach it, and the image format `simctl` writes, JPEG or PNG.
 */
export type SimulatorDisplayOptions = { readonly session: NativeCaptureSession; readonly udid: string; readonly tools: NativeTools; readonly format: FrameFormat }

/**
 * A frame source over the simulator's display, `simulator-display`: a `screenshot-loop` of `simctl io screenshot`, which
 * reads the display of the simulator the session runs on without the executor, so a capture never takes the session's
 * request queue and never waits for, or holds up, an action. Each frame is the file `simctl` wrote, in the format asked
 * for, untouched. It shows the whole device screen, the status bar and any other app in front included; the simulator
 * is the session's own, made for its runtime. A session that is lost, disposed or cancelled ends capture.
 *
 * @example const source = simulatorDisplayFrameSource({ session, udid: runtime.udid, tools: systemTools, format: 'jpeg' }, identity)
 */
export function simulatorDisplayFrameSource(options: SimulatorDisplayOptions, identity: RecordIdentity): ScreenshotLoopSource {
  const { session, udid, tools, format } = options
  const own = sessionRecordIdentity(session.identity)
  const refused = identityRefusal(own, identity)
  const generation = session.appStatus.generation
  return new ScreenshotLoopSource({
    name: 'simulator-display',
    identity: own,
    unavailable: () => refused ?? sessionOver(session, generation),
    grab: async (timeoutMs, signal): Promise<GrabbedImage> => {
      const over = sessionOver(session, generation)
      if (over !== undefined) return { ok: false, problem: over, lost: true }
      const taken = await grabSimulatorDisplay({ tools, udid, format, timeoutMs, signal })
      // A session that ended while simctl ran ends capture, whatever simctl brought back.
      const ended = sessionOver(session, generation)
      if (ended !== undefined) return { ok: false, problem: ended, lost: true }
      return taken.ok ? { ok: true, format, bytes: taken.bytes } : { ok: false, problem: taken.problem }
    },
    grabTimeoutMs: nativeCaptureTimeoutMs,
  })
}

/**
 * The record identity a native session's frames carry: its test, attempt, app and session id, from the session itself.
 *
 * @example sessionRecordIdentity(session.identity) // { testId, attemptId, app: 'phone', sessionId: 'k3v9q0x2mb:phone' }
 */
export function sessionRecordIdentity(identity: SessionIdentity): RecordIdentity {
  const { owner, sessionId } = identity
  return Object.freeze({ testId: owner.testId, attemptId: owner.attemptId, app: owner.app, sessionId })
}

// Why a source of this session may not record as the session the caller named, or undefined when it is that session.
function identityRefusal(own: RecordIdentity, asked: RecordIdentity): string | undefined {
  if (own.testId === asked.testId && own.attemptId === asked.attemptId && own.app === asked.app && own.sessionId === asked.sessionId) return undefined
  return `This native session is ${own.sessionId} of ${JSON.stringify(own.testId)}, not ${asked.sessionId} of ${JSON.stringify(asked.testId)}, so Retest records nothing of it as that session.`
}

function sessionOver(session: NativeCaptureSession, generation: number): string | undefined {
  if (session.ended) return 'The native session is over, so there is nothing more to capture.'
  if (session.cancelled) return 'The native session was cancelled, so nothing more is captured.'
  if (session.appStatus.generation !== generation) return 'The app launch changed, so this frame source no longer has its original target.'
  if (!session.appStatus.expectedRunning) return 'The session no longer expects its app to be running, so nothing more is captured.'
  return undefined
}
