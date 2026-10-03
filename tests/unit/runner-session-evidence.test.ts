import type { ChildEvent } from '../../src/protocol/events.ts'
import type { LocatorRecipe } from '../../src/protocol/locator.ts'
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { expect } from '../../src/index.ts'
import { formatSessionId } from '../../src/protocol/evidence.ts'
import { truncateText } from '../../src/protocol/failures.ts'
import { BrowserPool } from '../../src/runner/browser-pool.ts'
import { ServedObservations } from '../../src/runner/observations.ts'
import { readRunFolder } from '../../src/store/read-run-folder.ts'
import { inProcessRun } from '../support/api/in-process-run.ts'
import { fakeLauncher } from '../support/fake-browser.ts'
import { observationOf } from '../support/observation.ts'
import { fakeExecutable, runProject, tempProject } from '../support/project.ts'
import { eventsOfType, quickTimeouts, runSupportFiles, testNamed } from '../support/run-harness.ts'
import { scriptedApp, scriptedTest } from '../support/scripted-process.ts'

const title: LocatorRecipe = { by: 'testId', value: 'task-title' }

function isTime(text: string | undefined): boolean {
  return text !== undefined && new Date(text).toISOString() === text
}

describe('a failure screenshot carries its evidence reference', async () => {
  const record = await runSupportFiles(['failing.retest.ts'])
  const failed = testNamed(record.result, 'shows the wrong text')
  const captured = eventsOfType(record.events, 'evidence.captured').find((event) => event.testId === failed.testId)

  test('its event names the path, the app, the session that took it, its attempt and when it came back', () => {
    assert.ok(captured)
    assert.equal(captured.session, 'page')
    assert.equal(captured.sessionId, formatSessionId(failed.attemptId, 'page'))
    assert.equal(captured.attemptId, failed.attemptId)
    assert.ok(isTime(captured.capturedAt), `an ISO time: ${captured.capturedAt}`)
    assert.ok(captured.capturedAt !== undefined && captured.capturedAt >= record.result.startedAt && captured.capturedAt <= record.result.finishedAt)
  })

  test('its entry in the result says the same, and names no app without a config', () => {
    assert.ok(captured)
    assert.deepEqual(failed.evidence, [
      { kind: 'screenshot', path: captured.path, sessionId: captured.sessionId, attemptId: failed.attemptId, capturedAt: captured.capturedAt },
    ])
  })

  test('a result rebuilt from the events alone keeps the same reference', () => {
    rmSync(join(record.folder, 'result.json'))
    const rebuilt = readRunFolder(record.folder)
    assert.equal(rebuilt.source, 'events.jsonl')
    assert.deepEqual(testNamed(rebuilt.result, 'shows the wrong text').evidence, failed.evidence)
  })
})

describe('in a run from a config, each app’s screenshot names its own session', async () => {
  const config = `import { chromium, defineConfig } from '@rehearsal-labs/retest'

export default defineConfig({
  apps: { owner: chromium({ baseUrl: 'http://127.0.0.1:4173' }), member: chromium({ baseUrl: 'http://127.0.0.1:4173' }) },
})
`
  const tests = `import { expect, test } from '@rehearsal-labs/retest'

test('shares a task', { apps: ['owner', 'member'] }, async ({ owner }) => {
  await expect(owner.getByTestId('hidden-note')).toBeVisible()
})
`
  const record = await runProject(tempProject({ 'retest.config.ts': config, 'tests/shared.retest.ts': tests }), { files: ['tests/shared.retest.ts'] })
  const [result] = record.result.files.flatMap((file) => file.tests)

  test('two apps, two sessions of one attempt, and each entry names its app', () => {
    assert.ok(result)
    assert.deepEqual(
      result.evidence.map(({ app, sessionId, attemptId }) => [app, sessionId, attemptId]),
      [
        ['owner', `${result.attemptId}:owner`, result.attemptId],
        ['member', `${result.attemptId}:member`, result.attemptId],
      ],
    )
    const events = eventsOfType(record.events, 'evidence.captured')
    assert.deepEqual(
      events.map(({ session, sessionId, path, capturedAt }) => ({ app: session, sessionId, path, capturedAt })),
      result.evidence.map(({ app, sessionId, path, capturedAt }) => ({ app, sessionId, path, capturedAt })),
    )
  })
})

