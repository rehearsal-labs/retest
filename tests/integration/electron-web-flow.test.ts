import type { TestContext } from 'node:test'
import type { RequestRecord } from '../../fixtures/cross-platform/service/request-log.ts'
import type { FinishedRun } from './cli-harness.ts'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { SEEDED_ACCOUNTS } from '../../fixtures/cross-platform/service/accounts.ts'
import { parseRequestRecord } from '../../fixtures/cross-platform/service/request-log.ts'
import { signalGroup } from '../../src/browser/chromium-process.ts'
import { budgets, eventsOf, filesHolding, repositoryRoot, runProject, scratchFolder, testNamed, writeProject } from './cli-harness.ts'

// One test across two apps on the cross-platform fixture's service: it creates a task in the Electron fixture, opens
// that task by its id on the web in Chrome, marks it done there, and sees the change in the Electron window once the
// service passes it on. The same test fails at the web check when the service never passes changes on to the web, and
// the password reaches the Electron window only on the origin the config allows.

const electronVersion = '44.5.1'
const givenBinary = process.env['RETEST_TEST_ELECTRON']
const electronBinary = givenBinary ?? join(homedir(), 'Library/Caches/retest-proofs/electron', electronVersion, 'dist/Electron.app/Contents/MacOS/Electron')
// On macOS a missing binary fails these tests. Elsewhere Retest has no route to an Electron build yet, so without one
// given they are skipped by name, never in silence.
const unverified =
  process.platform !== 'darwin' && givenBinary === undefined
    ? `unverified: RETEST_TEST_ELECTRON is not set, and Retest has no route yet to an Electron build on ${process.platform}, so no Electron app was run`
    : false
const fixtureApp = join(repositoryRoot, 'fixtures/electron')
const serverScript = join(repositoryRoot, 'fixtures/cross-platform/service/server.ts')
const [ada] = SEEDED_ACCOUNTS
assert.ok(ada !== undefined && ada.id === 'ada')
const password = ada.password
const syncDelayMs = 1000
const environment = { RETEST_ELECTRON_FLOW_PASSWORD: password }
// A change reaches another client after the sync delay, and the clients ask for the list once a second.
const timeouts = budgets({ assertion: 6000, action: 4000, test: 40_000 })
const flowName = 'creates a task in Electron, marks it done on the web, and sees it done in Electron'

const flow = `import { randomUUID } from 'node:crypto'
import { expect, secret, test } from '@rehearsal-labs/retest'

test(${JSON.stringify(flowName)}, { apps: ['desktop', 'web'] }, async ({ desktop, web }) => {
  // Titles repeat in the service on purpose, so the task is followed by the id the service gives it.
  const title = 'Release checklist ' + randomUUID().slice(0, 8)
  await desktop.getByTestId('account').fill('ada')
  await desktop.getByTestId('password').fill(secret('password'))
  await desktop.getByTestId('sign-in').click()
  await expect(desktop.getByTestId('signed-in-account')).toHaveText('ada')
  await desktop.getByTestId('new-task-title').fill(title)
  await desktop.getByTestId('create-task').click()
  await expect(desktop).toHaveURL(/\\/electron\\/tasks\\/task-[0-9a-f]{12}$/)
  const id = /\\/tasks\\/(task-[0-9a-f]{12})$/.exec(await desktop.url())?.[1]
  if (id === undefined) throw new Error('The window names no task: ' + (await desktop.url()))
  await expect(desktop.getByTestId('created-task-id')).toHaveText(id)
  await expect(desktop.getByTestId('task-state-' + id)).toHaveText('Open')

  await web.goto('/')
  await web.getByTestId('account').fill('ada')
  await web.getByTestId('password').fill(secret('password'))
  await web.getByTestId('sign-in').click()
  await expect(web.getByTestId('signed-in-account')).toHaveText('ada')
  // The web sees the task once the service has passed it on.
  await expect(web.getByTestId('task-title-' + id)).toHaveText(title)
  await web.goto('/tasks/' + id)
  await expect(web.getByTestId('selected-task-id')).toHaveText(id)
  await expect(web.getByTestId('selected-task-title')).toHaveText(title)
  await expect(web.getByTestId('selected-task-state')).toHaveText('Open')
  await web.getByTestId('edit-done').check()
  await web.getByTestId('save-task').click()
  await expect(web.getByTestId('selected-task-state')).toHaveText('Done')

  // And the Electron window sees the web's change once the service has passed it on.
  await expect(desktop.getByTestId('task-state-' + id)).toHaveText('Done')
})
`

