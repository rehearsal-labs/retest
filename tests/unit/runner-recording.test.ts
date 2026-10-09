import type { RetestEvent } from '../../src/protocol/events.ts'
import type { TestResult } from '../../src/protocol/result.ts'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, test } from 'node:test'
import { formatSessionId } from '../../src/protocol/evidence.ts'
import { ownStartTime } from '../../src/runner/media-leftovers.ts'
import { rebuildRecordedResult, rebuildResult } from '../../src/store/rebuild-result.ts'
import { tempProject } from '../support/project.ts'
import { eventsOfType, newRunFolder } from '../support/run-harness.ts'
import { unpinnedMedia } from '../support/unpinned-host.ts'
import { endedPid } from './native-fake-tools.ts'
import { fakeMediaStarter, recordProject } from './runner-recording-fakes.ts'

const tests = `import { expect, secret, test } from '@rehearsal-labs/retest'

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('saves a task', async ({ page }) => {
  await page.goto('/')
  await pause(120)
  await page.getByTestId('task-title').fill('Release checklist')
  await page.getByTestId('save-task').click()
  await expect(page.getByTestId('saved-task')).toHaveText('Release checklist')
})

test('shows the wrong task', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('task-title').fill('Draft')
  await page.getByTestId('save-task').click()
  await pause(120)
  await expect(page.getByTestId('saved-task')).toHaveText('Release checklist')
})

test('types a secret and fails', async ({ page }) => {
  await page.goto('/login')
  await pause(120)
  await page.getByTestId('task-title').fill(secret('password'))
  await pause(120)
  await expect(page.getByTestId('saved-task')).toHaveText('Signed in')
})
`

const signIn = `import { expect, secret, test } from '@rehearsal-labs/retest'

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('signs in and goes on', async ({ page }) => {
  await page.goto('/login')
  await pause(150)
  await page.getByTestId('task-title').fill(secret('password'))
  await pause(150)
  await page.getByTestId('tasks-link').click()
  await pause(150)
  await expect(page.getByTestId('save-task')).toBeVisible()
})
`

function config(block = ''): string {
  return `import { chromium, defineConfig } from '@rehearsal-labs/retest'

export default defineConfig({
  apps: { web: chromium({ baseUrl: 'http://127.0.0.1:4173', executablePath: '/fake/chromium' }) },
  secrets: { password: () => 'hunter2-7391-secret' },
  secretOrigins: { password: ['http://127.0.0.1:4173'] },
  ${block}
})
`
}

const newTypes = new Set(['recording.started', 'recording.finished', 'media.started', 'media.failed', 'media.lost', 'media.closed', 'media.leftovers', 'capture.withheld', 'capture.resumed', 'capture.masked_entry', 'artifact.removed', 'artifact.removal_failed'])

function named(tests: readonly TestResult[], name: string): TestResult {
  const found = tests.find((each) => each.name === name)
  assert.ok(found, `a test named ${name}`)
  return found
}

function allTests(result: { files: { tests: TestResult[] }[] }): TestResult[] {
  return result.files.flatMap((file) => file.tests)
}

// What an event says, without what changes from one run to the next.
function shape(event: RetestEvent): string {
  const { type } = event
  // A look's wait is how long the page took to change, which differs from one run to the next.
  const keys = Object.keys(event).filter((key) => !['sequence', 'time', 'elapsedMs', 'runId', 'attemptId', 'durationMs', 'pid', 'waitedMs'].includes(key)).sort()
  return `${type}:${keys.join(',')}`
}

