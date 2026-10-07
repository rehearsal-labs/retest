import type { EvidenceRecord } from '../../protocol/evaluation.ts'
import type { CaptureState } from '../../protocol/diagnostics.ts'
import type { CaptureSourceName } from '../../protocol/identity.ts'
import type { TestResult } from '../../protocol/result.ts'
import type { TestEvent } from '../run-record.ts'
import type { ArtifactFiles, PictureFile } from './artifact-files.ts'
import { describeProblem } from './artifact-files.ts'

/**
 * A screenshot a test's record names: one the run saved, with what the report found at its path, or one the run could
 * not save, with the reason it gave. `app` is present in a run with a config.
 */
export type ScreenshotItem = {
  app?: string
  sessionId?: string
  source?: CaptureSourceName
  capturedAt?: string
  observationId?: string
} & ({ saved: true; reference: string; picture: PictureFile } | { saved: false; message: string })

/**
 * How much of a test's evidence is here, apart from how the test ended. `complete`: everything the run took is in the
 * folder and every capture is whole. `partial`: something was kept and something was lost, each loss in `reasons`.
 * `unavailable`: nothing could be kept, and `reasons` says why. `none`: the test took nothing, because it did not run
 * or because nothing was asked of it.
 */
export type EvidenceState = 'complete' | 'partial' | 'unavailable' | 'none'

export type EvidenceStatus = { state: EvidenceState; reasons: string[] }

/** A test's screenshots and the status of its evidence as a whole. */
export type TestEvidence = { screenshots: ScreenshotItem[]; status: EvidenceStatus }

/** The reason a test that held a page and did not pass names when it has no screenshot and no reason for none. */
export const noScreenshotReason: string = 'no failure screenshot was recorded, and the run named no reason'

const evidenceWords: Record<EvidenceState, string> = {
  complete: 'Evidence complete',
  partial: 'Evidence partial',
  unavailable: 'Evidence unavailable',
  none: 'No evidence',
}

/** @example evidenceLabel('partial') // 'Evidence partial' */
export function evidenceLabel(state: EvidenceState): string {
  return evidenceWords[state]
}

/**
 * A test's evidence: each screenshot its record names, read from the run folder, and what its diagnostics captures, AI
 * check evidence and recordings kept and lost. A loss is never left out: a screenshot the run could not save, a file
 * that is not where its record says, a capture or a recording that is partial or unavailable with each gap the run
 * named, any other gap in the run's own evidence status of the attempt, and an artifact that cannot be read are each a
 * reason.
 *
 * @example testEvidence(test, record.events, files).status.state // 'partial'
 */
