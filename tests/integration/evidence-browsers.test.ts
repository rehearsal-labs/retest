import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { servePages } from './browser-harness.ts'
import { budgets, configSource, eventsOf, filesHolding, runProject, writeProject } from './cli-harness.ts'
import { engineUnderTest } from './engines.ts'
import { binary, decoder, ffmpeg, observationLoader, observations, preserveReport, proofRoot, secretAbsent, verifyScreenshots, verifyVideo } from './evidence-support.test.ts'
import { recordingSkip } from './recording-harness.ts'

const source = `import { expect, secret, test } from '@rehearsal-labs/retest'
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
for (const expected of ['Safe before', 'Wrong title']) test(expected, async ({page}) => {
 await page.goto('/')
 await expect(page.getByTestId('state')).toHaveText('Safe before')
 await pause(350)
 await test.evaluate({ judge: 'fake', requirement: { pass: 'The safe state is shown.' }, evidence: { capture: 'screenshot' } })
 await page.goto('/after')
 await expect(page.getByTestId('state')).toHaveText('Safe after')
 await pause(350)
 await expect(page.getByTestId('state')).toHaveText(expected === 'Safe before' ? 'Safe after' : expected)
})
test('secret fill', async ({page}) => {
 await page.goto('/')
 await expect(page.getByTestId('state')).toHaveText('Safe before')
 await pause(400)
 await page.getByTestId('entry').fill(secret('value'))
 await expect(page.getByTestId('state')).toHaveText('Secret state')
 await pause(500)
 await page.goto('/after')
 await expect(page.getByTestId('state')).toHaveText('Safe after')
 await pause(500)
})`

const before = '<body style="margin:0;background:#0000ff"><p data-testid="state">Safe before</p><input data-testid="entry" oninput="document.body.style.background=\'#ff0000\';document.querySelector(\'[data-testid=state]\').textContent=\'Secret state\'">'
const after = '<body style="margin:0;background:#00ff00"><p data-testid="state">Safe after</p>'