const signIn = `import { expect, secret, test } from '@rehearsal-labs/retest'

test('signs in to the service in the Electron window', { apps: ['desktop'] }, async ({ desktop }) => {
  await desktop.getByTestId('account').fill('ada')
  await desktop.getByTestId('password').fill(secret('password'))
  await desktop.getByTestId('sign-in').click()
  await expect(desktop.getByTestId('signed-in-account')).toHaveText('ada')
})
`

type ConfigOptions = { service: string; web: boolean; secretOrigins: boolean }

function configSource({ service, web, secretOrigins }: ConfigOptions): string {
  const apps = [
    `desktop: electron({ executablePath: ${JSON.stringify(electronBinary)}, appPath: ${JSON.stringify(fixtureApp)}, args: [${JSON.stringify(`--service=${service}`)}] }),`,
    ...(web ? [`web: chrome({ baseUrl: ${JSON.stringify(service)} }),`] : []),
  ]
  return `import { chrome, defineConfig, electron, env } from '@rehearsal-labs/retest'

export default defineConfig({
  apps: {
    ${apps.join('\n    ')}
  },
  secrets: { password: env('RETEST_ELECTRON_FLOW_PASSWORD') },${secretOrigins ? `\n  secretOrigins: { password: [${JSON.stringify(service)}] },` : ''}
})
`
}

type Service = { url: string; requests(): RequestRecord[] }

/** Starts the service on a free port in a process group of its own, ended after the test. */
async function startService(t: TestContext, flags: readonly string[] = []): Promise<Service> {
  const folder = await scratchFolder(t, 'retest-electron-service-')
  const networkLog = join(folder, 'network.jsonl')
  const args = ['--conditions=retest-source', serverScript, '--port', '0', '--sync-delay-ms', String(syncDelayMs), '--network-log', networkLog, ...flags]
  const child = spawn(process.execPath, args, { detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const { pid } = child
  assert.ok(pid !== undefined, 'the service did not start')
  t.after(() => signalGroup(pid, 'SIGKILL'))
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8').on('data', (text: string) => {
    stdout += text
  })
  child.stderr.setEncoding('utf8').on('data', (text: string) => {
    stderr += text
  })
  const end = performance.now() + 15_000
  for (;;) {
    const url = /^(http:\/\/127\.0\.0\.1:\d+)\n/.exec(stdout)?.[1]
    if (url !== undefined) {
      const requests = (): RequestRecord[] =>
        existsSync(networkLog)
          ? readFileSync(networkLog, 'utf8')
              .split('\n')
              .filter((line) => line !== '')
              .flatMap((line) => parseRequestRecord(line) ?? [])
          : []
      return { url, requests }
    }
    if (performance.now() > end) assert.fail(`the service printed no address within 15 s: ${stderr}`)
    await delay(10)
  }
}

function binaryPresent(): void {
  assert.ok(existsSync(electronBinary), `No Electron binary at ${electronBinary}. Download Electron ${electronVersion} as docs/plans/public-beta/proofs/electron.md says, or set RETEST_TEST_ELECTRON to an Electron binary.`)
}

// The task the Electron window created, as its own check of the created id recorded it.
function createdId(run: FinishedRun): string {
  const created = eventsOf(run.events, 'assertion.passed').find((event) => event.locator?.by === 'testId' && event.locator.value === 'created-task-id')
  const id = created?.expected?.text
  assert.ok(id !== undefined && /^task-[0-9a-f]{12}$/.test(id), `the Electron window showed the task it created: ${JSON.stringify(created?.expected)}`)
  return id
}