describe('a run that records nothing', async () => {
  const plain = tempProject({ 'retest.config.ts': config(), 'tests/tasks.retest.ts': tests })
  const off = tempProject({ 'retest.config.ts': config('recording: { record: false },'), 'tests/tasks.retest.ts': tests })
  const media = fakeMediaStarter()
  const before = await recordProject(plain, { files: ['tests/tasks.retest.ts'], startMedia: media.start })
  const after = await recordProject(off, { files: ['tests/tasks.retest.ts'], startMedia: media.start })

  test('starts no media or recording while secret withholding policy stays active', () => {
    assert.equal(media.started.length, 0)
    for (const run of [before, after]) {
      assert.deepEqual(run.events.filter((event) => newTypes.has(event.type)).map((event) => event.type), ['capture.withheld', 'capture.resumed'])
      assert.ok(eventsOfType(run.events, 'test.finished').every((event) => event.evidenceStatus === undefined))
      assert.equal(eventsOfType(run.events, 'run.finished')[0]?.evidenceStatus, undefined)
      assert.equal(run.result.evidenceStatus, undefined)
      assert.ok(allTests(run.result).every((each) => each.recordings === undefined && each.evidenceStatus === undefined))
      for (const page of run.browsers.flatMap((browser) => browser.framed)) assert.equal(page.sources.length, 0, 'no frame source was asked for')
    }
  })

  test('runs as a run without the block does: the same events in the same order, the same outcomes and exit code', () => {
    // A failing check looks again until its time runs out, so how many looks it took differs between two runs; each run
    // of the same event in a row counts once.
    const collapsed = (events: readonly RetestEvent[]): string[] => events.map(shape).filter((each, index, all) => index === 0 || all[index - 1] !== each)
    assert.deepEqual(collapsed(after.events), collapsed(before.events))
    assert.deepEqual(allTests(after.result).map((each) => [each.name, each.status, each.failure?.class]), allTests(before.result).map((each) => [each.name, each.status, each.failure?.class]))
    assert.equal(after.result.exitCode, before.result.exitCode)
    assert.equal(before.result.exitCode, 1)
  })

  test('withholds a secret failure screenshot through the withheld stretch with recording off', () => {
    for (const run of [before, after]) {
      const secretTest = named(allTests(run.result), 'types a secret and fails')
      assert.equal(secretTest.status, 'failed')
      assert.equal(secretTest.evidence.length, 0)
      assert.equal(eventsOfType(run.events, 'evidence.captured').filter(event => event.attemptId === secretTest.attemptId).length, 0)
      const refused = eventsOfType(run.events, 'evidence.failed').filter(event => event.attemptId === secretTest.attemptId)
      assert.equal(refused.length, 1)
      assert.equal(refused[0]?.reason, 'failure')
      assert.equal(refused[0]?.withheld, 'secret_entry')
      const withheld = eventsOfType(run.events, 'capture.withheld').filter(event => event.attemptId === secretTest.attemptId)
      const resumed = eventsOfType(run.events, 'capture.resumed').filter(event => event.attemptId === secretTest.attemptId)
      assert.equal(withheld.length, 1)
      assert.equal(resumed.length, 1)
      assert.ok(withheld[0] && refused[0] && resumed[0] && withheld[0].sequence < refused[0].sequence && refused[0].sequence < resumed[0].sequence)
    }
  })
})

