import type { RetestEvent } from '../../src/protocol/events.ts'
import type { RunResult, TestResult } from '../../src/protocol/result.ts'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { monotonicClock } from '../../src/protocol/deadline.ts'
import { rebuildResult } from '../../src/store/rebuild-result.ts'
import { RunStore } from '../../src/store/run-store.ts'
import { runProject, tempProject } from '../support/project.ts'
import { eventsOfType, runSupportFiles } from '../support/run-harness.ts'
import { tempFolder } from '../support/temp-folder.ts'

// A result rebuilt from the events of a finished run equals result.json test for test, now that screenshots, actions,
// navigations, assertions and AI check evidence carry the record identity. Every field is compared, not a chosen few.

function tests(result: RunResult): TestResult[] {
  return result.files.flatMap((file) => file.tests)
}

// Where each event of an attempt sits on the run's clock, to place a screenshot between them.
function attemptSpan(events: readonly RetestEvent[], attemptId: string): { from: number; to: number } {
  const own = events.filter((event) => 'attemptId' in event && event.attemptId === attemptId)
  const from = own.find((event) => event.type === 'test.started')?.elapsedMs
  const to = own.find((event) => event.type === 'test.finished')?.elapsedMs
  assert.ok(from !== undefined && to !== undefined, `attempt ${attemptId} started and finished`)
  return { from, to }
}

describe('the run store keeps the run’s clock, as its events count it', () => {
  // An event stamped on a clock that started at `startedAt`, as the event log stamps one.
  function stampedAt(startedAt: number): RetestEvent {
    const elapsedMs = Math.round(monotonicClock() - startedAt)
    return { schemaVersion: 1, runId: 'run-1', sequence: 0, time: new Date().toISOString(), elapsedMs, origin: 'parent', type: 'run.narrowed', only: [], kept: 0, collected: 0 }
  }

  function busy(milliseconds: number): void {
    const end = monotonicClock() + milliseconds
    while (monotonicClock() < end) {
      // Holds the thread, as a slow write between stamping an event and writing it would.
    }
  }

  test('it knows no time before the first event, then agrees with the events to about a millisecond and never goes back', () => {
    const store = RunStore.create(join(tempFolder('run-clock-'), 'run'))
    const startedAt = monotonicClock() - 5000
    assert.equal(store.elapsedMs(), undefined)
    const before = monotonicClock()
    store.appendEvent(stampedAt(startedAt))
    const read = store.elapsedMs()
    const counted = Math.round(monotonicClock() - startedAt)
    // Rounding gives a millisecond; whatever this thread waited between the stamp and the reading adds to it.
    const slack = 1 + Math.ceil(monotonicClock() - before)
    assert.ok(read !== undefined && Math.abs(read - counted) <= slack, `${read} against ${counted}, within ${slack}`)
    busy(5)
    const later = store.elapsedMs()
    assert.ok(later !== undefined && later >= read)
    store.close()
  })

  test('an event written late does not set the clock behind; the next prompt one corrects it', () => {
    const store = RunStore.create(join(tempFolder('run-clock-'), 'run'))
    const startedAt = monotonicClock() - 1000
    const late = stampedAt(startedAt)
    busy(30)
    store.appendEvent(late)
    const lagging = store.elapsedMs()
    const before = monotonicClock()
    store.appendEvent(stampedAt(startedAt))
    const read = store.elapsedMs()
    const counted = Math.round(monotonicClock() - startedAt)
    const slack = 1 + Math.ceil(monotonicClock() - before)
    assert.ok(lagging !== undefined && counted - lagging >= 25, `the late event alone places the clock behind: ${lagging} against ${counted}`)
    assert.ok(read !== undefined && Math.abs(read - counted) <= slack, `${read} against ${counted}, within ${slack}`)
    store.close()
  })
})