test('a task created in Electron is opened by its id on the web, marked done there, and seen done in Electron', { timeout: 180_000, skip: unverified }, async (t) => {
  binaryPresent()
  const service = await startService(t)
  const root = await writeProject(t, { 'retest.config.ts': configSource({ service: service.url, web: true, secretOrigins: false }), 'tests/flow.retest.ts': flow })
  const run = await runProject(t, root, { env: environment, timeouts })

  assert.equal(run.exit.code, 0, `${run.stdout}\n${run.stderr}`)
  assert.equal(testNamed(run, flowName).status, 'passed')
  const id = createdId(run)

  // Both apps ran: the Electron app with its versions, and Chrome.
  const started = eventsOf(run.events, 'browser.started')
  const desktop = started.filter((event) => event.app === 'desktop')
  const web = started.filter((event) => event.app === 'web')
  assert.equal(desktop.length, 1)
  assert.deepEqual([desktop[0]?.product, desktop[0]?.version, desktop[0]?.target?.electron?.version], ['Electron', electronVersion, electronVersion])
  assert.match(desktop[0]?.target?.electron?.chromium ?? '', /^\d+\.\d+\.\d+\.\d+$/)
  assert.equal(web.length, 1)
  assert.equal(web[0]?.product, 'Chrome')
  assert.equal(web[0]?.target?.electron, undefined)

  // The service saw the task made by the Electron client and changed by the web client, by its id.
  const requests = service.requests()
  const made = requests.filter((request) => request.method === 'POST' && request.path === '/api/tasks')
  assert.deepEqual(made.map(({ client, status }) => ({ client, status })), [{ client: 'electron', status: 201 }], 'the task was made by the Electron window, once')
  const changed = requests.filter((request) => request.method === 'PATCH')
  assert.deepEqual(changed.map(({ path, client, status }) => ({ path, client, status })), [{ path: `/api/tasks/${id}`, client: 'web', status: 200 }])
  assert.ok(requests.some((request) => request.method === 'POST' && request.path === '/api/sign-in' && request.client === 'electron' && request.status === 200))

  assert.deepEqual(filesHolding(run.output, password), [], 'the password reached no file of the run')
  for (const { pid } of desktop) {
    assert.throws(() => process.kill(pid, 0), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ESRCH', 'the Electron app is gone')
  }
})

test('when the service never passes changes on to the web, the test fails at the web check, naming the task, and goes no further', { timeout: 180_000, skip: unverified }, async (t) => {
  binaryPresent()
  const service = await startService(t, ['--broken-sync=web'])
  const root = await writeProject(t, { 'retest.config.ts': configSource({ service: service.url, web: true, secretOrigins: false }), 'tests/flow.retest.ts': flow })
  const run = await runProject(t, root, { env: environment, timeouts })

  assert.equal(run.exit.code, 1, `${run.stdout}\n${run.stderr}`)
  const result = testNamed(run, flowName)
  // The web never gets a row for the task, so its check finds no element by that id.
  assert.deepEqual([result.status, result.failure?.class], ['failed', 'not_found'])
  const id = createdId(run)
  const failed = eventsOf(run.events, 'assertion.failed').filter((event) => event.testId === result.testId)
  assert.equal(failed.length, 1)
  const [check] = failed
  assert.deepEqual(check?.locator, { by: 'testId', value: `task-title-${id}` }, 'the failing check is the web reading the task by its id')
  assert.equal(check?.session, 'web')
  assert.match(result.failure?.message ?? '', new RegExp(id))

  // Nothing ran after the failed check: no action or check of the attempt follows it, and the web changed nothing.
  const later = run.events.filter(
    (event) => (event.type.startsWith('action.') || event.type.startsWith('assertion.')) && 'testId' in event && event.testId === result.testId && event.sequence > (check?.sequence ?? Infinity),
  )
  assert.deepEqual(later.map((event) => event.type), [])
  assert.deepEqual(service.requests().filter((request) => request.method === 'PATCH'), [])
  assert.deepEqual(filesHolding(run.output, password), [], 'the password reached no file of the run')
})

test('the password is typed into the Electron window only when secretOrigins names the service, and refused by name without it', { timeout: 180_000, skip: unverified }, async (t) => {
  binaryPresent()
  const service = await startService(t)
  const allowed = await writeProject(t, { 'retest.config.ts': configSource({ service: service.url, web: false, secretOrigins: true }), 'tests/sign-in.retest.ts': signIn })
  const accepted = await runProject(t, allowed, { env: environment, timeouts })
  assert.equal(accepted.exit.code, 0, `${accepted.stdout}\n${accepted.stderr}`)
  const signInsBefore = service.requests().filter((request) => request.path === '/api/sign-in' && request.client === 'electron')
  assert.deepEqual(signInsBefore.map(({ status }) => status), [200], 'the window signed in with the password it was given')

  const refusing = await writeProject(t, { 'retest.config.ts': configSource({ service: service.url, web: false, secretOrigins: false }), 'tests/sign-in.retest.ts': signIn })
  const refused = await runProject(t, refusing, { env: environment, timeouts })
  assert.equal(refused.exit.code, 1, `${refused.stdout}\n${refused.stderr}`)
  const result = testNamed(refused, 'signs in to the service in the Electron window')
  assert.deepEqual([result.status, result.failure?.class], ['failed', 'not_actionable'])
  assert.equal(
    result.failure?.message,
    `Retest did not type the secret "password": the page is on ${service.url}, and it may be typed only on no origin, since no app it uses has a base URL. Add the origin to secretOrigins if it belongs there.`,
  )
  const signInsAfter = service.requests().filter((request) => request.path === '/api/sign-in' && request.client === 'electron')
  assert.equal(signInsAfter.length, 1, 'the refused run sent no sign-in')
  for (const run of [accepted, refused]) assert.deepEqual(filesHolding(run.output, password), [], 'the password reached no file of either run')
})
