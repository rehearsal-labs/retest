import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { servePages } from './browser-harness.ts'
import { budgets, configSource, eventsOf, filesHolding, runProject, scratchFolder, testNamed, writeProject } from './cli-harness.ts'

const fakeJudge = fileURLToPath(new URL('../support/fake-evaluator.ts', import.meta.url))

test('a non-recording CLI screenshot check refuses pixels after a secret fill', async (t) => {
  const app = await servePages(t, { '/': '<!doctype html><title>Secret entry</title><input data-testid="entry"><p data-testid="ready">Ready</p>' })
  const log = join(await scratchFolder(t), 'judge.jsonl')
  const root = await writeProject(t, {
    'retest.config.ts': configSource(`{
      apps: { web: chrome({ baseUrl: ${JSON.stringify(app.url)} }) },
      secrets: { password: env('RETEST_CLOSEOUT_PASSWORD') },
      evaluation: { judges: { fake: { adapter: ${JSON.stringify(fakeJudge)}, options: { log: ${JSON.stringify(log)} }, accepts: ['images'] } } },
    }`),
    'tests/secret.retest.ts': `import { secret, test } from '@rehearsal-labs/retest'
      test('secret screenshot', async ({ page }) => {
        await page.goto('/')
        await page.getByTestId('entry').fill(secret('password'))
        await test.evaluate({ requirement: { pass: 'The page shows a ready state.' }, evidence: { capture: 'screenshot' } })
      })`,
  })
  const secret = randomUUID()
  const run = await runProject(t, root, { env: { RETEST_CLOSEOUT_PASSWORD: secret }, timeouts: budgets({ test: 30_000 }) })
  assert.equal(run.exit.code, 2, `${run.stdout}\n${run.stderr}`)
  const result = testNamed(run, 'secret screenshot')
  const evaluation = result.evaluations?.[0]
  assert.equal(evaluation?.verdict, 'error')
  assert.match(evaluation?.failure?.message ?? '', /withheld|secret/i)
  assert.equal(evaluation?.evidence[0]?.path, undefined, 'no evaluation screenshot is saved')
  assert.deepEqual(result.evidence, [], 'no failure screenshot is saved during withholding')
  assert.equal(eventsOf(run.events, 'capture.withheld').length, 1)
  assert.equal(eventsOf(run.events, 'recording.started').length, 0, 'recording remains off')
  const calls = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter((line) => line.includes('"call"')) : []
  assert.equal(calls.length, 0, 'no pixels reach the judge')
  assert.deepEqual(filesHolding(run.output, secret), [], 'the secret reaches no text artifact')
})


test('CLI evaluation receives the current bounded diagnostics with its attempt identity', async (t) => {
  const app = await servePages(t, {
    '/': '<!doctype html><title>Diagnostics</title><p data-testid="ready">Ready</p><script>console.log("closeout diagnostic marker")</script>',
    '/later': '<!doctype html><title>Later diagnostics</title><p data-testid="ready">Later</p><script>console.log("closeout later marker")</script>',
  })
  const log = join(await scratchFolder(t), 'judge.jsonl')
  const root = await writeProject(t, {
    'retest.config.ts': configSource(`{
      apps: { web: chrome({ baseUrl: ${JSON.stringify(app.url)} }) },
      evaluation: { judges: { fake: { adapter: ${JSON.stringify(fakeJudge)}, options: { log: ${JSON.stringify(log)} }, accepts: ['text'] } } },
    }`),
    'tests/diagnostics.retest.ts': `import { expect, test } from '@rehearsal-labs/retest'
      test('diagnostics selected', async ({ page }) => {
        await page.goto('/')
        await expect(page.getByTestId('ready')).toHaveText('Ready')
        await test.evaluate({ requirement: { pass: 'The console contains the diagnostic marker.' }, evidence: { diagnostics: 'console' } })
        await page.goto('/later')
        await expect(page.getByTestId('ready')).toHaveText('Later')
        await test.evaluate({ requirement: { pass: 'The console contains the later marker.' }, evidence: { diagnostics: 'console' } })
      })`,
  })
  const run = await runProject(t, root, { timeouts: budgets({ test: 30_000 }) })
  assert.equal(run.exit.code, 0, `${run.stdout}\n${run.stderr}`)
  const result = testNamed(run, 'diagnostics selected')
  const evaluation = result.evaluations?.[0]
  assert.equal(evaluation?.verdict, 'pass')
  const evidence = evaluation?.evidence[0]
  assert.ok(evidence?.kind === 'diagnostics' && evidence.path !== undefined)
  assert.deepEqual([evidence.testId, evidence.attemptId, evidence.app, evidence.sessionId], [result.testId, result.attemptId, 'web', `${result.attemptId}:web`])
  assert.equal(evidence.console?.state, 'complete')
  assert.ok((evidence.records?.length ?? 0) > 0)
  const saved = readFileSync(join(run.output, evidence.path), 'utf8')
  assert.match(saved, /closeout diagnostic marker/)
  assert.match(readFileSync(log, 'utf8'), /closeout diagnostic marker/, 'the judge receives the stored current records')
  assert.equal(result.evaluations?.length, 2)
  assert.doesNotMatch(saved, /closeout later marker/, 'the first snapshot stays frozen before later navigation')
  const later = result.evaluations?.[1]
  assert.equal(later?.verdict, 'pass')
  const laterEvidence = later?.evidence[0]
  assert.ok(laterEvidence?.kind === 'diagnostics' && laterEvidence.path !== undefined)
  assert.deepEqual([laterEvidence.testId, laterEvidence.attemptId, laterEvidence.app, laterEvidence.sessionId], [result.testId, result.attemptId, 'web', `${result.attemptId}:web`])
  assert.match(readFileSync(join(run.output, laterEvidence.path), 'utf8'), /closeout later marker/, 'a later snapshot sees collection continue after the first check')
  assert.match(readFileSync(log, 'utf8'), /closeout later marker/)
  assert.equal(result.diagnostics?.[0]?.console.state, 'complete', 'taking a view does not finish collection')
})
