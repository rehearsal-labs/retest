import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { browserPath, servePages } from './browser-harness.ts'
import { budgets, configSource, runProject, startRun, writeProject } from './cli-harness.ts'
import { encoderPid, finishRecordingRun, ownershipOf, recordingSkip } from './recording-harness.ts'
import { binary, ffmpeg, observationLoader, preserveReport, proofRoot, verifyVideo } from './evidence-support.test.ts'

// Injection sets a supported media-protocol bound, without replacing dispatch, capture, encoding or verdict logic.
test('a real Chrome recording with a stalled encoder names queue drops and preserves its application pass', {timeout:90000,skip:recordingSkip},async t=>{
 mkdirSync(proofRoot,{recursive:true})
 const observed=join(proofRoot,'observations'),loader=observationLoader(observed)
 appendFileSync(loader,`\nregisterHooks({
 load(url,context,nextLoad){
  const loaded=nextLoad(url,context)
  if(!url.endsWith('/src/media/client.ts'))return loaded
  return {...loaded,source:String(loaded.source)+${JSON.stringify(`\nconst evidenceQueueRecord=MediaProcess.prototype.record\nMediaProcess.prototype.record=function(start,timeout){return evidenceQueueRecord.call(this,{...start,queueFrames:2},timeout)}\n`)}}
 }
})\n`)
 const site=await servePages(t,{'/':'<body><p data-testid="state">Ready</p><script>let n=0;setInterval(()=>document.body.style.background=(n++%2)?"#0000ff":"#00ff00",20)</script>'})
 const source=`import {expect,test} from '@rehearsal-labs/retest';test('passes with saturated queue',async({page})=>{await page.goto('/');await new Promise(resolve=>setTimeout(resolve,6000));await expect(page.getByTestId('state')).toHaveText('Ready')})`
 const root=await writeProject(t,{'retest.config.ts':configSource(`{apps:{web:chromium({executablePath:${JSON.stringify(browserPath())},baseUrl:${JSON.stringify(site.url)}})},recording:{record:true,fps:10,size:{width:320,height:240}}}`),'queue.retest.ts':source})
 const started=await startRun(t,{cwd:root,browser:false,files:['queue.retest.ts'],timeouts:budgets({test:30000,setup:30000,cleanup:15000}),env:{RETEST_MEDIA_BINARY:binary,RETEST_FFMPEG:ffmpeg,NODE_OPTIONS:`--import=${loader}`}})
 const media=await started.retest.waitForEvent('media.started')
 await started.retest.waitForEvent('recording.started')
 await started.retest.waitForEvent('action.completed',event=>event.command==='goto')
 const owner=ownershipOf(started),encoder=encoderPid(media.media.pid)
 const identity=owner.verifiedIdentity(encoder)
 assert.ok(identity)
 writeFileSync(join(proofRoot,'stalled-encoder.json'),JSON.stringify(identity,null,2))
 process.kill(encoder,'SIGSTOP')
 try{await delay(2500)}finally{
  const current=owner.verifiedIdentity(encoder)
  assert.ok(current)
  assert.deepEqual([current.pid,current.parentPid,current.groupId,current.startedAt,current.command],[identity.pid,identity.parentPid,identity.groupId,identity.startedAt,identity.command],'only the recorded encoder is resumed')
  process.kill(encoder,'SIGCONT')
 }
 const run=await finishRecordingRun(started,owner)
 writeFileSync(join(run.output,'cli-output.json'),JSON.stringify({exit:run.exit,stdout:run.stdout,stderr:run.stderr},null,2))
 const kept=await preserveReport(run,'queue'),html=readFileSync(join(kept,'report.html'),'utf8')
 t.diagnostic(`artifacts ${kept}; observations ${observed}`)
 assert.equal(run.exit.code,0)
 const result=run.result?.files.flatMap(file=>file.tests)[0],recording=result?.recordings?.[0]
 assert.ok(result&&recording?.path)
 assert.equal(result.status,'passed')
 assert.equal(result.failure,undefined)
 assert.equal(recording.status,'partial')
 assert.ok((recording.media?.dropped??0)>=10, 'a queue of two names at least ten dropped frames during the recorded stall')
 assert.ok(recording.gaps.some(gap=>gap.code==='frames_dropped'))
 assert.ok(html.includes('dropped'))
 await verifyVideo(run,recording,observed)
 writeFileSync(join(proofRoot,'queue-summary.json'),JSON.stringify({identity,recording,verdict:result.status},null,2))
 const offRoot=await writeProject(t,{'retest.config.ts':configSource(`{apps:{web:chromium({executablePath:${JSON.stringify(browserPath())},baseUrl:${JSON.stringify(site.url)}})},recording:{record:false}}`),'queue.retest.ts':source})
 const off=await runProject(t,offRoot,{timeouts:budgets({test:30000,setup:30000,cleanup:15000}),env:{RETEST_MEDIA_BINARY:join(offRoot,'absent-media'),RETEST_FFMPEG:join(offRoot,'absent-ffmpeg')}})
 writeFileSync(join(off.output,'cli-output.json'),JSON.stringify({exit:off.exit,stdout:off.stdout,stderr:off.stderr},null,2))
 await preserveReport(off,'queue-off')
 const baseline=off.result?.files.flatMap(file=>file.tests)[0]
 assert.ok(baseline)
 assert.deepEqual([result.status,result.failure,run.exit],[baseline.status,baseline.failure,off.exit],'queue saturation keeps the recording-off application outcome and exit')
 assert.equal(off.events.some(event=>event.type.startsWith('media.')||event.type.startsWith('recording.')),false)
})
