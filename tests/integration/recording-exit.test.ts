import assert from 'node:assert/strict'
import { test } from 'node:test'
import { rebuildResult } from '../../src/store/rebuild-result.ts'
import { readFinishedRun, waitFor } from './cli-harness.ts'
import { encoderPid, finishRecordingRun, killOwned, ownershipOf, recordingRun, recordingSkip, saveProof } from './recording-harness.ts'

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
  assert.deepEqual(run.exit, { code: null, signal: 'SIGKILL' })
  assert.equal(run.result, undefined)
  // The assertion precedes harness cleanup: only the runner is killed by the test body.
  await waitFor('the worker and all launch descendants to stop after the runner died', () => !owner.remains())
  assert.deepEqual(owner.readProblems, [])
  const rebuilt = rebuildResult(run.events)
  assert.equal(rebuilt.evidenceStatus?.state, 'unavailable')
  assert.equal(rebuilt.files.flatMap(file => file.tests)[0]?.recordings?.[0]?.gaps[0]?.code, 'run_stopped')
  saveProof(run, 'runner-exit')
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
  saveProof(run, 'required-evidence')
})
