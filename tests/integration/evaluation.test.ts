import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { formatSessionId } from '../../src/protocol/evidence.ts'
import { openApp } from './browser-harness.ts'
import { budgets, childLog, configSource, eventsOf, filesHolding, resultOf, runCli, runProject, scratchFolder, testNamed, textHolds, writeProject } from './cli-harness.ts'

// AI checks through a real `retest run`: its own process loads the fake judge from the project, a real test file
// process asks for the checks, and real Chrome supplies the screenshots. The fake writes what it saw to a file outside
// the run folder. It proves the lifecycle on the real path, not any model's judgement.

const fakeJudge = fileURLToPath(new URL('../support/fake-evaluator.ts', import.meta.url))
const key = 'sk-e2e-judge-7c2d5a91'

const tests = `import { expect, test } from '@rehearsal-labs/retest'

async function save(page) {
  await page.goto('/')
  await page.getByTestId('task-title').fill('Release checklist')
  await page.getByTestId('save-task').click()
  await expect(page.getByTestId('saved-task')).toHaveText('Release checklist')
}

test('screenshot pass', async ({ page }) => {
  await save(page)
  await test.evaluate({ requirement: { pass: 'The page shows the saved task.' }, evidence: { capture: 'screenshot' } })
})

test('screenshot fail', async ({ page }) => {
  await save(page)
  await test.evaluate({ requirement: { fail: 'The page shows the saved task.' }, evidence: { app: 'web', capture: 'screenshot' } })
})

test('caught', async ({ page }) => {
  await save(page)
  try {
    await test.evaluate({ requirement: { fail: 'The page shows the saved task.' }, evidence: { capture: 'screenshot' } })
  } catch {
    // Swallowed on purpose: the parent's record still fails the test.
  }
})

test('undecided', async ({ page }) => {
  await save(page)
  await test.evaluate({ requirement: { inconclusive: 'The page shows the saved task.' }, evidence: { capture: 'screenshot' } })
})

test('advisory warning', async ({ page }) => {
  await save(page)
  await test.evaluate({ requirement: { fail: 'The page is in dark mode.' }, evidence: { capture: 'screenshot' }, mode: 'advisory' })
})

test('text and the credential variable', async () => {
  console.log(\`the judge's variable in the test process is \${process.env.RETEST_E2E_JUDGE_KEY === undefined ? 'absent' : 'present'}\`)
  await test.evaluate({ requirement: { 'echo-secret': 'The reply is polite.' }, evidence: { text: 'Thank you for your order.' } })
})
`