describe('a run that records', { skip: unpinnedMedia }, async () => {
  const root = tempProject({ 'retest.config.ts': config("recording: { record: true, size: { width: 800, height: 600 }, fps: 10 },"), 'tests/tasks.retest.ts': tests })
  const media = fakeMediaStarter()
  const run = await recordProject(root, { files: ['tests/tasks.retest.ts'], startMedia: media.start })
  const results = allTests(run.result)

  test('starts one media process for the run, and closes it', () => {
    assert.equal(media.started.length, 1)
    assert.equal(media.started[0]?.closes, 1)
    assert.equal(eventsOfType(run.events, 'media.started').length, 1)
    const closed = eventsOfType(run.events, 'media.closed')
    assert.equal(closed.length, 1)
    const finished = eventsOfType(run.events, 'run.finished')[0]
    assert.ok(finished !== undefined && closed[0] !== undefined && closed[0].sequence < finished.sequence, 'the media process closed before the run reported')
  })

  test('records each app session once, with the run, attempt, test, app and session identity', () => {
    const recordings = media.started[0]?.recordings ?? []
    assert.equal(recordings.length, results.length)
    for (const result of results) {
      const recording = recordings.find((each) => each.start.identity.attemptId === result.attemptId)
      assert.ok(recording !== undefined, result.name)
      assert.deepEqual(recording.start.identity, { runId: run.result.runId, attemptId: result.attemptId, testId: result.testId, app: 'web', sessionId: formatSessionId(result.attemptId, 'web') })
      assert.deepEqual({ width: recording.start.width, height: recording.start.height, fps: recording.start.fps }, { width: 800, height: 600, fps: 10 })
      assert.ok(recording.start.output.includes(`/artifacts/${result.attemptId}/`), recording.start.output)
    }
    assert.equal(new Set(recordings.map((each) => each.start.output)).size, recordings.length, 'no two attempts share an output')
  })

  test("starts each recording before the session's first action, and finishes it before the attempt's end", () => {
    for (const result of results) {
      const own = run.events.filter((event) => 'attemptId' in event && event.attemptId === result.attemptId)
      const started = own.findIndex((event) => event.type === 'recording.started')
      const firstAction = own.findIndex((event) => event.type === 'action.completed' || event.type === 'action.failed')
      const finished = own.findIndex((event) => event.type === 'recording.finished')
      const ended = own.findIndex((event) => event.type === 'test.finished')
      assert.ok(started >= 0 && firstAction > started, `${result.name}: recording.started at ${started}, first action at ${firstAction}`)
      assert.ok(finished > firstAction && finished < ended, `${result.name}: recording.finished at ${finished}, test.finished at ${ended}`)
    }
  })

  test('keeps evidence apart from the outcome: a failed test has complete evidence and keeps its failure', () => {
    const passed = named(results, 'saves a task')
    const failed = named(results, 'shows the wrong task')
    assert.equal(passed.status, 'passed')
    assert.equal(failed.status, 'failed')
    assert.equal(failed.failure?.class, 'check_failed')
    for (const result of [passed, failed]) {
      assert.deepEqual(result.evidenceStatus, { state: 'complete' })
      assert.equal(result.recordings?.length, 1)
      assert.equal(result.recordings?.[0]?.status, 'complete')
      assert.match(result.recordings?.[0]?.path ?? '', new RegExp(`^artifacts/${result.attemptId}/web-[a-z0-9-]+/recording-1\\.mp4$`))
    }
    assert.equal(run.result.exitCode, 1)
  })

  test('a recording lays the run\'s events over its video from the events alone', () => {
    const passed = named(results, 'saves a task')
    const record = passed.recordings?.[0]
    assert.ok(record?.clock !== undefined)
    const own = run.events.filter((event) => 'attemptId' in event && event.attemptId === passed.attemptId)
    const actions = own.filter((event) => event.type === 'action.completed')
    assert.ok(actions.length >= 3)
    for (const action of actions) {
      const videoUs = action.elapsedMs * 1000 - record.clock.videoZeroUs
      assert.ok(videoUs >= -1000 && videoUs <= record.clock.durationUs + 1000, `${action.command} at ${videoUs} µs of ${record.clock.durationUs}`)
    }
  })

  test('the secret fill withheld the session, and the failure screenshot that would have shown it', () => {
    const secretTest = named(results, 'types a secret and fails')
    assert.equal(secretTest.status, 'failed')
    assert.equal(secretTest.evidence.length, 0)
    const withheld = eventsOfType(run.events, 'evidence.failed').find((event) => event.attemptId === secretTest.attemptId)
    assert.equal(withheld?.withheld, 'secret_entry')
    assert.equal(secretTest.evidenceStatus?.state, 'partial')
    assert.deepEqual(secretTest.evidenceStatus?.gaps?.map((gap) => gap.code).sort(), ['pixels_withheld', 'screenshot_withheld'])
    const stretch = eventsOfType(run.events, 'capture.withheld').find((event) => event.attemptId === secretTest.attemptId)
    assert.ok(stretch !== undefined)
    assert.equal(stretch.secret, 'password')
    const recording = media.started[0]?.recordings.find((each) => each.start.identity.attemptId === secretTest.attemptId)
    assert.ok(recording !== undefined)
    assert.ok(recording.frames.every((frame) => frame.timestampUs < stretch.fromUs), 'no frame from the stretch on reached the media process')
    assert.ok(recording.gaps.some((gap) => gap.reason === 'pixels_withheld' && gap.fromUs <= stretch.fromUs + 1000), JSON.stringify(recording.gaps))
  })

  test('an unfinished recorded run rebuilds with unavailable evidence on its test and run', () => {
    const start = run.events.findIndex(event => event.type === 'recording.started')
    assert.ok(start > 0)
    const rebuilt = rebuildResult(run.events.slice(0, start + 1))
    assert.equal(allTests(rebuilt)[0]?.evidenceStatus?.state, 'unavailable')
    assert.equal(rebuilt.evidenceStatus?.state, 'unavailable')
  })

  test('a failed retention unlink does not claim that a recording was removed', () => {
    const event = eventsOfType(run.events, 'recording.finished')[0]
    assert.ok(event?.recording.path)
    const scope = { schemaVersion: event.schemaVersion, runId: event.runId, sequence: event.sequence, time: event.time, elapsedMs: event.elapsedMs, origin: event.origin, ...(event.session === undefined ? {} : { session: event.session }), testId: event.testId, attemptId: event.attemptId, sessionId: event.sessionId }
    const removed = { ...scope, type: 'artifact.removed' as const, path: event.recording.path, kind: 'recording' as const, reason: 'passed_attempt_recording' as const, moment: 'attempt_finished' as const, bytes: 5 }
    const refused = { ...scope, type: 'artifact.removal_failed' as const, path: removed.path, kind: removed.kind, moment: removed.moment, reason: removed.reason, message: 'The file was replaced before unlink.' }
    const rebuilt = rebuildResult([...run.events, removed, refused])
    assert.equal(allTests(rebuilt).find(test => test.attemptId === event.attemptId)?.recordings?.[0]?.removed, undefined)
  })

  test('the run says its evidence, and a result rebuilt from the events equals result.json', () => {
    assert.deepEqual(run.result.evidenceStatus, { state: 'partial', attempts: { complete: 2, partial: 1, unavailable: 0, notRequested: 0 } })
    assert.deepEqual(rebuildRecordedResult(run.events), run.written)
  })
})

