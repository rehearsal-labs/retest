import type { SourceRecording } from '../../src/media/capture.ts'
import type { Ended, Started } from '../../src/media/protocol.ts'
import type { RecordingRecord } from '../../src/protocol/recording.ts'
import type { FileResult, TestResult } from '../../src/protocol/result.ts'
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { parse } from '../../src/protocol/schema.ts'
import { recordingRecordSchema } from '../../src/protocol/recording.ts'
import { attemptEvidence, endedRecording, evidenceFailure, runEvidence, unstartedRecording } from '../../src/runner/evidence-status.ts'
import { runOutcome } from '../../src/runner/outcome.ts'

const identity = { testId: 'a.retest.ts > saves', attemptId: 'k3v9q0x2mb', app: 'web', sessionId: 'k3v9q0x2mb:web' }
const place = { identity, sequence: 1, recordingId: 'k3v9q0x2mb-1-1' }
const recordingIdentity = { runId: 'run-1', ...identity }

const started: Started = {
  type: 'started', recordingId: place.recordingId, identity: recordingIdentity, codec: 'h264', container: 'mp4', encoder: 'libx264', encoderVersion: '9.0.2',
  encoderPid: 4242, path: '/runs/r/artifacts/k3v9q0x2mb/web-1/recording-1.mp4', route: 'decoded', width: 1280, height: 720, fps: 10,
  queueFrames: 60, queueBytes: 67108864, maxGapMs: 1800000, maxDurationMs: 1800000, stallMs: 10000,
}

function ended(overrides: Partial<Ended> = {}): Ended {
  return {
    type: 'ended', recordingId: place.recordingId, identity: recordingIdentity, status: 'ok', message: 'Wrote the video.', path: started.path,
    frames: { received: 30, shown: 26, superseded: 4, dropped: 0, outOfOrder: 0, outOfRange: 0, undecodable: 0, duplicate: 0, unprocessed: 0, resized: 30 },
    firstTimestampUs: 80_239, framesBeforeFirst: 0, gaps: [], gapsShortened: 0, endClipped: false, outputFrames: 30, durationUs: 3_000_000, bytesReceived: 1000,
    bytesToEncoder: 1000, queue: { peakFrames: 2, peakBytes: 2000, saturated: 0 }, captureGaps: [], captureGapsReported: 0, evidence: { status: 'complete', reasons: [] },
    frameMapEntries: 30, frameMapOmitted: 0, frameMap: [], ...overrides,
  }
}

function report(overrides: Partial<SourceRecording> = {}): SourceRecording {
  return {
    source: 'chromium', identity, status: 'ended', stoppedBy: 'signal', started, ended: ended(),
    capture: { mode: 'screencast', requestedFps: 10, delivered: 51, superseded: 21, dropped: 0, problems: [] },
    frames: { delivered: 30, sent: 30, dropped: 0, notSent: 0, withheld: 0, refused: { identity: 0, timestamp: 0, clock: 0, outOfOrder: 0, outOfRange: 0, tooLarge: 0, empty: 0 } },
    gaps: { reported: 0, sent: 0, notSent: 0, refused: 0, withheldStretches: 0, withheldUs: 0 }, problems: [], ...overrides,
  }
}

function withoutEnding(value: SourceRecording): SourceRecording { const { ended: _ended, ...rest } = value; return rest }
function withoutStart(value: SourceRecording): SourceRecording { const { started: _started, ...rest } = withoutEnding(value); return rest }
function withoutCapture(value: SourceRecording): SourceRecording { const { capture: _capture, ...rest } = value; return rest }
function withoutPath(value: Ended): Ended { const { path: _path, ...rest } = value; return rest }

const facts = { path: 'artifacts/k3v9q0x2mb/web-1/recording-1.mp4', withheldBeforeSending: 0, mediaLost: false }

function valid(record: RecordingRecord): RecordingRecord {
  const parsed = parse(recordingRecordSchema, record)
  assert.ok(parsed.ok, parsed.ok ? '' : JSON.stringify(parsed.issues))
  return record
}

