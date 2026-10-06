import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { startTaskService } from '../../fixtures/cross-platform/service/task-service.ts'
import { listSimulators } from '../../src/native/ios-simulator.ts'
import { systemTools } from '../../src/native/processes.ts'
import { budgets, configSource, eventsOf, filesHolding, runProject, writeProject } from './cli-harness.ts'
import { nativeSkipReason, processesWith, taskDeskApp, taskPhoneApp } from './native-harness.ts'
import { binary, decoder, ffmpeg, observationLoader, observations, preserveReport, proofRoot, secretAbsent, verifyScreenshots, verifyVideo } from './evidence-support.test.ts'
import { assertNativeObservationTimeoutDeadline } from './native-observation-deadline-fixture.ts'

const target = process.env['RETEST_EVIDENCE_NATIVE'] ?? 'ios-simulator'
assert.ok(target === 'ios-simulator' || target === 'macos')
const app = target === 'ios-simulator' ? 'phone' : 'desk'
const bundle = target === 'ios-simulator' ? 'dev.retest.fixtures.taskphone' : 'dev.retest.fixtures.taskdesk'
const unavailable = await nativeSkipReason(target)

const source = `import { expect, secret, test } from '@rehearsal-labs/retest'
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
for (const expected of ['ready', 'wrong']) test(expected, { apps: ['${app}'] }, async ({${app}:page}) => {
 await expect(page.getByTestId('service-status')).toContainText('Connected to ')
 await pause(1500)
 await test.evaluate({ judge:'fake', requirement:{pass:'The service ready state is shown.'}, evidence:{app:'${app}',capture:'screenshot'} })
 await page.getByTestId('account-field').fill('Evidence account')
 await expect(page.getByTestId('account-field')).toHaveValue('Evidence account')
${app === 'phone' ? ' await page.keyboard.dismiss()\n' : ''} await pause(1500)
${app === 'phone' ? ' // Re-read the owned app at the assertion boundary; an already-hidden keyboard sends no input.\n await page.keyboard.dismiss()\n' : ''} await expect(page.getByTestId('service-status')).toHaveText(expected === 'ready' ? /Connected to / : 'Wrong state', {timeout:5000})
})
test('secret fill', {apps:['${app}']}, async ({${app}:page}) => {
 await expect(page.getByTestId('service-status')).toContainText('Connected to ')
 await pause(1500)
 await page.getByTestId('account-field').fill(secret('value'))
 await expect(page.getByTestId('account-field')).toHaveValue('{{value}}')
 await pause(2000)
})`

test('a timed-out native tree observation retains its original deadline and failure without another read', assertNativeObservationTimeoutDeadline)