describe('a failure screenshot’s identity survives the rebuild', async () => {
  const record = await runSupportFiles(['failing.retest.ts'])
  const failed = tests(record.result).find((result) => result.name === 'shows the wrong text')

  test('result.json names what took it and when on the run’s clock, between its attempt’s start and end', () => {
    assert.ok(failed)
    const [screenshot] = failed.evidence
    assert.ok(screenshot)
    assert.equal(screenshot.source, 'chromium')
    assert.equal(screenshot.sessionId, `${failed.attemptId}:page`)
    const span = attemptSpan(record.events, failed.attemptId)
    assert.ok(screenshot.capturedElapsedMs !== undefined && screenshot.capturedElapsedMs >= span.from && screenshot.capturedElapsedMs <= span.to, `${screenshot.capturedElapsedMs} lies within ${span.from} to ${span.to}`)
    const [captured] = eventsOfType(record.events, 'evidence.captured')
    assert.ok(captured && captured.capturedElapsedMs !== undefined)
    assert.ok(captured.capturedElapsedMs <= captured.elapsedMs, 'it was captured before its event was written')
  })

  test('the rebuilt result equals result.json for every test, every field', () => {
    assert.deepEqual(rebuildResult(record.events).files, record.result.files)
    assert.deepEqual(record.written?.files, record.result.files)
  })

  test('the actions, navigations and assertions of the attempt name its session', () => {
    assert.ok(failed)
    const sessionId = `${failed.attemptId}:page`
    const own = record.events.filter((event) => 'attemptId' in event && event.attemptId === failed.attemptId)
    for (const event of own) {
      if (event.type === 'action.completed' || event.type === 'action.failed' || event.type === 'navigation' || event.type === 'evidence.captured') assert.equal(event.sessionId, sessionId, event.type)
      if ((event.type === 'assertion.passed' || event.type === 'assertion.failed') && event.locator !== undefined) assert.equal(event.sessionId, sessionId, event.type)
    }
    assert.ok(own.some((event) => event.type === 'assertion.failed' && event.sessionId === sessionId))
  })
})

describe('in a run from a config, each app’s screenshot and its looks rebuild to result.json', async () => {
  const config = `import { chromium, defineConfig } from '@rehearsal-labs/retest'

export default defineConfig({
  apps: { owner: chromium({ baseUrl: 'http://127.0.0.1:4173' }), member: chromium({ baseUrl: 'http://127.0.0.1:4173' }) },
})
`
  const shared = `import { expect, test } from '@rehearsal-labs/retest'

test('shares a task', { apps: ['owner', 'member'] }, async ({ owner, member }) => {
  await member.goto('/')
  await expect(member.getByTestId('save-task')).toBeVisible()
  await expect(owner.getByTestId('hidden-note')).toBeVisible()
})
`
  const record = await runProject(tempProject({ 'retest.config.ts': config, 'tests/shared.retest.ts': shared }), { files: ['tests/shared.retest.ts'] })

  test('each screenshot names its app, session, source and run-clock time, and the rebuild equals result.json', () => {
    const [result] = tests(record.result)
    assert.ok(result)
    assert.deepEqual(
      result.evidence.map(({ app, sessionId, source }) => [app, sessionId, source]),
      [
        ['owner', `${result.attemptId}:owner`, 'chromium'],
        ['member', `${result.attemptId}:member`, 'chromium'],
      ],
    )
    assert.ok(result.evidence.every((each) => typeof each.capturedElapsedMs === 'number'))
    assert.deepEqual(rebuildResult(record.events).files, record.result.files)
  })

  test('a passed look names the session that served it, and a failed one the session of its app', () => {
    const passed = eventsOfType(record.events, 'assertion.passed')
    const failed = eventsOfType(record.events, 'assertion.failed')
    const served = new Set(eventsOfType(record.events, 'observation').map((event) => `${event.observationId} ${event.sessionId}`))
    assert.deepEqual(passed.map((event) => [event.session, event.sessionId]), [['member', `${passed[0]?.attemptId}:member`]])
    for (const event of passed) assert.ok(served.has(`${event.observationId} ${event.sessionId}`), 'the look it names was served in that session')
    assert.deepEqual(failed.map((event) => [event.session, event.sessionId]), [['owner', `${failed[0]?.attemptId}:owner`]])
  })
})