describe('a secret typed, then a page that opens another document', { skip: unpinnedMedia }, async () => {
  const root = tempProject({ 'retest.config.ts': config('recording: { record: true },'), 'tests/sign-in.retest.ts': signIn })
  const media = fakeMediaStarter()
  const run = await recordProject(root, { files: ['tests/sign-in.retest.ts'], startMedia: media.start })
  const [result] = allTests(run.result)

  test('withholds from before the first key until the new document, then starts the capture afresh and keeps its frames', () => {
    assert.equal(result?.status, 'passed', result?.failure?.message)
    const withheld = eventsOfType(run.events, 'capture.withheld')[0]
    const resumed = eventsOfType(run.events, 'capture.resumed')[0]
    assert.ok(withheld !== undefined && resumed !== undefined)
    assert.equal(resumed.endedBy, 'new_document')
    const recording = media.started[0]?.recordings[0]
    assert.ok(recording !== undefined)
    const inside = recording.frames.filter((frame) => frame.timestampUs >= withheld.fromUs && frame.timestampUs <= resumed.untilUs)
    assert.deepEqual(inside, [], 'no frame of the stretch is in the recording')
    assert.ok(recording.frames.some((frame) => frame.timestampUs > resumed.untilUs), 'frames after the stretch are kept')
    const page = run.browsers[0]?.framed[0]
    assert.ok((page?.sources.length ?? 0) >= 2, 'the capture was started again after the stretch')
    const gap = recording.gaps.find((each) => each.reason === 'pixels_withheld')
    assert.ok(gap !== undefined && gap.fromUs <= withheld.fromUs + 1000 && gap.toUs >= resumed.untilUs - 1000, JSON.stringify({ gap, withheld, resumed }))
  })

  test('the recording is partial with the withheld stretch named, and the test keeps its pass', () => {
    const record = result?.recordings?.[0]
    assert.equal(record?.status, 'partial')
    assert.deepEqual(record?.gaps.map((gap) => gap.code), ['pixels_withheld'])
    assert.ok((record?.withheld?.stretches ?? 0) >= 1)
    assert.equal(run.result.exitCode, 0)
    assert.deepEqual(rebuildRecordedResult(run.events), run.written)
  })
})

