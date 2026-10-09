import type { FakeCall } from '../support/fake-evaluator.ts'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { MediaProcess, mediaArguments } from '../../src/media/client.ts'
import { OwnedProcessGroup } from '../../src/shared/process-ownership.ts'
import { servePages } from './browser-harness.ts'
import { budgets, configSource, eventsOf, filesHolding, runProject, waitFor, writeProject } from './cli-harness.ts'
import { engineUnderTest } from './engines.ts'
import { binary, decoder, ffmpeg, observationLoader, observations, preserveReport, proofRoot, secretAbsent, verifyScreenshots, verifyVideo } from './evidence-support.test.ts'
import { recordingSkip } from './recording-harness.ts'

const source=`import {expect,secret,test} from '@rehearsal-labs/retest'
test('secret image requests are refused until a new document',async({page})=>{
 await page.goto('/')
 await expect(page.getByTestId('state')).toHaveText('Before')
 await new Promise(resolve=>setTimeout(resolve,500))
 await test.evaluate({judge:'fake',requirement:{'before-shot':'The safe before state is shown.'},evidence:{capture:'screenshot'}})
 await page.getByTestId('entry').fill(secret('value'))
 await expect(page.getByTestId('state')).toHaveText('Secret state')
 await new Promise(resolve=>setTimeout(resolve,800))
 await test.evaluate({judge:'fake',mode:'advisory',requirement:{'blocked-shot':'The current state is shown.'},evidence:{capture:'screenshot'}})
 await test.evaluate({judge:'fake',mode:'advisory',requirement:{'blocked-frames':'The current state is shown.'},evidence:{recording:{lastMs:500}}})
 await page.goto('/after')
 await expect(page.getByTestId('state')).toHaveText('After')
 await new Promise(resolve=>setTimeout(resolve,1500))
 await test.evaluate({judge:'fake',mode:'advisory',requirement:{'after-frames':'The safe after state is shown.'},evidence:{recording:{lastMs:500}}})
 await test.evaluate({judge:'fake',requirement:{'after-shot':'The safe after state is shown.'},evidence:{capture:'screenshot'}})
})`

