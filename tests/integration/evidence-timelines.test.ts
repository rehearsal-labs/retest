import type { FinishedRun } from './cli-harness.ts'
import type { RecordingRecord } from '../../src/protocol/recording.ts'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { assertSucceeded, readEvents, readResult, repositoryRoot, runProgram } from './cli-harness.ts'
import { proofRoot } from './evidence-support.test.ts'
import { nativeSkipReason } from './native-harness.ts'

export type TimelineOverlay = {
 identity:{runId:string;testId:string;attemptId:string;app:string;sessionId:string}
 events:{sequence:number;type:string;captureUs:number;videoUs:number;inVideo:boolean;withheld:boolean}[]
 missing:string[]
}

export function recordingTimeline(run: FinishedRun, recording: RecordingRecord): TimelineOverlay {
 const clock=recording.clock
 assert.ok(clock&&recording.path,'an app timeline requires a real playable recording clock')
 assert.equal(clock.capture,'run_us')
 assert.equal(clock.shortenedCount,clock.shortened.length,'an omitted shortening cannot be guessed')
 assert.ok(run.result)
 const starts=run.events.filter(event=>event.type==='capture.withheld'&&event.sessionId===recording.sessionId)
 const ends=run.events.filter(event=>event.type==='capture.resumed'&&event.sessionId===recording.sessionId)
 const events=run.events.filter(event=>'attemptId' in event&&event.attemptId===recording.attemptId&&'session' in event&&event.session===recording.app&&(event.type.startsWith('action.')||event.type==='assertion.passed'||event.type==='assertion.failed')).map(event=>{
  const captureUs=event.elapsedMs*1000
  const videoUs=captureUs-clock.videoZeroUs-clock.shortened.filter(gap=>gap.captureUs<=captureUs).reduce((sum,gap)=>sum+gap.shortenedByUs,0)
  const withheld=starts.some(start=>start.type==='capture.withheld'&&start.fromUs<=captureUs&&!ends.some(end=>end.type==='capture.resumed'&&end.untilUs>=start.fromUs&&end.untilUs<=captureUs))
  return {sequence:event.sequence,type:event.type,captureUs,videoUs,inVideo:videoUs>=0&&videoUs<=clock.durationUs,withheld}
 })
 const missing:string[]=[]
 if(events.length===0)missing.push('The flow reached no action or assertion on this app; a blank recording cannot prove its flow state.')
 if(events.some(event=>!event.inVideo))missing.push('At least one app action or assertion lies outside the recorded video interval.')
 if(events.some(event=>event.type.startsWith('assertion.')&&event.withheld))missing.push('An app check falls in withheld pixels; a prior frame cannot prove the state it checked.')
 return {identity:{runId:run.result.runId,testId:recording.testId,attemptId:recording.attemptId,app:recording.app,sessionId:recording.sessionId},events,missing}
}

const suppliedFolders: string[] = process.env['RETEST_EVIDENCE_TIMELINES']?.split(',')??[]
test('every app flow timeline has actual recorded pixels at its checks', {timeout:900000},async t=>{
 mkdirSync(proofRoot,{recursive:true})
 let folders = suppliedFolders
 if (folders.length === 0) {
  const unavailable = (await nativeSkipReason('ios-simulator')) ?? (await nativeSkipReason('macos'))
  if (unavailable !== undefined) {
   assert.equal(unavailable.endsWith(' is missing'), false, `a missing local fixture or executor is a defect: ${unavailable}`)
   t.skip(`The real iOS and macOS flow prerequisites the guide's native apps section names are unavailable: ${unavailable}`)
   return
  }
  const retained = join(proofRoot, 'fresh-flow')
  const environment: NodeJS.ProcessEnv = {...process.env, RETEST_TEST_ENGINE:'chromium', RETEST_EVIDENCE_OUT:retained}
  // A child test runner is independent of the current Node test worker.
  delete environment['NODE_TEST_CONTEXT']
  const generated = await runProgram(process.execPath, ['--conditions=retest-source', '--test', '--test-concurrency=1', '--test-name-pattern=^the reference flow with the web on Chrome creates', 'tests/integration/evidence-flows.test.ts'], repositoryRoot,
   environment)
  writeFileSync(join(proofRoot,'fresh-flow.log'),generated.stdout+'\n'+generated.stderr)
  assertSucceeded(generated,'fresh recorded iOS, web and macOS flow')
  const folder = join(retained,'chromium-recorded')
  const generatedResult = readResult(readFileSync(join(folder,'result.json'),'utf8'))
  assert.deepEqual([generatedResult.status, generatedResult.exitCode], ['passed', 0], 'the fresh flow really passed before its timeline is checked')
  folders = [folder]
  t.diagnostic(`Fresh real app flow and recording evidence retained at ${retained}`)
 }
 for(const folder of folders){
  const result=readResult(readFileSync(join(folder,'result.json'),'utf8')),events=readEvents(readFileSync(join(folder,'events.jsonl'),'utf8'))
  const run={output:folder,result,events,exit:{code:result.exitCode,signal:null},stdout:'',stderr:'',durationMs:0}
  const recordings=result.files.flatMap(file=>file.tests).flatMap(test=>test.recordings??[])
  await t.test(`${folder}: all three app recording records exist`,()=>assert.deepEqual(recordings.map(recording=>recording.app).sort(),['desk','phone','web']))
  for(const recording of recordings)await t.test(`${folder}: ${recording.app}`,()=>{
   const overlay=recordingTimeline(run,recording)
   writeFileSync(join(proofRoot,`${result.runId}-${recording.app}-timeline.json`),JSON.stringify(overlay,null,2))
   assert.deepEqual(overlay.missing,[], 'all required app checks have recorded pixels on their own timeline')
  })
 }
})
