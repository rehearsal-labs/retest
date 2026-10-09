import type { EventBody } from '../../src/protocol/events.ts'
import type { RecordingRecord } from '../../src/protocol/recording.ts'
import type { FinishedRun } from './cli-harness.ts'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { RunMedia, startMediaProcess } from '../../src/runner/run-media.ts'
import { OwnedProcessGroup } from '../../src/shared/process-ownership.ts'
import { rebuildResult } from '../../src/store/rebuild-result.ts'
import { buildReport } from '../../src/reporters/html/build-report.ts'
import { createHumanReporter } from '../../src/reporters/human.ts'
import { countParts } from '../../src/reporters/format.ts'
import { assertStdoutIsEvents, readFinishedRun, repositoryRoot, waitFor } from './cli-harness.ts'
import { encoderPid, finishRecordingRun, killOwned, ownershipOf, partialFiles, recordingRun, recordingSkip } from './recording-harness.ts'
import { eventsOfType } from '../support/run-harness.ts'
import { decoder, ffmpeg, ffprobe, preserve, reportFor } from './evidence-support.test.ts'

// Existing real-Chrome failure scenarios and their assertions are retained verbatim below.
async function saveProof(run: FinishedRun, name: string, t: TestContext): Promise<void> {
  writeFileSync(join(run.output, 'cli-output.json'), JSON.stringify({exit:run.exit, stdout:run.stdout, stderr:run.stderr},null,2))
  const kept=preserve(run,name)
  await t.test(`${name} terminal, JSONL and HTML evidence agree`,async()=>{
  assertStdoutIsEvents(run)
  if (run.result !== undefined) {
    await reportFor({...run,output:kept})
    assert.deepEqual([run.exit.code,run.exit.signal], [run.result.exitCode,null], 'terminal process and result/JSONL/HTML exit agree')
    assert.ok(run.stdout.includes(run.result.runId), 'terminal names the run it reports')
  } else {
    const result = rebuildResult(run.events)
    const report = await buildReport({directory:run.output,shown:run.output,source:'events.jsonl',result,events:run.events,warnings:['Runner ended before result.json.']})
    writeFileSync(join(kept,'report.html'),report)
    assert.ok(report.includes('run_stopped') || report.includes('before'), 'HTML names interrupted evidence')
    const block=/<script type="application\/json" id="retest-outcome">([^<]*)<\/script>/.exec(report)?.[1]
    assert.ok(block)
    const shown:{runId:string;status:string;exitCode:number;counts:object}=JSON.parse(block)
    assert.deepEqual([shown.runId,shown.status,shown.exitCode,shown.counts],[result.runId,result.status,result.exitCode,result.counts],'HTML retains the explicitly reconstructed interrupted outcome')
    let terminal=''
    const writer={write:(text:string):void=>{terminal+=text}}
    const human=createHumanReporter({stdout:writer,stderr:writer,color:false,runFolder:kept})
    for(const event of run.events)human.onEvent(event)
    human.onRunEnd(result)
    writeFileSync(join(kept,'reconstructed-terminal-report.txt'),terminal)
    const counts=countParts(result.counts).join(' · ')
    if(counts!=='')assert.ok(terminal.includes(counts))
    for(const test of result.files.flatMap(file=>file.tests))for(const recording of test.recordings??[])for(const gap of recording.gaps){
      assert.ok(terminal.includes(gap.message),'reconstructed human output names the same interrupted gap')
      assert.ok(terminal.includes(gap.code),'reconstructed human output names the exact gap code')
      const escaped=gap.message.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;').replaceAll('`','&#96;')
      assert.ok(report.includes(escaped),'HTML and terminal retain every reconstructed recording reason')
    }
  }
  })
}

async function decoded(run: FinishedRun, recording: RecordingRecord): Promise<void> {
  assert.ok(recording.path && recording.video && recording.clock, 'a usable recording has path, video facts and clock mapping')
  const path=join(run.output,recording.path)
  const probe=await decoder(ffprobe,['-v','error','-count_frames','-show_entries','stream=codec_name,width,height,nb_read_frames:format=duration','-of','json',path])
  const read:{streams:{codec_name:string;width:number;height:number;nb_read_frames:string}[];format:{duration:string}}=JSON.parse(probe.toString())
  assert.equal(read.streams.length,1)
  const stream=read.streams[0]
  assert.ok(stream)
  assert.deepEqual([stream.codec_name,stream.width,stream.height,Number(stream.nb_read_frames)],[recording.video.codec,recording.video.width,recording.video.height,recording.video.outputFrames])
  assert.ok(recording.video.outputFrames>0)
  assert.ok(Math.abs(Number(read.format.duration)*1e6-recording.video.durationUs)<=100000)
  await decoder(ffmpeg,['-v','error','-xerror','-i',path,'-f','null','-'])
}

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
    await saveProof(run,ending,t)
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
    if (recording.path!==undefined) await decoded(run,recording)
    else assert.ok(recording.gaps.length>0,'missing video is named incomplete')
    const closed = eventsOfType(run.events,'media.closed')[0]
    assert.ok(closed && closed.problems===undefined)
    assert.ok(finished[0] && finished[0].sequence<closed.sequence,'evidence is saved before media shutdown')
    assert.ok(closed.sequence<eventsOfType(run.events,'run.finished')[0]!.sequence)
    if (ending==='timeout') {
      const baseline = await finishRecordingRun(await recordingRun(t,waiting,{record:false,timeout:600}))
      const withoutRecording = baseline.result?.files.flatMap(file=>file.tests)[0]
      assert.ok(withoutRecording)
      assert.deepEqual([result.status,result.failure?.class,run.exit], [withoutRecording.status,withoutRecording.failure?.class,baseline.exit], 'recording preserves the existing timeout outcome and exit status')
      assert.equal(baseline.events.some(event=>event.type.startsWith('media.') || event.type.startsWith('recording.')),false)
      await saveProof(baseline,'timeout-off',t)
    } else {
      const withoutMedia=await recordingRun(t,waiting,{record:false,timeout:10000})
      await withoutMedia.retest.waitForEvent('action.completed',event=>event.command==='goto')
      const baselineOwner=ownershipOf(withoutMedia)
      if(ending==='SIGINT') withoutMedia.retest.signal('SIGINT')
      if(ending==='browser') killOwned(baselineOwner,(await withoutMedia.retest.waitForEvent('browser.started')).pid)
      const baseline=await finishRecordingRun(withoutMedia,baselineOwner)
      await saveProof(baseline,`${ending}-off`,t)
      const observed=baseline.result?.files.flatMap(file=>file.tests)[0]
      assert.ok(observed)
      assert.deepEqual([result.status,result.failure?.class,run.exit],[observed.status,observed.failure?.class,baseline.exit],'recording keeps the corresponding off application verdict and exit')
      assert.equal(baseline.events.some(event=>event.type.startsWith('media.')||event.type.startsWith('recording.')),false)
    }
  })
}

test('a killed runner leaves no owned media worker, encoder, browser or test process', { timeout: 60000, skip: recordingSkip }, async t => {
  const started = await recordingRun(t, `import {test} from '@rehearsal-labs/retest'; test('waits',async({page})=>{await page.goto('/');await new Promise(resolve=>setTimeout(resolve,10000))})`)
  const media = await started.retest.waitForEvent('media.started')
  await started.retest.waitForEvent('recording.started')
  await started.retest.waitForEvent('action.completed', event => event.command === 'goto')
  const owner = ownershipOf(started)
  assert.ok(owner.verifiedIdentity(encoderPid(media.media.pid)))
  t.after(async () => {
    if (owner.remains()) {
      const cleanup = owner.signalReport('SIGKILL')
      assert.deepEqual(cleanup.problems, [])
      assert.deepEqual(cleanup.identityRefusals, [])
      await waitFor('the recorded exit-test descendants gone after harness cleanup', () => !owner.remains())
    }
  })
  killOwned(owner, started.retest.pid)
  const run = await readFinishedRun(started)
  await saveProof(run, 'runner-exit',t)
  assert.deepEqual(run.exit, { code: null, signal: 'SIGKILL' })
  assert.equal(run.result, undefined)
  // The assertion precedes harness cleanup: only the runner is killed by the test body.
  await waitFor('the worker and all launch descendants to stop after the runner died', () => !owner.remains())
  assert.deepEqual(owner.readProblems, [])
  const rebuilt = rebuildResult(run.events)
  assert.equal(rebuilt.evidenceStatus?.state, 'unavailable')
  assert.equal(rebuilt.files.flatMap(file => file.tests)[0]?.recordings?.[0]?.gaps[0]?.code, 'run_stopped')
})

test('required evidence has its own CLI exit while a test keeps its observed pass', { timeout: 60000, skip: recordingSkip }, async t => {
  const started = await recordingRun(t, `import {expect,test} from '@rehearsal-labs/retest'; test('passes',async({page})=>{await page.goto('/');await new Promise(resolve=>setTimeout(resolve,2000));await expect(page.getByTestId('save-task')).toBeVisible()})`, { required: true })
  const media = await started.retest.waitForEvent('media.started')
  await started.retest.waitForEvent('recording.started')
  await started.retest.waitForEvent('action.completed', event => event.command === 'goto')
  const owner = ownershipOf(started)
  assert.ok(owner.verifiedIdentity(encoderPid(media.media.pid)))
  killOwned(owner, media.media.pid)
  const run = await finishRecordingRun(started, owner)
  await saveProof(run, 'required-evidence',t)
  assert.deepEqual(run.exit, { code: 2, signal: null })
  assert.equal(run.result?.status, 'error')
  assert.equal(run.result?.failure?.class, 'evidence_incomplete')
  assert.equal(run.result?.evidenceStatus?.state, 'unavailable')
  const [result] = run.result?.files.flatMap(file => file.tests) ?? []
  assert.ok(result)
  assert.equal(result.status, 'passed')
  assert.equal(result.failure, undefined)
  assert.equal(result.recordings?.[0]?.status, 'unavailable')
  assert.ok(result.recordings?.[0]?.gaps.some(gap => gap.code === 'media_process_lost'))
  assert.equal(result.evidenceStatus?.state, 'unavailable')
})

// A killed runner cannot finalize. The next run's worker removes only the old recording's owned leftovers.
test('the next media worker removes leftovers of a killed run and leaves unrelated files alone', { timeout: 60000, skip: recordingSkip }, async t => {
  const started = await recordingRun(t, `import { test } from '@rehearsal-labs/retest'; test('waits',async({page})=>{await page.goto('/');await new Promise(resolve=>setTimeout(resolve,10000))})`)
  const mediaStart = await started.retest.waitForEvent('media.started')
  await started.retest.waitForEvent('recording.started')
  await started.retest.waitForEvent('action.completed', event => event.command === 'goto')
  const owner = ownershipOf(started)
  killOwned(owner, mediaStart.media.pid)
  killOwned(owner, started.retest.pid)
  const stopped = owner.signalReport('SIGKILL')
  assert.deepEqual(stopped.problems, [])
  assert.deepEqual(stopped.identityRefusals, [])
  const killed = await readFinishedRun(started)
  assert.equal(killed.result, undefined)
  await waitFor('all recorded launch descendants gone', () => !owner.remains())
  assert.deepEqual(owner.readProblems, [])
  assert.ok(partialFiles(started.output).length > 0, 'the killed worker left a real partial recording')
  const rebuilt = rebuildResult(killed.events)
  assert.equal(rebuilt.evidenceStatus?.state, 'unavailable')
  assert.equal(rebuilt.files.flatMap(file => file.tests)[0]?.recordings?.[0]?.gaps[0]?.code, 'run_stopped')
  const foreign = join(started.output, 'artifacts', 'foreign', 'recording-other.mp4.partial')
  mkdirSync(dirname(foreign), { recursive: true })
  writeFileSync(foreign, 'unrelated sentinel')
  const events: EventBody[] = []
  let nextOwner: OwnedProcessGroup | undefined
  const next = new RunMedia({
    location: { executable: process.env['RETEST_TEST_MEDIA_BINARY'] ?? join(repositoryRoot, 'media/target/release/retest-media'), ffmpeg: process.env['RETEST_TEST_FFMPEG'] ?? '/opt/homebrew/bin/ffmpeg' },
    start: async (location, budget) => { const process = await startMediaProcess(location, budget); nextOwner = new OwnedProcessGroup(process.pid); assert.deepEqual(nextOwner.capture(), []); return process },
    emit: event => void events.push(event), timeouts: { start: 10000, close: 5000, leftovers: 5000 }, runFolder: join(dirname(started.output), 'current'),
  })
  t.after(async () => { assert.equal(await next.close(), undefined); assert.equal(nextOwner?.remains(), false) })
  assert.equal((await next.acquire()).ok, true)
  await waitFor('the killed run leftovers removal', () => events.some(event => event.type === 'media.leftovers' && event.removed.length > 0))
  assert.deepEqual(partialFiles(started.output), ['artifacts/foreign/recording-other.mp4.partial'])
  assert.equal(existsSync(foreign), true)
  const removal = events.find(event => event.type === 'media.leftovers')
  assert.ok(removal?.type === 'media.leftovers')
  assert.equal(removal.previousRunId, killed.events[0]?.runId)
  assert.equal(removal.status, 'ok')
  assert.equal(await next.close(), undefined)
  assert.equal(nextOwner?.remains(), false)
  writeFileSync(join(started.output,'next-worker-events.json'),JSON.stringify(events,null,2))
  await saveProof(killed,'leftovers',t)
})
