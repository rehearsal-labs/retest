import type { LoadedConfig } from '../../src/config/loaded.ts'
import type { RetestEvent } from '../../src/protocol/events.ts'
import type { RunResult, TestResult } from '../../src/protocol/result.ts'
import type { RunOptions } from '../../src/runner/contract.ts'
import type { FakeBrowser, FakeOptions } from '../support/fake-browser.ts'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { describe, test } from 'node:test'
import { BrowserError } from '../../src/browser/browser-error.ts'
import { configFileName, loadConfig } from '../../src/config/load.ts'
import { defaultEvaluationLimits } from '../../src/evaluation/budget.ts'
import { runFiles } from '../../src/runner/run.ts'
import { resolveSecrets } from '../../src/runner/secrets.ts'
import { SessionBudget } from '../../src/runner/sessions.ts'
import { rebuildResult } from '../../src/store/rebuild-result.ts'
import { fakeLauncher } from '../support/fake-browser.ts'
import createFakeEvaluator from '../support/fake-evaluator.ts'
import { fakeExecutable, tempProject } from '../support/project.ts'
import { newRunFolder, quickTimeouts, readEvents, readResult } from '../support/run-harness.ts'

// The replay lifecycle through a whole run, on the fake browser: the host's preparation and cleanup around each
// attempt, session reservations under workers, the execution record and the requirement. Real Chrome proves the same
// in tests/integration/participants-*.test.ts.

const config = `import { chromium, defineConfig } from '@rehearsal-labs/retest'
export default defineConfig({
  apps: { owner: chromium({ baseUrl: 'http://127.0.0.1:4173' }), member: chromium({ baseUrl: 'http://127.0.0.1:4173' }) },
  defaultApp: 'owner',
})
`

const twoApps = `import { expect, test } from '@rehearsal-labs/retest'
import { title } from './helpers/title.ts'

test('shows nothing saved to either account', { apps: ['owner', 'member'] }, async ({ owner, member }) => {
  await owner.goto('/')
  await member.goto('/')
  await expect(owner.getByTestId('saved-task')).toHaveText('')
  await expect(member.getByTestId('saved-task')).toHaveText(title.slice(0, 0))
})

test('fails its own check', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('saved-task')).toHaveText('Never saved')
})
`

const helper = `export const title = 'Quarterly report'\n`

type Recorded = { result: RunResult; events: RetestEvent[]; browsers: FakeBrowser[]; written: RunResult | undefined }

async function load(root: string): Promise<LoadedConfig> {
  const loaded = await loadConfig(join(root, configFileName))
  assert.ok(loaded.ok, loaded.ok ? '' : loaded.failure.message)
  return loaded.config
}

type Launcher = ReturnType<typeof fakeLauncher>

async function run(root: string, files: string[], options: Partial<RunOptions> & { launcher?: Launcher } = {}): Promise<Recorded> {
  const loaded = await load(root)
  const secrets = resolveSecrets(loaded, {})
  assert.ok(secrets.ok)
  const folder = newRunFolder()
  const { launcher, ...rest } = options
  const { launch, browsers } = launcher ?? fakeLauncher()
  const result = await runFiles(
    {
      files,
      rootDir: root,
      apps: { kind: 'config', config: loaded, secrets: secrets.secrets },
      timeouts: quickTimeouts,
      outputDir: folder,
      headless: true,
      workers: 1,
      signal: new AbortController().signal,
      lastRunFile: false,
      ...rest,
    },
    [],
    launch,
    fakeExecutable,
  )
  return { result, events: readEvents(folder).events, browsers, written: readResult(folder) }
}

function named(result: RunResult, name: string): TestResult {
  const found = result.files.flatMap((file) => file.tests).find((each) => each.name === name)
  assert.ok(found !== undefined, `a test named ${name}`)
  return found
}

function eventsFor<Type extends RetestEvent['type']>(events: readonly RetestEvent[], type: Type, attemptId?: string): Extract<RetestEvent, { type: Type }>[] {
  return events.filter((event): event is Extract<RetestEvent, { type: Type }> => event.type === type && (attemptId === undefined || ('attemptId' in event && event.attemptId === attemptId)))
}

