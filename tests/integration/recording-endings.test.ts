import assert from 'node:assert/strict'
import { test } from 'node:test'
import { eventsOfType } from '../support/run-harness.ts'
import { decoded, encoderPid, finishRecordingRun, killOwned, ownershipOf, recordingRun, recordingSkip, saveProof } from './recording-harness.ts'

const waiting = `import { expect, test } from '@rehearsal-labs/retest'
test('waits',async({page})=>{await page.goto('/');await new Promise(resolve=>setTimeout(resolve,2000));await expect(page.getByTestId('save-task')).toBeVisible()})`

for (const ending of ['media','encoder','SIGINT','timeout','browser'] as const) {
  test(`recording shutdown after ${ending} preserves the outcome and confirms owned processes gone`,{timeout:60000,skip:recordingSkip},async t=>{
    const started = await recordingRun(t,waiting,{timeout:ending==='timeout'?600:10000})
    const began = await started.retest.waitForEvent('recording.started')
    const media = await started.retest.waitForEvent('media.started')
    await started.retest.waitForEvent('action.completed',event=>event.command==='goto')
    const owner = ownershipOf(started)
    const worker = media.media.pid
    const encoder = encoderPid(worker)
    assert.ok(owner.verifiedIdentity(encoder))
    if (ending==='media') killOwned(owner,worker)
    if (ending==='encoder') killOwned(owner,encoder)
    if (ending==='browser') killOwned(owner,(await started.retest.waitForEvent('browser.started')).pid)
    if (ending==='SIGINT') started.retest.signal('SIGINT')
    const run = await finishRecordingRun(started,owner)
    const result = run.result?.files.flatMap(file=>file.tests)[0]
    assert.ok(result)
    if (ending==='media' || ending==='encoder') {
      assert.equal(result.status,'passed',result.failure?.message)
      assert.equal(run.exit.code,0)
      assert.equal(result.recordings?.[0]?.status,'unavailable')
      assert.ok(result.evidenceStatus?.state==='unavailable' || result.evidenceStatus?.state==='partial')
    } else {
      assert.equal(result.status,ending==='timeout'?'failed':'error')
      assert.equal(run.exit.code,ending==='SIGINT'?130:ending==='timeout'?1:2)
      assert.equal(result.failure?.class,ending==='SIGINT'?'interrupted':ending==='timeout'?'timeout':'session_lost')
    }
    const finished = eventsOfType(run.events,'recording.finished')
    assert.equal(finished.length,1)
    assert.equal(finished[0]?.recording.recordingId,began.recordingId)
    const recording = finished[0]?.recording
    assert.ok(recording)
    if (recording.path!==undefined) decoded(run,recording)
    else assert.ok(recording.gaps.length>0,'missing video is named incomplete')
    const closed = eventsOfType(run.events,'media.closed')[0]
    assert.ok(closed && closed.problems===undefined)
    assert.ok(finished[0] && finished[0].sequence<closed.sequence,'evidence is saved before media shutdown')
    assert.ok(closed.sequence<eventsOfType(run.events,'run.finished')[0]!.sequence)
    saveProof(run,ending)
    if (ending==='timeout') {
      const baseline = await finishRecordingRun(await recordingRun(t,waiting,{record:false,timeout:600}))
      const withoutRecording = baseline.result?.files.flatMap(file=>file.tests)[0]
      assert.ok(withoutRecording)
      assert.deepEqual([result.status,result.failure?.class,run.exit], [withoutRecording.status,withoutRecording.failure?.class,baseline.exit], 'recording preserves the existing timeout outcome and exit status')
      assert.equal(baseline.events.some(event=>event.type.startsWith('media.') || event.type.startsWith('recording.')),false)
    }
  })
}