describe('a recording as it ended', () => {
  test('a whole video is complete, with its identity, its video, its frames and the clock that lays events over it', () => {
    const record = valid(endedRecording(place, report(), facts))
    assert.equal(record.status, 'complete')
    assert.deepEqual(record.gaps, [])
    assert.deepEqual({ testId: record.testId, attemptId: record.attemptId, app: record.app, sessionId: record.sessionId, sequence: record.sequence }, { ...identity, sequence: 1 })
    assert.equal(record.path, facts.path)
    assert.deepEqual(record.video, { codec: 'h264', container: 'mp4', width: 1280, height: 720, fps: 10, outputFrames: 30, durationUs: 3_000_000 })
    assert.deepEqual(record.clock, { capture: 'run_us', videoZeroUs: 80_239, durationUs: 3_000_000, shortened: [], shortenedCount: 0 })
    assert.equal(record.stoppedBy, 'attempt_ended')
    assert.equal(record.mode, 'screencast')
  })

  test('superseded frames are no loss, and frames the policy withheld make the video partial, never dropped', () => {
    const withheld = report({ frames: { ...report().frames, delivered: 40, withheld: 10 }, gaps: { reported: 1, sent: 1, notSent: 0, refused: 0, withheldStretches: 1, withheldUs: 900_000 }, ended: ended({ evidence: { status: 'partial', reasons: ['capture_gaps'] }, captureGapsReported: 1 }) })
    const record = valid(endedRecording(place, withheld, { ...facts, withheldBeforeSending: 3 }))
    assert.equal(record.status, 'partial')
    assert.deepEqual(record.gaps.map((gap) => gap.code), ['pixels_withheld'])
    assert.deepEqual(record.frames, { delivered: 43, sent: 30, dropped: 0, notSent: 0, withheld: 13, refused: 0 })
    assert.deepEqual(record.withheld, { stretches: 1, durationUs: 900_000 })
    assert.equal(record.media?.dropped, 0)
  })

  test('a capture that ended before the attempt did leaves a partial video that says why', () => {
    const lost = report({ stoppedBy: 'source', capture: { ...report().capture!, endedEarly: "The page's session ended: the target detached." } })
    const record = valid(endedRecording(place, lost, facts))
    assert.equal(record.status, 'partial')
    assert.deepEqual(record.gaps.map((gap) => gap.code), ['capture_ended_early'])
    assert.match(record.gaps[0]?.message ?? '', /target detached/)
  })

  test("the media process's own reasons and frames lost on the way are each named", () => {
    const lossy = report({ frames: { ...report().frames, dropped: 2, notSent: 1, refused: { ...report().frames.refused, clock: 1 } }, ended: ended({ evidence: { status: 'partial', reasons: ['frames_dropped', 'gaps_shortened'] }, gapsShortened: 1 }) })
    const record = valid(endedRecording(place, lossy, facts))
    assert.equal(record.status, 'partial')
    assert.deepEqual(record.gaps.map((gap) => gap.code), ['frames_dropped', 'gaps_shortened', 'frames_not_sent', 'frames_refused'])
  })

  test('a recording lost with its media process is unavailable, names the loss and a kept partial file, and claims no video', () => {
    const lost = withoutEnding(report({ status: 'lost', reason: 'the media process ended with signal SIGKILL' }))
    const record = valid(endedRecording(place, lost, { ...facts, path: undefined, partialPath: 'artifacts/k3v9q0x2mb/web-1/recording-1.mp4.partial', mediaLost: true }))
    assert.equal(record.status, 'unavailable')
    assert.equal(record.path, undefined)
    assert.equal(record.partialPath, 'artifacts/k3v9q0x2mb/web-1/recording-1.mp4.partial')
    assert.deepEqual(record.gaps.map((gap) => gap.code), ['media_process_lost'])
    assert.match(record.gaps[0]?.message ?? '', /whether it plays was not checked/)
  })

  test('a recording whose ending never came, with the process still there, is lost by its own name', () => {
    const record = valid(endedRecording(place, withoutEnding(report({ status: 'lost', reason: 'no ending within 15000 ms' })), { ...facts, path: undefined }))
    assert.deepEqual(record.gaps.map((gap) => gap.code), ['recording_lost'])
  })

  test("an ending without a video takes the media process's reasons", () => {
    const record = valid(endedRecording(place, report({ ended: withoutPath(ended({ status: 'deadline_exceeded', evidence: { status: 'unavailable', reasons: ['deadline_exceeded'] } })) }), { ...facts, path: undefined }))
    assert.equal(record.status, 'unavailable')
    assert.deepEqual(record.gaps.map((gap) => gap.code), ['deadline_exceeded'])
  })

  test('a source that could not capture, and a target with no frame source, are unavailable by name', () => {
    assert.deepEqual(valid(endedRecording(place, withoutStart(report({ status: 'unavailable', reason: 'The page is gone.' })), facts)).gaps.map((gap) => gap.code), ['capture_unavailable'])
    const none = valid(unstartedRecording(place, 'no_frame_source', 'Retest has no frame source for WebKit pages yet, so this session was not recorded.'))
    assert.equal(none.status, 'unavailable')
    assert.deepEqual(none.gaps, [{ code: 'no_frame_source', message: 'Retest has no frame source for WebKit pages yet, so this session was not recorded.', app: 'web', sessionId: identity.sessionId }])
  })
})

