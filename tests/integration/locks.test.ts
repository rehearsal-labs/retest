import type { TestContext } from 'node:test'
import type { FinishedRun } from './cli-harness.ts'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { TASK_APP_PASSWORD } from '../../fixtures/task-app/sign-in.ts'
import { openApp } from './browser-harness.ts'
import { budgets, configSource, eventsOf, finishRun, repositoryRoot, resultOf, runCli, runProject, secondBrowserPath, startRun, testNamed, writeProject } from './cli-harness.ts'

// Shared-state locks on real Chrome, under workers. The task app counts how many visitors hold a named thing at
// once (`/holders/hold`), so a run shows from the outside whether two holders of one lock ever overlapped.

type Holders = { current: number; most: number; holds: number }

async function holders(url: string, name: string): Promise<Holders> {
  const response = await fetch(new URL(`/holders?name=${encodeURIComponent(name)}`, url))
  const body: unknown = await response.json()
  assert.ok(typeof body === 'object' && body !== null && 'most' in body && 'holds' in body && 'current' in body)
  const { current, most, holds } = body
  assert.ok(typeof current === 'number' && typeof most === 'number' && typeof holds === 'number')
  return { current, most, holds }
}

// A test that holds `name` at the task app for `ms`, and checks that nobody else held it meanwhile, or, with
// `until`, that someone did.
function holdingTest(title: string, options: string, name: string, query: string, overlap: string): string {
  return `test('${title}', ${options}, async ({ page }) => {
  await page.goto('/holders/hold?name=${name}&${query}')
  await expect(page.getByTestId('overlap')).toHaveText('${overlap}')
})`
}

function holdingFile(tests: readonly string[]): string {
  return `import { expect, test } from '@rehearsal-labs/retest'\n\n${tests.join('\n\n')}\n`
}

async function project(t: TestContext, files: Readonly<Record<string, string>>): Promise<{ root: string; url: string }> {
  const app = await openApp(t)
  const config = configSource(`{ apps: { web: chrome({ baseUrl: ${JSON.stringify(app.url)} }) }, locks: ['inbox', 'account'] }`)
  return { root: await writeProject(t, { 'retest.config.ts': config, ...files }), url: app.url }
}

/** Each attempt's hold, from the moment it had its locks to the moment its test finished, by test name. */
function holds(run: FinishedRun, lock: string): { name: string; from: number; to: number; waitedMs: number }[] {
  const finished = eventsOf(run.events, 'test.finished')
  return eventsOf(run.events, 'lock.acquired')
    .filter((event) => event.locks.includes(lock))
    .map((event) => {
      const end = finished.find((each) => each.attemptId === event.attemptId)
      assert.ok(end !== undefined, `the attempt ${event.attemptId} finished`)
      const name = resultOf(run).files.flatMap((file) => file.tests).find((each) => each.attemptId === event.attemptId)?.name ?? event.testId
      return { name, from: event.elapsedMs, to: end.elapsedMs, waitedMs: event.waitedMs }
    })
    .sort((one, other) => one.from - other.from)
}

function assertNoOverlap(spans: readonly { name: string; from: number; to: number }[]): void {
  for (const [index, span] of spans.entries()) {
    const previous = spans[index - 1]
    if (previous === undefined) continue
    assert.ok(span.from >= previous.to, `${span.name} took the lock at ${span.from} ms, before ${previous.name} finished at ${previous.to} ms`)
  }
}

test('without a lock, tests in different files hold the same thing at once under workers', async (t) => {
  // The control for the next test: the counter sees two holders when nothing keeps them apart.
  const { root, url } = await project(t, {
    'tests/a.retest.ts': holdingFile([holdingTest('first', '{}', 'shared', 'ms=8000&until=2', '2')]),
    'tests/b.retest.ts': holdingFile([holdingTest('second', '{}', 'shared', 'ms=8000&until=2', '2')]),
  })
  const run = await runProject(t, root, { args: ['--workers', '2'], timeouts: budgets({ navigation: 10_000, test: 15_000 }) })
  assert.equal(run.exit.code, 0, run.stderr)
  assert.deepEqual(await holders(url, 'shared'), { current: 0, most: 2, holds: 2 })
})

test('two tests that hold a common lock never run at the same time across workers, and the others keep running beside them', async (t) => {
  const files: Record<string, string> = {}
  for (const letter of ['a', 'b', 'c', 'd']) {
    files[`tests/${letter}.retest.ts`] = holdingFile([
      holdingTest(`${letter} reads the inbox`, "{ locks: ['inbox'] }", 'inbox', 'ms=300', '1'),
      holdingTest(`${letter} reads the inbox again`, "{ locks: ['inbox'] }", 'inbox', 'ms=300', '1'),
    ])
  }
  files['tests/e.retest.ts'] = holdingFile([
    holdingTest('uses the account', "{ locks: ['account', 'inbox'] }", 'inbox', 'ms=300', '1'),
    holdingTest('holds nothing', '{}', 'free', 'ms=300', '1'),
  ])
  const { root, url } = await project(t, files)
  const run = await runProject(t, root, { args: ['--workers', '4'] })
  assert.equal(run.exit.code, 0, run.stderr)
  assert.equal(resultOf(run).counts.passed, 10)
  assert.deepEqual(await holders(url, 'inbox'), { current: 0, most: 1, holds: 9 }, 'the app never saw two inbox holders at once')

  const spans = holds(run, 'inbox')
  assert.equal(spans.length, 9)
  assertNoOverlap(spans)
  assert.ok(spans.some((span) => span.waitedMs > 0), 'some test waited for the lock')
  const waited = eventsOf(run.events, 'lock.acquired').filter((event) => event.waitedMs > 0)
  assert.ok(waited.some((event) => (event.heldBy?.length ?? 0) > 0), 'a test that waited names the test that held the lock')
  assert.equal(eventsOf(run.events, 'lock.acquired').find((event) => event.testId === testNamed(run, 'holds nothing').testId), undefined, 'a test that holds nothing records no lock')
  const both = eventsOf(run.events, 'lock.acquired').find((event) => event.testId === testNamed(run, 'uses the account').testId)
  assert.deepEqual(both?.locks, ['account', 'inbox'])
  const started = eventsOf(run.events, 'run.started')[0]
  assert.equal(started?.options.workers, 4, 'the run kept its workers')
})

