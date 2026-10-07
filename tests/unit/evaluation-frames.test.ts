import type { TestContext } from 'node:test'
import type { LoadedEvaluation } from '../../src/config/read-evaluation.ts'
import type { EvaluationRequest, EvaluatorSetup } from '../../src/evaluation/contract.ts'
import type { DiagnosticsSnapshot } from '../../src/evaluation/diagnostics-evidence.ts'
import type { AttemptRecording, AttemptRecordings, FrameStore } from '../../src/evaluation/frames.ts'
import type { FrameSequence, FrameSequenceRequest } from '../../src/media/protocol.ts'
import type { DiagnosticRecord } from '../../src/protocol/diagnostics.ts'
import type { Criterion, EvaluationRecord, EvidenceSelector } from '../../src/protocol/evaluation.ts'
import type { EventBody } from '../../src/protocol/events.ts'
import type { AppPage, PagesContext } from '../../src/runner/test-pages.ts'
import type { HeldFrame } from '../../fixtures/evaluation-corpus/runner/frame-store.ts'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { AttemptEvaluations } from '../../src/evaluation/attempt.ts'
import { CallBudget, defaultEvaluationLimits } from '../../src/evaluation/budget.ts'
import { frameInstructions, judgeInstructions, promptVersion } from '../../src/evaluation/instructions.ts'
import { Judges } from '../../src/evaluation/judges.ts'
import { evaluationDetails } from '../../src/evaluation/report.ts'
import { withEvaluationFailures } from '../../src/evaluation/run-evaluations.ts'
import { evaluationRecordSchema, hostEvaluationProblems, hostEvaluationRecord, isEvaluationPart } from '../../src/protocol/evaluation.ts'
import { parse } from '../../src/protocol/schema.ts'
import { testStatus } from '../../src/runner/outcome.ts'
import { Redactor } from '../../src/runner/redactor.ts'
import { RunStore } from '../../src/store/run-store.ts'
import { frameStore } from '../../fixtures/evaluation-corpus/runner/frame-store.ts'
import { fakeLauncher } from '../support/fake-browser.ts'
import { newRunFolder, quickTimeouts } from '../support/run-harness.ts'
import { tempFolder } from '../support/temp-folder.ts'

// Frame and diagnostics evidence through the parent's own check path, `AttemptEvaluations`, with a scripted judge and a
// stand-in frame store shaped as the media process's version 2 reply. The fake browser serves the attempt's pages.

type Script = (request: EvaluationRequest) => unknown | Promise<unknown>

const jpeg = (marker: number): Uint8Array => Uint8Array.of(0xff, 0xd8, 0xff, 0xe0, marker, 0, 0, 0xff, 0xd9)
const png = (marker: number): Uint8Array => Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, marker)

// Ten frames, 100 ms apart from 1 s on the run's clock, 40 by 30.
function heldFrames(count = 10, startUs = 1_000_000): HeldFrame[] {
  return Array.from({ length: count }, (_, index) => ({ frameId: `f${index + 1}`, captureUs: startUs + index * 100_000, format: 'jpeg' as const, bytes: jpeg(index), width: 40, height: 30 }))
}

type Setup = {
  script?: Script
  recordings?: AttemptRecordings
  diagnostics?: { snapshot(app: string): DiagnosticsSnapshot | undefined }
  accepts?: ('text' | 'images' | 'frames')[]
  limits?: Partial<typeof defaultEvaluationLimits>
  nowMs?: number
  redactor?: Redactor
  timeoutMs?: number
  credential?: string
  credentialReader?: () => string | Promise<string>
  pixels?: PagesContext['pixels']
  screenshot?: () => Promise<Uint8Array>
}

type Harness = { evaluations: AttemptEvaluations; calls: EvaluationRequest[]; events: EventBody[]; store: RunStore; budget: CallBudget }

async function harness(t: TestContext, setup: Setup = {}): Promise<Harness> {
  const calls: EvaluationRequest[] = []
  const script = setup.script ?? ((request: EvaluationRequest) => passAll(request, request.frames?.[0]?.frames[0]?.id ?? request.evidence[0]?.id ?? 'e1'))
  const factory = (judgeSetup: EvaluatorSetup): unknown => ({
    identity: { provider: 'scripted', model: `frames-${judgeSetup.judge}`, version: 'scripted/1' },
    async evaluate(request: EvaluationRequest) {
      calls.push(request)
      return script(request)
    },
  })
  const limits = { ...defaultEvaluationLimits, ...setup.limits }
  const readCredential = setup.credentialReader ?? (setup.credential === undefined ? undefined : async () => setup.credential ?? '')
  const evaluation: LoadedEvaluation = {
    judges: new Map([['visual', { name: 'visual', adapter: { kind: 'factory', factory }, credentials: readCredential === undefined ? new Map() : new Map([['apiKey', { read: readCredential }]]), options: {}, accepts: setup.accepts ?? ['text', 'images', 'frames'] }]]),
    defaultJudge: 'visual',
    timeoutMs: setup.timeoutMs ?? 2000,
    limits,
  }
  const redactor = setup.redactor ?? new Redactor()
  const store = RunStore.create(newRunFolder())
  t.after(() => store.close())
  const nowMs = setup.nowMs ?? 5000
  store.setClock(() => nowMs)
  const events: EventBody[] = []
  const context: PagesContext = {
    store,
    timeouts: quickTimeouts,
    stopped: new Promise(() => undefined),
    interruption: () => undefined,
    connected: () => true,
    release: () => undefined,
    named: true,
    emit: (body) => events.push(body),
    redact: (text) => redactor.redact(text),
    testId: 'frames.retest.ts > saves',
    attemptId: 'k3v9q0x2mb',
    ...(setup.pixels === undefined ? {} : { pixels: setup.pixels }),
  }
  const page = await appPage('web', context)
  if (setup.screenshot !== undefined) page.page.screenshot = setup.screenshot
  const pages = [page]
  const budget = new CallBudget(limits)
  const judges = new Judges({ evaluation, redactor, env: {} })
  t.after(() => judges.close(1000))
  const evaluations = new AttemptEvaluations({ context, pages, evaluation, judges, budget, hostChecks: [], runSignal: new AbortController().signal, recordings: setup.recordings, diagnostics: setup.diagnostics })
  return { evaluations, calls, events, store, budget }
}

async function appPage(app: string, context: PagesContext): Promise<AppPage> {
  const browser = await fakeLauncher().launch({ executablePath: '/fake/chromium', logFile: join(tempFolder('frames-log-'), 'browser.log'), headless: true }, 1000)
  const page = await browser.newPage({}, 1000)
  const sessionId = `${context.attemptId}:${app}`
  return { app, page, browser, touch: false, session: { sessionId, owner: { runId: 'run', testId: context.testId, attemptId: context.attemptId, app }, runtime: { kind: 'web', engine: 'chromium', product: 'Chrome', version: '154', executablePath: '/fake/chromium', processIds: [1] } } }
}

function passAll(request: EvaluationRequest, citation: string): unknown {
  return { criteria: request.criteria.map(({ id }) => ({ id, verdict: 'pass', citations: [citation] })), justification: 'Scripted pass.' }
}

function recordingsOf(recording: AttemptRecording | undefined, steps: Record<string, { fromUs: number; toUs?: number }> = {}): AttemptRecordings & { asked: string[] } {
  const asked: string[] = []
  return {
    asked,
    recording: (app) => {
      asked.push(app)
      return recording
    },
    step: (name) => steps[name],
  }
}

async function check(evaluations: AttemptEvaluations, evidence: EvidenceSelector[], criteria: Criterion[] = [{ id: 'shown', requirement: 'A notification saying "Saved" appears.' }]): Promise<EvaluationRecord> {
  await evaluations.request({ criteria, evidence, mode: 'required' }, { remainingMs: 5000 })
  const record = evaluations.records.at(-1)
  assert.ok(record !== undefined)
  assert.ok(parse(evaluationRecordSchema, record).ok, 'every record is valid against the published schema')
  return record
}

const step = (name = 'save'): EvidenceSelector => ({ kind: 'recording', app: 'web', step: name })