export function testEvidence(test: TestResult, events: readonly TestEvent[], files: ArtifactFiles): TestEvidence {
  const screenshots = screenshotItems(test, events, files)
  if (test.status === 'not_run' || test.status === 'skipped') {
    return { screenshots, status: { state: 'none', reasons: [test.status === 'skipped' ? 'the test was skipped' : 'the test did not run'] } }
  }
  const named = test.variant !== undefined
  const reasons: string[] = []
  let kept = 0
  for (const item of screenshots) {
    const of = item.app === undefined ? '' : ` of ${item.app}`
    if (!item.saved) reasons.push(`the screenshot${of} was not saved: ${item.message}`)
    else if (item.picture.ok) kept += 1
    else reasons.push(`the screenshot${of} cannot be shown: ${describeProblem(item.picture)}`)
  }
  if (screenshots.length === 0 && expectsScreenshot(test, events)) reasons.push(noScreenshotReason)
  for (const summary of test.diagnostics ?? []) {
    const of = named && summary.app !== undefined ? ` of ${summary.app}` : ''
    const kinds: [string, { state: CaptureState; reason?: string }][] = [['console', summary.console], ['network', summary.network]]
    for (const [kind, capture] of kinds) {
      if (capture.state === 'complete' || capture.state === 'partial') kept += 1
      if (capture.state === 'partial' || capture.state === 'unavailable') reasons.push(`the ${kind} capture${of} is ${capture.state}: ${capture.reason ?? 'no reason was recorded'}`)
    }
    if (summary.path === undefined) continue
    const file = files.diagnostics(summary.path)
    if (!file.ok) reasons.push(`the diagnostics artifact${of} cannot be read: ${describeProblem(file)}`)
  }
  for (const record of test.evaluations ?? []) {
    for (const evidence of record.evidence) {
      if (evidence.kind === 'frames') {
        const subject = `the frames ${evidence.id} of AI check ${record.checkId}`
        reasons.push(...evaluationEvidenceReasons(evidence, subject))
        if ((evidence.frames ?? []).length === 0) reasons.push(`${subject} have no saved frames`)
        for (const frame of evidence.frames ?? []) {
          const picture = files.picture(frame.path)
          if (picture.ok) kept += 1
          else reasons.push(`${subject}, frame ${frame.id}, cannot be shown: ${describeProblem(picture)}`)
        }
        continue
      }
      if (evidence.kind === 'diagnostics') {
        const subject = `the diagnostics ${evidence.id} of AI check ${record.checkId}`
        reasons.push(...evaluationEvidenceReasons(evidence, subject))
        if (evidence.path === undefined) reasons.push(`${subject} were not saved`)
        else {
          const file = files.evaluationDiagnostics(evidence.path)
          if (file.ok) kept += 1
          else reasons.push(`${subject} cannot be read: ${describeProblem(file)}`)
        }
        continue
      }
      if (evidence.kind !== 'screenshot') continue
      if (evidence.path === undefined) {
        reasons.push(`the screenshot ${evidence.id} of AI check ${record.checkId} was not saved`)
        continue
      }
      const picture = files.picture(evidence.path)
      if (picture.ok) kept += 1
      else reasons.push(`the screenshot ${evidence.id} of AI check ${record.checkId} cannot be shown: ${describeProblem(picture)}`)
    }
  }
  for (const recording of test.recordings ?? []) {
    // A video retention removed after the attempt passed went by the config's rule; it is named, not counted as lost.
    if (recording.removed !== undefined) continue
    const of = ` ${recording.sequence} of ${recording.app}`
    if (recording.removalPending === true) reasons.push(`the recording${of} is present, removal not confirmed`)
    if (recording.path !== undefined) {
      const video = files.video(recording.path)
      if (video.ok) kept += 1
      else reasons.push(`the recording${of} cannot be shown: ${describeProblem(video)}`)
    }
    if (recording.status === 'complete') continue
    if (recording.gaps.length === 0) reasons.push(`the recording${of} is ${recording.status}, and the run named no reason`)
    for (const gap of recording.gaps) reasons.push(`the recording${of} is ${recording.status}: ${gap.message}`)
  }
  // The run's own reading of the attempt's evidence: a gap it names that no reason above covers is a reason too.
  for (const gap of test.evidenceStatus?.gaps ?? []) {
    if (!reasons.some((reason) => reason.includes(gap.message))) reasons.push(gap.message)
  }
  if (stoppedMidway(test, events)) reasons.push('the run stopped before this test finished, so evidence it would have taken later is missing')
  const state: EvidenceState = reasons.length === 0 ? (kept === 0 ? 'none' : 'complete') : kept === 0 ? 'unavailable' : 'partial'
  return { screenshots, status: { state, reasons } }
}