describe('a look’s reference carries the session that served it', () => {
  const visible = { matcher: 'toBeVisible' } as const

  // A passed assertion on a look, as the test process sends it.
  function assertionNaming(run: { testId: string; attemptId: string }, reference: { observationId: string; sessionId: string }): Extract<ChildEvent, { type: 'assertion.passed' }> {
    return {
      type: 'assertion.passed',
      testId: run.testId,
      attemptId: run.attemptId,
      matcher: 'toBeVisible',
      locator: title,
      check: visible,
      ...reference,
      expected: null,
      actual: truncateText('Release checklist'),
      attempts: 1,
      durationMs: 3,
    }
  }

  test('the test process receives each look with its id and its session, and the look’s event names the same session', async () => {
    const run = await scriptedTest({ attemptId: 'k3v9q0x2mb' })
    await run.command(1, { kind: 'goto', url: '/tasks' })
    const look = await run.command(2, { kind: 'observe', locator: title })
    await run.finish()
    assert.ok(look.ok && look.kind === 'observe')
    assert.deepEqual([look.observationId, look.sessionId], ['o1', 'k3v9q0x2mb:page'])
    const events = run.events.flatMap(({ body }) => (body.type === 'observation' ? [body] : []))
    assert.deepEqual(events.map((event) => [event.observationId, event.session, event.sessionId]), [['o1', scriptedApp, 'k3v9q0x2mb:page']])
  })

  test('a look an earlier attempt served is refused in a later one, though the later attempt served its own look with that id', async () => {
    const earlier = await scriptedTest({ attemptId: 'attempt1' })
    const kept = await earlier.command(1, { kind: 'observe', locator: { by: 'testId', value: 'saved-task' } })
    await earlier.finish()
    assert.ok(kept.ok && kept.kind === 'observe' && kept.observationId !== undefined && kept.sessionId !== undefined)
    const later = await scriptedTest({ attemptId: 'attempt2' })
    const own = await later.command(1, { kind: 'observe', locator: title })
    assert.ok(own.ok && own.kind === 'observe')
    assert.equal(own.observationId, kept.observationId, 'ids repeat from one attempt to the next')
    later.event(assertionNaming(later, { observationId: kept.observationId, sessionId: kept.sessionId }))
    const report = await later.report
    assert.equal(report.failure?.class, 'test_error')
    assert.match(report.failure?.message ?? '', /named o1 of the session "attempt1:page", but the session "attempt2:page" served this test's o1/)
    assert.deepEqual(later.events.filter(({ body }) => body.type === 'assertion.passed'), [], 'no assertion is written')
  })

  test('a look sent back with its own session is judged on that look', async () => {
    const run = await scriptedTest({ attemptId: 'attempt1' })
    const look = await run.command(1, { kind: 'observe', locator: title })
    assert.ok(look.ok && look.kind === 'observe' && look.observationId !== undefined && look.sessionId !== undefined)
    run.event(assertionNaming(run, { observationId: look.observationId, sessionId: look.sessionId }))
    await run.finish()
    const passed = run.events.flatMap(({ body }) => (body.type === 'assertion.passed' ? [body] : []))
    assert.deepEqual(passed.map((event) => [event.observationId, event.judgedBy]), [['o1', 'parent']])
  })

  test('a session without a look’s id is refused', async () => {
    const run = await scriptedTest({ attemptId: 'attempt1' })
    await run.command(1, { kind: 'observe', locator: title })
    const { observationId: _observationId, ...withoutId } = assertionNaming(run, { observationId: 'o1', sessionId: 'attempt1:page' })
    run.event({ ...withoutId, type: 'assertion.failed', failure: { class: 'check_failed', message: 'It did not show.' } })
    const report = await run.report
    assert.match(report.failure?.message ?? '', /sent the session "attempt1:page" of a look without the look's id/)
  })

  test('a look’s id without its session is refused, passed or failed, though this attempt served that look', async () => {
    for (const type of ['assertion.passed', 'assertion.failed'] as const) {
      const run = await scriptedTest({ attemptId: 'attempt1' })
      const look = await run.command(1, { kind: 'observe', locator: title })
      assert.ok(look.ok && look.kind === 'observe' && look.observationId !== undefined && look.sessionId !== undefined)
      const { sessionId: _sessionId, ...withoutSession } = assertionNaming(run, { observationId: look.observationId, sessionId: look.sessionId })
      run.event(type === 'assertion.passed' ? withoutSession : { ...withoutSession, type, failure: { class: 'check_failed', message: 'It did not show.' } })
      const report = await run.report
      assert.equal(report.failure?.class, 'test_error', type)
      assert.match(report.failure?.message ?? '', /named the look "o1" without the session that served it/)
      assert.deepEqual(run.events.filter(({ body }) => body.type === 'assertion.passed' || body.type === 'assertion.failed'), [], 'no assertion is written')
    }
  })

  test('the test process sends a look’s session back with its id, as the look came', async () => {
    const { runPage, events } = inProcessRun('tests/unit/runner-session-evidence.test.ts', (command) => {
      if (command.kind !== 'observe') return { ok: true, kind: 'click' }
      return { ok: true, kind: 'observe', observation: observationOf([{ text: 'Release checklist', visible: true }]), observationId: 'o1', sessionId: 'k3v9q0x2mb:page' }
    })
    const verdict = await runPage(({ page }) => expect(page.getByTestId('task-title')).toBeVisible())
    assert.equal(verdict.status, 'passed')
    const sent = events().flatMap((event) => (event.type === 'assertion.passed' ? [event] : []))
    assert.deepEqual(sent.map((event) => [event.observationId, event.sessionId]), [['o1', 'k3v9q0x2mb:page']])
  })

  test('the parent keeps the session it served each look in', () => {
    const looks = new ServedObservations()
    const id = looks.serve({ app: 'web', sessionId: 'a1:web', locator: title, observation: observationOf([{ text: 'Release checklist', visible: true }]) })
    const judged = looks.judge(assertionNamingFor(id, 'a2:web'), { app: 'web' })
    assert.deepEqual(judged, { ok: false, problem: 'named o1 of the session "a2:web", but the session "a1:web" served this test\'s o1' })
  })

  test('the parent refuses a look’s id sent without its session, at a locator and at the page', () => {
    const looks = new ServedObservations()
    const atLocator = looks.serve({ app: 'web', sessionId: 'a1:web', locator: title, observation: observationOf([{ text: 'Release checklist', visible: true }]) })
    const atPage = looks.serve({ app: 'web', sessionId: 'a1:web', page: { url: 'http://127.0.0.1:4173/tasks', title: 'Tasks' } })
    const { sessionId: _locatorSession, ...locatorWithoutSession } = assertionNamingFor(atLocator, 'a1:web')
    assert.deepEqual(looks.judge(locatorWithoutSession, { app: 'web' }), { ok: false, problem: 'named the look "o1" without the session that served it' })
    const { locator: _locator, sessionId: _pageSession, ...pageWithoutSession } = assertionNamingFor(atPage, 'a1:web')
    const pageAssertion = { ...pageWithoutSession, matcher: 'toHaveURL', check: { matcher: 'toHaveURL', url: 'http://127.0.0.1:4173/tasks' } } as const
    assert.deepEqual(looks.judge(pageAssertion, { app: 'web' }), { ok: false, problem: 'named the look "o2" without the session that served it' })
    assert.equal(looks.judge({ ...pageAssertion, sessionId: 'a1:web' }, { app: 'web' }).ok, true, 'the same assertion with its session is judged')
  })

  function assertionNamingFor(observationId: string, sessionId: string): Extract<ChildEvent, { type: 'assertion.passed' }> {
    return {
      type: 'assertion.passed',
      testId: 'tests/a.retest.ts > runs',
      attemptId: 'a2',
      matcher: 'toBeVisible',
      locator: title,
      check: visible,
      observationId,
      sessionId,
      expected: null,
      actual: truncateText('Release checklist'),
      attempts: 1,
      durationMs: 3,
    }
  }
})

describe('the pool names what each target runs on', () => {
  test('a ready target carries its browser’s identity as a Chromium web runtime', async () => {
    const launched = fakeLauncher()
    const pool = new BrowserPool({
      launch: launched.launch,
      findExecutable: fakeExecutable,
      logFile: (app, target) => `/logs/${app}-${target}.log`,
      headless: true,
      named: true,
      timeouts: quickTimeouts,
      stopped: new Promise(() => {}),
      interruption: () => undefined,
      onStarted: () => {},
      onLost: () => {},
    })
    const stable = { name: 'stable', browser: 'chromium', headless: true, executablePath: '/fake/stable' } as const
    const ready = await pool.ensure({ name: 'web', targets: new Map([['stable', stable]]) }, stable)
    assert.ok(ready.ok)
    const { product, version, executablePath, pid } = ready.value.browser
    assert.deepEqual(ready.value.runtime, { kind: 'web', engine: 'chromium', product, version, executablePath, processIds: [pid] })
  })
})
