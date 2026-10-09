import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import type { FakeCall } from '../support/fake-evaluator.ts'
import type { DeliveredImages } from './evidence-judge.test.ts'
import { parseArtifact } from '../../src/diagnostics/artifact.ts'
import { servePages } from './browser-harness.ts'
import { budgets, configSource, eventsOf, filesHolding, runProject, writeProject } from './cli-harness.ts'
import { engineUnderTest } from './engines.ts'
import { binary, decoder, ffmpeg, observationLoader, observations, preserveReport, proofRoot, secretAbsent, verifyScreenshots, verifyVideo } from './evidence-support.test.ts'
import { recordingSkip } from './recording-harness.ts'

const source = `import { expect, secret, test } from '@rehearsal-labs/retest'
test('bounded secret diagnostics while recording',async({page})=>{
 await page.goto('/')
 await expect(page.getByTestId('state')).toHaveText('Before')
 await new Promise(resolve=>setTimeout(resolve,500))
 await test.evaluate({judge:'fake',requirement:{pass:'The safe before state is shown.'},evidence:{capture:'screenshot'}})
 await page.getByTestId('entry').fill(secret('value'))
 await expect(page.getByTestId('state')).toHaveText('Flooded')
 await new Promise(resolve=>setTimeout(resolve,500))
 await page.goto('/after')
 await expect(page.getByTestId('state')).toHaveText('After')
 await new Promise(resolve=>setTimeout(resolve,500))
 await test.evaluate({judge:'fake',requirement:{pass:'The safe after state is shown.'},evidence:{capture:'screenshot'}})
})`

test('recording survives bounded and sanitized diagnostics, with the judge and HTML using the same images', {timeout:180000,skip:recordingSkip},async t=>{
 const engine=engineUnderTest()
 const site=await servePages(t,{
  '/':'<body style="background:#0000ff"><p data-testid="state">Before</p><input data-testid="entry" oninput="for(let n=0;n<2000;n++)console.log(n+\':\'+this.value+\':\'+\'x\'.repeat(1000));document.querySelector(\'[data-testid=state]\').textContent=\'Flooded\';document.body.style.background=\'#ff0000\'">',
  '/after':'<body style="background:#00ff00"><p data-testid="state">After</p>'
 })
 mkdirSync(proofRoot,{recursive:true})
 const observed=join(proofRoot,'observations'), loader=observationLoader(observed), calls=join(proofRoot,'judge-calls.jsonl')
 const hashes=join(proofRoot,'judge-image-hashes.jsonl')
 const value=randomUUID(),fake=fileURLToPath(new URL('./evidence-judge.test.ts',import.meta.url))
 const root=await writeProject(t,{'retest.config.ts':configSource(`{apps:{web:${engine.target(`baseUrl:${JSON.stringify(site.url)}`)}},secrets:{value:env('RETEST_EVIDENCE_SECRET')},diagnostics:{limits:{consoleEntries:10,consoleBytes:20000,textLength:4096}},recording:{record:true,fps:10,size:{width:320,height:240}},evaluation:{judges:{fake:{adapter:${JSON.stringify(fake)},accepts:['images'],options:{log:${JSON.stringify(calls)},hashLog:${JSON.stringify(hashes)}}}}}}`),'flood.retest.ts':source})
 const run=await runProject(t,root,{timeouts:budgets({test:30000,setup:30000,cleanup:15000}),env:{RETEST_EVIDENCE_SECRET:value,RETEST_MEDIA_BINARY:binary,RETEST_FFMPEG:ffmpeg,NODE_OPTIONS:`--import=${loader}`}})
 writeFileSync(join(run.output,'cli-output.json'),JSON.stringify({exit:run.exit,stdout:run.stdout,stderr:run.stderr},null,2))
 const kept=await preserveReport(run,'flood'),html=readFileSync(join(kept,'report.html'),'utf8')
 t.diagnostic(`artifacts ${kept}; judge ${calls}; observations ${observed}`)
 secretAbsent(run,value)
 assert.deepEqual(filesHolding(proofRoot,value),[])
 assert.equal(run.exit.code,0)
 const result=run.result?.files.flatMap(file=>file.tests)[0]
 assert.ok(result)
 assert.equal(result.status,'passed')
 const summary=result.diagnostics?.[0]
 assert.ok(summary)
 assert.equal(summary.console.state,'partial')
 assert.ok(summary.console.state==='partial')
 assert.equal(summary.console.entries,10)
 assert.ok(summary.console.dropped>=1990)
 assert.ok(summary.console.bytes<=20000)
 assert.ok(summary.path)
 const read=parseArtifact(readFileSync(join(run.output,summary.path),'utf8'),summary.path)
 assert.ok(read.ok)
 const lines=read.lines
 assert.equal(lines.filter(line=>line.type==='console').length,10)
 assert.ok(html.includes(String(summary.console.dropped)))
 const recording=result.recordings?.[0]
 assert.ok(recording)
 assert.equal(recording.status,'partial')
 assert.ok(recording.gaps.some(gap=>gap.code==='pixels_withheld'))
 await verifyVideo(run,recording,observed)
 const withheld=eventsOf(run.events,'capture.withheld'),resumed=eventsOf(run.events,'capture.resumed')
 assert.equal(withheld.length,1)
 assert.equal(resumed.length,1)
 const from=withheld[0]?.fromUs,until=resumed[0]?.untilUs
 assert.ok(from!==undefined&&until!==undefined&&until>from&&recording.path)
 assert.deepEqual(observations(observed,recording).frames.filter(frame=>frame.timestampUs>=from&&frame.timestampUs<=until),[])
 const rgb=await decoder(ffmpeg,['-v','error','-xerror','-i',join(run.output,recording.path),'-vf','format=rgb24,scale=1:1:flags=area','-pix_fmt','rgb24','-f','rawvideo','pipe:1'])
 for(let index=0;index<rgb.length;index+=3)assert.equal((rgb[index]??0)>(rgb[index+1]??0)+(rgb[index+2]??0)+80,false,'no decoded flood frame contains the red secret scene')
 await verifyScreenshots(run,result)
 const requests:FakeCall[]=readFileSync(calls,'utf8').trim().split('\n').flatMap(line=>{const entry:{call?:FakeCall}=JSON.parse(line);return entry.call?[entry.call]:[]})
 const images=result.evaluations?.flatMap(check=>check.evidence)??[]
 assert.equal(requests.length,2)
 assert.equal(images.length,2)
 const delivered:DeliveredImages[]=readFileSync(hashes,'utf8').trim().split('\n').map(line=>JSON.parse(line))
 assert.equal(delivered.length,2)
 for(let index=0;index<images.length;index++){
  const image=images[index],sent=requests[index]?.evidence[0]
  assert.ok(image?.path&&sent)
  const bytes=readFileSync(join(run.output,image.path))
  assert.equal(sent.bytes,bytes.length)
  assert.equal(image.sha256,createHash('sha256').update(bytes).digest('hex'))
  assert.deepEqual(delivered[index]?.images,[{id:image.id,app:image.app,bytes:bytes.length,sha256:image.sha256,capturedAt:image.capturedAt}],'the actual judge image bytes and saved HTML reference are identical')
  assert.ok(html.includes(image.path))
 }
 writeFileSync(join(proofRoot,'flood-summary.json'),JSON.stringify({console:summary.console,recording,images,judgeRequests:requests.length},null,2))
})