// The events say what was captured and what could not be; a result read without its events still lists what it saved.
function screenshotItems(test: TestResult, events: readonly TestEvent[], files: ArtifactFiles): ScreenshotItem[] {
  const named = test.variant !== undefined
  if (events.length === 0) {
    return test.evidence.map((evidence) => ({
      ...optional({ app: evidence.app, sessionId: evidence.sessionId, source: evidence.source, capturedAt: evidence.capturedAt, observationId: evidence.observationId }),
      saved: true as const,
      reference: evidence.path,
      picture: files.picture(evidence.path),
    }))
  }
  return events.flatMap((event): ScreenshotItem[] => {
    const app = named ? event.session : undefined
    if (event.type === 'evidence.captured') {
      const { sessionId, source, capturedAt, observationId } = event
      return [{ ...optional({ app, sessionId, source, capturedAt, observationId }), saved: true, reference: event.path, picture: files.picture(event.path) }]
    }
    if (event.type === 'evidence.failed') return [{ ...optional({ app, sessionId: event.sessionId, source: event.source }), saved: false, message: event.message }]
    return []
  })
}

// A test that did not pass and held a page has a failure screenshot or a reason it has none, unless it never had a
// page: a test that failed before its sessions opened takes no screenshot.
function expectsScreenshot(test: TestResult, events: readonly TestEvent[]): boolean {
  if (test.status === 'passed') return false
  if ((test.execution?.sessions.length ?? 0) > 0) return true
  return events.some((event) => event.type === 'navigation' || event.type === 'action.completed' || event.type === 'action.failed' || event.type === 'observation')
}

function stoppedMidway(test: TestResult, events: readonly TestEvent[]): boolean {
  return test.failure?.class === 'interrupted' && events.some((event) => event.type === 'test.started') && !events.some((event) => event.type === 'test.finished')
}

type Identity = { app?: string; sessionId?: string; source?: CaptureSourceName; capturedAt?: string; observationId?: string }
type MaybeIdentity = { [Key in keyof Identity]: Identity[Key] | undefined }

function optional(fields: MaybeIdentity): Identity {
  const kept: Identity = {}
  if (fields.app !== undefined) kept.app = fields.app
  if (fields.sessionId !== undefined) kept.sessionId = fields.sessionId
  if (fields.source !== undefined) kept.source = fields.source
  if (fields.capturedAt !== undefined) kept.capturedAt = fields.capturedAt
  if (fields.observationId !== undefined) kept.observationId = fields.observationId
  return kept
}

/** Every recorded loss in a frame or diagnostics evidence item, including losses without a status label. */
export function evaluationEvidenceReasons(evidence: EvidenceRecord, subject: string): string[] {
  const reasons: string[] = []
  if (evidence.status === 'partial' || evidence.status === 'unavailable') reasons.push(`${subject} are ${evidence.status}: ${evidence.reason ?? 'no reason was recorded'}`)
  else if (evidence.reason !== undefined) reasons.push(`${subject}: ${evidence.reason}`)
  const omitted = evidence.omitted
  if (omitted !== undefined && omitted.byCount + omitted.byBytes + omitted.undecodable > 0) reasons.push(`${subject}: ${omitted.byCount} frames omitted by count, ${omitted.byBytes} by bytes, ${omitted.undecodable} undecodable`)
  for (const frame of evidence.framesNotSent ?? []) reasons.push(`${subject}: frame ${frame.frameId} at ${frame.captureUs} us was not sent, ${frame.fate}`)
  for (const stretch of evidence.stretches ?? []) {
    const losses = Object.entries(stretch.lost).filter(([, count]) => count > 0).map(([kind, count]) => `${count} ${kind}`)
    if (losses.length + stretch.captureGaps.length > 0) reasons.push(`${subject}: ${stretch.fromUs} to ${stretch.toUs} us, ${[...losses, ...stretch.captureGaps].join(', ')}`)
  }
  if ((evidence.recordsOmitted ?? 0) > 0) reasons.push(`${subject}: ${evidence.recordsOmitted} records omitted`)
  for (const kind of ['console', 'network'] as const) {
    const part = evidence[kind]
    if (part !== undefined && part.state !== 'complete') reasons.push(`${subject}: ${kind} is ${part.state}, ${part.reason ?? 'no reason was recorded'}`)
  }
  return reasons
}