test(`recorded evidence on real ${engineUnderTest().label}, secret pixels withheld and recording off keeps verdicts`, { timeout: 180000, skip: recordingSkip }, async t => {
  const engine = engineUnderTest()
  const site = await servePages(t, { '/': before, '/after': after })
  const secret = randomUUID()
  const observed = join(proofRoot, `${engine.name}-observations`)
  const loader = observationLoader(observed)
  const fake = fileURLToPath(new URL('../support/fake-evaluator.ts', import.meta.url))
  const make = async (record: boolean) => writeProject(t, {
    'retest.config.ts': configSource(`{ apps: { web: ${engine.target(`baseUrl: ${JSON.stringify(site.url)}`)} }, secrets: { value: env('RETEST_EVIDENCE_SECRET') }, recording: { record: ${record}, fps: 10, size: {width:320,height:240} }, evaluation: { judges: { fake: {adapter:${JSON.stringify(fake)}, accepts:['images']} } } }`),
    'evidence.retest.ts': source,
  })
  mkdirSync(proofRoot, { recursive: true })
  const run = await runProject(t, await make(true), { timeouts: budgets({ test: 30000, setup: 30000, cleanup: 15000 }), env: { RETEST_EVIDENCE_SECRET: secret, RETEST_MEDIA_BINARY: binary, RETEST_FFMPEG: ffmpeg, NODE_OPTIONS: `--import=${loader}` } })
  assert.equal(run.stderr.includes(secret) || run.stdout.includes(secret), false)
  writeFileSync(join(observed, 'cli-output.json'), JSON.stringify({exit:run.exit, stderr:run.stderr, stdout:run.stdout}, null, 2))
  // Save before verification, so a failed check retains its complete real-target run.
  const kept = await preserveReport(run, `${engine.name}-on`)
  t.diagnostic(`artifacts ${kept}; observations ${observed}`)
  secretAbsent(run, secret)
  assert.deepEqual(filesHolding(observed, secret), [], 'approved source images and metadata contain no secret bytes')
  assert.equal(run.exit.code, 1)
  const results = run.result?.files.flatMap(file => file.tests) ?? []
  assert.deepEqual(results.map(result => [result.status, result.failure?.class]), [['passed', undefined], ['failed', 'check_failed'], ['passed', undefined]])
  const screenshot = results[1]?.evidence.find(item => item.kind === 'screenshot')
    assert.ok(screenshot)
  await decoder(ffmpeg, ['-v', 'error', '-xerror', '-i', join(run.output, screenshot.path), '-f', 'null', '-'])
  for (const result of results) {
    const recording = result.recordings?.[0]
    assert.ok(recording)
    assert.deepEqual([recording.testId, recording.attemptId, recording.app, recording.sessionId], [result.testId, result.attemptId, 'web', `${result.attemptId}:web`])
    assert.equal(recording.mode, engine.name === 'firefox' ? 'screenshot-loop' : 'screencast')
    assert.equal(recording.source, engine.name)
    assert.ok(recording.status === 'complete' || recording.gaps.every(gap => gap.message.length > 0))
    if (result !== results[2]) await verifyScreenshots(run, result)
    await verifyVideo(run, recording, observed)
  }
  await t.test('secret interval excludes exposed pixels and retains both safe states', async () => {
  const secretTest = results[2]
  const recording = secretTest?.recordings?.[0]
  assert.ok(secretTest && recording?.path)
  const withheld = eventsOf(run.events, 'capture.withheld').filter(event => event.attemptId === secretTest.attemptId)
  const resumed = eventsOf(run.events, 'capture.resumed').filter(event => event.attemptId === secretTest.attemptId)
  assert.equal(withheld.length, 1)
  assert.equal(resumed.length, 1)
  const from = withheld[0]?.fromUs, until = resumed[0]?.untilUs
  assert.ok(from !== undefined && until !== undefined && until > from)
  const frames = observations(observed, recording).frames
  assert.deepEqual(frames.filter(frame => frame.timestampUs >= from && frame.timestampUs <= until), [], 'no approved frame in the secret stretch')
  const rgb = await decoder(ffmpeg, ['-v', 'error', '-xerror', '-i', join(run.output, recording.path), '-vf', 'format=rgb24,scale=1:1:flags=area', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'])
  let blue = 0, green = 0
  for (let index = 0; index < rgb.length; index += 3) {
    const r = rgb[index] ?? 0, g = rgb[index + 1] ?? 0, b = rgb[index + 2] ?? 0
    assert.equal(r > g + b + 80, false, 'no decoded frame holds the red secret state')
    if (b > r + g + 80) blue += 1
    if (g > r + b + 80) green += 1
  }
  writeFileSync(join(observed, 'secrecy.json'), JSON.stringify({ fromUs: from, untilUs: until, withheldFrames: 0, decodedFrames: rgb.length / 3, blue, green }, null, 2))
  assert.ok(blue > 0 && green > 0, 'video retains safe states before and after withholding')
  assert.equal(recording.status, 'partial')
  assert.ok(recording.gaps.some(gap => gap.code === 'pixels_withheld'))
  writeFileSync(join(observed, 'secrecy.json'), JSON.stringify({ fromUs: from, untilUs: until, withheldFrames: 0, decodedFrames: rgb.length / 3, blue, green }, null, 2))
  })
  const off = await runProject(t, await make(false), { timeouts: budgets({ test:30000, setup:30000, cleanup:15000 }), env: { RETEST_EVIDENCE_SECRET: secret, RETEST_MEDIA_BINARY: '/missing-media', RETEST_FFMPEG: '/missing-ffmpeg' } })
  await preserveReport(off, `${engine.name}-off`)
  secretAbsent(off, secret)
  assert.equal(off.exit.code, run.exit.code)
  assert.deepEqual(off.result?.files.flatMap(file => file.tests).map(result => [result.status, result.failure?.class]), results.map(result => [result.status, result.failure?.class]))
  assert.equal(off.events.some(event => event.type.startsWith('media.') || event.type.startsWith('recording.')), false)
  assert.ok(off.result?.files.flatMap(file => file.tests).every(result => result.recordings === undefined))
  t.diagnostic(`on/off verdicts for ${engine.label}; ${results.length} on verdicts match off; ${eventsOf(run.events, 'media.started').length} media process; ${readFileSync(join(observed, 'secrecy.json'), 'utf8')}`)
})
