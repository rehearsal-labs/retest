import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatSessionId } from '../../src/protocol/evidence.ts'
import { eventsOfType } from '../support/run-harness.ts'
import { decoded, finishRecordingRun, ownershipOf, partialFiles, recordingRun, recordingSkip, saveProof } from './recording-harness.ts'

const source = `import { expect, test } from '@rehearsal-labs/retest'
const pause = ms => new Promise(resolve => setTimeout(resolve,ms))
for (const expected of ['Release checklist','Wrong title']) test(expected, async({page})=>{
  await page.goto('/')
  await pause(250)
  await page.getByTestId('task-title').fill('Release checklist')
  await page.getByTestId('save-task').click()
  await pause(250)
  await expect(page.getByTestId('saved-task')).toHaveText(expected)
})`

test('a real passing and failing run records playable video with identity and separate evidence', { timeout: 60000, skip: recordingSkip }, async t => {
  const started = await recordingRun(t, source)
  await started.retest.waitForEvent('recording.started')
  const owner = ownershipOf(started)
  const run = await finishRecordingRun(started, owner)
  assert.deepEqual(run.exit, {code:1,signal:null})
  const tests = run.result?.files.flatMap(file=>file.tests) ?? []
  assert.deepEqual(tests.map(result=>[result.status,result.evidenceStatus?.state]), [['passed','complete'],['failed','complete']])
  assert.equal(run.result?.evidenceStatus?.state,'complete')
  for (const result of tests) {
    const recording = result.recordings?.[0]
    assert.ok(recording)
    assert.deepEqual([recording.testId,recording.attemptId,recording.app,recording.sessionId], [result.testId,result.attemptId,'web',formatSessionId(result.attemptId,'web')])
    decoded(run, recording)
    const events = run.events.filter(event=>'attemptId' in event && event.attemptId===result.attemptId)
    const began = eventsOfType(events,'recording.started')[0]
    const end = eventsOfType(events,'recording.finished')[0]
    const finished = eventsOfType(events,'test.finished')[0]
    assert.ok(began && end && finished && end.sequence < finished.sequence)
    assert.equal(began.runId,run.result?.runId)
    const execution = eventsOfType(events,'test.started')[0]?.execution
    assert.ok(execution && result.execution)
    assert.deepEqual(execution.configuration,result.execution.configuration)
    assert.deepEqual(execution.bundle,result.execution.bundle)
    assert.deepEqual(execution.runtime,result.execution.runtime)
    assert.deepEqual(execution.sessions,result.execution.sessions)
    for (const event of eventsOfType(events,'action.completed')) {
      assert.ok(recording.clock && event.elapsedMs*1000 >= recording.clock.videoZeroUs - 100000)
      assert.ok(recording.clock && event.elapsedMs*1000 <= recording.clock.videoZeroUs + recording.clock.durationUs + 100000)
    }
  }
  assert.equal(new Set(tests.map(result=>result.recordings?.[0]?.path)).size,2,'attempts never overwrite another recording')
  assert.deepEqual(partialFiles(run.output),[])
  saveProof(run,'passed-and-failed')
})

test('recording off produces no media process or recording events and keeps observed verdicts', {timeout:60000}, async t=>{
  const started = await recordingRun(t,source,{record:false})
  const run = await finishRecordingRun(started)
  assert.equal(run.exit.code,1)
  assert.deepEqual(run.result?.files.flatMap(file=>file.tests).map(result=>result.status), ['passed','failed'])
  assert.equal(run.result?.evidenceStatus,undefined)
  assert.equal(run.events.some(event=>event.type.startsWith('media.') || event.type.startsWith('recording.')),false)
  assert.ok(run.result?.files.flatMap(file=>file.tests).every(result=>result.recordings===undefined))
})
