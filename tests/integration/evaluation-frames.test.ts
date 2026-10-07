import type { TestContext } from 'node:test'
import type { OwnedBrowser } from '../../src/browser/contract.ts'
import type { LoadedEvaluation } from '../../src/config/read-evaluation.ts'
import type { EvaluationRequest, EvaluatorSetup } from '../../src/evaluation/contract.ts'
import type { AttemptRecordings, StepSpan } from '../../src/evaluation/frames.ts'
import type { FrameSource, MediaRecorder, SourceRecording } from '../../src/media/capture.ts'
import type { Recording } from '../../src/media/client.ts'
import type { Criterion, EvaluationRecord, EvidenceSelector } from '../../src/protocol/evaluation.ts'
import type { RecordIdentity } from '../../src/protocol/identity.ts'
import type { AppPage, PagesContext } from '../../src/runner/test-pages.ts'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { serveScene } from '../../fixtures/evaluation-corpus/capture/scenes.ts'
import { webRuntimeIdentity } from '../../src/browser/contract.ts'
import { ChromiumPage } from '../../src/browser/page.ts'
import { AttemptEvaluations } from '../../src/evaluation/attempt.ts'
import { CallBudget, defaultEvaluationLimits } from '../../src/evaluation/budget.ts'
import { Judges } from '../../src/evaluation/judges.ts'
import { CaptureSuspension, microsecondsSince, recordSource } from '../../src/media/capture.ts'
import { mediaArguments, MediaProcess } from '../../src/media/client.ts'
import { formatSessionId } from '../../src/protocol/evidence.ts'
import { evaluationRecordSchema } from '../../src/protocol/evaluation.ts'
import { parse } from '../../src/protocol/schema.ts'
import { Redactor } from '../../src/runner/redactor.ts'
import { RunStore } from '../../src/store/run-store.ts'
import { newRunFolder, quickTimeouts } from '../support/run-harness.ts'
import { launch, scratchFolder, setupMs } from './browser-harness.ts'
import { mediaPrerequisites } from './capture-proof.ts'

// Frame checks on a real recording: Chrome's screencast of the corpus's toast scene, through the Chromium frame source
// and `recordSource`, into the real media process with its frames kept, and the parent's own `AttemptEvaluations` asking
// that recording for each check's interval, with a scripted judge. This harness gives the attempt the recording and
// the steps' spans directly, on the run store's clock; it does not exercise the full CLI recorded-step path. It
// shows the frames a judge receives are the media process's own, saved and hashed as sent; that a frame the recording
// has not placed is never sent; that a stretch the pixel policy withheld keeps a pass from counting; that an absence
// pass over frames is set aside; and that an ended recording with nothing missing lets a pass count. It claims nothing
// about any model.

const identity: RecordIdentity = { testId: 'tests/integration/evaluation-frames.test.ts > frames', attemptId: 'frames1', app: 'web', sessionId: formatSessionId('frames1', 'web') }
const titleField = { by: 'testId', value: 'task-title' } as const
const saveButton = { by: 'testId', value: 'save-task' } as const
const shown: Criterion = { id: 'shown', requirement: 'A notification says the task "Release checklist" was saved.' }

type Harness = { evaluations: AttemptEvaluations; calls: EvaluationRequest[]; store: RunStore }