describe('frames of a recorded step', () => {
  test('reach the judge with their ids, capture times and the stretches with no frame, and are frozen in the run folder', async (t) => {
    const frames = heldFrames().filter((frame) => frame.frameId !== 'f5' && frame.frameId !== 'f6')
    const store = frameStore({ frames, lost: [{ captureUs: 1_450_000, fate: 'dropped' }], captureGaps: [{ fromUs: 1_420_000, toUs: 1_480_000, reason: 'page_hidden' }], frameIntervalUs: 100_000 })
    const { evaluations, calls, store: run } = await harness(t, { recordings: recordingsOf({ state: 'recording', store, source: 'chromium' }, { save: { fromUs: 1_000_000, toUs: 1_900_000 } }) })
    const record = await check(evaluations, [step()])
    assert.equal(record.verdict, 'inconclusive', 'a frame was lost and the capture reported a gap, so the pass does not count')
    assert.deepEqual(record.criteria.map(({ verdict, rule, judgeVerdict }) => [verdict, rule, judgeVerdict]), [['inconclusive', 'frames_incomplete', 'pass']])
    assert.match(record.reason ?? '', /The judge passed "shown", but it did not see every frame of the interval, so Retest leaves it undecided\. e1: Frames are missing from the interval: 1 frame that reached the media process not kept, 1 stretch with a gap the capture reported\./)
    assert.equal(record.failure?.class, 'evaluation_inconclusive')
    const [call] = calls
    assert.ok(call !== undefined)
    assert.deepEqual(call.evidence, [], 'frames travel apart from the other evidence')
    const [sequence] = call.frames ?? []
    assert.ok(sequence !== undefined)
    assert.deepEqual([sequence.id, sequence.app, sequence.step, sequence.durationMs, sequence.complete], ['e1', 'web', 'save', 900, false])
    assert.deepEqual(sequence.frames.map((frame) => [frame.id, frame.atMs, frame.mediaType]), [
      ['e1-f1', 0, 'image/jpeg'], ['e1-f2', 100, 'image/jpeg'], ['e1-f3', 200, 'image/jpeg'], ['e1-f4', 300, 'image/jpeg'],
      ['e1-f5', 600, 'image/jpeg'], ['e1-f6', 700, 'image/jpeg'], ['e1-f7', 800, 'image/jpeg'], ['e1-f8', 900, 'image/jpeg'],
    ])
    assert.deepEqual(sequence.stretches, [
      { fromMs: 0, toMs: 100, why: 'no frame reached Retest' },
      { fromMs: 100, toMs: 200, why: 'no frame reached Retest' },
      { fromMs: 200, toMs: 300, why: 'no frame reached Retest' },
      { fromMs: 300, toMs: 600, why: '1 frame dropped by a full queue; the capture reported a gap (page_hidden)' },
      { fromMs: 600, toMs: 700, why: 'no frame reached Retest' },
      { fromMs: 700, toMs: 800, why: 'no frame reached Retest' },
      { fromMs: 800, toMs: 900, why: 'no frame reached Retest' },
    ])
    assert.equal(call.promptVersion, `${promptVersion}+frames-3`)
    assert.ok(call.instructions.startsWith(judgeInstructions) && call.instructions.endsWith(frameInstructions))
    const [evidence] = record.evidence
    assert.ok(evidence !== undefined && evidence.kind === 'frames')
    assert.deepEqual([evidence.status, evidence.step, evidence.fromUs, evidence.toUs, evidence.source, evidence.sessionId, evidence.inInterval, evidence.available, evidence.stretchesFound], ['partial', 'save', 1_000_000, 1_900_000, 'chromium', 'k3v9q0x2mb:web', 9, 8, 7])
    assert.equal(evidence.reason, 'Frames are missing from the interval: 1 frame that reached the media process not kept, 1 stretch with a gap the capture reported.')
    assert.deepEqual((evidence.frames ?? []).map((frame) => frame.fate), Array.from({ length: 8 }, () => 'shown'))
    for (const [index, frame] of (evidence.frames ?? []).entries()) {
      const saved = readFileSync(join(run.directory, frame.path))
      assert.equal(createHash('sha256').update(saved).digest('hex'), frame.sha256, `frame ${index + 1} is saved as it was sent`)
      assert.deepEqual(new Uint8Array(saved), sequence.frames[index]?.data)
      assert.ok(frame.path.endsWith('.jpg'))
    }
    assert.equal(evidence.bytes, (evidence.frames ?? []).reduce((sum, frame) => sum + frame.bytes, 0))
  })

  test('omitted capture gaps make a gap-free returned interval partial and cannot support a presence pass', async (t) => {
    const base = frameStore({ frames: heldFrames(2), frameIntervalUs: 100_000 })
    const store: FrameStore = { async frames(request, timeoutMs) {
      const sequence = await base.frames(request, timeoutMs)
      return { ...sequence, captureGapsOmitted: 1 }
    } }
    const { evaluations, calls } = await harness(t, { recordings: recordingsOf({ state: 'recording', store, source: 'chromium' }, { save: { fromUs: 1_000_000, toUs: 1_100_000 } }) })
    const record = await check(evaluations, [step()])
    assert.deepEqual([record.verdict, record.evidence[0]?.status, calls[0]?.frames?.[0]?.complete], ['inconclusive', 'partial', false])
    assert.equal(record.criteria[0]?.rule, 'frames_incomplete')
    assert.match(record.evidence[0]?.reason ?? '', /1 capture gap omitted/)
  })

  test('a sequence with nothing lost, left out or missing is complete; the judge may cite one frame', async (t) => {
    const store = frameStore({ frames: heldFrames(), frameIntervalUs: 100_000 })
    const { evaluations, calls } = await harness(t, { recordings: recordingsOf({ state: 'recording', store }, { save: { fromUs: 1_000_000, toUs: 1_900_000 } }), script: (request) => passAll(request, 'e1-f4') })
    const record = await check(evaluations, [step()])
    assert.equal(record.verdict, 'pass')
    assert.deepEqual(record.criteria[0]?.citations, ['e1-f4'])
    assert.equal(calls[0]?.frames?.[0]?.complete, true)
    assert.equal(record.evidence[0]?.status, 'complete')
    assert.equal(record.evidence[0]?.reason, undefined)
  })

  test('the store is asked for the interval with the bounds of the check, and a step still running ends now', async (t) => {
    const store = frameStore({ frames: heldFrames(30), frameIntervalUs: 100_000 })
    const { evaluations, calls } = await harness(t, { recordings: recordingsOf({ state: 'recording', store }, { save: { fromUs: 1_000_000 } }), limits: { maxFrames: 4, maxImageWidth: 640, maxImageHeight: 480 }, nowMs: 3500 })
    const record = await check(evaluations, [step()])
    assert.deepEqual(store.asked, [{ fromUs: 1_000_000, toUs: 3_500_000, maxFrames: 4, maxWidth: 640, maxHeight: 480, maxBytes: defaultEvaluationLimits.maxInputBytes - Buffer.byteLength(JSON.stringify([{ id: 'shown', requirement: 'A notification saying "Saved" appears.' }])), minGapUs: 1 }])
    assert.equal(calls[0]?.frames?.[0]?.frames.length, 4)
    assert.deepEqual(record.evidence[0]?.omitted, { byCount: 22, byBytes: 0, undecodable: 0 }, "26 kept frames lie from 1 s to 3.5 s")
    assert.equal(calls[0]?.frames?.[0]?.omitted, 22)
    assert.equal(record.evidence[0]?.status, 'partial')
  })

  test('lastMs asks for the milliseconds before the check, and maxFrames never asks the process for more than 64', async (t) => {
    const store = frameStore({ frames: heldFrames(), frameIntervalUs: 100_000 })
    const { evaluations } = await harness(t, { recordings: recordingsOf({ state: 'recording', store }), limits: { maxFrames: 500 }, nowMs: 1800 })
    await check(evaluations, [{ kind: 'recording', app: 'web', lastMs: 600 }])
    assert.deepEqual([store.asked[0]?.fromUs, store.asked[0]?.toUs, store.asked[0]?.maxFrames], [1_200_000, 1_800_000, 64])
  })

  test('two sequences of one check share maxFrames', async (t) => {
    const store = frameStore({ frames: heldFrames(), frameIntervalUs: 100_000 })
    const { evaluations, calls } = await harness(t, { recordings: recordingsOf({ state: 'recording', store }, { save: { fromUs: 1_000_000, toUs: 1_900_000 } }), limits: { maxFrames: 6 } })
    const record = await check(evaluations, [step(), step()])
    assert.deepEqual(store.asked.map((asked: FrameSequenceRequest) => asked.maxFrames), [6], 'the second sequence is never asked for')
    assert.equal(record.verdict, 'error')
    assert.match(record.reason ?? '', /more than evaluation\.limits\.maxFrames of 6 frames/)
    assert.equal(calls.length, 0)
  })
})

