import type { TestContext } from 'node:test'
import type { FixtureProxy } from '../../fixtures/proxy/server.ts'
import type { TaskApp, TaskAppOptions } from '../../fixtures/task-app/server.ts'
import type { Failure } from '../../src/protocol/failures.ts'
import type { HostRun, Packed, StartedRun } from './cli-harness.ts'
import assert from 'node:assert/strict'
import { existsSync, readdirSync } from 'node:fs'
import { copyFile, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { PROXY_HEADER, startProxy } from '../../fixtures/proxy/server.ts'
import { TASK_APP_PASSWORD } from '../../fixtures/task-app/sign-in.ts'
import { tempFolder } from '../support/temp-folder.ts'
import { openApp } from './browser-harness.ts'
import {
  childLog,
  eventsOf,
  filesHolding,
  finishHost,
  installPacked,
  onlyEvent,
  packRetest,
  repositoryRoot,
  runCli,
  secondBrowserPath,
  startHost,
  textHolds,
  writeFiles,
} from './cli-harness.ts'

// Acceptance check 6: examples/host/host.ts, a host's own program, run from a project outside the repository with
// the packed tarball installed offline. It builds its config in memory, gives each secret as a function, writes the
// test file into a new folder of its own with no node_modules, sends Chrome for Testing through the fixture proxy,
// adds host checks, gives the test process an environment of its own, writes no last-run file, and reads its run
// folder back. SIGTERM makes it stop the run with a Failure that says why.

const hostToken = 'host-token-3f81c2a9'
const file = 'checkout.retest.ts'
const shuttingDown: Failure = { class: 'interrupted', message: 'The host is shutting down, so it stopped the run.' }

describe('a host-style run', () => {
  let root = ''
  let packed: Packed | undefined

  before(async () => {
    root = tempFolder('host-run-')
    packed = await packRetest(root)
  })

  after(async () => {
    if (root !== '') await rm(root, { recursive: true, force: true })
  })

  async function hostProject(name: string): Promise<string> {
    assert.ok(packed !== undefined, 'the package was packed')
    const project = join(root, name)
    await mkdir(project)
    await writeFiles(project, { 'package.json': `${JSON.stringify({ name: `host-${name}`, private: true, type: 'module' })}\n` })
    await installPacked(project, packed)
    for (const name of ['host.ts', file]) await copyFile(join(repositoryRoot, 'examples/host', name), join(project, name))
    assert.ok(!project.startsWith(repositoryRoot), 'the project lives outside the repository')
    return project
  }

  type Hosted = { app: TaskApp; proxy: FixtureProxy; project: string; started: StartedRun }

  async function startHostRun(t: TestContext, name: string, app: Omit<TaskAppOptions, 'requireHeader' | 'outbox'> = {}): Promise<Hosted> {
    const project = await hostProject(name)
    const outbox = join(project, 'outbox.txt')
    const opened = await openApp(t, { ...app, requireHeader: PROXY_HEADER, outbox })
    const proxy = await startProxy()
    t.after(() => proxy.close())
    const started = await startHost(t, {
      cwd: project,
      command: [process.execPath, 'host.ts', opened.url, proxy.url, outbox],
      env: { HOST_PASSWORD: TASK_APP_PASSWORD, HOST_TOKEN: hostToken, RETEST_CHROMIUM: secondBrowserPath() },
    })
    return { app: opened, proxy, project, started }
  }

  // The folder the host wrote the test into: its run's root, which it names on stderr.
  function rootOf(run: HostRun): string {
    const written = /^root (.+)$/m.exec(run.stderr)?.[1]
    assert.ok(written !== undefined, `the host named the folder it wrote the test into. stderr:\n${run.stderr}`)
    return written
  }

  // What the host reported after reading its run folder back, against what it kept in memory.
  function assertFolderReadBack(run: HostRun): void {
    const read = /^run folder read from (.+): (.+), (.+) (\d+) events$/m.exec(run.stderr)
    assert.deepEqual(read?.slice(1), ['result.json', 'the same result', 'the same', String(run.events.length)], run.stderr)
  }

  // The test file lives outside the project in a folder of its own, with no node_modules, and no last-run file is
  // left under it or the project.
  function assertOwnFolder(run: HostRun, project: string): string {
    const written = rootOf(run)
    assert.ok(!written.startsWith(project) && !written.startsWith(repositoryRoot), `${written} is outside the project and the repository`)
    assert.deepEqual(readdirSync(written).sort(), [file], 'the folder holds the test file and nothing else: no node_modules, no .retest')
    assert.equal(existsSync(join(project, '.retest')), false, 'no .retest folder under the project either')
    assert.equal(onlyEvent(run.events, 'run.started').rootDir, written)
    return written
  }

  test('passes: every page request goes through the proxy, the checks are the parent’s, and no secret or host variable reaches the test', async (t) => {
    const { app, proxy, project, started } = await startHostRun(t, 'passing')
    const run = await finishHost(started)

    assert.equal(run.exit.code, 0, run.stderr)
    assert.equal(run.returned.status, 'passed')
    const written = assertOwnFolder(run, project)
    const runStarted = onlyEvent(run.events, 'run.started')
    assert.equal(runStarted.options.config, 'host.config.ts', 'the config is recorded under its label')
    assert.equal(existsSync(join(written, 'host.config.ts')), false, 'and no file is behind the label')
    assert.deepEqual(Object.keys(runStarted.options.hostChecks ?? {}), [file], 'the checks are keyed by the file the host wrote')
    assert.deepEqual(runStarted.files, [file])
    assertFolderReadBack(run)

    // One app on Chrome for Testing, through the fixture proxy, which the app requires for every request.
    const browsers = eventsOf(run.events, 'browser.started')
    assert.deepEqual(
      browsers.map((event) => [event.executablePath, event.target?.proxy]),
      [[secondBrowserPath(), { server: proxy.url, bypass: ['<-loopback>'] }]],
    )
    assert.equal(app.refused(), 0, 'the app refused no request, so every one came through the proxy')
    const carried = proxy.requests().map(({ method, target }) => `${method} ${target}`)
    for (const request of [`GET ${app.url}/code/sign-in`, `POST ${app.url}/code/send`, `POST ${app.url}/code/verify`, `GET ${app.url}/`, `POST ${app.url}/api/tasks`]) {
      assert.ok(carried.includes(request), `the proxy carried ${request}`)
    }

    // The host checks are the parent's events, and the result lists each.
    const checks = eventsOf(run.events, 'host_check.passed')
    assert.deepEqual(
      checks.map((event) => [event.origin, event.check.kind, event.actual.title]),
      [
        ['parent', 'address', 'Tasks'],
        ['parent', 'text', 'Tasks'],
        ['parent', 'text', 'Tasks'],
      ],
    )
    const [result] = run.returned.files.flatMap((each) => each.tests)
    assert.deepEqual(result?.hostChecks?.map((entry) => entry.status), ['passed', 'passed', 'passed'])

    // Each navigation says what opened it, and no goto opened the page the checks read: the app's own link did.
    const navigations = eventsOf(run.events, 'navigation').map((event) => [event.url.slice(app.url.length), event.cause, event.title])
    assert.deepEqual(navigations, [
      ['/code/sign-in', 'goto', 'Sign in with a code'],
      ['/code/verify', 'action', 'Enter the code'],
      ['/account', 'action', 'Account'],
      ['/', 'action', 'Tasks'],
    ])
    const firstCheck = run.events.findIndex((event) => event.type === 'host_check.passed')
    const lastBefore = eventsOf(run.events.slice(0, firstCheck), 'navigation').at(-1)
    assert.deepEqual([lastBefore?.url, lastBefore?.cause], [`${app.url}/`, 'action'], 'the last navigation before the checks was not a goto')

    // Each locator check rested on a look the parent served; the harness checks the look for every pass.
    assert.deepEqual(
      eventsOf(run.events, 'assertion.passed').map((event) => [event.matcher, event.judgedBy]),
      [
        ['toBeVisible', 'parent'],
        ['toHaveText', 'parent'],
        ['toHaveText', 'parent'],
      ],
    )
    const actions = eventsOf(run.events, 'action.completed')
    assert.deepEqual(
      actions.filter((event) => event.secret !== undefined || event.command === 'press').map((event) => [event.command, event.secret ?? event.key]),
      [
        ['fill', 'password'],
        ['fill', 'code'],
        ['press', 'Enter'],
      ],
    )

    // The test process had CANARY, and none of the host's own variables.
    const log = childLog(run, file)
    for (const line of ['CANARY is set', 'HOST_TOKEN is not set', 'HOST_PASSWORD is not set']) assert.ok(log.includes(line), log)

    // The password, the code and the host's token are in no file of the run folder, the output or the events.
    const [code, ...resent] = app.sentCodes()
    assert.ok(code !== undefined && resent.length === 0, 'the app sent one code')
    for (const value of [TASK_APP_PASSWORD, code, hostToken]) {
      assert.deepEqual(filesHolding(run.output, value), [], 'no file of the run folder holds a secret or the host token')
      assert.ok(!textHolds(run.stdout, value) && !textHolds(run.stderr, value), 'the host printed none of them, events included')
    }
  })

  test('against an app that saves and ends on the wrong page, the same run fails with host_check_failed', async (t) => {
    const { app, project, started } = await startHostRun(t, 'wrong-page', { mode: 'wrong-page' })
    const run = await finishHost(started)

    assert.equal(run.exit.code, 1, run.stderr)
    assertOwnFolder(run, project)
    assertFolderReadBack(run)
    const [result] = run.returned.files.flatMap((each) => each.tests)
    assert.deepEqual([result?.status, result?.failure?.class], ['failed', 'host_check_failed'])
    assert.deepEqual(result?.hostChecks?.map((entry) => [entry.check.kind, entry.status]), [
      ['address', 'failed'],
      ['text', 'passed'],
      ['text', 'passed'],
    ])
    assert.match(result?.failure?.message ?? '', /the page is on http:\/\/127\.0\.0\.1:\d+\/drafts, expected http:\/\/127\.0\.0\.1:\d+\/\./)
    assert.equal(eventsOf(run.events, 'assertion.passed').length, 3, 'the test’s own checks passed')
    // The save's own click listener moved the address, so the last navigation is the action's, on the wrong page.
    const last = eventsOf(run.events, 'navigation').at(-1)
    assert.deepEqual([last?.url, last?.cause], [`${app.url}/drafts`, 'action'])
  })

  test('stopped with a Failure as its reason, the run records that reason in run.finished, the result and the test it stopped, and exits 130', async (t) => {
    // The save never answers in time, so the test is still waiting for it when the host is told to shut down.
    const { project, started } = await startHostRun(t, 'stopped', { mode: 'delayed', delayMs: 60_000 })
    await started.retest.waitForEvent('action.completed', (event) => event.command === 'click' && event.locator?.by === 'role' && event.locator.name === 'Save')
    started.retest.signal('SIGTERM')
    const run = await finishHost(started)

    assert.equal(run.exit.code, 130, run.stderr)
    assert.deepEqual([run.returned.status, run.returned.failure], ['interrupted', shuttingDown])
    const finished = onlyEvent(run.events, 'run.finished')
    assert.deepEqual([finished.status, finished.exitCode, finished.failure], ['interrupted', 130, shuttingDown])
    const [result] = run.returned.files.flatMap((each) => each.tests)
    assert.deepEqual([result?.status, result?.failure], ['error', shuttingDown])
    assert.deepEqual(result?.hostChecks?.map((entry) => entry.status), ['not_run', 'not_run', 'not_run'], 'no check ran on a body that did not pass')
    assertOwnFolder(run, project)
    assertFolderReadBack(run)

    // The report replayed from the folder says why the run stopped.
    const report = await runCli(t, ['inspect', run.output], { env: { NO_COLOR: '1' } })
    assert.equal(report.exit.code, 0, report.stderr)
    assert.ok(report.stdout.includes(shuttingDown.message), report.stdout)
  })
})