describe("an attempt's evidence and the run's", () => {
  const complete = endedRecording(place, report(), facts)
  const partial = endedRecording(place, report({ stoppedBy: 'source' }), facts)
  const missing = unstartedRecording(place, 'media_unavailable', 'No media binary is named.')

  test('an attempt is complete, partial, unavailable or not requested from its recordings', () => {
    assert.deepEqual(attemptEvidence([complete], []), { state: 'complete' })
    assert.equal(attemptEvidence([complete, missing], []).state, 'partial')
    assert.equal(attemptEvidence([missing], []).state, 'unavailable')
    assert.deepEqual(attemptEvidence([], [{ code: 'screenshot_failed', message: 'gone' }]), { state: 'not_requested' })
    assert.deepEqual(attemptEvidence([complete], [{ code: 'screenshot_withheld', message: 'withheld' }]).gaps?.map((gap) => gap.code), ['screenshot_withheld'])
  })

  const testWith = (state: 'complete' | 'partial' | 'unavailable' | 'not_requested', status: TestResult['status'] = 'passed'): TestResult => ({
    testId: 't', name: 't', file: 'a.retest.ts', location: { file: 'a.retest.ts', line: 1, column: 1 }, attemptId: 'a', status, durationMs: 1, assertionCount: 1, evidence: [], evidenceStatus: { state },
  })

  test('the run counts its attempts and is only complete when every attempt that asked got all of it', () => {
    assert.deepEqual(runEvidence([testWith('complete'), testWith('not_requested')], [], false), { state: 'complete', attempts: { complete: 1, partial: 0, unavailable: 0, notRequested: 1 } })
    assert.equal(runEvidence([testWith('complete'), testWith('partial')], [], false).state, 'partial')
    assert.equal(runEvidence([testWith('unavailable')], [], true).state, 'unavailable')
    assert.equal(runEvidence([testWith('not_requested')], [], false).state, 'not_requested')
    assert.equal(partial.status, 'partial')
  })

  test('required evidence that is missing fails the run with its own class, and never a test', () => {
    assert.equal(evidenceFailure(runEvidence([testWith('complete')], [], true)), undefined)
    assert.equal(evidenceFailure(runEvidence([testWith('partial')], [], false)), undefined)
    const lacking = evidenceFailure(runEvidence([testWith('complete'), testWith('unavailable')], [], true))
    assert.equal(lacking?.class, 'evidence_incomplete')
    assert.match(lacking?.message ?? '', /1 attempt lacks some of it \(0 partial, 1 unavailable\)/)
  })

  test('the run ends with exit 2 and its own failure while every test keeps its outcome; a failed test still exits 1', () => {
    const lacking = evidenceFailure(runEvidence([testWith('unavailable')], [], true))
    assert.ok(lacking !== undefined)
    const files = (status: TestResult['status']): FileResult[] => [{ file: 'a.retest.ts', collection: 'ok', tests: [testWith('unavailable', status)] }]
    const passedRun = runOutcome({ stoppedBy: undefined, runFailures: [], outputFailures: [], evidenceFailure: lacking, files: files('passed') })
    assert.deepEqual({ status: passedRun.status, exitCode: passedRun.exitCode, complete: passedRun.complete, failure: passedRun.failure?.class, passed: passedRun.counts.passed }, { status: 'error', exitCode: 2, complete: false, failure: 'evidence_incomplete', passed: 1 })
    const failedRun = runOutcome({ stoppedBy: undefined, runFailures: [], outputFailures: [], evidenceFailure: lacking, files: files('failed') })
    assert.deepEqual({ exitCode: failedRun.exitCode, failed: failedRun.counts.failed }, { exitCode: 1, failed: 1 })
    const plain = runOutcome({ stoppedBy: undefined, runFailures: [], outputFailures: [], files: files('passed') })
    assert.deepEqual({ exitCode: plain.exitCode, complete: plain.complete, failure: plain.failure }, { exitCode: 0, complete: true, failure: undefined })
  })
})