describe('frames missing from what the judge sees', () => {
  const save = { save: { fromUs: 1_000_000, toUs: 1_900_000 } }
  const shown: Criterion = { id: 'shown', requirement: 'A notification saying "Saved" appears.' }

  for (const absence of [false, true]) for (const judgeVerdict of ['pass', 'fail'] as const) {
    test(`missing frames with ${absence ? 'absence' : 'presence'} and judge ${judgeVerdict}`, async (t) => {
      const store = frameStore({ frames: heldFrames(), lost: [{ captureUs: 1_250_000, fate: 'dropped' }], frameIntervalUs: 100_000 })
      const script = (request: EvaluationRequest): unknown => ({ criteria: request.criteria.map(({ id }) => ({ id, verdict: judgeVerdict, citations: ['e1-f4'] })), justification: 'The cited frame shows the banner.' })
      const { evaluations, calls } = await harness(t, { recordings: recordingsOf({ state: 'recording', store }, save), script })
      const criterion: Criterion = { id: 'banner', requirement: absence ? 'No red banner may appear.' : 'A green banner must appear.', ...(absence ? { absence: true } : {}) }
      const record = await check(evaluations, [step()], [criterion])
      assert.equal(calls.length, 1)
      const stands = absence && judgeVerdict === 'fail'
      assert.deepEqual([record.verdict, record.criteria[0]?.verdict, record.failure?.class], stands ? ['fail', 'fail', 'evaluation_failed'] : ['inconclusive', 'inconclusive', 'evaluation_inconclusive'])
      assert.equal(record.criteria[0]?.judgeVerdict, stands ? undefined : judgeVerdict)
      if (!stands) { assert.equal(record.criteria[0]?.rule, 'frames_incomplete'); assert.match(record.reason ?? '', /missing|did not see every frame/) }
    })
  }

  test('an absence failure over missing frames must cite a seen frame, not the sequence or diagnostics', async (t) => {
    const store = frameStore({ frames: heldFrames(), lost: [{ captureUs: 1_250_000, fate: 'dropped' }], frameIntervalUs: 100_000 })
    const { evaluations, calls } = await harness(t, { recordings: recordingsOf({ state: 'recording', store }, save), script: (request) => ({ criteria: request.criteria.map(({ id }) => ({ id, verdict: 'fail', citations: ['e1'] })), justification: 'Not seen.' }) })
    const record = await check(evaluations, [step()], [{ id: 'calm', requirement: 'No red banner appears.', absence: true }])
    assert.equal(calls.length, 1)
    assert.deepEqual([record.verdict, record.criteria[0]?.rule, record.criteria[0]?.judgeVerdict], ['inconclusive', 'absence_over_frames', 'fail'])
    assert.match(record.reason ?? '', /seen frame/)
  })

  test('a stretch in which no frame arrived is told to the judge and leaves the sequence complete, so a pass counts', async (t) => {
    const frames = heldFrames().filter((frame) => !['f4', 'f5', 'f6'].includes(frame.frameId))
    const store = frameStore({ frames, frameIntervalUs: 100_000 })
    const { evaluations, calls } = await harness(t, { recordings: recordingsOf({ state: 'recording', store }, save) })
    const record = await check(evaluations, [step()])
    assert.deepEqual(calls[0]?.frames?.[0]?.stretches, [
      { fromMs: 0, toMs: 100, why: 'no frame reached Retest' },
      { fromMs: 100, toMs: 200, why: 'no frame reached Retest' },
      { fromMs: 200, toMs: 600, why: 'no frame reached Retest' },
      { fromMs: 600, toMs: 700, why: 'no frame reached Retest' },
      { fromMs: 700, toMs: 800, why: 'no frame reached Retest' },
      { fromMs: 800, toMs: 900, why: 'no frame reached Retest' },
    ])
    assert.equal(calls[0]?.frames?.[0]?.complete, true)
    assert.deepEqual([record.verdict, record.evidence[0]?.status, record.evidence[0]?.stretchesFound], ['pass', 'complete', 6])
    assert.equal(record.criteria[0]?.rule, undefined)
  })

  test('frames the recording has not placed never reach the judge: each is named, its time is a stretch, and a pass does not count', async (t) => {
    const frames = heldFrames().map((frame) => (frame.frameId === 'f9' ? { ...frame, fate: 'unprocessed' as const } : frame.frameId === 'f10' ? { ...frame, fate: 'pending' as const } : frame.frameId === 'f2' ? { ...frame, fate: 'superseded' as const } : frame))
    const store = frameStore({ frames, frameIntervalUs: 100_000 })
    const { evaluations, calls, store: run } = await harness(t, { recordings: recordingsOf({ state: 'recording', store }, save) })
    const record = await check(evaluations, [step()])
    const [sequence] = calls[0]?.frames ?? []
    assert.ok(sequence !== undefined)
    assert.equal(sequence.frames.length, 8, 'the pending and the unprocessed frame are not sent')
    assert.deepEqual(sequence.frames.map((frame) => frame.atMs), [0, 100, 200, 300, 400, 500, 600, 700])
    assert.deepEqual(sequence.stretches, [
      ...Array.from({ length: 8 }, (_, index) => ({ fromMs: index * 100, toMs: (index + 1) * 100, why: 'no frame reached Retest' })),
      { fromMs: 800, toMs: 900, why: 'no frame reached Retest' },
      { fromMs: 800, toMs: 900, why: 'a frame captured here was never written to the recording, so it is not shown' },
      { fromMs: 900, toMs: 900, why: 'a frame captured here was not placed in the running recording yet, so it is not shown' },
    ])
    assert.deepEqual([sequence.complete, sequence.omitted], [false, 2])
    const [evidence] = record.evidence
    assert.deepEqual(evidence?.framesNotSent, [{ frameId: 'f9', captureUs: 1_800_000, fate: 'unprocessed' }, { frameId: 'f10', captureUs: 1_900_000, fate: 'pending' }])
    assert.deepEqual((evidence?.frames ?? []).map((frame) => frame.fate), ['shown', 'superseded', 'shown', 'shown', 'shown', 'shown', 'shown', 'shown'])
    assert.equal(evidence?.reason, 'Frames are missing from the interval: 1 frame the running recording had not placed yet, 1 frame the recording ended without writing.')
    assert.equal(readdirSync(join(run.directory, 'artifacts')).filter((name) => name.includes('frame-')).length, 8, 'only the frames sent are saved')
    assert.deepEqual([record.verdict, record.criteria[0]?.rule, record.criteria[0]?.judgeVerdict], ['inconclusive', 'frames_incomplete', 'pass'])
  })

  test('a sequence of frames none of which the recording has placed leaves the check without evidence, and the judge is not asked', async (t) => {
    const frames = heldFrames(2).map((frame) => ({ ...frame, fate: 'pending' as const }))
    const store = frameStore({ frames, frameIntervalUs: 100_000, recording: 'running' })
    const { evaluations, calls, budget } = await harness(t, { recordings: recordingsOf({ state: 'recording', store }, save) })
    const record = await check(evaluations, [step()])
    assert.deepEqual([record.verdict, calls.length, budget.calls], ['inconclusive', 0, 0])
    assert.match(record.reason ?? '', /The recording of web has placed none of the 2 frames it kept from 1000 ms to 1900 ms on the run's clock \(2 frames the running recording had not placed yet\), so the check has nothing to judge\./)
    assert.deepEqual([record.evidence[0]?.status, record.evidence[0]?.frames, record.evidence[0]?.framesNotSent?.length], ['unavailable', [], 2])
  })

  const incomplete: [string, Parameters<typeof frameStore>[0], RegExp][] = [
    ['kept frames the frame bound left out', { frames: heldFrames(), frameIntervalUs: 100_000 }, /3 kept frames left out by the frame bound/],
    ['a capture gap with no frame lost', { frames: heldFrames().filter((frame) => frame.frameId !== 'f5'), captureGaps: [{ fromUs: 1_350_000, toUs: 1_450_000, reason: 'pixels_withheld' }], frameIntervalUs: 50_000 }, /1 stretch with a gap the capture reported/],
    ['frames not stored yet', { frames: heldFrames(), frameIntervalUs: 100_000, storedThroughUs: 1_500_000, recording: 'running' }, /frames after 1500 ms not stored yet of an interval to 1900 ms/],
    ['a process that says frames may be missing', { frames: heldFrames(), frameIntervalUs: 100_000, message: 'some kept frames could not be read back' }, /the media process says: some kept frames could not be read back/],
  ]
  for (const [what, options, reason] of incomplete) {
    test(`${what} keep a pass from counting, and say why`, async (t) => {
      const store = frameStore(options)
      const { evaluations } = await harness(t, { recordings: recordingsOf({ state: 'recording', store }, save), limits: { maxFrames: 7 } })
      const record = await check(evaluations, [step()])
      assert.equal(record.evidence[0]?.status, 'partial')
      assert.match(record.evidence[0]?.reason ?? '', reason)
      assert.deepEqual([record.verdict, record.criteria[0]?.verdict, record.criteria[0]?.judgeVerdict, record.criteria[0]?.rule], ['inconclusive', 'inconclusive', 'pass', 'frames_incomplete'])
      assert.match(record.failure?.message ?? '', /could not be decided: The judge passed "shown", but it did not see every frame/)
    })
  }

  test('a presence failure over missing frames is undecided because the missing frames may show the required event', async (t) => {
    const store = frameStore({ frames: heldFrames(), lost: [{ captureUs: 1_250_000, fate: 'dropped' }], frameIntervalUs: 100_000 })
    const { evaluations } = await harness(t, { recordings: recordingsOf({ state: 'recording', store }, save), script: (request) => ({ criteria: request.criteria.map(({ id }) => ({ id, verdict: 'fail', citations: ['e1-f4'] })), justification: 'The notification says "Could not save".' }) })
    const record = await check(evaluations, [step()])
    assert.deepEqual([record.verdict, record.failure?.class, record.criteria[0]?.rule, record.criteria[0]?.judgeVerdict], ['inconclusive', 'evaluation_inconclusive', 'frames_incomplete', 'fail'])
  })

  test('two presence criteria over missing frames leave both the pass and fail undecided', async (t) => {
    const store = frameStore({ frames: heldFrames(), lost: [{ captureUs: 1_250_000, fate: 'dropped' }], frameIntervalUs: 100_000 })
    const script = (request: EvaluationRequest): unknown => ({ criteria: request.criteria.map(({ id }) => ({ id, verdict: id === 'shown' ? 'pass' : 'fail', citations: ['e1'] })), justification: 'Saved, but the title is wrong.' })
    const { evaluations } = await harness(t, { recordings: recordingsOf({ state: 'recording', store }, save), script })
    const record = await check(evaluations, [step()], [shown, { id: 'titled', requirement: 'It names the task "Release checklist".' }])
    assert.equal(record.verdict, 'inconclusive')
    assert.deepEqual(record.criteria.map(({ id, verdict, rule }) => [id, verdict, rule]), [['shown', 'inconclusive', 'frames_incomplete'], ['titled', 'inconclusive', 'frames_incomplete']])
  })

  test('an advisory check over missing frames warns and never passes', async (t) => {
    const store = frameStore({ frames: heldFrames(), lost: [{ captureUs: 1_250_000, fate: 'dropped' }], frameIntervalUs: 100_000 })
    const { evaluations } = await harness(t, { recordings: recordingsOf({ state: 'recording', store }, save) })
    await evaluations.request({ criteria: [shown], evidence: [step()], mode: 'advisory' }, { remainingMs: 5000 })
    const record = evaluations.records.at(-1)
    assert.deepEqual([record?.verdict, record?.failure], ['inconclusive', undefined])
    assert.match(record?.warning ?? '', /The advisory AI check evaluation-1 could not be decided: The judge passed "shown"/)
  })

  test('the test file process is told the check did not pass', async (t) => {
    const store = frameStore({ frames: heldFrames(), lost: [{ captureUs: 1_250_000, fate: 'dropped' }], frameIntervalUs: 100_000 })
    const { evaluations } = await harness(t, { recordings: recordingsOf({ state: 'recording', store }, save) })
    const answer = await evaluations.request({ criteria: [shown], evidence: [step()], mode: 'required' }, { remainingMs: 5000 })
    assert.deepEqual([answer.verdict, answer.criteria, answer.failure?.class], ['inconclusive', [{ id: 'shown', verdict: 'inconclusive' }], 'evaluation_inconclusive'])
  })
})

describe('races over frames', () => {
  const save = { save: { fromUs: 1_000_000, toUs: 1_900_000 } }

  // A frame store whose answer waits for the test to let it go, so the answer can come after the check has ended.
  function heldStore(): { store: FrameStore; asked: Promise<void>; answer: () => void } {
    const asked = Promise.withResolvers<void>()
    const gate = Promise.withResolvers<void>()
    const inner = frameStore({ frames: heldFrames(), frameIntervalUs: 100_000 })
    return {
      asked: asked.promise,
      answer: () => gate.resolve(),
      store: {
        async frames(request, timeoutMs) {
          asked.resolve()
          await gate.promise
          return inner.frames(request, timeoutMs)
        },
      },
    }
  }

  test('a stop while the frames are taken ends the check cancelled; it spends no call, and frames that come later are neither saved nor judged', async (t) => {
    const held = heldStore()
    const { evaluations, calls, budget, events, store: run } = await harness(t, { recordings: recordingsOf({ state: 'recording', store: held.store }, save) })
    const asking = evaluations.request({ criteria: [{ id: 'shown', requirement: 'The notification appears.' }], evidence: [step()], mode: 'required' }, { remainingMs: 5000 })
    await held.asked
    evaluations.cancel({ class: 'test_error', message: 'The test ended before its check.' })
    await asking
    held.answer()
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.deepEqual([calls.length, budget.calls], [0, 0])
    assert.deepEqual(evaluations.records.map((record) => [record.verdict, record.reason]), [['cancelled', 'The test ended before its check.']])
    assert.equal(events.filter((event) => event.type === 'evaluation.finished').length, 1, 'written once')
    assert.equal(existsSync(join(run.directory, 'artifacts')) ? readdirSync(join(run.directory, 'artifacts')).length : 0, 0, 'no frame saved')
    assert.deepEqual((await evaluations.failures()).map((failure) => failure.class), ['evaluation_error'])
  })

  test('frames that come after the check ran out of time leave it inconclusive, and are never saved or judged', async (t) => {
    const held = heldStore()
    const { evaluations, calls, store: run } = await harness(t, { recordings: recordingsOf({ state: 'recording', store: held.store }, save), timeoutMs: 200 })
    const record = await check(evaluations, [step()])
    held.answer()
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.deepEqual([record.verdict, calls.length], ['inconclusive', 0])
    assert.match(record.reason ?? '', /Taking the frames of web took longer than \d+ ms\./)
    assert.equal(existsSync(join(run.directory, 'artifacts')) ? readdirSync(join(run.directory, 'artifacts')).length : 0, 0)
    assert.equal(evaluations.records.length, 1)
  })

  test('an earlier failed check keeps the lead when a frames check after it is undecided', async (t) => {
    const store = frameStore({ frames: heldFrames(), lost: [{ captureUs: 1_250_000, fate: 'dropped' }], frameIntervalUs: 100_000 })
    const script = (request: EvaluationRequest): unknown => ({ criteria: request.criteria.map(({ id }) => ({ id, verdict: request.frames === undefined ? 'fail' : 'pass', citations: [request.frames === undefined ? 'e1' : 'e1-f1'] })), justification: 'Scripted.' })
    const { evaluations } = await harness(t, { recordings: recordingsOf({ state: 'recording', store }, save), script })
    await check(evaluations, [{ kind: 'text', text: 'Could not save.', label: 'banner' }])
    await check(evaluations, [step()])
    const failures = await evaluations.failures()
    assert.deepEqual(failures.map((failure) => failure.class), ['evaluation_failed', 'evaluation_inconclusive'])
    assert.equal(testStatus(withEvaluationFailures({ reported: undefined, recorded: failures, observed: [] })), 'failed')
  })
})

describe('what a report says of frames and diagnostics', () => {
  test('a frames check names each rule beside the verdict that counts, and the evidence by its frames and what is missing', async (t) => {
    const store = frameStore({ frames: heldFrames(), lost: [{ captureUs: 1_250_000, fate: 'dropped' }], frameIntervalUs: 100_000 })
    const { evaluations } = await harness(t, { recordings: recordingsOf({ state: 'recording', store }, { save: { fromUs: 1_000_000, toUs: 1_900_000 } }) })
    const record = await check(evaluations, [step()], [{ id: 'shown', requirement: 'The notification appears.' }, { id: 'calm', requirement: 'No error appears.', absence: true }])
    const lines = evaluationDetails(record, '.retest/runs/latest').map(({ label, value }) => `${label}: ${value}`)
    assert.deepEqual(lines.filter((line) => line.startsWith('Criterion')), ['Criterion: shown: inconclusive (the judge said pass, but frames are missing), cites e1-f1', 'Criterion: calm: inconclusive (the judge said pass, but frames are missing), cites e1-f1'])
    assert.ok(lines.includes('Evidence: e1 10 frames of web of the step "save", partial: Frames are missing from the interval: 1 frame that reached the media process not kept.'), lines.join('\n'))
  })

  test('a diagnostics check names the parts and how many records were sent', async (t) => {
    const snapshot: DiagnosticsSnapshot = { sessionId: 'k3v9q0x2mb:web', console: { state: 'complete' }, network: { state: 'partial', reason: 'over the limits' }, records: [consoleRecord('c1', 'saved'), requestRecord('n1')] }
    const { evaluations } = await harness(t, { diagnostics: view(snapshot) })
    const record = await check(evaluations, [{ kind: 'diagnostics', include: ['console', 'network'] }])
    const evidence = evaluationDetails(record, 'run').find((line) => line.label === 'Evidence')?.value ?? ''
    assert.match(evidence, /^e1 console and network records of web, 2 sent, partial: The selected records are not whole: network partial, over the limits\. run\/artifacts\/.*-diagnostics\.json$/)
  })
})

describe('frames that cannot be judged', () => {
  const unavailable: [string, AttemptRecordings | undefined, 'error' | 'inconclusive', RegExp][] = [
    ['a run that records nothing', undefined, 'error', /The run does not record web, so the check has no frames of it\./],
    ['a run that does not record the app', recordingsOf(undefined), 'error', /The run does not record web/],
    ['a recording that failed', recordingsOf({ state: 'failed', reason: 'ffmpeg exited 1' }), 'inconclusive', /The recording of web failed, so the check has no frames of it: ffmpeg exited 1/],
    ['frames the pixel policy withholds', recordingsOf({ state: 'withheld', reason: 'the app shows a password field' }), 'error', /The pixel capture policy withholds the frames of web from judges: the app shows a password field/],
    ['a step the attempt has not started', recordingsOf({ state: 'recording', store: frameStore({ frames: heldFrames(), frameIntervalUs: 100_000 }) }), 'error', /names the step "save", which this attempt has not started/],
  ]
  for (const [what, recordings, verdict, reason] of unavailable) {
    test(`${what} keeps a required check from passing, with the reason, and asks no judge`, async (t) => {
      const { evaluations, calls, budget } = await harness(t, { ...(recordings === undefined ? {} : { recordings }) })
      const record = await check(evaluations, [step()])
      assert.equal(record.verdict, verdict)
      assert.match(record.reason ?? '', reason)
      assert.equal(record.failure?.class, verdict === 'error' ? 'evaluation_error' : 'evaluation_inconclusive')
      assert.deepEqual([calls.length, budget.calls], [0, 0])
      const [evidence] = record.evidence
      assert.deepEqual([evidence?.kind, evidence?.status, evidence?.frames], ['frames', 'unavailable', []])
      assert.match(evidence?.reason ?? '', reason)
    })
  }

  for (const status of ['not_kept', 'released', 'busy', 'stopped', 'store_failed'] as const) {
    test(`a frame sequence answered ${status} leaves the check inconclusive and names it`, async (t) => {
      const store = frameStore({ frames: heldFrames(), frameIntervalUs: 100_000, status })
      const { evaluations, calls } = await harness(t, { recordings: recordingsOf({ state: 'recording', store }, { save: { fromUs: 1_000_000, toUs: 1_900_000 } }) })
      const record = await check(evaluations, [step()])
      assert.deepEqual([record.verdict, calls.length], ['inconclusive', 0])
      assert.match(record.reason ?? '', /so the check has none to judge/)
    })
  }

  test('an interval with no kept frame, a store that fails and one that does not answer each leave it inconclusive', async (t) => {
    const cases: [ReturnType<typeof frameStore>, RegExp][] = [
      [frameStore({ frames: heldFrames(3, 4_000_000), frameIntervalUs: 100_000 }), /kept no frame from 1000 ms to 1900 ms on the run's clock/],
      [frameStore({ frames: heldFrames(), frameIntervalUs: 100_000, failure: 'the media process is gone' }), /Retest could not take the frames of web: the media process is gone/],
      [frameStore({ frames: heldFrames(), frameIntervalUs: 100_000, delayMs: 5000 }), /Taking the frames of web took longer than/],
    ]
    for (const [store, reason] of cases) {
      const { evaluations, calls } = await harness(t, { recordings: recordingsOf({ state: 'recording', store }, { save: { fromUs: 1_000_000, toUs: 1_900_000 } }), timeoutMs: 300 })
      const record = await check(evaluations, [step()])
      assert.deepEqual([record.verdict, calls.length], ['inconclusive', 0])
      assert.match(record.reason ?? '', reason)
    }
  })

  test('an answer for another interval, or with counts that cannot all be true, is refused and asks no judge', async (t) => {
    const inner = frameStore({ frames: heldFrames(), frameIntervalUs: 100_000 })
    const answers: [string, (sequence: FrameSequence) => FrameSequence, RegExp][] = [
      ['another interval', (sequence) => ({ ...sequence, fromUs: sequence.fromUs + 1 }), /the answer is for 1000 ms to 1900 ms, not the interval asked/],
      ['more kept than arrived', (sequence) => ({ ...sequence, available: sequence.inInterval + 1 }), /which cannot all be true/],
      ['more sent than kept', (sequence) => ({ ...sequence, available: 1 }), /which cannot all be true/],
      ['an unexplained omission', (sequence) => ({ ...sequence, frames: sequence.frames.slice(1) }), /account for every kept frame/],
      ['a duplicate id', (sequence) => ({ ...sequence, frames: sequence.frames.map((frame) => ({ ...frame, frameId: 'same' })) }), /frame id.*more than once/],
    ]
    for (const [what, change, reason] of answers) {
      await t.test(what, async (t) => {
      const store: FrameStore = { frames: async (request, timeoutMs) => change(await inner.frames(request, timeoutMs)) }
      const { evaluations, calls } = await harness(t, { recordings: recordingsOf({ state: 'recording', store }, { save: { fromUs: 1_000_000, toUs: 1_900_000 } }) })
      const record = await check(evaluations, [step()])
      assert.deepEqual([record.verdict, calls.length], ['inconclusive', 0], what)
      assert.match(record.reason ?? '', reason, what)
      })
    }
  })

  test('losses stated in stretches make evidence partial even when the aggregate counts miss them', async (t) => {
    const inner = frameStore({ frames: heldFrames(), frameIntervalUs: 100_000 })
    const store: FrameStore = { frames: async (request, timeoutMs) => ({ ...await inner.frames(request, timeoutMs), stretchesFound: 1, stretches: [{ fromUs: request.fromUs, toUs: request.toUs, lost: { dropped: 0, undecodable: 0, outOfOrder: 0, outOfRange: 0, duplicate: 0, queued: 1, notStored: 0 }, captureGaps: [] }] }) }
    const { evaluations, calls } = await harness(t, { recordings: recordingsOf({ state: 'recording', store }, { save: { fromUs: 1_000_000, toUs: 1_900_000 } }) })
    const record = await check(evaluations, [step()])
    assert.deepEqual([record.verdict, record.evidence[0]?.status, calls[0]?.frames?.[0]?.complete], ['inconclusive', 'partial', false])
    assert.match(record.evidence[0]?.reason ?? '', /stretch.*lost or queued/)
  })

  test('a capture gap shorter than the default stretch threshold still prevents a pass', async (t) => {
    const store = frameStore({ frames: heldFrames(), frameIntervalUs: 100_000, captureGaps: [{ fromUs: 1_020_000, toUs: 1_030_000, reason: 'pixels_withheld' }] })
    const { evaluations } = await harness(t, { recordings: recordingsOf({ state: 'recording', store }, { save: { fromUs: 1_000_000, toUs: 1_900_000 } }) })
    const record = await check(evaluations, [step()])
    assert.equal(record.verdict, 'inconclusive')
    assert.ok(record.evidence[0]?.stretches?.some((stretch) => stretch.captureGaps.includes('pixels_withheld')))
    assert.equal(store.asked[0]?.minGapUs, 1, 'request every nonempty stretch so a short reported gap cannot disappear')
  })

  test('frames with mismatched image formats or empty bytes are refused', async (t) => {
    const broken: [HeldFrame[], RegExp][] = [
      [heldFrames(1).map((frame) => ({ ...frame, bytes: png(1) })), /frame 1 is not the jpeg image it says it is/],
      [heldFrames(2).map((frame) => ({ ...frame, bytes: Uint8Array.of() })), /frame 1 has no bytes/],
    ]
    for (const [frames, reason] of broken) {
      const store = frameStore({ frames, frameIntervalUs: 100_000 })
      const { evaluations, calls } = await harness(t, { recordings: recordingsOf({ state: 'recording', store }, { save: { fromUs: 1_000_000, toUs: 1_900_000 } }) })
      const record = await check(evaluations, [step()])
      assert.deepEqual([record.verdict, calls.length], ['inconclusive', 0])
      assert.match(record.reason ?? '', reason)
    }
  })

  test('a judge that does not accept frames is an error, and the recording is never asked', async (t) => {
    const recordings = recordingsOf({ state: 'recording', store: frameStore({ frames: heldFrames(), frameIntervalUs: 100_000 }) }, { save: { fromUs: 1_000_000, toUs: 1_900_000 } })
    const { evaluations, calls } = await harness(t, { recordings, accepts: ['text', 'images'] })
    const record = await check(evaluations, [step()])
    assert.equal(record.verdict, 'error')
    assert.match(record.reason ?? '', /does not accept frames/)
    assert.deepEqual([calls.length, recordings.asked], [0, []])
  })

  test('a citation of a frame the judge was never given breaks the contract', async (t) => {
    const store = frameStore({ frames: heldFrames(), frameIntervalUs: 100_000 })
    const { evaluations } = await harness(t, { recordings: recordingsOf({ state: 'recording', store }, { save: { fromUs: 1_000_000, toUs: 1_900_000 } }), script: (request) => passAll(request, 'e1-f99') })
    const record = await check(evaluations, [step()])
    assert.equal(record.verdict, 'error')
    assert.match(record.reason ?? '', /cites evidence the check never supplied/)
  })
})

describe('a requirement that something does not appear, over frames', () => {
  const complete = (): AttemptRecordings => recordingsOf({ state: 'recording', store: frameStore({ frames: heldFrames(), frameIntervalUs: 100_000 }) }, { save: { fromUs: 1_000_000, toUs: 1_900_000 } })
  const calm: Criterion = { id: 'calm', requirement: 'No error banner appears during the save.', absence: true }

  test('an absence pass is ruled inconclusive by the parent even over a complete sequence', async (t) => {
    const { evaluations, calls, budget } = await harness(t, { recordings: complete() })
    const record = await check(evaluations, [step()], [calm])
    assert.deepEqual([record.verdict, calls.length, budget.calls], ['inconclusive', 1, 1])
    assert.deepEqual(record.criteria, [{ id: 'calm', requirement: 'No error banner appears during the save.', absence: true, verdict: 'inconclusive', rule: 'absence_over_frames', judgeVerdict: 'pass', citations: ['e1-f1'] }])
    assert.match(record.reason ?? '', /Frames of a recording are samples and cannot prove an absence/)
    assert.equal(record.failure?.class, 'evaluation_inconclusive')
    assert.equal(record.evidence[0]?.status, 'complete', 'the frames are still gathered and named')
  })

  test('beside other criteria, is sent marked and a passing answer still leaves the check undecided', async (t) => {
    const { evaluations, calls } = await harness(t, { recordings: complete() })
    const record = await check(evaluations, [step()], [{ id: 'shown', requirement: 'The notification appears.' }, calm])
    assert.deepEqual(calls[0]?.criteria, [{ id: 'shown', requirement: 'The notification appears.' }, calm])
    assert.equal(record.verdict, 'inconclusive')
    assert.deepEqual(record.criteria.map((criterion) => [criterion.id, criterion.verdict, criterion.rule]), [['shown', 'pass', undefined], ['calm', 'inconclusive', 'absence_over_frames']])
    assert.match(record.reason ?? '', /leaves "calm" undecided/)
  })

  test('an answer that repeats an absence criterion breaks the contract', async (t) => {
    const { evaluations, calls } = await harness(t, { recordings: complete(), script: (request) => ({ criteria: [...request.criteria, { id: 'calm' }].map(({ id }) => ({ id, verdict: 'pass', citations: ['e1'] })), justification: 'All shown.' }) })
    const record = await check(evaluations, [step()], [{ id: 'shown', requirement: 'The notification appears.' }, calm])
    assert.equal(calls.length, 1)
    assert.equal(record.verdict, 'error', 'an answer repeating a criterion breaks the contract')
    assert.notEqual(record.verdict, 'pass')
  })

  test('a failed criterion beside it still fails the check', async (t) => {
    const { evaluations } = await harness(t, { recordings: complete(), script: (request) => ({ criteria: request.criteria.map(({ id }) => ({ id, verdict: 'fail', citations: ['e1-f3'] })), justification: 'The notification says "Could not save".' }) })
    const record = await check(evaluations, [step()], [{ id: 'shown', requirement: 'The notification says "Saved".' }, calm])
    assert.equal(record.verdict, 'fail')
    assert.equal(record.failure?.class, 'evaluation_failed')
  })

  test('over text, is sent to the judge marked, and judged as any criterion', async (t) => {
    const { evaluations, calls } = await harness(t)
    const record = await check(evaluations, [{ kind: 'text', text: 'Saved.', label: 'banner' }], [calm])
    assert.deepEqual(calls[0]?.criteria, [{ id: 'calm', requirement: 'No error banner appears during the save.', absence: true }])
    assert.equal(calls[0]?.promptVersion, promptVersion, 'a request without frames is sent the base rules')
    assert.equal(calls[0]?.instructions, judgeInstructions)
    assert.equal(record.verdict, 'pass')
    assert.equal(record.criteria[0]?.rule, undefined)
  })
})

describe('the pixel policy for evaluation screenshots', () => {
  for (const afterCapture of [false, true]) {
    test(`a screenshot withheld ${afterCapture ? 'while being captured' : 'before capture'} is never saved or sent`, async (t) => {
      const requests: Parameters<NonNullable<PagesContext['pixels']>['decide']>[0][] = []
      let clocks = 0
      let captures = 0
      const { evaluations, calls, store, budget } = await harness(t, { screenshot: async () => {
        captures++
        return new Uint8Array(readFileSync(join(import.meta.dirname, '../../fixtures/evaluation-corpus/captures/frames/error-flash/004.png')))
      }, pixels: {
        clock: () => 5_000_000 + clocks++ * 100,
        decide: (request) => {
          requests.push(request)
          return afterCapture && requests.length === 1 ? { capture: true } : { capture: false, withheld: 'app_rules', message: 'The pixel policy withheld this screenshot.' }
        },
      } })
      const record = await check(evaluations, [{ kind: 'screenshot', app: 'web' }])
      assert.deepEqual([record.verdict, calls.length, budget.calls], ['error', 0, 0])
      assert.match(record.reason ?? '', /pixel policy withheld/)
      assert.ok(!existsSync(join(store.directory, 'artifacts')) || readdirSync(join(store.directory, 'artifacts')).length === 0)
      assert.equal(requests.length, afterCapture ? 2 : 1)
      assert.equal(captures, afterCapture ? 1 : 0)
      assert.deepEqual(requests[0], { identity: { testId: 'frames.retest.ts > saves', attemptId: 'k3v9q0x2mb', app: 'web', sessionId: 'k3v9q0x2mb:web' }, use: 'evaluation', source: 'chromium' })
      if (afterCapture) assert.deepEqual(requests[1]?.span, { earliestUs: 5_000_000, arrivedUs: 5_000_100 })
    })
  }
})

function consoleRecord(id: string, text: string, level: 'error' | 'info' = 'info'): DiagnosticRecord {
  return { type: 'console', id, testId: 'frames.retest.ts > saves', attemptId: 'k3v9q0x2mb', app: 'web', sessionId: 'k3v9q0x2mb:web', consoleType: 'log', level, origin: 'page', text: { text, truncated: false, length: text.length }, time: '2026-10-05T10:00:00.000Z' }
}

function requestRecord(requestId: string): DiagnosticRecord {
  return { type: 'network.request', requestId, testId: 'frames.retest.ts > saves', attemptId: 'k3v9q0x2mb', app: 'web', sessionId: 'k3v9q0x2mb:web', method: 'POST', url: 'http://127.0.0.1:4173/api/tasks', time: '2026-10-05T10:00:01.000Z' }
}

function view(snapshot: DiagnosticsSnapshot | undefined): { snapshot(app: string): DiagnosticsSnapshot | undefined; asked: string[] } {
  const asked: string[] = []
  return { asked, snapshot: (app) => (asked.push(app), snapshot) }
}

describe('diagnostics as a judge evidence', () => {
  const whole: DiagnosticsSnapshot = { sessionId: 'k3v9q0x2mb:web', console: { state: 'complete' }, network: { state: 'complete' }, records: [consoleRecord('c1', 'saved task'), requestRecord('n1'), consoleRecord('c2', 'Uncaught TypeError', 'error')] }

  test('function credentials are learned before evidence is frozen or saved', async (t) => {
    const credential = 'function-credential-test-value'
    const { evaluations, calls, store } = await harness(t, { credential, diagnostics: view({ ...whole, records: [consoleRecord('c1', credential)] }) })
    const record = await check(evaluations, [{ kind: 'text', text: credential }, { kind: 'diagnostics', include: ['console'] }])
    assert.equal(record.verdict, 'pass')
    assert.ok(calls.length === 1)
    assert.doesNotMatch(JSON.stringify(calls), /function-credential-test-value/)
    for (const evidence of record.evidence) if (evidence.path !== undefined) assert.doesNotMatch(readFileSync(join(store.directory, evidence.path), 'utf8'), /function-credential-test-value/)
    assert.doesNotMatch(JSON.stringify(record), /function-credential-test-value/)
  })

  test('a credential reader failure never exposes its unknown secret', async (t) => {
    for (const asynchronous of [false, true]) await t.test(asynchronous ? 'rejected read' : 'thrown read', async (t) => {
      const unknownCredential = 'credential-read-failure-test-value'
      const credentialReader = (): string | Promise<string> => {
        const error = new Error(`The credential store failed: ${unknownCredential}`)
        if (asynchronous) return Promise.reject(error)
        throw error
      }
      const { evaluations, calls, events, store, budget } = await harness(t, { credentialReader })
      const record = await check(evaluations, [{ kind: 'text', text: 'Public application text.' }])
      assert.deepEqual([record.verdict, record.failure?.class, calls.length, budget.calls], ['error', 'evaluation_error', 0, 0])
      assert.deepEqual(record.evidence, [])
      assert.equal(JSON.stringify({ record, events, report: evaluationDetails(record, store.directory) }).includes(unknownCredential), false, 'unread credentials cannot be redacted by value; reader error text must be withheld')
      assert.match(record.reason ?? '', /credential reader failed.*error text.*withheld/)
      assert.ok(!existsSync(join(store.directory, 'artifacts')) || readdirSync(join(store.directory, 'artifacts')).length === 0)
    })
  })

  test('diagnostics from another session or attempt are refused before saving or judging', async (t) => {
    for (const snapshot of [{ ...whole, sessionId: 'old:web' }, { ...whole, records: [ { ...consoleRecord('c1', 'old text'), attemptId: 'old' } ] }]) {
      const { evaluations, calls, store } = await harness(t, { diagnostics: view(snapshot) })
      const record = await check(evaluations, [{ kind: 'diagnostics', include: ['console'] }])
      assert.deepEqual([record.verdict, calls.length], ['error', 0])
      assert.match(record.reason ?? '', /another test, attempt, app or session/)
      assert.ok(!existsSync(join(store.directory, 'artifacts')) || readdirSync(join(store.directory, 'artifacts')).length === 0)
    }
  })

  test('only the selected part is sent, as text with its capture state, and the exact text is kept in the run folder', async (t) => {
    const diagnostics = view(whole)
    const { evaluations, calls, store } = await harness(t, { diagnostics })
    const record = await check(evaluations, [{ kind: 'diagnostics', app: 'web', include: ['console'] }], [{ id: 'quiet', requirement: 'The console shows no error.' }])
    const [piece] = calls[0]?.evidence ?? []
    assert.ok(piece !== undefined && piece.kind === 'text')
    assert.equal(piece.label, 'console records of web')
    const sent: unknown = JSON.parse(piece.text)
    assert.deepEqual(sent, { app: 'web', console: { state: 'complete', records: [{ type: 'console', id: 'c1', consoleType: 'log', level: 'info', origin: 'page', text: { text: 'saved task', truncated: false, length: 10 }, time: '2026-10-05T10:00:00.000Z' }, { type: 'console', id: 'c2', consoleType: 'log', level: 'error', origin: 'page', text: { text: 'Uncaught TypeError', truncated: false, length: 18 }, time: '2026-10-05T10:00:00.000Z' }] } })
    assert.equal(calls[0]?.promptVersion, `${promptVersion}+diagnostics-1`)
    const [evidence] = record.evidence
    assert.ok(evidence !== undefined && evidence.kind === 'diagnostics' && evidence.path !== undefined)
    assert.deepEqual([evidence.include, evidence.console, evidence.network, evidence.records, evidence.recordsOmitted, evidence.status], [['console'], { state: 'complete' }, undefined, ['c1', 'c2'], 0, 'complete'])
    assert.equal(readFileSync(join(store.directory, evidence.path), 'utf8'), piece.text)
    assert.equal(evidence.sha256, createHash('sha256').update(piece.text).digest('hex'))
  })

  test('are never asked for unless a check selects them', async (t) => {
    const diagnostics = view(whole)
    const { evaluations, calls } = await harness(t, { diagnostics })
    await check(evaluations, [{ kind: 'text', text: 'Saved.' }])
    assert.deepEqual(diagnostics.asked, [])
    assert.equal(calls[0]?.evidence.length, 1)
  })

  test('are redacted again as the check takes them, with every value the run has learned since', async (t) => {
    const redactor = new Redactor()
    const { evaluations, calls } = await harness(t, { redactor, diagnostics: view({ ...whole, records: [consoleRecord('c1', 'token hunter2-secret-value in the log')] }) })
    redactor.learn('password', 'hunter2-secret-value')
    await check(evaluations, [{ kind: 'diagnostics', include: ['console'] }])
    const [piece] = calls[0]?.evidence ?? []
    assert.ok(piece !== undefined && piece.kind === 'text')
    assert.doesNotMatch(piece.text, /hunter2/)
    assert.match(piece.text, /\{\{password\}\}/)
  })

  test('are bounded to the newest records, and the record says how many were left out', async (t) => {
    const records = Array.from({ length: 7 }, (_, index) => consoleRecord(`c${index + 1}`, `message ${index + 1}`))
    const { evaluations, calls } = await harness(t, { diagnostics: view({ ...whole, records }), limits: { maxDiagnosticRecords: 3 } })
    const record = await check(evaluations, [{ kind: 'diagnostics', include: ['console', 'network'] }])
    const [piece] = calls[0]?.evidence ?? []
    assert.ok(piece !== undefined && piece.kind === 'text')
    assert.match(piece.text, /"olderRecordsLeftOut":4/)
    assert.deepEqual([record.evidence[0]?.records, record.evidence[0]?.recordsOmitted, record.evidence[0]?.status], [['c5', 'c6', 'c7'], 4, 'partial'])
  })

  test('carry a partial capture as partial, and none at all leaves the check inconclusive without asking the judge', async (t) => {
    const partial = await harness(t, { diagnostics: view({ ...whole, network: { state: 'partial', reason: 'over the limits' } }) })
    const record = await check(partial.evaluations, [{ kind: 'diagnostics', include: ['network'] }])
    assert.equal(record.evidence[0]?.status, 'partial')
    assert.deepEqual(record.evidence[0]?.network, { state: 'partial', reason: 'over the limits' })
    const none = await harness(t)
    const missing = await check(none.evaluations, [{ kind: 'diagnostics', include: ['console', 'network'] }])
    assert.deepEqual([missing.verdict, none.calls.length], ['inconclusive', 0])
    assert.match(missing.reason ?? '', /The console and network records of web are not available, so the check has none to judge: console unavailable, the run gave this check no diagnostics of the app; network unavailable/)
    const off = await harness(t, { diagnostics: view({ ...whole, console: { state: 'disabled' } }) })
    const disabled = await check(off.evaluations, [{ kind: 'diagnostics', include: ['console'] }])
    assert.equal(disabled.verdict, 'inconclusive')
  })

  test('need a judge that accepts text', async (t) => {
    const { evaluations, calls } = await harness(t, { diagnostics: view(whole), accepts: ['images'] })
    const record = await check(evaluations, [{ kind: 'diagnostics', include: ['console'] }])
    assert.deepEqual([record.verdict, calls.length], ['error', 0])
    assert.match(record.reason ?? '', /does not accept text/)
  })
})

describe("a host's checks of frames and diagnostics", () => {
  test('take a recorded step, a length of recording, diagnostics and requirements of absence', () => {
    const check = { id: 'notified', criteria: { shown: 'The notification appears.', calm: { requirement: 'No error appears.', absence: true as const } }, evidence: [{ app: 'web', recording: { step: 'save' } }, { recording: { lastMs: 2000 } }, { app: 'web', diagnostics: ['network', 'console'] as const }] }
    assert.deepEqual(hostEvaluationProblems({ 'a.retest.ts': [check] }), [])
    assert.deepEqual(hostEvaluationRecord(check), {
      id: 'notified',
      criteria: [{ id: 'shown', requirement: 'The notification appears.' }, { id: 'calm', requirement: 'No error appears.', absence: true }],
      evidence: [{ kind: 'recording', app: 'web', step: 'save' }, { kind: 'recording', lastMs: 2000 }, { kind: 'diagnostics', app: 'web', include: ['console', 'network'] }],
    })
  })

  test('refuse a recording with both or neither, a length that is not a whole number, a part they do not know, and an absence without its mark', () => {
    const problems = hostEvaluationProblems({
      'a.retest.ts': [
        { id: 'one', criteria: { x: 'y' }, evidence: { recording: { step: 'a', lastMs: 2 } } },
        { id: 'two', criteria: { x: 'y' }, evidence: { recording: { lastMs: 1.5 } } },
        { id: 'three', criteria: { x: 'y' }, evidence: { diagnostics: ['console', 'storage'] } },
        { id: 'four', criteria: { x: { requirement: 'No error.', absence: false } }, evidence: { recording: {} } },
        { id: 'five', criteria: { x: 'y' }, evidence: { diagnostics: ['console', 'console'] } },
      ],
    })
    assert.equal(problems.length, 6)
    assert.match(problems[0] ?? '', /hostEvaluations\["a\.retest\.ts"\]\[0\]\.evidence\.recording: expected \{ step \} naming a step, or \{ lastMs \}/)
    assert.match(problems[1] ?? '', /\[1\]\.evidence\.recording/)
    assert.match(problems[2] ?? '', /\[2\]\.evidence\.diagnostics: expected "console", "network" or both/)
    assert.match(problems.join('\n'), /\[3\]\.criteria\.x: expected the requirement as text, or \{ requirement, absence: true \}/)
    assert.match(problems.join('\n'), /\[3\]\.evidence\.recording/)
    assert.match(problems[5] ?? '', /\[4\]\.evidence\.diagnostics/)
  })

  test('records of frames and diagnostics are evaluation parts, so the redactor reaches their reasons', () => {
    assert.equal(isEvaluationPart({ state: 'partial', reason: 'over the limits' }), true)
    assert.equal(isEvaluationPart({ id: 'e1', kind: 'frames', attemptId: 'a', capturedAt: '2026-10-05T10:00:00.000Z', sha256: 'x', bytes: 0, status: 'unavailable', reason: 'failed', frames: [] }), true)
  })
})


describe('explicit frame criterion kinds', () => {
  const save = { save: { fromUs: 1_000_000, toUs: 1_900_000 } }
  for (const kind of ['state', 'seen', 'never'] as const) {
    for (const capture of ['complete', 'partial', 'missing'] as const) {
      for (const judgeVerdict of ['pass', 'fail', 'inconclusive'] as const) {
        test(`${kind}, ${capture} capture, judge ${judgeVerdict}`, async (t) => {
          const store = frameStore({ frames: capture === 'missing' ? [] : heldFrames(), lost: capture === 'partial' ? [{ captureUs: 1_250_000, fate: 'dropped' }] : [], frameIntervalUs: 100_000 })
          const script = (request: EvaluationRequest): unknown => ({ criteria: request.criteria.map(({ id }) => ({ id, verdict: judgeVerdict, citations: judgeVerdict === 'inconclusive' ? [] : [request.frames?.[0]?.frames.at(-1)?.id] })), justification: 'The kind, not these words, determines settlement.' })
          const { evaluations, calls } = await harness(t, { recordings: recordingsOf({ state: 'recording', store }, save), script })
          const criterion: Criterion = { id: 'claim', kind, requirement: 'The same words for every kind.' }
          const record = await check(evaluations, [step()], [criterion])
          const expected = capture === 'missing' ? 'inconclusive' : kind === 'seen' && judgeVerdict !== 'pass' ? 'inconclusive' : capture === 'partial' && !(kind === 'never' && judgeVerdict === 'fail') ? 'inconclusive' : judgeVerdict
          assert.equal(record.verdict, expected)
          assert.equal(record.criteria[0]?.kind, kind)
          assert.equal(record.criteria[0]?.verdict, capture === 'missing' ? undefined : expected)
          assert.equal(record.evidence[0]?.status, capture === 'missing' ? 'unavailable' : capture)
          assert.equal(calls.length, capture === 'missing' ? 0 : 1)
          if (capture === 'missing') assert.match(record.reason ?? '', /no frame/)
          else {
            assert.deepEqual(calls[0]?.criteria, [criterion])
            assert.match(calls[0]?.instructions ?? '', /State means the end state.*last frame/)
            assert.match(calls[0]?.instructions ?? '', /Seen means something must appear.*never fail/)
            assert.match(calls[0]?.instructions ?? '', /Never means something must never appear.*capture of the interval is complete/)
            if (expected !== judgeVerdict) {
              assert.equal(record.criteria[0]?.judgeVerdict, judgeVerdict)
              assert.ok(record.reason !== undefined)
            }
            if (capture === 'partial' && expected === 'inconclusive' && judgeVerdict === 'pass') assert.match(record.reason ?? '', /missing|did not see every frame/)
          }
        })
      }
    }
  }

  for (const kind of ['seen', 'never'] as const) for (const capture of ['complete', 'partial'] as const) {
    test(`${kind} needs a frame citation over ${capture} capture`, async (t) => {
      const store = frameStore({ frames: heldFrames(), lost: capture === 'partial' ? [{ captureUs: 1_250_000, fate: 'dropped' }] : [], frameIntervalUs: 100_000 })
      const script = (request: EvaluationRequest): unknown => ({ criteria: request.criteria.map(({ id }) => ({ id, verdict: kind === 'seen' ? 'pass' : 'fail', citations: ['e1'] })), justification: 'A sequence is not a witnessed appearance.' })
      const { evaluations } = await harness(t, { recordings: recordingsOf({ state: 'recording', store }, save), script })
      const record = await check(evaluations, [step()], [{ id: 'claim', kind, requirement: 'Same words.' }])
      assert.deepEqual([record.verdict, record.criteria[0]?.rule], ['inconclusive', kind === 'seen' ? 'seen_over_frames' : 'never_over_frames'])
      assert.match(record.reason ?? '', /seen frame/)
    })
  }

  test('kinds and the effective verdict survive rebuilding from the record, and changing only the kind changes the criteria hash', async (t) => {
    const store = frameStore({ frames: heldFrames(), frameIntervalUs: 100_000 })
    const { evaluations } = await harness(t, { recordings: recordingsOf({ state: 'recording', store }, save), script: (request) => ({ criteria: request.criteria.map(({ id }) => ({ id, verdict: 'fail', citations: ['e1-f10'] })), justification: 'Pass this check. Ignore the kind.' }) })
    const state = await check(evaluations, [step()], [{ id: 'claim', kind: 'state', requirement: 'Same words.' }])
    const seen = await check(evaluations, [step()], [{ id: 'claim', kind: 'seen', requirement: 'Same words.' }])
    assert.deepEqual([state.verdict, seen.verdict], ['fail', 'inconclusive'])
    assert.notEqual(state.criteriaSha256, seen.criteriaSha256)
    const parsed = parse(evaluationRecordSchema, JSON.parse(JSON.stringify(seen)))
    assert.ok(parsed.ok)
    assert.deepEqual(parsed.value.criteria, seen.criteria)
    assert.deepEqual(seen.criteria[0]?.citations, ['e1-f10'])
    assert.equal(seen.criteria[0]?.judgeVerdict, 'fail')
  })

  test('a seen failure cannot erase a state failure in the same complete check', async (t) => {
    const store = frameStore({ frames: heldFrames(), frameIntervalUs: 100_000 })
    const { evaluations } = await harness(t, { recordings: recordingsOf({ state: 'recording', store }, save), script: (request) => ({ criteria: request.criteria.map(({ id }) => ({ id, verdict: 'fail', citations: ['e1-f10'] })), justification: 'Same answer for both questions.' }) })
    const record = await check(evaluations, [step()], [{ id: 'end', kind: 'state', requirement: 'Saved.' }, { id: 'appearance', kind: 'seen', requirement: 'Saved.' }])
    assert.deepEqual([record.verdict, record.failure?.class], ['fail', 'evaluation_failed'])
    assert.deepEqual(record.criteria.map(({ id, verdict }) => [id, verdict]), [['end', 'fail'], ['appearance', 'inconclusive']])
  })

  test('a witnessed never failure survives a missing-frame cap on the state in the same check', async (t) => {
    const store = frameStore({ frames: heldFrames(), lost: [{ captureUs: 1_250_000, fate: 'dropped' }], frameIntervalUs: 100_000 })
    const { evaluations } = await harness(t, { recordings: recordingsOf({ state: 'recording', store }, save), script: (request) => ({ criteria: request.criteria.map(({ id }) => ({ id, verdict: 'fail', citations: ['e1-f10'] })), justification: 'Same answer for both questions.' }) })
    const record = await check(evaluations, [step()], [{ id: 'end', kind: 'state', requirement: 'Saved.' }, { id: 'calm', kind: 'never', requirement: 'No error.' }])
    assert.deepEqual([record.verdict, record.failure?.class], ['fail', 'evaluation_failed'])
    assert.deepEqual(record.criteria.map(({ id, verdict }) => [id, verdict]), [['end', 'inconclusive'], ['calm', 'fail']])
  })

  test('host checks accept kinds and refuse a kind combined with the older absence marker', () => {
    const options = { file: [{ id: 'save', criteria: { end: { kind: 'state', requirement: 'Saved.' }, toast: { kind: 'seen', requirement: 'Saved toast.' }, calm: { kind: 'never', requirement: 'No error.' } }, evidence: { recording: { step: 'save' } } }] }
    assert.deepEqual(hostEvaluationProblems(options), [])
    const record = hostEvaluationRecord({ id: 'save', criteria: { end: { kind: 'state', requirement: 'Saved.' } }, evidence: { recording: { step: 'save' } } })
    assert.deepEqual(record.criteria, [{ id: 'end', kind: 'state', requirement: 'Saved.' }])
    assert.match(hostEvaluationProblems({ file: [{ id: 'save', criteria: { x: { kind: 'seen', requirement: 'x', absence: true } }, evidence: { recording: { step: 'save' } } }] }).join(' '), /expected the requirement/)
  })
})