describe('a host preparation in a run', () => {
  test('one that fails ends the attempt with a setup result before any app action, and its cleanup still runs', async () => {
    const root = tempProject({ [configFileName]: config, 'tests/shared.retest.ts': twoApps, 'tests/helpers/title.ts': helper })
    const told: string[] = []
    const recorded = await run(root, ['tests/shared.retest.ts'], {
      selection: { grep: 'shows nothing' },
      hostChecks: { 'tests/shared.retest.ts': [{ kind: 'text', id: 'save-shown', app: 'owner', text: 'Save' }] },
      requirement: { version: 'shared-v1' },
      prepare: {
        'tests/shared.retest.ts': {
          prepare: async () => ({ status: 'failed', reason: 'the fixture service is down' }),
          cleanup: async (context) => void told.push(`${context.preparation ?? 'none'} ${context.failed}`),
        },
      },
    })
    const result = named(recorded.result, 'shows nothing saved to either account')
    assert.equal(result.status, 'error')
    assert.equal(result.failure?.class, 'setup_failed')
    assert.match(result.failure?.message ?? '', /^The host's preparation for "tests\/shared\.retest\.ts" failed, so the test did not act on any app: it said: the fixture service is down\.$/)
    assert.deepEqual(result.ending, { kind: 'setup_failed', notRun: ['save-shown'] })
    assert.deepEqual(result.hostChecks?.map((check) => [check.check.id, check.status]), [['save-shown', 'not_run']])
    assert.deepEqual(result.preparations?.map((record) => record.outcome), ['failed'])
    assert.deepEqual(told, ['failed true'])
    const actions = recorded.events.filter((event) => (event.type.startsWith('action.') || event.type === 'navigation' || event.type === 'observation') && 'attemptId' in event && event.attemptId === result.attemptId)
    assert.deepEqual(actions, [], 'no action, look or navigation reached an app')
    assert.deepEqual(recorded.browsers.flatMap((browser) => browser.commands), [], 'no command reached a page')
    assert.deepEqual(recorded.browsers.flatMap((browser) => browser.pages), [], 'no page was even opened')
    assert.equal(recorded.result.exitCode, 2, 'a setup result is never a pass and never an application failure')
    const types = eventsFor(recorded.events, 'test.started').concat()
    assert.equal(types.length, 1)
    assert.deepEqual(rebuildResult(recorded.events).files[0]?.tests[0]?.preparations, result.preparations, 'the rebuilt result keeps the preparation')
  })

  test('one that does not answer in time is uncertain and stops the body the same way', async () => {
    const root = tempProject({ [configFileName]: config, 'tests/shared.retest.ts': twoApps, 'tests/helpers/title.ts': helper })
    const recorded = await run(root, ['tests/shared.retest.ts'], {
      selection: { grep: 'shows nothing' },
      prepare: { 'tests/shared.retest.ts > shows nothing saved to either account': { timeoutMs: 50, prepare: () => new Promise(() => undefined) } },
    })
    const result = named(recorded.result, 'shows nothing saved to either account')
    assert.equal(result.failure?.class, 'setup_failed')
    assert.equal(result.preparations?.[0]?.outcome, 'uncertain')
    assert.deepEqual(recorded.browsers.flatMap((browser) => browser.commands), [])
  })

  test('a cleanup that fails keeps the test’s own failure and is reported beside it', async () => {
    const root = tempProject({ [configFileName]: config, 'tests/shared.retest.ts': twoApps, 'tests/helpers/title.ts': helper })
    const recorded = await run(root, ['tests/shared.retest.ts'], {
      prepare: {
        'tests/shared.retest.ts': {
          prepare: async () => ({ status: 'prepared', recipe: 'shared-records@1', seed: 7, receipt: 'op-1' }),
          cleanup: () => Promise.reject(new Error('the fixture service did not answer')),
        },
      },
    })
    const failing = named(recorded.result, 'fails its own check')
    assert.equal(failing.status, 'failed')
    assert.equal(failing.failure?.class, 'check_failed', 'the application failure stays the failure')
    assert.deepEqual(failing.cleanupFailures?.map((each) => each.class), ['cleanup_failed'])
    assert.deepEqual(failing.ending, { kind: 'assertion_failed' })
    const passing = named(recorded.result, 'shows nothing saved to either account')
    assert.equal(passing.status, 'error', 'a cleanup failure alone makes a passing body an error')
    assert.equal(passing.failure, undefined)
    assert.deepEqual(passing.ending, { kind: 'cleanup_failed' })
    assert.deepEqual(passing.preparations?.map((record) => [record.outcome, record.recipe, record.seed, record.receipt]), [['prepared', 'shared-records@1', 7, 'op-1']])
    assert.deepEqual(passing.cleanups?.map((record) => record.outcome), ['failed'])
    assert.deepEqual(passing.execution?.startingState, [
      { app: 'owner', browserStorage: 'fresh', backendData: 'prepared' },
      { app: 'member', browserStorage: 'fresh', backendData: 'prepared' },
    ])
    assert.equal(recorded.result.exitCode, 1)
    const order = recorded.events.filter((event) => 'attemptId' in event && event.attemptId === passing.attemptId).map((event) => event.type)
    assert.deepEqual([order.indexOf('test.started') < order.indexOf('preparation.finished'), order.indexOf('preparation.finished') < order.indexOf('action.completed')], [true, true])
    assert.ok(order.indexOf('cleanup.finished') > order.lastIndexOf('action.completed') && order.indexOf('cleanup.finished') < order.indexOf('test.finished'))
  })
})

describe('the execution record in a run', () => {
  test('records the bundle the process loaded, its configuration, runtime, sessions and starting state, in test.started and the result', async () => {
    const root = tempProject({ [configFileName]: config, 'tests/shared.retest.ts': twoApps, 'tests/helpers/title.ts': helper, 'tests/unrelated.ts': 'export const other = 1\n' })
    const first = await run(root, ['tests/shared.retest.ts'], { appBuilds: { owner: 'build-41' } })
    const result = named(first.result, 'shows nothing saved to either account')
    const started = eventsFor(first.events, 'test.started', result.attemptId)[0]
    assert.ok(started?.execution !== undefined)
    assert.deepEqual(result.execution, started.execution, 'the result keeps what test.started recorded')
    const execution = started.execution
    assert.deepEqual(execution.bundle?.modules.map((module) => module.path), ['tests/helpers/title.ts', 'tests/shared.retest.ts'], 'the test file and its helper, and nothing from node_modules or Retest')
    assert.deepEqual(execution.sessions.map((session) => [session.app, session.sessionId, session.product]), [
      ['owner', `${result.attemptId}:owner`, 'FakeChromium'],
      ['member', `${result.attemptId}:member`, 'FakeChromium'],
    ])
    assert.deepEqual(execution.appBuilds, { owner: 'build-41' })
    assert.deepEqual(execution.unavailable, ['app-build:member'])
    assert.equal(execution.runtime.node, process.version)
    assert.deepEqual(execution.configuration.settings.timeouts, quickTimeouts)
    assert.deepEqual(execution.startingState, [
      { app: 'owner', browserStorage: 'fresh', backendData: 'unavailable' },
      { app: 'member', browserStorage: 'fresh', backendData: 'unavailable' },
    ])
    assert.deepEqual(rebuildResult(first.events).files[0]?.tests.find((each) => each.attemptId === result.attemptId)?.execution, result.execution)

    writeFileSync(join(root, 'tests/unrelated.ts'), 'export const other = 2\n')
    const unrelated = named((await run(root, ['tests/shared.retest.ts'], { appBuilds: { owner: 'build-41' } })).result, 'shows nothing saved to either account')
    assert.equal(unrelated.execution?.bundle?.sha256, execution.bundle?.sha256, 'a file the test never loaded changes nothing')
    assert.equal(unrelated.execution?.configuration.sha256, execution.configuration.sha256)

    writeFileSync(join(root, 'tests/helpers/title.ts'), `export const title = 'Quarterly reports'\n`)
    const changed = named((await run(root, ['tests/shared.retest.ts'], { appBuilds: { owner: 'build-41' } })).result, 'shows nothing saved to either account')
    assert.notEqual(changed.execution?.bundle?.sha256, execution.bundle?.sha256, 'a changed helper changes the bundle')
    assert.equal(changed.execution?.configuration.sha256, execution.configuration.sha256, 'and not the configuration')

    const slower = named((await run(root, ['tests/shared.retest.ts'], { timeouts: { ...quickTimeouts, assertion: 400 } })).result, 'shows nothing saved to either account')
    assert.notEqual(slower.execution?.configuration.sha256, execution.configuration.sha256, 'a changed budget changes the configuration')
  })

  test("a test's bundle is the same in a full run and a run of it alone: a module an earlier test imported is that test's", async () => {
    const two = `import { expect, test } from '@rehearsal-labs/retest'

test('imports a helper late', async ({ page }) => {
  const { title } = await import('./helpers/title.ts')
  await page.goto('/')
  await expect(page.getByTestId('saved-task')).toHaveText(title.slice(0, 0))
})

test('imports nothing more', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('saved-task')).toHaveText('')
})
`
    const root = tempProject({ [configFileName]: config, 'tests/two.retest.ts': two, 'tests/helpers/title.ts': helper })
    const full = await run(root, ['tests/two.retest.ts'])
    const alone = await run(root, ['tests/two.retest.ts'], { selection: { grep: 'imports nothing more' } })
    const later = named(full.result, 'imports nothing more')
    assert.deepEqual(later.execution?.bundle?.modules.map((module) => module.path), ['tests/two.retest.ts'])
    assert.equal(later.execution?.bundle?.sha256, named(alone.result, 'imports nothing more').execution?.bundle?.sha256)
    assert.deepEqual(named(full.result, 'imports a helper late').execution?.bundle?.modules.map((module) => module.path), ['tests/helpers/title.ts', 'tests/two.retest.ts'])
  })

  test('a module the body imports while it runs joins the bundle the result records', async () => {
    const lazy = `import { expect, test } from '@rehearsal-labs/retest'

test('reads a helper it imports late', async ({ page }) => {
  const { title } = await import('./helpers/title.ts')
  await page.goto('/')
  await expect(page.getByTestId('saved-task')).toHaveText(title.slice(0, 0))
})
`
    const root = tempProject({ [configFileName]: config, 'tests/lazy.retest.ts': lazy, 'tests/helpers/title.ts': helper })
    const recorded = await run(root, ['tests/lazy.retest.ts'])
    const result = named(recorded.result, 'reads a helper it imports late')
    assert.equal(result.status, 'passed')
    const started = eventsFor(recorded.events, 'test.started', result.attemptId)[0]
    const finished = eventsFor(recorded.events, 'test.finished', result.attemptId)[0]
    assert.deepEqual(started?.execution?.bundle?.modules.map((module) => module.path), ['tests/lazy.retest.ts'])
    assert.deepEqual(finished?.bundle?.modules.map((module) => module.path), ['tests/helpers/title.ts', 'tests/lazy.retest.ts'])
    assert.deepEqual(result.execution?.bundle, finished?.bundle)
    assert.deepEqual(rebuildResult(recorded.events).files[0]?.tests[0]?.execution?.bundle, finished?.bundle)
  })
})

describe('the execution record and credentials', () => {
  // A host's run whose config, built without validation, puts a secret's value into a proxy address, a base URL, a
  // judge's options, a lock's name, the requirement version, the app build, the session owner and the test's
  // environment, with the secret's value given here.
  async function credentialRun(secret: string): Promise<{ result: RunResult; folder: string }> {
    const folder = newRunFolder()
    const { launch } = fakeLauncher()
    const proxy = { server: 'http://ada:hunter2-7391@127.0.0.1:8080', bypass: [] }
    const target = { name: 'chromium', browser: 'chromium', executablePath: '/fake/chromium', headless: true, proxy } as const
    const lock = `lock${secret}`
    const loaded: LoadedConfig = {
      file: '/work/retest.config.ts',
      apps: new Map([['web', { name: 'web', baseUrl: 'http://ada:base-pass-5521@127.0.0.1:4173', targets: new Map([['chromium', target]]) }]]),
      defaultApp: 'web',
      runs: [],
      secrets: new Map([['password', { source: { env: 'RETEST_UNIT_PASSWORD' }, origins: [] }]]),
      locks: [lock],
      timeouts: {},
      evaluation: {
        judges: new Map([['fake', { name: 'fake', adapter: { kind: 'factory', factory: createFakeEvaluator }, credentials: new Map(), options: { default: 'pass', gateway: `https://gateway.example/${secret}` }, accepts: ['text'] }]]),
        defaultJudge: 'fake',
        timeoutMs: 5000,
        limits: defaultEvaluationLimits,
      },
    }
    const tests = `import { expect, test } from '@rehearsal-labs/retest'\ntest('runs', { locks: [${JSON.stringify(lock)}] }, () => expect(1).toBe(1))\n`
    const root = tempProject({ 'tests/a.retest.ts': tests })
    const result = await runFiles(
      {
        files: ['tests/a.retest.ts'],
        rootDir: root,
        apps: { kind: 'config', config: loaded, secrets: new Map([['password', { value: secret }]]) },
        timeouts: quickTimeouts,
        outputDir: folder,
        headless: true,
        signal: new AbortController().signal,
        lastRunFile: false,
        appBuilds: { web: `build ${secret}` },
        sessions: { owner: `owner ${secret}`, budget: new SessionBudget({ perOwner: 1, host: 1 }) },
        requirement: { version: `release ${secret}` },
        hostEvaluations: { 'tests/a.retest.ts': [{ id: 'reads-well', criteria: { pass: 'The text reads well.' }, evidence: { text: 'Thank you.' } }] },
        testEnvironment: { TOKEN: secret },
      },
      [],
      launch,
      fakeExecutable,
    )
    return { result, folder }
  }

  test('a credential in an address, and a secret value anywhere the host writes, never reach the record, a fingerprint or any file of the run', async () => {
    const { result, folder } = await credentialRun('value-of-the-secret-9917')
    assert.equal(result.exitCode, 0, JSON.stringify(result.files[0]?.tests[0]?.failure))
    const execution = result.files[0]?.tests[0]?.execution
    assert.equal(execution?.configuration.settings.apps['web']?.proxy?.server, 'http://127.0.0.1:8080/')
    assert.deepEqual(execution?.secretReferences, [{ name: 'password', source: 'env', variable: 'RETEST_UNIT_PASSWORD', origins: [] }])
    assert.equal(execution?.appBuilds?.['web'], 'build {{password}}')
    assert.equal(execution?.owner, 'owner {{password}}')
    assert.equal(execution?.requirement?.version, 'release {{password}}')
    assert.deepEqual(execution?.configuration.settings.locks, ['lock{{password}}'])
    assert.deepEqual(execution?.configuration.settings.environment, ['TOKEN'], 'the environment by name alone')
    assert.deepEqual(execution?.configuration.settings.evaluation?.judges.map((judge) => [judge.name, judge.codeUnavailable]), [['fake', true]])
    for (const path of readdirSync(folder, { recursive: true, encoding: 'utf8' })) {
      const file = join(folder, path)
      if (!statSync(file).isFile()) continue
      const text = readFileSync(file, 'utf8')
      for (const held of ['hunter2-7391', 'ada:', 'base-pass-5521', 'value-of-the-secret-9917']) assert.equal(text.includes(held), false, `${path} holds ${held}`)
    }
  })

  test('a rotated secret leaves every fingerprint as it was', async () => {
    const first = (await credentialRun('value-of-the-secret-9917')).result.files[0]?.tests[0]?.execution
    const second = (await credentialRun('rotated-secret-value-4402')).result.files[0]?.tests[0]?.execution
    assert.ok(first !== undefined && second !== undefined)
    assert.equal(second.configuration.sha256, first.configuration.sha256)
    assert.equal(second.requirement?.sha256, first.requirement?.sha256)
    assert.deepEqual(second.requirement?.checks, first.requirement?.checks)
  })
})

describe('sessions and the contexts that hold them', () => {
  test('contexts that could not be closed keep their sessions until their browser closes, and the event says so', async () => {
    const holding = (letter: string): string => `import { expect, test } from '@rehearsal-labs/retest'\n\ntest('${letter} holds the only session', async ({ page }) => {\n  await page.goto('/')\n  await expect(page.getByTestId('saved-task')).toHaveText('')\n})\n`
    const root = tempProject({ [configFileName]: config, 'tests/a.retest.ts': holding('a'), 'tests/b.retest.ts': holding('b') })
    const budget = new SessionBudget({ perOwner: 1, host: 1 })
    const recorded = await run(root, ['tests/a.retest.ts', 'tests/b.retest.ts'], {
      workers: 2,
      sessions: { owner: 'agent-1', budget, waitMs: 800 },
      timeouts: { ...quickTimeouts, cleanup: 150 },
      launcher: fakeLauncher({ disposeDelayMs: 1200 }),
    })
    const results = recorded.result.files.flatMap((file) => file.tests)
    const first = results.find((each) => each.status === 'error')
    const second = results.find((each) => each.status === 'not_run')
    assert.ok(first !== undefined && second !== undefined, JSON.stringify(results.map((each) => [each.name, each.status, each.failure?.message])))
    assert.deepEqual(first.cleanupFailures?.map((each) => each.message), ["Closing the test's browser context took longer than 150 ms."])
    assert.match(second.failure?.message ?? '', /^Not run: 1 session for "agent-1" did not come free within 800 ms\. When it gave up, "agent-1" held 1 of 1 and the host 1 of 1\.$/, 'the context that would not close still held the only session')
    const released = eventsFor(recorded.events, 'session.released', first.attemptId)[0]
    assert.equal(released?.after, 'browser_closed')
    const secondFinished = eventsFor(recorded.events, 'test.finished', second.attemptId)[0]
    assert.ok(released !== undefined && secondFinished !== undefined && released.sequence > secondFinished.sequence, 'given back only once the browser closed, at the end of the run')
    assert.deepEqual(budget.snapshot(), { host: 0, owners: new Map(), waiting: 0 })
  })

  test("a stopped run closes its contexts before another owner gets their sessions", async () => {
    const holding = (letter: string): string => `import { expect, test } from '@rehearsal-labs/retest'\n\ntest('${letter} holds the only session', async ({ page }) => {\n  await page.goto('/')\n  await expect(page.getByTestId('saved-task')).toHaveText('')\n})\n`
    const root = tempProject({ [configFileName]: config, 'tests/a.retest.ts': holding('a'), 'tests/b.retest.ts': holding('b') })
    const budget = new SessionBudget({ perOwner: 1, host: 1 })
    const launchers: ReturnType<typeof fakeLauncher>[] = []
    let most = 0
    const count = async (): Promise<void> => {
      const open = launchers.flatMap((launcher) => launcher.browsers).filter((browser) => browser.connected).flatMap((browser) => browser.pages).filter((page) => !page.disposed)
      most = Math.max(most, open.length + 1)
    }
    const first = fakeLauncher({ hang: 'goto', holdOpening: count, holdClosing: () => sleep(200) })
    const second = fakeLauncher({ holdOpening: count })
    launchers.push(first, second)
    const stop = new AbortController()
    const reserved = Promise.withResolvers<void>()
    const watcher = {
      name: 'stopper',
      onEvent: (event: RetestEvent) => {
        if (event.type === 'session.reserved') reserved.resolve()
      },
      onRunEnd: () => undefined,
    }
    const sessions = (owner: string) => ({ owner, budget, waitMs: 10_000 })
    const loaded = await load(root)
    const secrets = resolveSecrets(loaded, {})
    assert.ok(secrets.ok)
    const options = (file: string, owner: string, signal: AbortSignal): RunOptions => ({
      files: [file],
      rootDir: root,
      apps: { kind: 'config', config: loaded, secrets: secrets.secrets },
      timeouts: { ...quickTimeouts, test: 20_000, navigation: 20_000 },
      outputDir: newRunFolder(),
      headless: true,
      workers: 1,
      signal,
      lastRunFile: false,
      sessions: sessions(owner),
    })
    const stopped = runFiles(options('tests/a.retest.ts', 'owner-a', stop.signal), [watcher], first.launch, fakeExecutable)
    await reserved.promise
    const next = runFiles(options('tests/b.retest.ts', 'owner-b', new AbortController().signal), [], second.launch, fakeExecutable)
    await sleep(300)
    stop.abort('SIGINT')
    const [a, b] = await Promise.all([stopped, next])
    assert.deepEqual([a.exitCode, b.exitCode], [130, 0])
    assert.equal(most, 1, `${most} contexts were open at once on a host budget of 1`)
    assert.equal(first.browsers[0]?.pages[0]?.disposed, true, 'the stopped run closed its context itself')
  })

  test('closed contexts give their sessions back at once', async () => {
    const root = tempProject({ [configFileName]: config, 'tests/shared.retest.ts': twoApps, 'tests/helpers/title.ts': helper })
    const recorded = await run(root, ['tests/shared.retest.ts'], { sessions: { owner: 'agent-1', budget: new SessionBudget({ perOwner: 2, host: 2 }) } })
    const released = eventsFor(recorded.events, 'session.released')
    assert.deepEqual(released.map((event) => [event.sessions, event.after]), [
      [2, 'contexts_closed'],
      [1, 'contexts_closed'],
    ])
    for (const event of released) {
      const finished = eventsFor(recorded.events, 'test.finished', event.attemptId)[0]
      assert.ok(finished !== undefined && event.sequence > finished.sequence)
    }
  })
})

describe('endings in a run rest on the parent’s records', () => {
  const forged = `import { test } from '@rehearsal-labs/retest'

let scope = { testId: '', attemptId: '' }
process.on('message', (message) => {
  if (typeof message === 'object' && message !== null && message.type === 'run') scope = { testId: message.testId, attemptId: message.attemptId }
})

test('claims what the parent never saw', async () => {
  process.send?.({ type: 'test-finished', ...scope, status: 'failed', failure: { class: process.env.FORGED_CLASS, message: 'Forged by the test process.' }, assertionCount: 0, durationMs: 0 })
  await new Promise(() => undefined)
})
`

  test('a failure class the test process forges names no check, crash or unknown outcome', async () => {
    const root = tempProject({ [configFileName]: config, 'tests/forged.retest.ts': forged })
    for (const forgedClass of ['host_check_failed', 'session_lost', 'outcome_unknown']) {
      const recorded = await run(root, ['tests/forged.retest.ts'], {
        testEnvironment: { FORGED_CLASS: forgedClass },
        hostChecks: { 'tests/forged.retest.ts': [{ kind: 'text', id: 'save-shown', text: 'Save' }] },
      })
      const result = named(recorded.result, 'claims what the parent never saw')
      assert.equal(result.failure?.class, forgedClass, 'the test keeps the failure it reported')
      assert.deepEqual(result.ending, { kind: 'test_error', notRun: ['save-shown'] }, forgedClass)
    }
  })

  test('a host check that could not read a slow page is a check error, not a crash', async () => {
    const root = tempProject({ [configFileName]: config, 'tests/shared.retest.ts': twoApps, 'tests/helpers/title.ts': helper })
    const recorded = await run(root, ['tests/shared.retest.ts'], {
      selection: { grep: 'shows nothing' },
      hostChecks: { 'tests/shared.retest.ts': [{ kind: 'text', id: 'save-shown', app: 'owner', text: 'Save', timeoutMs: 150 }] },
      launcher: fakeLauncher({
        onRead: () => {
          throw new BrowserError({ class: 'timeout', message: 'The page did not answer in time.' })
        },
      }),
    })
    const result = named(recorded.result, 'shows nothing saved to either account')
    assert.equal(result.failure?.class, 'session_lost')
    assert.match(result.failure?.message ?? '', /did not answer a host check within 150 ms/)
    assert.deepEqual(result.ending, { kind: 'check_error', checkId: 'save-shown' })
  })
})

describe('session limits in a run', () => {
  test('under workers, concurrent attempts never hold more sessions than the owner and host limits allow', async () => {
    const files: Record<string, string> = { [configFileName]: config, 'tests/helpers/title.ts': helper }
    for (const letter of ['a', 'b', 'c', 'd', 'e']) {
      files[`tests/${letter}.retest.ts`] = `import { expect, test } from '@rehearsal-labs/retest'

test('${letter} one app', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('saved-task')).toHaveText('')
})

test('${letter} two apps', { apps: ['owner', 'member'] }, async ({ owner, member }) => {
  await owner.goto('/')
  await member.goto('/')
  await expect(member.getByTestId('saved-task')).toHaveText('')
})
`
    }
    const root = tempProject(files)
    const budget = new SessionBudget({ perOwner: 3, host: 3 })
    let most = 0
    // Counted as each context opens, across every browser of the run: the contexts open now, this one included.
    const fake: FakeOptions = {
      holdOpening: async () => {
        most = Math.max(most, launcher.browsers.flatMap((browser) => browser.pages).filter((page) => !page.disposed).length + 1)
      },
      holdAnswer: async (command) => {
        if (command.kind === 'goto') await sleep(60)
      },
    }
    const launcher = fakeLauncher(fake)
    const recorded = await run(root, ['a', 'b', 'c', 'd', 'e'].map((letter) => `tests/${letter}.retest.ts`), {
      workers: 5,
      sessions: { owner: 'agent-1', budget, waitMs: 20_000 },
      timeouts: { ...quickTimeouts, test: 20_000 },
      launcher,
    })
    assert.equal(recorded.result.exitCode, 0, JSON.stringify(recorded.result.failure))
    assert.equal(recorded.result.counts.passed, 10)
    assert.ok(budget.peak().host <= 3, `the budget held ${budget.peak().host} sessions at once`)
    assert.ok(most <= 3 && most >= 2, `${most} browser contexts were open at once, at most 3`)
    const reserved = eventsFor(recorded.events, 'session.reserved')
    assert.equal(reserved.length, 10, 'every attempt reserved its sessions')
    assert.ok(reserved.every((event) => event.owner === 'agent-1' && event.active.host <= 3 && event.active.owner <= 3))
    assert.deepEqual([...new Set(reserved.map((event) => event.sessions))].sort(), [1, 2])
    assert.ok(reserved.some((event) => event.waitedMs > 0), 'some attempt waited for sessions')
    assert.deepEqual(budget.snapshot(), { host: 0, owners: new Map(), waiting: 0 }, 'every session came back when the run ended')
    const started = eventsFor(recorded.events, 'run.started')[0]
    assert.deepEqual(started?.options.sessions, { owner: 'agent-1', perOwner: 3, host: 3, waitMs: 20_000 })

    // The control: the same run without limits opens more contexts at once, so the limit above did the work.
    let unlimited = 0
    const free = fakeLauncher({
      holdOpening: async () => {
        unlimited = Math.max(unlimited, free.browsers.flatMap((browser) => browser.pages).filter((page) => !page.disposed).length + 1)
      },
      holdAnswer: async (command) => {
        if (command.kind === 'goto') await sleep(60)
      },
    })
    const control = await run(root, ['a', 'b', 'c', 'd', 'e'].map((letter) => `tests/${letter}.retest.ts`), { workers: 5, timeouts: { ...quickTimeouts, test: 20_000 }, launcher: free })
    assert.equal(control.result.exitCode, 0)
    assert.ok(unlimited > 3, `without limits ${unlimited} contexts were open at once`)
    assert.deepEqual(eventsFor(control.events, 'session.reserved'), [], 'and no session is reserved')
  })

  test('the wait for sessions counts against no budget of the test', async () => {
    const holding = (letter: string): string => `import { expect, test } from '@rehearsal-labs/retest'\n\ntest('${letter} holds the only session', async ({ page }) => {\n  await page.goto('/')\n  await expect(page.getByTestId('saved-task')).toHaveText('')\n})\n`
    const root = tempProject({ [configFileName]: config, 'tests/a.retest.ts': holding('a'), 'tests/b.retest.ts': holding('b') })
    const launcher = fakeLauncher({
      holdAnswer: async (command) => {
        if (command.kind === 'goto') await sleep(500)
      },
    })
    const recorded = await run(root, ['tests/a.retest.ts', 'tests/b.retest.ts'], {
      workers: 2,
      sessions: { owner: 'agent-1', budget: new SessionBudget({ perOwner: 1, host: 1 }) },
      timeouts: { ...quickTimeouts, test: 800 },
      launcher,
    })
    assert.equal(recorded.result.exitCode, 0, JSON.stringify(recorded.result.files.flatMap((file) => file.tests.map((each) => each.failure?.message))))
    const waited = eventsFor(recorded.events, 'session.reserved').map((event) => event.waitedMs).sort((first, second) => first - second)
    assert.equal(waited[0], 0)
    const longest = waited[1] ?? 0
    assert.ok(longest > 400, `one attempt waited ${longest} ms for the only session`)
    const second = recorded.result.files.flatMap((file) => file.tests).find((each) => each.attemptId === eventsFor(recorded.events, 'session.reserved').find((event) => event.waitedMs === longest)?.attemptId)
    assert.equal(second?.status, 'passed', 'it passed, though its wait and its run together took longer than its 800 ms budget')
    assert.ok((second?.durationMs ?? 0) + longest > 800)
  })

  test('an attempt that needs more sessions than any limit allows does not run, and the rest do', async () => {
    const root = tempProject({ [configFileName]: config, 'tests/shared.retest.ts': twoApps, 'tests/helpers/title.ts': helper })
    const recorded = await run(root, ['tests/shared.retest.ts'], { sessions: { owner: 'agent-1', budget: new SessionBudget({ perOwner: 1, host: 4 }) } })
    const two = named(recorded.result, 'shows nothing saved to either account')
    assert.equal(two.status, 'not_run')
    assert.match(two.failure?.message ?? '', /^Not run: the test needs 2 sessions at once, more than the limit of 1 for each owner, so it could never start\.$/)
    assert.equal(named(recorded.result, 'fails its own check').status, 'failed', 'the one-app test still ran')
  })
})

describe('the requirement in a run', () => {
  test('a frozen check that changed is refused by name before any test runs, and the same check passes under its id', async () => {
    const root = tempProject({ [configFileName]: config, 'tests/shared.retest.ts': twoApps, 'tests/helpers/title.ts': helper })
    const check = { kind: 'text' as const, id: 'save-shown', app: 'owner', text: 'Save' }
    const selection = { grep: 'shows nothing' }
    const first = await run(root, ['tests/shared.retest.ts'], { selection, hostChecks: { 'tests/shared.retest.ts': [check] }, requirement: { version: 'shared-v1' } })
    assert.equal(first.result.exitCode, 0)
    const frozen = eventsFor(first.events, 'run.started')[0]?.options.requirement
    assert.deepEqual(frozen?.checks.map((each) => each.id), ['save-shown'])
    const result = named(first.result, 'shows nothing saved to either account')
    assert.deepEqual(result.execution?.requirement?.checks, frozen?.checks)
    assert.deepEqual(result.hostChecks?.[0]?.check.id, 'save-shown')
    const checks = Object.fromEntries((frozen?.checks ?? []).map((each) => [each.id, each.sha256]))

    const again = await run(root, ['tests/shared.retest.ts'], { selection, hostChecks: { 'tests/shared.retest.ts': [check] }, requirement: { version: 'shared-v1', checks } })
    assert.equal(again.result.exitCode, 0)
    assert.equal(named(again.result, 'shows nothing saved to either account').execution?.requirement?.sha256, result.execution?.requirement?.sha256)

    const weakened = await run(root, ['tests/shared.retest.ts'], { selection, hostChecks: { 'tests/shared.retest.ts': [{ ...check, absent: true }] }, requirement: { version: 'shared-v1', checks } })
    assert.equal(weakened.result.exitCode, 2)
    assert.equal(weakened.result.failure?.class, 'usage')
    assert.match(weakened.result.failure?.message ?? '', /"save-shown" changed since the requirement "shared-v1" froze it/)
    assert.deepEqual(weakened.browsers, [], 'no browser started')
  })

  test('a failed host check names its id in its failure and in the ending', async () => {
    const root = tempProject({ [configFileName]: config, 'tests/shared.retest.ts': twoApps, 'tests/helpers/title.ts': helper })
    const recorded = await run(root, ['tests/shared.retest.ts'], {
      selection: { grep: 'shows nothing' },
      hostChecks: { 'tests/shared.retest.ts': [{ kind: 'text', id: 'record-shown', app: 'member', text: 'Quarterly report', timeoutMs: 100 }] },
    })
    const result = named(recorded.result, 'shows nothing saved to either account')
    assert.equal(result.failure?.class, 'host_check_failed')
    assert.equal(result.failure?.details?.['checkId'], 'record-shown')
    assert.match(result.failure?.message ?? '', /^The host check "record-shown" on member failed/)
    assert.deepEqual(result.ending, { kind: 'required_check_failed', checkId: 'record-shown' })
    const failed = eventsFor(recorded.events, 'host_check.failed', result.attemptId)[0]
    assert.equal(failed?.check.id, 'record-shown')
  })
})
