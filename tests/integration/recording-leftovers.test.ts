import type { EventBody } from '../../src/protocol/events.ts'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { RunMedia, startMediaProcess } from '../../src/runner/run-media.ts'
import { OwnedProcessGroup } from '../../src/shared/process-ownership.ts'
import { rebuildResult } from '../../src/store/rebuild-result.ts'
import { readFinishedRun, repositoryRoot, waitFor } from './cli-harness.ts'
import { killOwned, ownershipOf, partialFiles, recordingRun, recordingSkip } from './recording-harness.ts'

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
})
