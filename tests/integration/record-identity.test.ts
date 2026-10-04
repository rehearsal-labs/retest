import type { DiagnosticLine } from '../../src/protocol/diagnostics.ts'
import type { RetestEvent } from '../../src/protocol/events.ts'
import type { RecordIdentity } from '../../src/protocol/identity.ts'
import type { TestResult } from '../../src/protocol/result.ts'
import assert from 'node:assert/strict'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { parseArtifact } from '../../src/diagnostics/artifact.ts'
import { formatSessionId } from '../../src/protocol/evidence.ts'
import { openApp } from './browser-harness.ts'
import { budgets, configSource, eventsOf, inspectJson, onlyEvent, onlyTest, runCli, runProject, writeProject } from './cli-harness.ts'

// One real run on Chrome through `retest run`, whose failure screenshot, diagnostics, AI check evidence, looks, actions
// and navigations all name the same test, attempt, app and session, read back from result.json, the events, a result
// rebuilt from the events alone and `inspect`. The fake judge stands in for a model; nothing here judges pixels.

const fakeJudge = fileURLToPath(new URL('../support/fake-evaluator.ts', import.meta.url))

const tests = `import { expect, test } from '@rehearsal-labs/retest'

test('names every record by its session', async ({ page }) => {
  await page.goto('/diagnostics')
  await expect(page.getByTestId('status')).toHaveText('Done')
  await page.goto('/')
  await page.getByTestId('task-title').fill('Release checklist')
  await page.getByTestId('save-task').click()
  await test.evaluate({ requirement: { pass: 'The page shows the saved task.' }, evidence: { capture: 'screenshot' } })
  await expect(page.getByTestId('saved-task')).toHaveText('Another task')
})
`

type Keys = { testId: string | undefined; attemptId: string | undefined; app: string | undefined; sessionId: string | undefined }

// The identity keys of a record, under the identity's own names, each as the record has it or undefined.
function keysOf(record: { testId?: string | undefined; attemptId?: string | undefined; app?: string | undefined; sessionId?: string | undefined }): Keys {
  const { testId, attemptId, app, sessionId } = record
  return { testId, attemptId, app, sessionId }
}

function between(events: readonly RetestEvent[], attemptId: string, elapsedMs: number | undefined): boolean {
  const own = events.filter((event) => 'attemptId' in event && event.attemptId === attemptId)
  const from = own.find((event) => event.type === 'test.started')?.elapsedMs
  const to = own.find((event) => event.type === 'test.finished')?.elapsedMs
  return elapsedMs !== undefined && from !== undefined && to !== undefined && elapsedMs >= from && elapsedMs <= to
}

