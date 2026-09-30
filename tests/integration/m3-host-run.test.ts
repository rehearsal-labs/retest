import type { TestContext } from 'node:test'
import type { FixtureProxy } from '../../fixtures/proxy/server.ts'
import type { TaskApp } from '../../fixtures/task-app/server.ts'
import type { HostRun, Packed } from './cli-harness.ts'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { PROXY_HEADER, startProxy } from '../../fixtures/proxy/server.ts'
import { TASK_APP_PASSWORD } from '../../fixtures/task-app/sign-in.ts'
import { tempFolder } from '../support/temp-folder.ts'
import { openApp } from './browser-harness.ts'
import { childLog, eventsOf, filesHolding, installPacked, packRetest, repositoryRoot, runHost, secondBrowserPath, textHolds, writeFiles } from './cli-harness.ts'

// Acceptance check 6, the short list's form: examples/host/host.ts, a host's own program, run from a project outside
// the repository with the packed tarball installed offline. It builds its config in memory, gives each secret as a
// function, writes the test file itself, sends Chrome for Testing through the fixture proxy, adds host checks,
// and gives the test process an environment of its own.

const hostToken = 'host-token-3f81c2a9'

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
    for (const file of ['host.ts', 'checkout.retest.ts']) await copyFile(join(repositoryRoot, 'examples/host', file), join(project, file))
    assert.ok(!project.startsWith(repositoryRoot), 'the project lives outside the repository')
    return project
  }

  type Hosted = { run: HostRun; app: TaskApp; proxy: FixtureProxy; project: string }

  async function hostRun(t: TestContext, name: string, mode: 'ok' | 'wrong-page'): Promise<Hosted> {
    const project = await hostProject(name)
    const outbox = join(project, 'outbox.txt')
    const app = await openApp(t, { mode, requireHeader: PROXY_HEADER, outbox })
    const proxy = await startProxy()
    t.after(() => proxy.close())
    const run = await runHost(t, {
      cwd: project,
      command: [process.execPath, 'host.ts', app.url, proxy.url, outbox],
      env: { HOST_PASSWORD: TASK_APP_PASSWORD, HOST_TOKEN: hostToken, RETEST_CHROMIUM: secondBrowserPath() },
    })
    return { run, app, proxy, project }
  }

  test('passes: every page request goes through the proxy, the checks are the parent’s, and no secret or host variable reaches the test', async (t) => {
    const { run, app, proxy, project } = await hostRun(t, 'passing', 'ok')

    assert.equal(run.exit.code, 0, run.stderr)
    assert.equal(run.returned.status, 'passed')
    const [started] = eventsOf(run.events, 'run.started')
    assert.equal(started?.options.config, 'host.config.ts', 'the config is recorded under its label')
    assert.equal(existsSync(join(project, 'host.config.ts')), false, 'and no file is behind the label')
    const [file, ...others] = Object.keys(started?.options.hostChecks ?? {})
    assert.ok(file !== undefined && others.length === 0 && /^checkout-\w+\/checkout\.retest\.ts$/.test(file), `the checks are keyed by the file the host wrote: ${file}`)
    assert.deepEqual(started?.files, [file])

    // One app on Chrome for Testing, through the fixture proxy, which the app requires for every request.
    const browsers = eventsOf(run.events, 'browser.started')
    assert.deepEqual(
      browsers.map((event) => [event.executablePath, event.target?.proxy]),
      [[secondBrowserPath(), { server: proxy.url, bypass: ['<-loopback>'] }]],
    )
    assert.equal(app.refused(), 0, 'the app refused no request, so every one came through the proxy')
    const carried = proxy.requests().map(({ method, target }) => `${method} ${target}`)
    for (const request of [`GET ${app.url}/code/sign-in`, `POST ${app.url}/code/send`, `POST ${app.url}/code/verify`, `POST ${app.url}/api/tasks`]) {
      assert.ok(carried.includes(request), `the proxy carried ${request}`)
    }

    // The host checks are the parent's events, and the result lists each.
    assert.deepEqual(
      eventsOf(run.events, 'host_check.passed').map((event) => [event.origin, event.check.kind]),
      [
        ['parent', 'address'],
        ['parent', 'text'],
        ['parent', 'text'],
      ],
    )
    const [result] = run.returned.files.flatMap((each) => each.tests)
    assert.deepEqual(result?.hostChecks?.map((entry) => entry.status), ['passed', 'passed', 'passed'])

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
    const { run } = await hostRun(t, 'wrong-page', 'wrong-page')

    assert.equal(run.exit.code, 1, run.stderr)
    const [result] = run.returned.files.flatMap((each) => each.tests)
    assert.deepEqual([result?.status, result?.failure?.class], ['failed', 'host_check_failed'])
    assert.deepEqual(result?.hostChecks?.map((entry) => [entry.check.kind, entry.status]), [
      ['address', 'failed'],
      ['text', 'passed'],
      ['text', 'passed'],
    ])
    assert.match(result?.failure?.message ?? '', /the page is on http:\/\/127\.0\.0\.1:\d+\/drafts, expected http:\/\/127\.0\.0\.1:\d+\/\./)
    assert.equal(eventsOf(run.events, 'assertion.passed').length, 3, 'the test’s own checks passed')
  })
})