// Each check gets a run folder of its own, on the one clock, as each attempt's checks number from evaluation-1.
function harness(t: TestContext, page: AppPage, recordings: AttemptRecordings, clockMs: () => number): Harness {
  const store = RunStore.create(newRunFolder())
  t.after(() => store.close())
  store.setClock(clockMs)
  const calls: EvaluationRequest[] = []
  const factory = (setup: EvaluatorSetup): unknown => ({
    identity: { provider: 'scripted', model: `frames-${setup.judge}`, version: 'scripted/1' },
    async evaluate(request: EvaluationRequest) {
      calls.push(request)
      const cited = request.frames?.[0]?.frames.at(-1)?.id ?? request.evidence[0]?.id ?? 'e1'
      return { criteria: request.criteria.map(({ id }) => ({ id, verdict: 'pass', citations: [cited] })), justification: 'Scripted pass over whatever it was sent.' }
    },
  })
  const evaluation: LoadedEvaluation = { judges: new Map([['visual', { name: 'visual', adapter: { kind: 'factory', factory }, credentials: new Map(), options: {}, accepts: ['text', 'images', 'frames'] }]]), defaultJudge: 'visual', timeoutMs: 10_000, limits: defaultEvaluationLimits }
  const redactor = new Redactor()
  const judges = new Judges({ evaluation, redactor, env: {} })
  t.after(() => judges.close(1000))
  const context: PagesContext = {
    store,
    timeouts: quickTimeouts,
    stopped: new Promise(() => undefined),
    interruption: () => undefined,
    connected: () => true,
    release: () => undefined,
    named: true,
    emit: () => undefined,
    redact: (text) => redactor.redact(text),
    testId: identity.testId,
    attemptId: identity.attemptId,
  }
  const evaluations = new AttemptEvaluations({ context, pages: [page], evaluation, judges, budget: new CallBudget(defaultEvaluationLimits), hostChecks: [], runSignal: new AbortController().signal, recordings })
  return { evaluations, calls, store }
}

async function check(evaluations: AttemptEvaluations, evidence: EvidenceSelector[], criteria: Criterion[] = [shown]): Promise<EvaluationRecord> {
  await evaluations.request({ criteria, evidence, mode: 'required' }, { remainingMs: 20_000 })
  const record = evaluations.records.at(-1)
  assert.ok(record !== undefined)
  assert.ok(parse(evaluationRecordSchema, record).ok, 'the record is valid against the published schema')
  return record
}

async function act(page: ChromiumPage, kind: 'fill' | 'click', value?: string): Promise<void> {
  const result = kind === 'fill' ? await page.execute({ kind: 'fill', locator: titleField, value: value ?? '' }, 5000) : await page.execute({ kind: 'click', locator: saveButton }, 5000)
  assert.ok(result.ok, JSON.stringify(result))
}

// Every frame the judge received is a file in the run folder with the hash the record names, the same bytes.
function assertFramesSaved(record: EvaluationRecord, request: EvaluationRequest | undefined, store: RunStore): void {
  const [evidence] = record.evidence
  const sequence = request?.frames?.[0]
  assert.ok(evidence !== undefined && sequence !== undefined)
  assert.equal(evidence.frames?.length, sequence.frames.length)
  for (const [index, frame] of (evidence.frames ?? []).entries()) {
    const saved = readFileSync(join(store.directory, frame.path))
    assert.equal(createHash('sha256').update(saved).digest('hex'), frame.sha256)
    assert.deepEqual(new Uint8Array(saved), sequence.frames[index]?.data, `frame ${index + 1} is saved as the judge received it`)
    assert.ok(frame.fate === 'shown' || frame.fate === 'superseded', `frame ${index + 1} was placed: ${frame.fate}`)
  }
}