test('a run’s screenshots, diagnostics, AI check evidence and events join on one identity', async (t) => {
  const app = await openApp(t)
  const root = await writeProject(t, {
    'retest.config.ts': configSource(`{
  apps: { web: chrome({ baseUrl: ${JSON.stringify(app.url)} }) },
  evaluation: { judges: { fake: { adapter: ${JSON.stringify(fakeJudge)}, accepts: ['text', 'images'] } }, timeoutMs: 10000 },
}`),
    'tests/identity.retest.ts': tests,
  })
  const run = await runProject(t, root, { timeouts: budgets({ test: 30_000 }) })
  assert.equal(run.exit.code, 1, `${run.stdout}\n${run.stderr}`)
  const result = onlyTest(run)
  assert.equal(result.failure?.class, 'check_failed')
  const identity: RecordIdentity = { testId: result.testId, attemptId: result.attemptId, app: 'web', sessionId: formatSessionId(result.attemptId, 'web') }

  // The failure screenshot, in result.json and in its event.
  const [screenshot] = result.evidence
  assert.ok(screenshot !== undefined)
  assert.deepEqual(keysOf({ ...screenshot, testId: result.testId }), identity)
  assert.equal(screenshot.source, 'chromium')
  assert.ok(between(run.events, result.attemptId, screenshot.capturedElapsedMs), `captured at ${screenshot.capturedElapsedMs} ms on the run's clock, within its attempt`)
  const captured = onlyEvent(run.events, 'evidence.captured')
  assert.deepEqual(
    { app: captured.session, sessionId: captured.sessionId, attemptId: captured.attemptId, capturedAt: captured.capturedAt, capturedElapsedMs: captured.capturedElapsedMs, source: captured.source, path: captured.path },
    { app: screenshot.app, sessionId: screenshot.sessionId, attemptId: screenshot.attemptId, capturedAt: screenshot.capturedAt, capturedElapsedMs: screenshot.capturedElapsedMs, source: screenshot.source, path: screenshot.path },
  )

  // Every action, navigation, look, locator assertion and diagnostics marker names the same session.
  const named = run.events.filter(
    (event) =>
      event.type === 'action.completed' ||
      event.type === 'navigation' ||
      event.type === 'observation' ||
      event.type === 'assertion.failed' ||
      event.type === 'diagnostics.started' ||
      event.type === 'diagnostics.finished',
  )
  assert.ok(named.length >= 8, `${named.length} events name a session`)
  for (const event of named) {
    assert.ok('sessionId' in event)
    assert.deepEqual(keysOf({ ...event, app: event.session }), identity, event.type)
  }
  const failedAssertion = onlyEvent(run.events, 'assertion.failed')
  assert.ok(eventsOf(run.events, 'observation').some((look) => look.observationId === failedAssertion.observationId && look.sessionId === failedAssertion.sessionId), 'the failed check names a look served in its session')

  // Each diagnostics record names the same identity.
  const [summary] = result.diagnostics ?? []
  assert.ok(summary?.path !== undefined)
  const artifact = parseArtifact(readFileSync(join(run.output, summary.path), 'utf8'), summary.path)
  assert.ok(artifact.ok, artifact.ok ? '' : artifact.problem)
  const lines: readonly DiagnosticLine[] = artifact.lines
  assert.ok(lines.length > 2)
  for (const line of lines) assert.deepEqual(keysOf(line), identity, line.type)

  // The AI check's screenshot names the same identity, what took it and when on the run's clock.
  const [evaluation] = result.evaluations ?? []
  const [judged] = evaluation?.evidence ?? []
  assert.ok(judged !== undefined && judged.kind === 'screenshot')
  assert.deepEqual(keysOf(judged), identity)
  assert.equal(judged.source, 'chromium')
  assert.ok(between(run.events, result.attemptId, judged.capturedElapsedMs))
  assert.ok((judged.capturedElapsedMs ?? 0) <= onlyEvent(run.events, 'evaluation.finished').elapsedMs)

  // inspect --json gives the same test, the same events and the same diagnostics lines.
  const shown = await runCli(t, ['inspect', run.output, '--test', result.testId, '--json'], { cwd: root })
  assert.equal(shown.exit.code, 0, shown.stderr)
  const report: unknown = JSON.parse(shown.stdout)
  assert.ok(typeof report === 'object' && report !== null && 'test' in report && 'events' in report && 'diagnostics' in report)
  assert.deepEqual(report.test, result)
  assert.deepEqual(report.events, run.events.filter((event) => 'testId' in event && event.testId === result.testId))
  assert.match(JSON.stringify(report.diagnostics), new RegExp(`"sessionId":"${identity.sessionId}"`))

  // inspect --test names what took the screenshot and its session on the screenshot's line.
  const timeline = await runCli(t, ['inspect', run.output, '--test', result.testId], { cwd: root })
  assert.equal(timeline.exit.code, 0, timeline.stderr)
  assert.match(timeline.stdout, new RegExp(`screenshot \\S+\\.png  chromium, session ${identity.sessionId}`))

  // A result rebuilt from the events alone equals result.json, the new fields included.
  rmSync(join(run.output, 'result.json'))
  const rebuilt = await inspectJson(t, run.output)
  const rebuiltTest: TestResult | undefined = rebuilt.result.files.flatMap((file) => file.tests)[0]
  assert.deepEqual(rebuiltTest, result)
})