test('a test is not charged against its own budget for the time it waits for a lock', async (t) => {
  // The holder keeps the inbox until this test releases it, more than three times the waiter's budget after the
  // waiter has asked, so the wait is long by construction, not by timing.
  const budgetMs = 1500
  const app = await openApp(t)
  const holding = `import { expect, test } from '@rehearsal-labs/retest'

test('holds the inbox until released', { locks: ['inbox'], timeout: 30000 }, async ({ page }) => {
  await page.goto('/holders/hold?name=inbox&release=1')
  await expect(page.getByTestId('overlap')).toHaveText('1')
})
`
  const waiting = `import { expect, test } from '@rehearsal-labs/retest'

const appUrl = ${JSON.stringify(app.url)}

test('waits until the inbox is held', { timeout: 30000 }, async () => {
  const held = async () => ((await (await fetch(new URL('/holders?name=inbox', appUrl))).json()) as { current: number }).current
  await expect.poll(held, { timeout: 25000 }).toBe(1)
})

test('has a short budget', { locks: ['inbox'], timeout: ${budgetMs} }, async ({ page }) => {
  await page.goto('/holders/hold?name=inbox&ms=0')
  await expect(page.getByTestId('overlap')).toHaveText('1')
})
`
  const config = configSource(`{ apps: { web: chrome({ baseUrl: ${JSON.stringify(app.url)} }) }, locks: ['inbox'] }`)
  const root = await writeProject(t, { 'retest.config.ts': config, 'tests/a.retest.ts': holding, 'tests/b.retest.ts': waiting })
  const started = startRun(t, { files: [], cwd: root, browser: false, args: ['--workers', '2'], timeouts: budgets({ test: 30_000, assertion: 25_000, navigation: 20_000 }) })
  await waitForAsync('the inbox is held', async () => (await holders(app.url, 'inbox')).current === 1, 20_000)
  await delay(budgetMs * 3 + 1000)
  const released = await fetch(new URL('/holders/release?name=inbox', app.url))
  assert.equal(released.ok, true)
  const run = await finishRun(await started)
  assert.equal(run.exit.code, 0, JSON.stringify(resultOf(run).files.flatMap((each) => each.tests).map((each) => [each.name, each.status, each.failure?.message])))
  const short = testNamed(run, 'has a short budget')
  assert.equal(short.status, 'passed')
  assert.ok(short.durationMs < budgetMs, `the test took ${short.durationMs} ms of its own ${budgetMs} ms budget`)
  const wait = eventsOf(run.events, 'lock.acquired').find((event) => event.testId === short.testId)
  assert.ok(wait !== undefined && wait.waitedMs > budgetMs, `the test waited ${wait?.waitedMs} ms for the lock, longer than its budget, and passed`)
  assertNoOverlap(holds(run, 'inbox'))
  assert.equal((await holders(app.url, 'inbox')).most, 1)
  const shown = await runCli(t, ['inspect', run.output, '--test', short.testId], { cwd: root })
  assert.equal(shown.exit.code, 0, shown.stderr)
  assert.match(shown.stdout, /holds lock inbox, after waiting [\d.]+s/, 'inspect shows the wait in the timeline')
  const human = await runCli(t, ['inspect', run.output], { cwd: root })
  assert.match(human.stdout, /has a short budget {2}(\d+ ms|[\d.]+s)\n {6}holds lock inbox, after waiting [\d.]+s\n/, 'the human report shows the wait under the test')
})

/** Waits until an asynchronous condition holds, looking every 50 ms, and fails after `timeoutMs`. */
async function waitForAsync(what: string, condition: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const end = performance.now() + timeoutMs
  while (!(await condition())) {
    if (performance.now() > end) assert.fail(`${what} did not happen within ${timeoutMs} ms`)
    await delay(50)
  }
}

const example = join(repositoryRoot, 'examples/tasks')

function exampleFiles(): Record<string, string> {
  const paths = ['retest.config.ts', ...readdirSync(join(example, 'tests')).map((name) => `tests/${name}`)]
  return Object.fromEntries(paths.map((path) => [path, readFileSync(join(example, path), 'utf8')]))
}

test("the example's count of every save, which flaked under workers, passes run after run, its savers never overlapping", async (t) => {
  const app = await openApp(t)
  const root = await writeProject(t, exampleFiles())
  for (const attempt of [1, 2, 3]) {
    const run = await runProject(t, root, {
      args: ['--workers', '4'],
      env: { TASK_APP_URL: app.url, TASK_APP_PASSWORD, RETEST_CHROMIUM: secondBrowserPath() },
    })
    assert.equal(run.exit.code, 0, `run ${attempt}: ${run.stderr}`)
    assert.equal(testNamed(run, 'the server counts one save for one click').status, 'passed', `run ${attempt}`)
    const spans = holds(run, 'saves')
    assert.deepEqual(spans.map((span) => span.name).sort(), [
      'a task one role saves stays in its own browser',
      'saves "Groceries"',
      'saves "Release checklist"',
      'saves a task in each desktop browser',
      'saves a task in each desktop browser',
      'the server counts one save for one click',
    ])
    assertNoOverlap(spans)
  }
})