test('checks over frames of a real Chrome recording', async (t) => {
  const needs = mediaPrerequisites(t)
  if (needs === undefined) return
  const held: { recording?: Recording; media?: MediaProcess } = {}
  const stop = new AbortController()
  let recording: Promise<SourceRecording> | undefined
  // Hooks run in registration order. Finalize and release before closing the process, deleting files or closing Chrome.
  t.after(async () => {
    stop.abort()
    try {
      await recording
    } finally {
      try {
        await held.recording?.release(5000)
      } finally {
        await held.media?.close(10_000)
      }
    }
  })
  const folder = await scratchFolder(t)
  const media = await MediaProcess.start({ executable: needs.binary, args: mediaArguments({ ffmpeg: needs.ffmpeg }), startTimeoutMs: 10_000 })
  held.media = media
  const scene = await serveScene('toast')
  t.after(() => scene.close())
  const browser: OwnedBrowser = await launch(t)
  const opened = await browser.newPage({ baseUrl: scene.url, emulation: { viewport: { width: 640, height: 400 }, deviceScaleFactor: 1, touch: false, isMobile: false } }, setupMs)
  t.after(() => opened.dispose(2000))
  assert.ok(opened instanceof ChromiumPage, 'a Chromium page')
  const page = opened
  const session = { sessionId: identity.sessionId, owner: { runId: 'run-frames', testId: identity.testId, attemptId: identity.attemptId, app: 'web' }, runtime: webRuntimeIdentity(browser, 'chromium') }
  page.identify(session)
  assert.ok((await page.execute({ kind: 'goto', url: '/' }, 10_000)).ok)

  // The run's clock: the store's milliseconds and the capture's microseconds count from the same moment.
  const zero = performance.now()
  const clockUs = microsecondsSince(zero)
  const clockMs = (): number => Math.round(performance.now() - zero)

  // The recording `recordSource` starts, kept so the checks can ask it for frames while it runs.
  const recorder: MediaRecorder = {
    record: async (start, timeoutMs) => {
      const started = await media.record(start, timeoutMs)
      if (started.kind === 'started') held.recording = started.recording
      return started
    },
  }
  const suspension = new CaptureSuspension()
  const delivered: { timestampUs: number; earliestUs: number | undefined; atUs: number; withheld: boolean }[] = []
  const source = page.frameSource(identity, { format: 'png', maxWidth: 640, maxHeight: 400 })
  const traced: FrameSource = {
    name: source.name,
    identity: source.identity,
    availability: () => source.availability(),
    stop: (timeoutMs) => source.stop(timeoutMs),
    start: (options) => source.start({ ...options, deliver: (frame) => {
      delivered.push({ timestampUs: frame.timestampUs, earliestUs: frame.earliestUs, atUs: clockUs(), withheld: suspension.suspended })
      options.deliver(frame)
    } }),
  }
  recording = recordSource(traced, recorder, {
    recordingId: 'frames',
    runId: 'run-frames',
    output: join(folder, 'frames'),
    width: 640,
    height: 400,
    fps: 10,
    deadlineMs: 20_000,
    limits: { keepFrames: true },
    clock: clockUs,
    startTimeoutMs: 10_000,
    stopTimeoutMs: 5000,
    finishTimeoutMs: 30_000,
    signal: stop.signal,
    suspension,
  })
  for (let waited = 0; held.recording === undefined && waited < 100; waited++) await delay(100)
  const recorded = held.recording
  assert.ok(recorded !== undefined, 'the recording started')

  // Step "save": the toast comes 300 ms after the click and goes 900 ms later. A later paint places the step's frames.
  await act(page, 'fill', 'Release checklist')
  await delay(400)
  const spans: Record<string, StepSpan> = {}
  const saveFrom = clockUs()
  await act(page, 'click')
  await delay(2000)
  spans['save'] = { fromUs: saveFrom, toUs: clockUs() }
  await act(page, 'fill', 'Typed after save, so its frames are placed')
  // Stop the caret's future paints so the pending-frame interval includes the actual newest frame throughout its query.
  assert.ok((await page.execute({ kind: 'press', locator: titleField, key: 'Tab' }, 2000)).ok, 'focus leaves the blinking title field')
  await delay(600)

  const recordings: AttemptRecordings = {
    recording: (app) => (app === 'web' ? { state: 'recording', store: recorded, source: 'chromium' } : undefined),
    step: (name) => spans[name],
  }
  const appPage: AppPage = { app: 'web', page, browser, touch: false, session }

  await t.test('a step of the running recording: its frames are the process\'s own, saved as sent, and a pass counts only with nothing missing', async (t) => {
    const { evaluations, calls, store } = harness(t, appPage, recordings, clockMs)
    const record = await check(evaluations, [{ kind: 'recording', app: 'web', step: 'save' }])
    const [evidence] = record.evidence
    assert.ok(evidence !== undefined && evidence.kind === 'frames')
    assert.deepEqual([evidence.fromUs, evidence.toUs, evidence.source, evidence.step], [spans['save']?.fromUs, spans['save']?.toUs, 'chromium', 'save'])
    assert.ok((evidence.frames?.length ?? 0) > 0, 'the step kept frames')
    assertFramesSaved(record, calls[0], store)
    const sequence = calls[0]?.frames?.[0]
    assert.ok(sequence !== undefined && sequence.frames.every((frame) => frame.atMs >= 0 && frame.atMs <= sequence.durationMs))
    assert.equal(record.verdict === 'pass', evidence.status === 'complete', `a pass counts exactly when nothing is missing: ${evidence.reason ?? 'complete'}`)
    assert.equal(evidence.status, 'complete', `nothing should be missing from a step that is over: ${evidence.reason ?? ''}`)
    const direct = await recorded.frames({ fromUs: evidence.fromUs ?? 0, toUs: evidence.toUs ?? 0, maxFrames: 64, maxWidth: 4096, maxHeight: 4096 }, 10_000)
    t.diagnostic(JSON.stringify({ interval: [evidence.fromUs, evidence.toUs], checkedAtUs: clockUs(), stepFrames: direct.frames.map((frame) => ({ frameId: frame.frameId, captureUs: frame.captureUs, fate: frame.fate })) }))
    assert.deepEqual((evidence.frames ?? []).map((frame) => [frame.frameId, frame.captureUs]), direct.frames.filter((frame) => frame.fate === 'shown' || frame.fate === 'superseded').map((frame) => [frame.frameId, frame.captureUs]), 'the frames sent are the ones the process holds, in order')
  })

  await t.test('the latest frame of a running recording is pending, so it is named and never sent', async (t) => {
    const { evaluations, calls } = harness(t, appPage, recordings, clockMs)
    const record = await check(evaluations, [{ kind: 'recording', app: 'web', lastMs: 1500 }])
    const [evidence] = record.evidence
    assert.ok(evidence !== undefined)
    assert.equal((evidence.toUs ?? 0) - (evidence.fromUs ?? 0), 1_500_000)
    const direct = await recorded.frames({ fromUs: evidence.fromUs ?? 0, toUs: evidence.toUs ?? 0, maxFrames: 64, maxWidth: 4096, maxHeight: 4096 }, 10_000)
    const pending = direct.frames.filter((frame) => frame.fate === 'pending').map((frame) => frame.frameId)
    t.diagnostic(JSON.stringify({ interval: [evidence.fromUs, evidence.toUs], checkedAtUs: clockUs(), directFrames: direct.frames.map((frame) => ({ frameId: frame.frameId, captureUs: frame.captureUs, fate: frame.fate })), inInterval: direct.inInterval, available: direct.available, storedThroughUs: direct.storedThroughUs, sourceFrames: delivered }))
    assert.ok(pending.length > 0, `the running recording holds a pending frame: ${JSON.stringify(direct.frames.map((frame) => frame.fate))}`)
    assert.deepEqual((evidence.framesNotSent ?? []).filter((frame) => frame.fate === 'pending').map((frame) => frame.frameId), pending)
    const sentIds = new Set((evidence.frames ?? []).map((frame) => frame.frameId))
    for (const id of pending) assert.ok(!sentIds.has(id), `the pending frame ${id} was not sent`)
    assert.notEqual(record.verdict, 'pass')
    if (calls.length > 0) assert.deepEqual([record.criteria[0]?.rule, record.criteria[0]?.judgeVerdict], ['frames_incomplete', 'pass'])
  })

  // Pending frames are checked before suspension; a separate post-resume query below proves safe frames return.
  const hiddenFrom = clockUs()
  await act(page, 'fill', 'Release checklist')
  await act(page, 'click')
  await delay(150)
  suspension.suspend()
  await delay(1500)
  suspension.resume()
  await delay(300)
  spans['hidden'] = { fromUs: hiddenFrom, toUs: clockUs() }
  await act(page, 'fill', 'Typed after hidden, with the resumed capture window')
  await delay(600)
  await act(page, 'fill', 'Another safe paint after resume')
  await delay(600)

  await t.test('fresh post-resume paints enter the store while frames crossing the closed withheld stretch stay refused', async () => {
    const resumed = delivered.filter((frame) => frame.atUs > (spans['hidden']?.toUs ?? Infinity))
    assert.ok(resumed.length > 0, 'Chrome delivered frames after resume')
    const safe = resumed.filter((frame) => (frame.earliestUs ?? 0) > (spans['hidden']?.toUs ?? Infinity))
    assert.ok(safe.length > 0, 'the possible paint window advances beyond the withheld stretch')
    const direct = await recorded.frames({ fromUs: spans['hidden']?.toUs ?? 0, toUs: clockUs(), maxFrames: 64, maxWidth: 4096, maxHeight: 4096 }, 10_000)
    assert.ok(direct.frames.some((frame) => safe.some((seen) => seen.timestampUs === frame.captureUs)), 'the media store kept a fresh safe post-resume frame')
  })

  await t.test('a stretch the pixel policy withheld keeps the judge\'s pass from counting, and says so', async (t) => {
    const { evaluations, calls } = harness(t, appPage, recordings, clockMs)
    const record = await check(evaluations, [{ kind: 'recording', app: 'web', step: 'hidden' }])
    const [evidence] = record.evidence
    assert.ok(evidence !== undefined)
    assert.equal(evidence.status, 'partial')
    assert.ok((evidence.stretches ?? []).some((stretch) => stretch.captureGaps.includes('pixels_withheld')), JSON.stringify(evidence.stretches))
    assert.match(evidence.reason ?? '', /with a gap the capture reported/)
    assert.equal(calls.length, 1)
    assert.ok(calls[0]?.frames?.[0]?.stretches.some((stretch) => stretch.why.includes('the capture reported a gap (pixels_withheld)')))
    assert.deepEqual([record.verdict, record.criteria[0]?.verdict, record.criteria[0]?.rule, record.criteria[0]?.judgeVerdict], ['inconclusive', 'inconclusive', 'frames_incomplete', 'pass'])
    assert.equal(record.failure?.class, 'evaluation_inconclusive')
  })

  await t.test('a judge\'s absence pass over frames is inconclusive, however complete they are', async (t) => {
    const { evaluations, calls } = harness(t, appPage, recordings, clockMs)
    const record = await check(evaluations, [{ kind: 'recording', app: 'web', step: 'save' }], [{ id: 'calm', requirement: 'No error banner appears during the save.', absence: true }])
    assert.deepEqual([record.verdict, calls.length, record.criteria[0]?.rule, record.criteria[0]?.judgeVerdict], ['inconclusive', 1, 'absence_over_frames', 'pass'])
  })

  stop.abort()
  const ended = await recording
  t.diagnostic(JSON.stringify({ recordingFrames: ended.frames, recordingGaps: ended.gaps, sourceFrames: delivered }))
  assert.equal(ended.status, 'ended', JSON.stringify({ status: ended.status, reason: ended.reason, problems: ended.problems }))

  await t.test('after the recording ended, the same step is judged on frames that are all placed, and a pass counts', async (t) => {
    const { evaluations, calls, store } = harness(t, appPage, recordings, clockMs)
    const record = await check(evaluations, [{ kind: 'recording', app: 'web', step: 'save' }])
    const [evidence] = record.evidence
    assert.ok(evidence !== undefined)
    assert.deepEqual(evidence.framesNotSent, undefined, 'no frame of a step long over is left unplaced')
    assertFramesSaved(record, calls[0], store)
    assert.deepEqual([evidence.status, record.verdict], ['complete', 'pass'], evidence.reason ?? '')
    for (const kind of ['state', 'seen', 'never'] as const) {
      const criterion: Criterion = { id: 'claim', kind, requirement: kind === 'never' ? 'No error banner appears during the save.' : kind === 'seen' ? 'The saved task appears during the save.' : 'The last frame shows the saved task.' }
      const typed = await check(evaluations, [{ kind: 'recording', app: 'web', step: 'save' }], [criterion])
      assert.deepEqual([typed.evidence[0]?.status, typed.verdict, typed.criteria[0]?.kind], ['complete', 'pass', kind], typed.reason ?? '')
      assert.deepEqual(calls.at(-1)?.criteria, [criterion])
      assertFramesSaved(typed, calls.at(-1), store)
    }

  })
})
