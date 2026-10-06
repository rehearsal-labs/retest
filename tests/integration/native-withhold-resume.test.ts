import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { startTaskService } from '../../fixtures/cross-platform/service/task-service.ts'
import { budgets, configSource, eventsOf, runProject, writeProject } from './cli-harness.ts'
import { nativeSkipReason, processesWith, taskDeskApp } from './native-harness.ts'
import { verifyNativeSourcePrivacy } from './evidence-native-privacy.ts'
import { binary, ffmpeg, observationLoader, observations, preserveReport, proofRoot, secretAbsent, verifyScreenshots, verifyVideo } from './evidence-support.test.ts'

const unavailable = await nativeSkipReason('macos')

test('real desk secure focus loss keeps pixels with whole-source privacy', { skip: unavailable, timeout: 300000 }, async t => {
  assert.deepEqual(await processesWith('/TaskDesk.app/Contents/MacOS/TaskDesk'), [], 'never adopt an existing TaskDesk')
  const service = await startTaskService({ port: 0, printLine: () => undefined })
  t.after(() => service.close())
  const secretValue = randomUUID()
  const observed = join(proofRoot, 'native-resume-observations')
  const loader = observationLoader(observed)
  const evaluator = fileURLToPath(new URL('../support/fake-evaluator.ts', import.meta.url))
  const root = await writeProject(t, {
    'retest.config.ts': configSource(`{
      apps: { desk: { platform: 'macos', appPath: ${JSON.stringify(taskDeskApp)}, arguments: ['-reset', '-windowFrame', '20,60,700,480', '-serviceURL', ${JSON.stringify(service.url)}] } },
      secrets: { value: env('RETEST_NATIVE_PIXEL_SECRET') }, secretOrigins: { value: ['dev.retest.fixtures.taskdesk'] },
      recording: { record: true, fps: 10, size: { width: 320, height: 240 } },
      evaluation: { judges: { fake: { adapter: ${JSON.stringify(evaluator)}, accepts: ['images'] } } }
    }`),
    'resume.retest.ts': `import { expect, secret, test } from '@rehearsal-labs/retest'
      test('keeps the wrong-state failure after secure focus loss', { apps: ['desk'] }, async ({ desk }) => {
        await expect(desk.getByTestId('service-status')).toContainText('Connected to ')
        await test.evaluate({ judge: 'fake', requirement: { ready: 'The sign-in form is visible.' }, evidence: { app: 'desk', capture: 'screenshot' } })
        await desk.getByTestId('password-field').fill(secret('value'))
        await desk.getByTestId('account-field').fill('Pixel proof')
        await expect(desk.getByTestId('account-field')).toHaveValue('Pixel proof')
        await test.evaluate({ judge: 'fake', requirement: { ready: 'The sign-in form is visible.' }, evidence: { app: 'desk', capture: 'screenshot' } })
        await expect(desk.getByTestId('service-status')).toHaveText('Wrong state', { timeout: 5000 })
      })`,
  })
  const run = await runProject(t, root, {
    timeouts: budgets({ setup: 180000, action: 30000, assertion: 10000, test: 120000, cleanup: 60000 }),
    env: { RETEST_NATIVE_PIXEL_SECRET: secretValue, RETEST_MEDIA_BINARY: binary, RETEST_FFMPEG: ffmpeg, NODE_OPTIONS: `--import=${loader}` },
    args: ['--workers', '1'],
  })
  const kept = await preserveReport(run, 'native-resume-recorded')
  t.diagnostic(`artifacts ${kept}; observations ${observed}`)
  assert.deepEqual(await processesWith('/TaskDesk.app/Contents/MacOS/TaskDesk'), [], 'TaskDesk ended')
  secretAbsent(run, secretValue)
  const result = run.result?.files.flatMap(file => file.tests)[0]
  assert.ok(result)
  assert.deepEqual([result.status, result.failure?.class, run.exit.code], ['failed', 'check_failed', 1])
  const withheld = eventsOf(run.events, 'capture.withheld')
  const resumed = eventsOf(run.events, 'capture.resumed').filter(event => event.endedBy !== 'session_ended')
  assert.equal(withheld.length, 0, 'OS secure input needs no withheld stretch')
  assert.equal(resumed.length, 0)
  const masked = eventsOf(run.events, 'capture.masked_entry')
  assert.equal(masked.length, 1)
  assert.equal(masked[0]?.nativeField, 'secure')
  const recording = result.recordings?.[0]
  assert.ok(recording)
  const approved = observations(observed, recording)
  const entry = masked[0]
  assert.ok(entry)
  assert.ok(approved.frames.some(frame => frame.timestampUs < entry.atUs), 'pre-entry captures exist')
  assert.ok(approved.frames.some(frame => frame.timestampUs >= entry.atUs), 'secure captures continue')
  assert.equal(recording.gaps.some(gap => gap.code === 'pixels_withheld'), false)
  await verifyScreenshots(run, result)
  await verifyVideo(run, recording, observed)
  const sourcePrivacy = await verifyNativeSourcePrivacy(run, observed, secretValue, ['desk'])
  writeFileSync(join(observed, 'secrecy.json'), JSON.stringify({ maskedEntries: masked.length, withheldIntervals: 0, sourcePrivacy, wholeVideoDecoded: true }, null, 2) + '\n')
})