// A run that names no media binary reads RETEST_MEDIA_BINARY, so the variable is kept out of these runs whatever the
// machine running the tests has set.
async function withoutMediaVariable<T>(work: () => Promise<T>): Promise<T> {
  const saved = process.env['RETEST_MEDIA_BINARY']
  delete process.env['RETEST_MEDIA_BINARY']
  try {
    return await work()
  } finally {
    if (saved !== undefined) process.env['RETEST_MEDIA_BINARY'] = saved
  }
}

describe('a run whose media process cannot start', async () => {
  const root = tempProject({ 'retest.config.ts': config('recording: { record: true },'), 'tests/tasks.retest.ts': tests })
  const missing = await recordProject(root, { files: ['tests/tasks.retest.ts'], startMedia: fakeMediaStarter({ refuse: 'spawn ENOENT' }).start })
  const required = tempProject({ 'retest.config.ts': config('recording: { record: true, required: true },'), 'tests/tasks.retest.ts': tests })
  const strict = await recordProject(required, { files: ['tests/tasks.retest.ts'], media: { executable: '/missing/retest-media' }, startMedia: fakeMediaStarter({ refuse: 'spawn /missing/retest-media ENOENT' }).start })

  test('keeps every test\'s outcome and names the missing evidence on each', () => {
    for (const run of [missing, strict]) {
      const results = allTests(run.result)
      assert.deepEqual(results.map((each) => [each.name, each.status]), [['saves a task', 'passed'], ['shows the wrong task', 'failed'], ['types a secret and fails', 'failed']])
      for (const result of results) {
        assert.equal(result.evidenceStatus?.state, 'unavailable')
        assert.equal(result.recordings?.[0]?.status, 'unavailable')
      }
    }
    const [gap] = named(allTests(missing.result), 'saves a task').recordings?.[0]?.gaps ?? []
    assert.equal(gap?.code, 'media_unavailable')
    assert.match(gap?.message ?? '', /spawn ENOENT/)
    assert.equal(eventsOfType(missing.events, 'media.failed').length, 1)
  })

  test('a run that does not require evidence keeps its exit code; one that does ends with evidence_incomplete', () => {
    assert.equal(missing.result.exitCode, 1)
    assert.equal(missing.result.failure, undefined)
    assert.equal(strict.result.exitCode, 1, 'a failed test still leads')
    assert.equal(strict.result.failure?.class, 'evidence_incomplete')
    assert.equal(strict.result.complete, false)
    assert.deepEqual(rebuildRecordedResult(strict.events), strict.written)
  })
})

describe('a passing run that requires evidence it cannot have', { skip: unpinnedMedia }, async () => {
  const passing = `import { expect, test } from '@rehearsal-labs/retest'

test('saves a task', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('task-title').fill('Release checklist')
  await page.getByTestId('save-task').click()
  await expect(page.getByTestId('saved-task')).toHaveText('Release checklist')
})
`
  const root = tempProject({ 'retest.config.ts': config('recording: { record: true, required: true },'), 'tests/tasks.retest.ts': passing })
  const run = await withoutMediaVariable(() => recordProject(root, { files: ['tests/tasks.retest.ts'] }))

  test('passes its test and ends with exit 2 and its own named failure', () => {
    const [result] = allTests(run.result)
    assert.equal(result?.status, 'passed')
    assert.equal(result?.recordings?.[0]?.gaps[0]?.code, 'media_unavailable')
    assert.match(result?.recordings?.[0]?.gaps[0]?.message ?? '', /RETEST_MEDIA_BINARY/)
    assert.deepEqual({ exitCode: run.result.exitCode, status: run.result.status, failure: run.result.failure?.class }, { exitCode: 2, status: 'error', failure: 'evidence_incomplete' })
  })
})