test('AI checks run in the parent against real screenshots, and decide the exit code', async (t) => {
  const app = await openApp(t)
  const log = join(await scratchFolder(t, 'retest-judge-'), 'fake.jsonl')
  const root = await writeProject(t, {
    'retest.config.ts': configSource(`{
  apps: { web: chrome({ baseUrl: ${JSON.stringify(app.url)} }) },
  evaluation: {
    judges: { fake: { adapter: ${JSON.stringify(fakeJudge)}, credentials: { apiKey: env('RETEST_E2E_JUDGE_KEY') }, options: { log: ${JSON.stringify(log)} }, accepts: ['text', 'images'] } },
    timeoutMs: 10000,
  },
}`),
    'tests/judged.retest.ts': tests,
  })
  const run = await runProject(t, root, { env: { RETEST_E2E_JUDGE_KEY: key }, timeouts: budgets({ test: 30_000 }) })

  assert.equal(run.exit.code, 1, `${run.stdout}\n${run.stderr}`)
  const outcome = (name: string): [string, string | undefined] => {
    const found = testNamed(run, name)
    return [found.status, found.failure?.class]
  }
  assert.deepEqual(
    ['screenshot pass', 'screenshot fail', 'caught', 'undecided', 'advisory warning', 'text and the credential variable'].map(outcome),
    [['passed', undefined], ['failed', 'evaluation_failed'], ['failed', 'evaluation_failed'], ['inconclusive', 'evaluation_inconclusive'], ['passed', undefined], ['passed', undefined]],
  )

  // The screenshot the judge saw is the one the run folder keeps, from this attempt's session of web.
  const passed = testNamed(run, 'screenshot pass')
  const [evaluation] = passed.evaluations ?? []
  const [shot] = evaluation?.evidence ?? []
  assert.ok(shot !== undefined && shot.path !== undefined && shot.kind === 'screenshot')
  assert.equal(shot.sessionId, formatSessionId(passed.attemptId, 'web'))
  assert.equal(shot.attemptId, passed.attemptId)
  const bytes = readFileSync(join(run.output, shot.path))
  assert.equal(createHash('sha256').update(bytes).digest('hex'), shot.sha256)
  assert.ok((shot.width ?? 0) > 100 && (shot.height ?? 0) > 100, `a real capture: ${shot.width}x${shot.height}`)

  const entries: unknown[] = readFileSync(log, 'utf8').split('\n').filter((line) => line !== '').map((line): unknown => JSON.parse(line))
  const calls = entries.flatMap((entry) => at(entry, ['call']) ?? [])
  const setups = entries.flatMap((entry) => at(entry, ['setup']) ?? [])
  assert.equal(setups.length, 1, 'the judge is made once, in the process that runs Retest')
  assert.equal(at(setups[0], ['credentials', 'apiKey']), key)
  const image = (field: string): unknown => at(calls[0], ['evidence', 0, field])
  assert.deepEqual(['kind', 'app', 'width', 'height', 'bytes'].map(image), ['image', 'web', shot.width, shot.height, bytes.byteLength])
  for (const call of calls) assert.deepEqual(at(call, ['functions']), [], 'the judge receives no function')

  // The judge's credential never reaches the test process, the run folder or the terminal.
  assert.match(childLog(run, 'tests/judged.retest.ts'), /the judge's variable in the test process is absent/)
  assert.deepEqual(filesHolding(run.output, key), [], 'no file in the run folder holds the credential')
  assert.ok(!textHolds(run.stdout, key) && !textHolds(run.stderr, key))
  const echoed = testNamed(run, 'text and the credential variable').evaluations?.[0]
  assert.match(echoed?.justification ?? '', /\{\{fake\.apiKey\}\}/)

  const warned = testNamed(run, 'advisory warning').evaluations?.[0]
  assert.deepEqual([warned?.mode, warned?.verdict, warned?.failure], ['advisory', 'fail', undefined])
  assert.match(warned?.warning ?? '', /^The advisory AI check evaluation-1 failed/)
  assert.equal(eventsOf(run.events, 'evaluation.finished').length, 6)
  assert.deepEqual(resultOf(run).counts, { passed: 3, failed: 2, error: 0, notRun: 0, inconclusive: 1 })

  const shown = await runCli(t, ['inspect', run.output, '--test', testNamed(run, 'screenshot fail').testId], { cwd: root })
  assert.equal(shown.exit.code, 0, shown.stderr)
  assert.match(shown.stdout, /✗ AI check evaluation-1 failed, required, judge fake \(fake scripted-1-2026\)/)
  assert.match(shown.stdout, /evidence e1 screenshot of web \d+x\d+ .*\.png/)
  const evidencePath = /evidence e1 screenshot of web \d+x\d+ (\S+\.png)/.exec(shown.stdout)?.[1]
  assert.ok(evidencePath !== undefined && existsSync(evidencePath), 'inspect names the screenshot the judge saw')
})

// A value inside parsed JSON, by keys and indexes, or undefined when the path does not lead anywhere.
function at(value: unknown, path: readonly (string | number)[]): unknown {
  let current: unknown = value
  for (const step of path) {
    if (typeof current !== 'object' || current === null) return undefined
    current = Reflect.get(current, step)
  }
  return current
}