test('real secret fill refuses image requests, and approved frame sequences and thumbnails contain no exposed secret scene',{timeout:180000,skip:recordingSkip},async t=>{
 const engine=engineUnderTest()
 const site=await servePages(t,{
  '/':'<body style="margin:0;background:#0000ff"><p data-testid="state">Before</p><input data-testid="entry" oninput="document.body.style.background=\'#ff0000\';document.querySelector(\'[data-testid=state]\').textContent=\'Secret state\'">',
  '/after':'<body style="margin:0;background:#00ff00"><p data-testid="state">After</p><p id="paint"></p><script>let n=0;setInterval(()=>document.getElementById("paint").textContent=String(n++),30)</script>',
 })
 mkdirSync(proofRoot,{recursive:true})
 const observed=join(proofRoot,'observations'),loader=observationLoader(observed),callsPath=join(proofRoot,'judge-calls.jsonl')
 const value=randomUUID(),fake=fileURLToPath(new URL('../support/fake-evaluator.ts',import.meta.url))
 const configuration=configSource(`{
  apps:{web:${engine.target(`baseUrl:${JSON.stringify(site.url)}`)}},
  secrets:{value:env('RETEST_EVIDENCE_SECRET')},
  recording:{record:true,fps:10,size:{width:320,height:240}},
  evaluation:{
   limits:{maxFrames:4},
   judges:{
    fake:{adapter:${JSON.stringify(fake)},accepts:['images','frames'],options:{log:${JSON.stringify(callsPath)}}},
   },
  },
 }`)
 writeFileSync(join(proofRoot,'project-config.ts'),configuration)
 const root=await writeProject(t,{'retest.config.ts':configuration,'pixels.retest.ts':source})
 const run=await runProject(t,root,{timeouts:budgets({test:30000,setup:30000,cleanup:15000}),env:{RETEST_EVIDENCE_SECRET:value,RETEST_MEDIA_BINARY:binary,RETEST_FFMPEG:ffmpeg,NODE_OPTIONS:`--import=${loader}`}})
 const output={exit:run.exit,stdout:run.stdout.replaceAll(value,'<declared-secret>'),stderr:run.stderr.replaceAll(value,'<declared-secret>')}
 writeFileSync(join(proofRoot,'cli-output.json'),JSON.stringify(output,null,2))
 assert.ok(run.result,output.stderr)
 writeFileSync(join(run.output,'cli-output.json'),JSON.stringify(output,null,2))
 const kept=await preserveReport(run,'pixels'),html=readFileSync(join(kept,'report.html'),'utf8')
 t.diagnostic(`${engine.label}; artifacts ${kept}; approved sources ${observed}`)
 secretAbsent(run,value)
 assert.equal(run.exit.code,0)
 const result=run.result?.files.flatMap(file=>file.tests)[0],recording=result?.recordings?.[0]
 assert.ok(result&&recording)
 assert.equal(result.status,'passed')
 assert.equal(result.evaluations?.length,5)
 const [before,blockedShot,blockedFrames,afterFrames,afterShot]=result.evaluations??[]
 assert.ok(before&&blockedShot&&blockedFrames&&afterFrames&&afterShot)
 assert.deepEqual([before.verdict,afterShot.verdict],['pass','pass'])
 const screenshotReason='Retest withheld this capture of web by policy: the secret "value" was typed into a field Retest could not read, and the field had not been seen to stop showing it.'
 await t.test(`${blockedShot.checkId} names the exact screenshot policy refusal`,()=>{
  assert.equal(blockedShot.verdict,'error','policy refusal is named, never a passing visual check')
  assert.equal(blockedShot.reason,screenshotReason)
  assert.deepEqual(blockedShot.evidence,[],'a withheld screenshot produces no evidence')
 })
 await t.test(`${blockedFrames.checkId} is inconclusive with the exact wholly withheld interval reason and no frames`,()=>{
  assert.equal(blockedFrames.verdict,'inconclusive','missing interval evidence cannot settle the visual check')
  assert.equal(blockedFrames.evidence.length,1)
  const evidence=blockedFrames.evidence[0]
  assert.ok(evidence&&evidence.fromUs!==undefined&&evidence.toUs!==undefined)
  assert.equal(evidence.kind,'frames')
  assert.equal(evidence.status,'unavailable')
  assert.deepEqual(evidence.frames,[])
  assert.equal(evidence.bytes,0)
  assert.equal(evidence.path,undefined)
  assert.equal(evidence.sha256,createHash('sha256').update('').digest('hex'))
  assert.equal(evidence.toUs-evidence.fromUs,500000,'the requested lastMs interval is retained exactly')
  const withheld=eventsOf(run.events,'capture.withheld')[0],resumed=eventsOf(run.events,'capture.resumed')[0]
  assert.ok(withheld&&resumed&&evidence.fromUs>=withheld.fromUs&&evidence.toUs<=resumed.untilUs,'the whole requested interval lies within policy withholding')
  const reason=`The recording of web kept no frame from ${Math.round(evidence.fromUs/1000)} ms to ${Math.round(evidence.toUs/1000)} ms on the run's clock, so the check has nothing to judge.`
  assert.equal(blockedFrames.reason,reason)
  assert.equal(evidence.reason,reason)
 })
 for(const blocked of [blockedShot,blockedFrames]){
  assert.equal(blocked.evidence.some(item=>item.path!==undefined||(item.frames?.length??0)>0),false,'no refused secret image is persisted')
  assert.ok(blocked.reason&&html.includes(blocked.reason.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;')))
 }
 const calls:FakeCall[]=readFileSync(callsPath,'utf8').trim().split('\n').flatMap(line=>{const entry:{call?:FakeCall}=JSON.parse(line);return entry.call?[entry.call]:[]})
 assert.deepEqual(calls.map(call=>call.criteria[0]?.id),['before-shot','after-frames','after-shot'],'neither withheld request reaches the judge')
 await t.test('approved sequence, screenshot, video and thumbnail pixels independently decode without the exposed secret scene',async()=>{
 const sequence=afterFrames.evidence.find(item=>item.kind==='frames')
 assert.ok(sequence&&(sequence.frames?.length??0)>0,'the resumed recording really supplies a frame sequence')
 assert.equal(afterFrames.verdict==='pass',sequence.status==='complete','a sampled frame pass only counts when its evidence is complete')
 const withheld=eventsOf(run.events,'capture.withheld'),resumed=eventsOf(run.events,'capture.resumed')
 assert.equal(withheld.length,1)
 assert.equal(resumed.length,1)
 const from=withheld[0]?.fromUs,until=resumed[0]?.untilUs
 assert.ok(from!==undefined&&until!==undefined&&until>from)
 const traced=observations(observed,recording)
 assert.deepEqual(traced.frames.filter(frame=>frame.timestampUs>=from&&frame.timestampUs<=until),[])
 const rejectSecretScene=async(path:string):Promise<void>=>{
  const rgb=await decoder(ffmpeg,['-v','error','-xerror','-i',path,'-vf','format=rgb24,scale=1:1:flags=area','-pix_fmt','rgb24','-f','rawvideo','pipe:1'])
  assert.ok(rgb.length>0&&rgb.length%3===0)
  for(let index=0;index<rgb.length;index+=3)assert.equal((rgb[index]??0)>(rgb[index+1]??0)+(rgb[index+2]??0)+80,false,'no decoded artifact contains the exposed red secret scene')
 }
 const judged=calls[1]?.frames[0]
 assert.ok(judged)
 assert.equal(sequence.frames?.length,judged.frames.length)
 for(const [index,frame] of (sequence.frames??[]).entries()){
  const bytes=readFileSync(join(run.output,frame.path))
  assert.equal(createHash('sha256').update(bytes).digest('hex'),frame.sha256)
  assert.deepEqual([judged.frames[index]?.sha256,judged.frames[index]?.bytes],[frame.sha256,bytes.length])
  assert.ok(frame.captureUs>until)
  assert.ok(traced.frames.some(source=>source.frameId===frame.frameId&&source.timestampUs===frame.captureUs))
  assert.ok(html.includes(frame.path))
  await rejectSecretScene(join(run.output,frame.path))
 }
 await verifyScreenshots(run,result)
 for(const image of [before,afterShot].flatMap(check=>check.evidence))if(image.path)await rejectSecretScene(join(run.output,image.path))
 await verifyVideo(run,recording,observed)
 assert.ok(recording.path)
 await rejectSecretScene(join(run.output,recording.path))

 // Thumbnails use actual policy-approved source frames, never a fresh capture of the secret-bearing page.
 const media=await MediaProcess.start({executable:binary,args:mediaArguments({ffmpeg}),env:{PATH:'/opt/homebrew/bin:/usr/bin:/bin'},startTimeoutMs:10000})
 const owner=new OwnedProcessGroup(media.pid)
 t.after(async()=>{await media.close(10000);await waitFor('thumbnail process gone',()=>!owner.remains());assert.deepEqual(owner.readProblems,[])})
 assert.deepEqual(owner.capture(),[])
 const processIdentity=owner.verifiedIdentity(media.pid)
 assert.ok(processIdentity)
 writeFileSync(join(proofRoot,'thumbnail-process.json'),JSON.stringify(processIdentity,null,2))
 const sent=traced.frames.filter(frame=>frame.outcome==='sent'),selected=[sent[0],sent[Math.floor(sent.length/2)],sent.at(-1)]
 const thumbnails:object[]=[]
 for(const [index,frame] of selected.entries()){
  assert.ok(frame)
  assert.ok(frame.format==='jpeg'||frame.format==='png')
  assert.ok(frame.timestampUs<from||frame.timestampUs>until)
  const reply=await media.thumbnail({output:join(proofRoot,`thumbnail-${index}`),maxWidth:64,maxHeight:48,format:'png'},{format:frame.format,bytes:readFileSync(join(traced.folder,frame.image))},10000)
  writeFileSync(join(proofRoot,`thumbnail-${index}.json`),JSON.stringify({identity:traced.ended.identity,frameId:frame.frameId,captureUs:frame.timestampUs,reply},null,2))
  assert.equal(reply.status,'ok',reply.message)
  assert.ok(reply.path&&reply.width!==undefined&&reply.height!==undefined)
  assert.ok(reply.width<=64&&reply.height<=48)
  await rejectSecretScene(reply.path)
  thumbnails.push({identity:traced.ended.identity,frameId:frame.frameId,captureUs:frame.timestampUs,reply})
 }
 await media.close(10000)
 await waitFor('recorded thumbnail worker gone before the assertion',()=>!owner.remains())
 assert.deepEqual(owner.readProblems,[])
 assert.deepEqual(filesHolding(proofRoot,value),[])
 writeFileSync(join(proofRoot,'pixel-artifacts.json'),JSON.stringify({identity:traced.ended.identity,fromUs:from,untilUs:until,blockedRequests:[blockedShot,blockedFrames],sequence,thumbnails,judgedCalls:calls.length},null,2))
 })
})