describe('a media process that crashes during a test', { skip: unpinnedMedia }, async () => {
  const two = `import { expect, test } from '@rehearsal-labs/retest'

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('first', async ({ page }) => {
  await page.goto('/')
  await pause(100)
  await page.getByTestId('task-title').fill('crash now')
  await pause(100)
  await expect(page.getByTestId('save-task')).toBeVisible()
})

test('second', async ({ page }) => {
  await page.goto('/')
  await pause(100)
  await expect(page.getByTestId('save-task')).toBeVisible()
})
`
  const root = tempProject({ 'retest.config.ts': config('recording: { record: true },'), 'tests/two.retest.ts': two })
  const media = fakeMediaStarter()
  const run = await recordProject(root, {
    files: ['tests/two.retest.ts'],
    startMedia: media.start,
    fake: { onCommand: (command) => {
      if (command.kind === 'fill' && command.value === 'crash now') media.started[0]?.crash()
    } },
  })
  const [first, second] = allTests(run.result)

  test('never changes an outcome: both tests pass', () => {
    assert.equal(first?.status, 'passed')
    assert.equal(second?.status, 'passed')
    assert.equal(run.result.exitCode, 0)
  })

  test('names the lost recording, and the next test records on a new process', () => {
    assert.equal(first?.recordings?.[0]?.status, 'unavailable')
    assert.equal(first?.recordings?.[0]?.gaps[0]?.code, 'media_process_lost')
    const lost = eventsOfType(run.events, 'media.lost')
    assert.equal(lost.length, 1)
    assert.deepEqual({ recordings: lost[0]?.recordings, restart: lost[0]?.restart }, { recordings: 1, restart: true })
    assert.equal(media.started.length, 2)
    assert.equal(second?.recordings?.[0]?.status, 'complete')
    assert.deepEqual(eventsOfType(run.events, 'media.started').map((event) => event.media.start), [1, 2])
    assert.equal(eventsOfType(run.events, 'media.closed').length, 2, 'both processes were confirmed closed')
    assert.deepEqual(run.result.evidenceStatus?.attempts, { complete: 1, partial: 0, unavailable: 1, notRequested: 0 })
    assert.deepEqual(rebuildRecordedResult(run.events), run.written)
  })
})

describe('a wedged media process', { skip: unpinnedMedia }, async () => {
  const one = `import { expect, test } from '@rehearsal-labs/retest'

test('saves a task', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('save-task')).toBeVisible()
})
`
  const root = tempProject({ 'retest.config.ts': config('recording: { record: true },'), 'tests/one.retest.ts': one })
  const media = fakeMediaStarter({ finishHangs: true, closeHangs: true })
  const startedAt = performance.now()
  const run = await recordProject(root, { files: ['tests/one.retest.ts'], startMedia: media.start })
  const tookMs = performance.now() - startedAt

  test('cannot hang the run: the recording is lost by name, the close is bounded and reported, the test keeps its pass', () => {
    const [result] = allTests(run.result)
    assert.equal(result?.status, 'passed')
    assert.equal(result?.recordings?.[0]?.status, 'unavailable')
    assert.equal(result?.recordings?.[0]?.gaps[0]?.code, 'recording_lost')
    const closed = eventsOfType(run.events, 'media.closed')[0]
    assert.equal(closed?.forced, true)
    assert.ok((closed?.problems?.length ?? 0) > 0)
    assert.equal(run.result.failure?.class, 'cleanup_failed')
    assert.equal(run.result.exitCode, 2)
    assert.ok(tookMs < 30_000, `the run ended in ${Math.round(tookMs)} ms`)
  })
})

describe('an interrupted run that records', { skip: unpinnedMedia }, async () => {
  const slow = `import { test } from '@rehearsal-labs/retest'

test('waits', async ({ page }) => {
  await page.goto('/')
  await new Promise((resolve) => setTimeout(resolve, 4000))
})
`
  const root = tempProject({ 'retest.config.ts': config('recording: { record: true },'), 'tests/slow.retest.ts': slow })
  const media = fakeMediaStarter()
  const controller = new AbortController()
  const run = await recordProject(root, { files: ['tests/slow.retest.ts'], startMedia: media.start, signal: controller.signal, timeouts: { test: 10_000 }, onEvent: event => {
    if (event.type === 'recording.started') controller.abort('SIGINT')
  } })

  test('finishes its recording and closes the media process before it reports, and exits 130', () => {
    assert.equal(run.result.exitCode, 130)
    const finished = eventsOfType(run.events, 'recording.finished')
    assert.equal(finished.length, 1)
    assert.equal(finished[0]?.recording.status, 'complete')
    const closed = eventsOfType(run.events, 'media.closed')[0]
    const ended = eventsOfType(run.events, 'run.finished')[0]
    assert.ok(closed !== undefined && ended !== undefined && closed.sequence < ended.sequence)
    assert.ok((media.started[0]?.recordings[0]?.frames.length ?? 0) > 0)
    assert.deepEqual(rebuildRecordedResult(run.events), run.written)
  })
})

