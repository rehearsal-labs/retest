import type { TestContext } from 'node:test'
import type { AppServerFlags } from './cli-harness.ts'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { appLogFile } from '../../src/protocol/run-folder.ts'
import {
  answersAt,
  appServerCommand,
  appServersOn,
  configSource,
  eventsOf,
  freePort,
  isRunning,
  onlyEvent,
  resultOf,
  runProject,
  startAppServerFixture,
  writeProject,
} from './cli-harness.ts'

// Acceptance check 14: `start` runs the app's server when nothing answers at `ready`, waits for it, logs its
// output, and stops its whole process group when the run ends; a server already running is used and left alone;
// a server that never answers is a setup failure for the tests that need it.

const servedTests = `import { expect, test } from '@rehearsal-labs/retest'

test('opens the served page', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading')).toHaveText('Served by the app server')
})

test('opens it again', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading')).toHaveText('Served by the app server')
})
`

type ServedProject = { root: string; url: string; port: number }

/** `port` defaults to a free one; `command` to the fixture app server on it, started with `flags`. */
type ServedOptions = { port?: number; flags?: AppServerFlags; command?: string; timeoutMs?: number }

async function servedProject(t: TestContext, options: ServedOptions = {}): Promise<ServedProject> {
  const port = options.port ?? (await freePort())
  const url = `http://127.0.0.1:${port}`
  const command = options.command ?? appServerCommand(port, options.flags)
  const timeout = options.timeoutMs === undefined ? '' : `, timeoutMs: ${options.timeoutMs}`
  const root = await writeProject(t, {
    'retest.config.ts': configSource(`{
  apps: { web: chrome({ baseUrl: ${JSON.stringify(url)}, start: { command: ${JSON.stringify(command)}, ready: ${JSON.stringify(url)}${timeout} } }) },
}`),
    'tests/served.retest.ts': servedTests,
  })
  return { root, url, port }
}

test('start runs the server, waits until ready answers, logs its output, and stops its whole group at the end', async (t) => {
  const { root, url, port } = await servedProject(t, { flags: { delayMs: 700, child: true } })
  const run = await runProject(t, root)

  assert.equal(run.exit.code, 0, run.stderr)
  const started = onlyEvent(run.events, 'app.started')
  assert.deepEqual([started.app, started.ready], ['web', url])
  assert.ok(started.durationMs >= 700, `ready answered after ${started.durationMs} ms, before the server listened`)
  const firstTest = eventsOf(run.events, 'test.started')[0]
  assert.ok(firstTest !== undefined && started.sequence < firstTest.sequence, 'the server was ready before the test started')

  const log = readFileSync(join(run.output, appLogFile('web')), 'utf8')
  for (const line of ['starting', 'app server writes to stderr too', `listening on ${url}`, 'GET /', 'stopping on SIGTERM']) {
    assert.ok(log.includes(line), `the server log holds "${line}":\n${log}`)
  }
  const child = Number(/^child pid (\d+)$/m.exec(log)?.[1])
  assert.ok(Number.isInteger(child), 'the server started its child')
  assert.equal(isRunning(child), false, 'the child in the server group was stopped too')
  assert.deepEqual(await appServersOn(port), [])
  assert.equal(await answersAt(url), false)
})

test('a server already answering at ready is used, never started again, and left running', async (t) => {
  const port = await freePort()
  const { pid, url } = await startAppServerFixture(t, port)
  const { root } = await servedProject(t, { port })
  const run = await runProject(t, root)

  assert.equal(run.exit.code, 0, run.stderr)
  assert.deepEqual(eventsOf(run.events, 'app.started'), [])
  assert.deepEqual(onlyEvent(run.events, 'app.reused').ready, url)
  assert.equal(isRunning(pid), true, 'the server Retest found running is still running')
  assert.equal(await answersAt(url), true)
})

test('a server that never answers is a setup failure for every test that needs it, and is stopped', async (t) => {
  const { root, url, port } = await servedProject(t, { flags: { neverListen: true, child: true }, timeoutMs: 1500 })
  const run = await runProject(t, root)

  assert.equal(run.exit.code, 2, run.stderr)
  const failed = onlyEvent(run.events, 'app.failed')
  assert.equal(failed.failure.class, 'setup_failed')
  assert.match(failed.failure.message, new RegExp(`^The server for web did not answer at ${url} within 1500 ms\\. Its output is in .+app-web-[a-z0-9-]+\\.log\\.$`))
  const tests = resultOf(run).files.flatMap((file) => file.tests)
  assert.equal(tests.length, 2)
  for (const each of tests) {
    assert.equal(each.status, 'not_run')
    assert.deepEqual(each.failure, failed.failure, 'each test that needs the server carries its failure')
  }
  assert.deepEqual(eventsOf(run.events, 'browser.started'), [], 'no browser starts for tests that cannot run')
  assert.deepEqual(await appServersOn(port), [], 'the server that never answered was stopped')
  assert.match(readFileSync(join(run.output, appLogFile('web')), 'utf8'), /starting/)
})

test('a server that exits before it answers is a setup failure that gives its exit', async (t) => {
  const { root, url } = await servedProject(t, { command: 'echo about to fail; exit 3' })
  const run = await runProject(t, root)

  assert.equal(run.exit.code, 2, run.stderr)
  assert.match(onlyEvent(run.events, 'app.failed').failure.message, new RegExp(`^The server for web exited with exit code 3 before ${url} answered\\.`))
  assert.match(readFileSync(join(run.output, appLogFile('web')), 'utf8'), /about to fail/)
})

test('a server that ignores SIGTERM is killed after the close grace, with its group', async (t) => {
  const { root, port } = await servedProject(t, { flags: { ignoreTerm: true, child: true } })
  const run = await runProject(t, root)

  assert.equal(run.exit.code, 0, run.stderr)
  assert.match(readFileSync(join(run.output, appLogFile('web')), 'utf8'), /ignoring SIGTERM/)
  assert.deepEqual(await appServersOn(port), [])
})