describe('capture losses that the encoder cannot see', () => {
  test('a dropped source frame makes a usable video partial', () => {
    const record = endedRecording(place, report({ capture: { ...report().capture!, dropped: 1, problems: ['screenshot failed'] } }), facts)
    assert.equal(record.status, 'partial')
    assert.ok(record.gaps.some(gap => gap.code === 'capture_incomplete'))
  })
  test('a capture whose stop timed out cannot claim complete evidence', () => {
    const record = endedRecording(place, withoutCapture(report({ problems: ['The capture did not stop within its budget.'] })), facts)
    assert.equal(record.status, 'partial')
    assert.ok(record.gaps.some(gap => gap.code === 'capture_incomplete'))
  })
  test('a refused capture gap cannot disappear from evidence status', () => {
    const record = endedRecording(place, report({ gaps: { ...report().gaps, reported: 1, refused: 1 } }), facts)
    assert.equal(record.status, 'partial')
  })
})

test('an encoder capture gap remains partial even when the source did not count it', () => {
  const record = endedRecording(place, report({ ended: ended({ captureGapsReported: 1, evidence: { status: 'partial', reasons: ['capture_gaps'] } }) }), facts)
  assert.equal(record.status, 'partial')
  assert.ok(record.gaps.some(gap => gap.code === 'capture_gaps'))
})

test('a media ending that says incomplete cannot become complete through missing reasons', () => {
  const record = endedRecording(place, report({ ended: ended({ evidence: { status: 'partial', reasons: [] } }) }), facts)
  assert.equal(record.status, 'partial')
  assert.ok(record.gaps.length > 0)
})

for (const status of ['partial', 'unavailable'] as const) {
  test(`a reasonless recording stays ${status} when attempt evidence is aggregated`, () => {
    const record = valid({ ...unstartedRecording(place, 'media_unavailable', 'missing'), status, gaps: [] })
    const evidence = attemptEvidence([record], [])
    assert.equal(evidence.state, status)
    assert.deepEqual(evidence.gaps?.map(gap => gap.code), ['capture_incomplete'])
    assert.deepEqual([evidence.gaps?.[0]?.app, evidence.gaps?.[0]?.sessionId], [identity.app, identity.sessionId])
    assert.match(evidence.gaps?.[0]?.message ?? '', /without a specific reason/)
  })
}

test('recording records preserve arrival clock provenance, achieved cadence and screenshot latency', () => {
  const capture = { mode: 'screenshot-loop' as const, requestedFps: 10, delivered: 30, superseded: 0, dropped: 0, problems: [], achievedFps: 8.5, clockMapping: { timestamp: 'run-arrival' as const, targetClock: 'not-used' as const, imageRead: 'request-to-arrival' as const }, captureMs: { count: 30, minMs: 1, meanMs: 3, maxMs: 9 } }
  const record = valid(endedRecording(place, report({ capture }), facts))
  assert.deepEqual(record.capture, { clockMapping: capture.clockMapping, achievedFps: 8.5, captureMs: capture.captureMs })
  assert.equal(record.clock?.timestamp, 'host-arrival')
  const unavailable = valid(endedRecording(place, withoutEnding(report({ status: 'lost', capture })), { ...facts, path: undefined }))
  assert.deepEqual(unavailable.capture, record.capture, 'loss of video must retain observed source provenance')
  assert.equal(parse(recordingRecordSchema, { ...record, capture: { clockMapping: { ...capture.clockMapping, timestamp: 'target-paint' } } }).ok, false)
})