describe('leftovers of a killed run', { skip: unpinnedMedia }, async () => {
  const one = `import { expect, test } from '@rehearsal-labs/retest'

test('saves a task', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('save-task')).toBeVisible()
})
`
  const root = tempProject({ 'retest.config.ts': config('recording: { record: true },'), 'tests/one.retest.ts': one })
  const folder = newRunFolder()
  const runs = dirname(folder)
  const stamp = { schemaVersion: 1, sequence: 0, time: '2026-10-06T10:00:00.000Z', elapsedMs: 0, origin: 'parent' }
  // The killed owner's PID is absent. A live mismatched owner remains unconfirmed, a matching one runs, and a finished run is excluded.
  const earlier = (name: string, startedAt: string | undefined, finished: boolean, pid = process.pid): string => {
    const at = join(runs, name)
    mkdirSync(at, { recursive: true })
    const events = [
      { ...stamp, runId: name, type: 'run.started', retestVersion: '0.1.0', node: 'v24', platform: 'darwin-arm64', rootDir: root, files: [], options: { timeouts: { collection: 1, setup: 1, action: 1, navigation: 1, assertion: 1, test: 1, cleanup: 1 }, reporter: 'none' } },
      { ...stamp, runId: name, type: 'media.started', media: { pid: 4242, start: 1, version: '0.1.0', protocol: 2, build: { target: 't', profile: 'release' }, ffmpeg: 'ffmpeg', encoder: { state: 'ready' }, owner: { startTimeVersion: 1, pid, ...(startedAt === undefined ? {} : { startedAt }) } } },
      { ...stamp, runId: name, type: 'recording.started', testId: 't', attemptId: 'a1', session: 'web', sessionId: 'a1:web', recordingId: 'a1-1-1', number: 1, source: 'chromium', mode: 'screencast', path: 'artifacts/a1/web-1a2b/recording-1.mp4', fps: 10, width: 800, height: 600, codec: 'h264', container: 'mp4', route: 'decoded', keepFrames: false, startedUs: 1 },
    ]
    writeFileSync(join(at, 'events.jsonl'), `${events.map((event) => JSON.stringify(event)).join('\n')}\n`)
    if (finished) writeFileSync(join(at, 'result.json'), '{}')
    return at
  }
  const killed = earlier('killed', 'Thu Jan  1 00:00:00 1970', false, await endedPid())
  const mismatched = earlier('mismatched', 'Thu Jan  1 00:00:00 1970', false)
  earlier('finished', 'Thu Jan  1 00:00:00 1970', true)
  const ownStart = await ownStartTime()
  assert.ok(ownStart !== undefined, 'this process can read its own start time')
  earlier('running', ownStart, false)
  const media = fakeMediaStarter({ leftovers: (output) => ({ type: 'leftovers', requestId: 'l', status: 'ok', output, files: [{ path: `${output}.mp4.partial`, kind: 'video_partial', byteLength: 512 }], removed: true, skipped: [] }) })
  const swept = Promise.withResolvers<void>()
  const noted = new Set<string>()
  const run = await recordProject(root, {
    files: ['tests/one.retest.ts'], startMedia: media.start, folder,
    onEvent: event => {
      if (event.type === 'media.leftovers') noted.add(event.previousRunId)
      if (noted.has('killed') && noted.has('mismatched')) swept.resolve()
    },
    fake: { holdAnswer: async command => {
      if (command.kind !== 'goto') return
      const bound = setTimeout(() => swept.reject(new Error('the required leftover observations never arrived')), 1000)
      try { await swept.promise } finally { clearTimeout(bound) }
    } },
  })

  test('are removed through the media process for a run whose owner is gone, and for no other run', () => {
    const requests = media.started[0]?.leftoverRequests ?? []
    assert.deepEqual(requests, [{ output: join(killed, 'artifacts', 'a1', 'web-1a2b', 'recording-1'), remove: true }])
    const notes = eventsOfType(run.events, 'media.leftovers')
    const unconfirmed = notes.filter(event => event.previousRunId === 'mismatched')
    assert.equal(unconfirmed.length, 1)
    assert.equal(unconfirmed[0]?.status, 'unconfirmed')
    assert.deepEqual(unconfirmed[0]?.removed, [])
    assert.ok(unconfirmed[0]?.problem?.includes(`Remove ${join(mismatched, 'events.jsonl')} once no runner is running.`))
    const found = notes.filter(event => event.status === 'ok')
    assert.equal(notes.length, 2)
    assert.equal(found.length, 1)
    assert.ok(run.events.every(event => event.runId === run.result.runId), 'each envelope belongs to the current run')
    assert.deepEqual({ runId: found[0]?.previousRunId, reference: found[0]?.reference, removed: found[0]?.removed }, { runId: 'killed', reference: 'artifacts/a1/web-1a2b/recording-1', removed: [{ reference: 'artifacts/a1/web-1a2b/recording-1.mp4.partial', kind: 'video_partial', byteLength: 512 }] })
    assert.equal(allTests(run.result)[0]?.status, 'passed')
  })
})

