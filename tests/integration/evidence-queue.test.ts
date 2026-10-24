import type { OwnedProcessGroup, OwnedProcessIdentity } from '../../src/shared/process-ownership.ts'
import type { StartedRun } from './cli-harness.ts'
import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { consoleHost } from '../../src/shared/process-supervisor.ts'
import { launchesHeldByJob, launchOwnership } from '../../src/shared/process-system.ts'
import { browserPath, servePages } from './browser-harness.ts'
import { budgets, configSource, runProject, startRun, writeProject } from './cli-harness.ts'
import { encoderPid, finishRecordingRun, ownershipOf, recordingSkip } from './recording-harness.ts'
import { binary, ffmpeg, importOption, observationLoader, preserveReport, proofRoot, verifyVideo } from './evidence-support.test.ts'
import { resumeProcess, suspendProcess } from '../support/windows-suspend.ts'

// The encoder is stalled as a stopped process is: SIGSTOP and SIGCONT on macOS and Linux; on Windows, which has no such
// signal, every thread of it suspended and resumed.
// The run's processes, read as recordingRun's runs are: from ps on macOS and Linux; on Windows through the job the
// harness holds the command in, which holds everything it starts, the encoder among them.
function runOwnership(started: StartedRun): OwnedProcessGroup {
  if (!launchesHeldByJob) return ownershipOf(started)
  const owner = launchOwnership(started.retest.pid)
  assert.deepEqual(owner.capture(), [], 'record this test run and its launch descendants')
  return owner
}

// The encoder and every process it started, each as the run's owner recorded it. Chocolatey's ffmpeg, the one the
// Windows runners install, is a launcher: it starts the real ffmpeg, which reads the frames itself, so stalling the
// launcher alone leaves the encoding going. A real ffmpeg starts nothing. The console host Windows gives a console
// program is no part of the encoding and is left running.
function encoderProcesses(owner: OwnedProcessGroup, encoder: number): OwnedProcessIdentity[] {
  assert.deepEqual(owner.capture(), [], 'read the run again with what its encoder started')
  const found = new Map<number, OwnedProcessIdentity>()
  const own = owner.verifiedIdentity(encoder)
  assert.ok(own, 'the encoder is a recorded process of the run')
  found.set(encoder, own)
  let grew = true
  while (grew) {
    grew = false
    for (const entry of owner.stillThere) {
      if (found.has(entry.pid) || !found.has(entry.parentPid) || consoleHost({ ...entry, image: entry.command })) continue
      const verified = owner.verifiedIdentity(entry.pid)
      assert.ok(verified, `process ${entry.pid}, which the encoder started, is a recorded process of the run`)
      found.set(entry.pid, verified)
      grew = true
    }
  }
  return [...found.values()]
}

function stall(pid: number): void {
  if (process.platform === 'win32') suspendProcess(pid)
  else process.kill(pid, 'SIGSTOP')
}

function resume(pid: number): void {
  if (process.platform === 'win32') resumeProcess(pid)
  else process.kill(pid, 'SIGCONT')
}

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
 const started=await startRun(t,{cwd:root,browser:false,files:['queue.retest.ts'],timeouts:budgets({test:30000,setup:30000,cleanup:15000}),env:{RETEST_MEDIA_BINARY:binary,RETEST_FFMPEG:ffmpeg,NODE_OPTIONS:importOption(loader)}})
 const media=await started.retest.waitForEvent('media.started')
 await started.retest.waitForEvent('recording.started')
 await started.retest.waitForEvent('action.completed',event=>event.command==='goto')
 const owner=runOwnership(started),encoder=encoderPid(media.media.pid)
 const identity=owner.verifiedIdentity(encoder)
 assert.ok(identity)
 const stalled=encoderProcesses(owner,encoder)
 writeFileSync(join(proofRoot,'stalled-encoder.json'),JSON.stringify(identity,null,2))
 for(const each of stalled)stall(each.pid)
 try{await delay(2500)}finally{
  for(const each of stalled){
   const current=owner.verifiedIdentity(each.pid)
   assert.ok(current)
   assert.deepEqual([current.pid,current.parentPid,current.groupId,current.startedAt,current.command],[each.pid,each.parentPid,each.groupId,each.startedAt,each.command],'only the recorded encoder is resumed')
   resume(each.pid)
  }
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
 writeFileSync(join(proofRoot,'queue-summary.json'),JSON.stringify({identity,stalled,recording,verdict:result.status},null,2))
 const offRoot=await writeProject(t,{'retest.config.ts':configSource(`{apps:{web:chromium({executablePath:${JSON.stringify(browserPath())},baseUrl:${JSON.stringify(site.url)}})},recording:{record:false}}`),'queue.retest.ts':source})
 const off=await runProject(t,offRoot,{timeouts:budgets({test:30000,setup:30000,cleanup:15000}),env:{RETEST_MEDIA_BINARY:join(offRoot,'absent-media'),RETEST_FFMPEG:join(offRoot,'absent-ffmpeg')}})
 writeFileSync(join(off.output,'cli-output.json'),JSON.stringify({exit:off.exit,stdout:off.stdout,stderr:off.stderr},null,2))
 await preserveReport(off,'queue-off')
 const baseline=off.result?.files.flatMap(file=>file.tests)[0]
 assert.ok(baseline)
 assert.deepEqual([result.status,result.failure,run.exit],[baseline.status,baseline.failure,off.exit],'queue saturation keeps the recording-off application outcome and exit')
 assert.equal(off.events.some(event=>event.type.startsWith('media.')||event.type.startsWith('recording.')),false)
})