test(`recorded evidence on real ${target}, explicit native withholding and matching recording-off verdicts`, { timeout: 900000, skip: unavailable }, async t => {
  mkdirSync(proofRoot, { recursive: true })
  if (target === 'macos') assert.deepEqual(await processesWith('/TaskDesk.app/Contents/MacOS/TaskDesk'), [], 'never adopt an existing TaskDesk')
  const before = await listSimulators(systemTools, { timeoutMs:30000 })
  assert.ok(Array.isArray(before))
  const initial = new Set(before.map(device => device.udid))
  const service = await startTaskService({port:0})
  t.after(() => service.close())
  const secret = randomUUID()
  const observed = join(proofRoot, `${target}-observations`)
  const loader = observationLoader(observed)
  const fake = fileURLToPath(new URL('../support/fake-evaluator.ts', import.meta.url))
  const native = target === 'ios-simulator'
    ? `{platform:'ios-simulator',appPath:${JSON.stringify(taskPhoneApp)},device:'iPhone 17',runtime:'26.5',arguments:['-reset','-serviceURL',${JSON.stringify(service.url)}]}`
    : `{platform:'macos',appPath:${JSON.stringify(taskDeskApp)},arguments:['-reset','-windowFrame','20,60,700,480','-serviceURL',${JSON.stringify(service.url)}]}`
  const make = async (record: boolean) => writeProject(t, {
    'retest.config.ts': configSource(`{ apps:{${app}:${native}}, secrets:{value:env('RETEST_EVIDENCE_SECRET')}, secretOrigins:{value:[${JSON.stringify(bundle)}]}, recording:{record:${record},nativeWithholding:true,fps:10,size:{width:320,height:240}}, evaluation:{judges:{fake:{adapter:${JSON.stringify(fake)},accepts:['images']}}} }`),
    'evidence.retest.ts': source,
  })
  const timeouts = budgets({setup:300000,action:30000,assertion:20000,test:180000,cleanup:60000})
  const run = await runProject(t, await make(true), { timeouts, env:{RETEST_EVIDENCE_SECRET:secret,RETEST_MEDIA_BINARY:binary,RETEST_FFMPEG:ffmpeg,NODE_OPTIONS:`--import=${loader}`} })
  assert.equal(run.stderr.includes(secret) || run.stdout.includes(secret), false)
  writeFileSync(join(observed,'cli-output.json'),JSON.stringify({exit:run.exit,stderr:run.stderr,stdout:run.stdout},null,2))
  const kept = await preserveReport(run, `${target}-on`)
  t.diagnostic(`artifacts ${kept}; observations ${observed}`)
  const after = await listSimulators(systemTools,{timeoutMs:30000})
  assert.ok(Array.isArray(after))
  assert.deepEqual(after.filter(device=>!initial.has(device.udid)), [], 'no simulator created by the run remains')
  if(target==='macos') assert.deepEqual(await processesWith('/TaskDesk.app/Contents/MacOS/TaskDesk'), [], 'TaskDesk ended')
  secretAbsent(run, secret)
  assert.deepEqual(filesHolding(observed,secret),[])
  const results=run.result?.files.flatMap(file=>file.tests)??[]
  const coverageMessage=results.flatMap(result=>[
    ...(result.recordings??[]).flatMap(recording=>recording.gaps.map(gap=>gap.message)),
    result.failure?.message??'',
    ...(result.evaluations??[]).flatMap(check=>check.evidence.map(evidence=>evidence.reason??''))
  ]).find(message=>message.includes('lie over'))
  const coverage=coverageMessage===undefined?undefined:{message:coverageMessage}
  if(coverage){
    writeFileSync(join(proofRoot,'macos-refusal.json'),JSON.stringify({target:'not exercised',refusal:coverage.message},null,2))
    t.diagnostic(coverage.message)
  }
  await t.test('normal pass and assertion failure have independently decoded screenshots',async()=>{
    const normal=results[0],wrong=results[1]
    assert.ok(normal&&wrong)
    assert.equal(normal.status,'passed')
    assert.deepEqual([wrong.status,wrong.failure?.class],['failed','check_failed'])
    await verifyScreenshots(run,normal)
    await verifyScreenshots(run,wrong)
  })
  await t.test('recordings and screenshots independently decode with frame identity', async()=>{
    assert.deepEqual(results.map(result=>[result.status,result.failure?.class]),[['passed',undefined],['failed','check_failed'],['passed',undefined]])
    assert.equal(run.exit.code,1)
    const screenshot = results[1]?.evidence.find(item => item.kind === 'screenshot')
    assert.ok(screenshot)
    await decoder(ffmpeg,['-v','error','-xerror','-i',join(run.output,screenshot.path),'-f','null','-'])
    for(const result of results){
      const recording=result.recordings?.[0]
      assert.ok(recording)
      assert.deepEqual([recording.testId,recording.attemptId,recording.app,recording.sessionId],[result.testId,result.attemptId,app,`${result.attemptId}:${app}`])
      assert.equal(recording.mode,'screenshot-loop')
      assert.equal(recording.source,target==='ios-simulator'?'simulator-display':'window-crop')
      if(result!==results[2]) await verifyScreenshots(run,result)
      await verifyVideo(run,recording,observed)
    }
  })
  await t.test('explicit native withholding keeps a plain secret stretch out of every forwarded frame and image artifact',async()=>{
    const result=results[2],recording=result?.recordings?.[0]
    assert.ok(result&&recording?.path)
    const entries=eventsOf(run.events,'capture.native_entry').filter(event=>event.attemptId===result.attemptId)
    assert.equal(entries.length,1)
    assert.deepEqual([entries[0]?.nativeField,entries[0]?.branch],['plain','typed into a plain field, pixels withheld'])
    assert.equal(eventsOf(run.events,'capture.masked_entry').some(event=>event.attemptId===result.attemptId),false,'a plain field makes no secure-masking claim')
    assert.equal(recording.status,'partial')
    assert.ok(recording.gaps.some(gap=>gap.code==='pixels_withheld'))
    const withheld=eventsOf(run.events,'capture.withheld').filter(event=>event.attemptId===result.attemptId)
    assert.equal(withheld.length,1)
    const from=withheld[0]?.fromUs
    assert.ok(from!==undefined)
    assert.deepEqual(observations(observed,recording).frames.filter(frame=>frame.timestampUs>=from),[],'all input pixels after the secret are withheld through session end')
    assert.equal(eventsOf(run.events,'evidence.captured').some(event=>event.attemptId===result.attemptId),false)
    const frames=await decoder(ffmpeg,['-v','error','-xerror','-i',join(run.output,recording.path),'-f','null','-'])
    writeFileSync(join(observed,'secrecy.json'),JSON.stringify({withheldFromUs:from,approvedFramesAfterSecret:0,wholeDecode:true,decoderOutputBytes:frames.length},null,2))
  })
  if(coverage) return // The host refusal is retained as failing evidence; do not keep exercising the covered app.
  await t.test('recording off launches no media and keeps verdicts',async()=>{
    const off=await runProject(t,await make(false),{timeouts,env:{RETEST_EVIDENCE_SECRET:secret,RETEST_MEDIA_BINARY:'/missing-media',RETEST_FFMPEG:'/missing-ffmpeg'}})
    await preserveReport(off,`${target}-off`)
    secretAbsent(off,secret)
    assert.equal(off.exit.code,run.exit.code)
    assert.deepEqual(off.result?.files.flatMap(file=>file.tests).map(result=>[result.status,result.failure?.class]),results.map(result=>[result.status,result.failure?.class]))
    assert.equal(off.events.some(event=>event.type.startsWith('media.')||event.type.startsWith('recording.')),false)
    assert.ok(off.result?.files.flatMap(file=>file.tests).every(result=>result.recordings===undefined))
  })
})