test('two attempts of the same test in one run preserve both recordings', { skip: unpinnedMedia }, async () => {
  const root = tempProject({
    'retest.config.ts': `import { chromium, defineConfig } from '@rehearsal-labs/retest'; export default defineConfig({ apps: { web: { baseUrl: 'http://127.0.0.1:4173', targets: { first: chromium({ executablePath: '/fake/chrome' }), second: chromium({ executablePath: '/fake/chrome' }) } } }, recording: { record: true } })`,
    'tests/one.retest.ts': `import { expect,test } from '@rehearsal-labs/retest'; test('same test',async({page})=>{await page.goto('/');await expect(page.getByTestId('save-task')).toBeVisible()})`,
  })
  const media = fakeMediaStarter()
  const run = await recordProject(root, { files: ['tests/one.retest.ts'], startMedia: media.start })
  const results = allTests(run.result)
  assert.deepEqual(results.map(result => result.status), ['passed', 'passed'])
  assert.equal(new Set(results.map(result => result.testId)).size, 1)
  assert.equal(new Set(results.map(result => result.attemptId)).size, 2)
  const recordings = results.flatMap(result => result.recordings ?? [])
  assert.equal(recordings.length, 2)
  assert.equal(new Set(recordings.map(recording => recording.path)).size, 2)
  const { readArtifactFile } = await import('../../src/store/artifacts.ts')
  for (const recording of recordings) {
    assert.ok(recording.path)
    assert.equal(readArtifactFile(run.folder, recording.path, { maxBytes: 100 }).ok, true)
    assert.equal(recording.status, 'complete')
  }
  assert.equal(media.started.length, 1)
  assert.deepEqual(rebuildRecordedResult(run.events), run.written)
})


test('interruption before recording starts emits no fabricated recording or media process', async () => {
  const root = tempProject({ 'retest.config.ts': config('recording: { record: true },'), 'tests/one.retest.ts': `import {test} from '@rehearsal-labs/retest'; test('one',async({page})=>{await page.goto('/')})` })
  const media = fakeMediaStarter()
  const controller = new AbortController()
  controller.abort('SIGINT')
  const run = await recordProject(root, { files: ['tests/one.retest.ts'], startMedia: media.start, signal: controller.signal })
  assert.equal(run.result.exitCode, 130)
  assert.equal(media.started.length, 0)
  assert.equal(run.events.some(event => event.type.startsWith('recording.') || event.type.startsWith('media.')), false)
  assert.deepEqual(rebuildRecordedResult(run.events), run.written)
})
