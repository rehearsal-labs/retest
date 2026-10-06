import type { RetestEvent } from '../../src/protocol/events.ts'
import type { Failure } from '../../src/protocol/failures.ts'
import type { RetentionPlan } from '../../src/store/artifacts.ts'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mock, test } from 'node:test'
import { buildReport } from '../../src/reporters/html/build-report.ts'
import { EventLog } from '../../src/runner/event-log.ts'
import { applyRetention, eventArtifactReferences } from '../../src/store/artifacts.ts'
import { readEvents } from '../../src/store/read-run-folder.ts'
import { rebuildResult } from '../../src/store/rebuild-result.ts'
import { RunStore } from '../../src/store/run-store.ts'
import { configFiles, mp4, recordedRun, recordingPath } from './reporters-html-fixtures.ts'
import { projectFolder } from './reporters-fixtures.ts'

function setup(): { store: RunStore; log: EventLog; failures: Failure[]; plan: RetentionPlan; events: RetestEvent[] } {
  const root = projectFolder()
  const store = RunStore.create(join(root, 'run'))
  mkdirSync(join(store.directory, 'artifacts'))
  for (const [path, bytes] of Object.entries({ ...configFiles(), [recordingPath]: mp4() })) {
    mkdirSync(join(store.directory, path, '..'), { recursive: true })
    writeFileSync(join(store.directory, path), bytes)
  }
  const failures: Failure[] = []
  const log = new EventLog({ runId: 'run-1', store, reporters: [], elapsedMs: () => 0, onFailure: (failure) => failures.push(failure) })
  const events = recordedRun(root)
  for (const event of events) {
    const { schemaVersion: _schema, runId: _run, sequence: _sequence, time: _time, elapsedMs: _elapsed, origin, ...body } = event
    log.emit(body, origin)
  }
  const testId = events.find((event) => event.type === 'test.started')?.testId
  assert.ok(testId)
  const plan: RetentionPlan = { moment: { kind: 'attempt_finished', attemptId: 'k3v9q0x2mb', status: 'passed' }, kept: [], removals: [{ reference: recordingPath, kind: 'recording', reason: 'passed_attempt_recording', owner: { testId, attemptId: 'k3v9q0x2mb', app: 'web', sessionId: 'k3v9q0x2mb:web' } }] }
  return { store, log, failures, plan, events }
}

test('the real EventLog append failure keeps a retention file', async () => {
  const { store, log, failures, plan } = setup()
  const hook = mock.method(store, 'appendEvent', () => { throw new Error('synthetic append failure') })
  try {
    const recorder = { removing: (record: Parameters<EventLog['emit']>[0]) => log.emitPersisted(record), removed: (record: Parameters<EventLog['emit']>[0]) => { log.emit(record) }, failed: (record: Parameters<EventLog['emit']>[0]) => { log.emit(record) } }
    const outcome = applyRetention(store.directory, plan, recorder)
    assert.ok(existsSync(join(store.directory, recordingPath)), 'a swallowed append error must not authorize deletion')
    assert.deepEqual(outcome.removed, [])
    assert.equal(outcome.refused[0]?.reason, 'unrecorded')
    assert.equal(failures[0]?.class, 'reporting_failed')
  } finally { hook.mock.restore(); await log.flush(); store.close() }
})

test('a recorder that dies after persisting the request leaves present evidence with removal not confirmed', async () => {
  const { store, log, plan } = setup()
  try {
    const recorder = { removing: (record: Parameters<EventLog['emit']>[0]): never => { log.emit(record); throw new Error('recorder died after request') }, removed: () => assert.fail('completion must not occur'), failed: () => assert.fail('the recorder did not authorize unlink') }
    const outcome = applyRetention(store.directory, plan, recorder)
    assert.ok(existsSync(join(store.directory, recordingPath)))
    assert.deepEqual(outcome.removed, [])
    const read = readEvents(readFileSync(join(store.directory, 'events.jsonl'), 'utf8'))
    assert.ok(read.ok, read.ok ? '' : read.problem)
    assert.ok(eventArtifactReferences(read.events).some((reference) => reference.path === recordingPath), 'a request alone must keep the recording reference')
    const result = rebuildResult(read.events)
    const recording = result.files.flatMap((file) => file.tests).flatMap((test) => test.recordings ?? []).find((recording) => recording.path === recordingPath)
    assert.ok(recording)
    assert.equal(recording.removed, undefined)
    assert.equal(recording.removalPending, true)
    const inputRecording = read.events.find((event) => event.type === 'recording.finished')
    assert.ok(inputRecording?.type === 'recording.finished')
    assert.equal(inputRecording.recording.removalPending, undefined, 'reconstruction must not modify the input event')
    const html = await buildReport({ directory: store.directory, shown: 'run', source: 'events.jsonl', result, events: read.events, warnings: [] })
    assert.ok(html.includes('Present, removal not confirmed'))
    assert.ok(!html.includes('was removed after the test passed'))
  } finally { await log.flush(); store.close() }
})

test('successful retention persists request while present and completion only after unlink', async () => {
  const { store, log, plan } = setup()
  const states: boolean[] = []
  try {
    const recorder = { removing: (record: Parameters<EventLog['emit']>[0]) => { states.push(existsSync(join(store.directory, recordingPath))); return log.emitPersisted(record) }, removed: (record: Parameters<EventLog['emit']>[0]) => { states.push(existsSync(join(store.directory, recordingPath))); log.emit(record) }, failed: () => assert.fail('removal must succeed') }
    const outcome = applyRetention(store.directory, plan, recorder)
    assert.equal(outcome.removed.length, 1)
    assert.deepEqual(states, [true, false])
    const read = readEvents(readFileSync(join(store.directory, 'events.jsonl'), 'utf8'))
    assert.ok(read.ok, read.ok ? '' : read.problem)
    assert.deepEqual(read.events.filter((event) => event.type.startsWith('artifact.')).map((event) => event.type), ['artifact.removal_requested', 'artifact.removed'])
  } finally { await log.flush(); store.close() }
})
