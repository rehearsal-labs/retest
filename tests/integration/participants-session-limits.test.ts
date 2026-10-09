import type { RetestEvent } from '../../src/protocol/events.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openApp } from './browser-harness.ts'
import { budgets, configSource, eventsOf, hostScript, runHost, runProject, writeProject } from './cli-harness.ts'
import { holders, runHostProgram } from './participants-harness.ts'

// Release 1, owner and host session limits, on real Chrome under workers. The task app's holders counter sees from
// the outside how many pages hold a named thing at once, so a run shows whether more sessions were active than the
// limits allow. A session is one browser context and its page.

const holdMs = 700

// A test file whose tests hold `name` at the task app for a while, one with one app and, when asked, one with two.
function holdingFile(letter: string, name: string, twoApps: boolean): string {
  const hold = `/holders/hold?name=${name}&ms=${holdMs}`
  const two = twoApps
    ? `

test('${letter} holds with two apps', { apps: ['web', 'admin'] }, async ({ web, admin }) => {
  await Promise.all([web.goto('${hold}'), admin.goto('${hold}')])
  await expect(web.getByTestId('held-name')).toHaveText('${name}')
  await expect(admin.getByTestId('held-name')).toHaveText('${name}')
})`
    : ''
  return `import { expect, test } from '@rehearsal-labs/retest'

test('${letter} holds with one app', async ({ page }) => {
  await page.goto('${hold}')
  await expect(page.getByTestId('held-name')).toHaveText('${name}')
})${two}
`
}

function holdingFiles(name: string): Record<string, string> {
  return Object.fromEntries(['a', 'b', 'c', 'd'].map((letter, index) => [`tests/${letter}.retest.ts`, holdingFile(letter, name, index < 2)]))
}

const appsConfig = (url: string): string => `{ apps: { web: chrome({ baseUrl: ${JSON.stringify(url)} }), admin: chrome({ baseUrl: ${JSON.stringify(url)} }) }, defaultApp: 'web' }`
const files = ['a', 'b', 'c', 'd'].map((letter) => `tests/${letter}.retest.ts`)

function reserved(events: readonly RetestEvent[]): Extract<RetestEvent, { type: 'session.reserved' }>[] {
  return eventsOf(events, 'session.reserved')
}

test('under workers, concurrent attempts never hold more sessions than the configured limits, and without limits they would', async (t) => {
  const app = await openApp(t)

  // The control: without limits, four workers hold the counter more than twice at once.
  const control = await writeProject(t, { 'retest.config.ts': configSource(appsConfig(app.url)), ...holdingFiles('unlimited') })
  const free = await runProject(t, control, { args: ['--workers', '4'], timeouts: budgets({ navigation: 10_000 }) })
  assert.equal(free.exit.code, 0, free.stderr)
  assert.ok((await holders(app.url, 'unlimited')).most >= 3, 'without limits, three or more pages held at once')

  const options = `workers: 4,
    sessions: { owner: 'agent-1', budget: new (await import('@rehearsal-labs/retest/runner')).SessionBudget({ perOwner: 2, host: 2 }), waitMs: 30000 },`
  const root = await writeProject(t, { 'package.json': '{ "type": "module" }\n', 'host.ts': hostScript({ config: appsConfig(app.url), files, options }), ...holdingFiles('limited') })
  const run = await runHost(t, { cwd: root, command: [process.execPath, '--conditions=retest-source', 'host.ts'] })
  assert.equal(run.exit.code, 0, run.stderr)
  assert.equal(run.returned.counts.passed, 6)
  const counted = await holders(app.url, 'limited')
  assert.deepEqual([counted.holds, counted.current], [8, 0], 'every page held once and let go')
  assert.ok(counted.most <= 2, `the app saw ${counted.most} pages hold at once, at most the 2 sessions allowed`)
  assert.equal(counted.most, 2, 'the two-app tests did hold two at once')
  const events = reserved(run.events)
  assert.equal(events.length, 6, 'every attempt reserved its sessions before it started')
  assert.ok(events.every((event) => event.active.host <= 2 && event.active.owner <= 2 && event.owner === 'agent-1'))
  assert.ok(events.some((event) => event.waitedMs > 0), 'some attempt waited for sessions')
  for (const event of events) {
    const started = run.events.find((each) => each.type === 'test.started' && each.attemptId === event.attemptId)
    assert.ok(started !== undefined && started.sequence > event.sequence, 'sessions are reserved before the attempt starts')
  }
})

// Two runs of one host process, for two owners, draw from one host budget at once.
function twoOwnersProgram(url: string): string {
  return `import { chrome, defineConfig } from '@rehearsal-labs/retest'
import { resolveSecrets, runFiles, SessionBudget, validateConfig } from '@rehearsal-labs/retest/runner'
import { join } from 'node:path'

const folder = process.argv.at(-1) ?? ''
const loaded = validateConfig(defineConfig({ apps: { web: chrome({ baseUrl: ${JSON.stringify(url)} }) } }), join(process.cwd(), 'host.config.ts'))
if (!loaded.ok) throw new Error(loaded.failure.message)
const secrets = resolveSecrets(loaded.config, {})
if (!secrets.ok) throw new Error(secrets.failure.message)
const budget = new SessionBudget({ perOwner: 2, host: 3 })
const timeouts = { collection: 5000, setup: 15000, action: 2000, navigation: 10000, assertion: 2000, test: 20000, cleanup: 5000 }
const run = (owner, files) => runFiles({
  files, rootDir: process.cwd(), apps: { kind: 'config', config: loaded.config, secrets: secrets.secrets }, timeouts,
  outputDir: join(folder, owner), headless: true, signal: new AbortController().signal, workers: 3, lastRunFile: false,
  sessions: { owner, budget, waitMs: 60000 },
}, [])
const results = await Promise.all([run('owner-a', ['tests/a1.retest.ts', 'tests/a2.retest.ts', 'tests/a3.retest.ts']), run('owner-b', ['tests/b1.retest.ts', 'tests/b2.retest.ts', 'tests/b3.retest.ts'])])
const peak = budget.peak()
const after = budget.snapshot()
process.stdout.write(JSON.stringify({ exitCodes: results.map((result) => result.exitCode), peak: { host: peak.host, owners: Object.fromEntries(peak.owners) }, after: { host: after.host, waiting: after.waiting } }) + '\\n')
`
}

// A test that holds the host-wide counter, then its owner's own, in one session.
function ownerFile(owner: string, index: number): string {
  return `import { expect, test } from '@rehearsal-labs/retest'

test('${owner} ${index} holds', async ({ page }) => {
  await page.goto('/holders/hold?name=host-wide&ms=${holdMs}')
  await expect(page.getByTestId('held-name')).toHaveText('host-wide')
  await page.goto('/holders/hold?name=${owner}&ms=${holdMs}')
  await expect(page.getByTestId('held-name')).toHaveText('${owner}')
})
`
}

test('two owners share one host budget without oversubscribing it, and both get through', async (t) => {
  const app = await openApp(t)
  const projectFiles: Record<string, string> = { 'package.json': '{ "type": "module" }\n', 'host.ts': twoOwnersProgram(app.url) }
  for (const index of [1, 2, 3]) {
    projectFiles[`tests/a${index}.retest.ts`] = ownerFile('owner-a', index)
    projectFiles[`tests/b${index}.retest.ts`] = ownerFile('owner-b', index)
  }
  const root = await writeProject(t, projectFiles)
  const hosted = await runHostProgram(t, root, 'host.ts', ['owner-a', 'owner-b'])
  assert.equal(hosted.code, 0, hosted.stderr)
  const printed: unknown = JSON.parse(hosted.stdout.trim().split('\n').at(-1) ?? '{}')
  assert.deepEqual(printed, { exitCodes: [0, 0], peak: { host: 3, owners: { 'owner-a': 2, 'owner-b': 2 } }, after: { host: 0, waiting: 0 } })

  const hostWide = await holders(app.url, 'host-wide')
  assert.deepEqual([hostWide.holds, hostWide.current], [6, 0])
  assert.ok(hostWide.most <= 3, `the host held ${hostWide.most} at once, at most 3`)
  for (const owner of ['owner-a', 'owner-b']) {
    const own = await holders(app.url, owner)
    assert.deepEqual([own.holds, own.current], [3, 0], `${owner} ran all its tests`)
    assert.ok(own.most <= 2, `${owner} held ${own.most} at once, at most 2`)
    const events = reserved(hosted.runs[owner]?.events ?? [])
    assert.equal(events.length, 3)
    assert.ok(events.every((event) => event.owner === owner && event.active.owner <= 2 && event.active.host <= 3))
    assert.equal(hosted.runs[owner]?.result?.exitCode, 0)
  }
  const waited = ['owner-a', 'owner-b'].flatMap((owner) => reserved(hosted.runs[owner]?.events ?? [])).filter((event) => event.waitedMs > 0)
  assert.ok(waited.length > 0, 'six attempts on three host sessions: some waited, and every one was served')
})

// A run stopped while attempts wait for and hold sessions gives every one of them back, and the next run on the same
// budget gets its sessions at once.
function cancelProgram(url: string): string {
  return `import { chrome, defineConfig } from '@rehearsal-labs/retest'
import { resolveSecrets, runFiles, SessionBudget, validateConfig } from '@rehearsal-labs/retest/runner'
import { join } from 'node:path'

const folder = process.argv.at(-1) ?? ''
const loaded = validateConfig(defineConfig({ apps: { web: chrome({ baseUrl: ${JSON.stringify(url)} }) } }), join(process.cwd(), 'host.config.ts'))
if (!loaded.ok) throw new Error(loaded.failure.message)
const secrets = resolveSecrets(loaded.config, {})
if (!secrets.ok) throw new Error(secrets.failure.message)
const budget = new SessionBudget({ perOwner: 1, host: 1 })
const timeouts = { collection: 5000, setup: 15000, action: 2000, navigation: 10000, assertion: 2000, test: 20000, cleanup: 5000 }
const stop = new AbortController()
let waitingWhenStopped = -1
let hostWhenStopped = -1
let watching = false
// The run is stopped once the attempt that holds the session is inside its hold at the app, so it is stopped in its body.
// A fixed time after the reservation is not that: under load its browser can still be launching then, and a test whose
// body never started is not run.
async function stopInsideTheHold() {
  const endsAt = performance.now() + 15000
  while (performance.now() < endsAt) {
    const response = await fetch(new URL('/holders?name=cancelled', ${JSON.stringify(url)}))
    const { current } = await response.json()
    if (current > 0) break
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  waitingWhenStopped = budget.snapshot().waiting
  hostWhenStopped = budget.snapshot().host
  stop.abort({ class: 'interrupted', message: 'The host stopped the run while sessions were held and asked for.' })
}
const reporter = {
  name: 'stopper',
  onEvent: (event) => {
    if (event.type !== 'session.reserved' || watching) return
    watching = true
    void stopInsideTheHold()
  },
  onRunEnd: () => undefined,
}
const options = (output, files, signal) => ({
  files, rootDir: process.cwd(), apps: { kind: 'config', config: loaded.config, secrets: secrets.secrets }, timeouts,
  outputDir: join(folder, output), headless: true, signal, workers: 3, lastRunFile: false, sessions: { owner: 'agent-1', budget, waitMs: 60000 },
})
const startedAt = performance.now()
const stopped = await runFiles(options('stopped', ['tests/a.retest.ts', 'tests/b.retest.ts', 'tests/c.retest.ts'], stop.signal), [reporter])
const stoppedMs = Math.round(performance.now() - startedAt)
const after = budget.snapshot()
const next = await runFiles(options('next', ['tests/quick.retest.ts'], new AbortController().signal), [])
process.stdout.write(JSON.stringify({ stopped: stopped.exitCode, stoppedMs, waitingWhenStopped, hostWhenStopped, after: { host: after.host, waiting: after.waiting }, next: next.exitCode }) + '\\n')
`
}

test('cancelling a run gives back the sessions it held and the ones it was waiting for, within a bounded time', async (t) => {
  const app = await openApp(t)
  const long = (letter: string): string => `import { expect, test } from '@rehearsal-labs/retest'

test('${letter} holds for long', async ({ page }) => {
  await page.goto('/holders/hold?name=cancelled&ms=8000')
  await expect(page.getByTestId('held-name')).toHaveText('cancelled')
})
`
  const root = await writeProject(t, {
    'package.json': '{ "type": "module" }\n',
    'host.ts': cancelProgram(app.url),
    'tests/a.retest.ts': long('a'),
    'tests/b.retest.ts': long('b'),
    'tests/c.retest.ts': long('c'),
    'tests/quick.retest.ts': `import { expect, test } from '@rehearsal-labs/retest'\n\ntest('runs at once', async ({ page }) => {\n  await page.goto('/holders/hold?name=next&ms=0')\n  await expect(page.getByTestId('held-name')).toHaveText('next')\n})\n`,
  })
  const hosted = await runHostProgram(t, root, 'host.ts', ['stopped', 'next'])
  assert.equal(hosted.code, 0, hosted.stderr)
  const printed: unknown = JSON.parse(hosted.stdout.trim().split('\n').at(-1) ?? '{}')
  assert.ok(typeof printed === 'object' && printed !== null)
  assert.deepEqual(
    Object.fromEntries(Object.entries(printed).filter(([key]) => key !== 'stoppedMs')),
    { stopped: 130, waitingWhenStopped: 2, hostWhenStopped: 1, after: { host: 0, waiting: 0 }, next: 0 },
    'one attempt held the only session and two waited when the run stopped; afterwards nothing is held or waiting, and the next run ran',
  )
  const stoppedMs = 'stoppedMs' in printed && typeof printed.stoppedMs === 'number' ? printed.stoppedMs : Infinity
  assert.ok(stoppedMs < 8000, `the stopped run ended in ${stoppedMs} ms, before the hold it was in could finish`)
  const stopped = hosted.runs['stopped']?.result
  assert.equal(stopped?.status, 'interrupted')
  const statuses = stopped?.files.flatMap((file) => file.tests.map((each) => each.status)).sort()
  assert.deepEqual(statuses, ['error', 'not_run', 'not_run'], 'the attempt that held the session was stopped and the two waiting never ran')
  const next = reserved(hosted.runs['next']?.events ?? [])
  assert.deepEqual(next.map((event) => event.waitedMs), [0], 'the next run got its session at once')
})

// One owner's run is stopped while it holds the host's only session and another owner's run waits for it. The waiting
// run must not get the session until the stopped run's context is closed: the app's counter would see two pages at once.
function abortedOwnerProgram(url: string): string {
  return `import { chrome, defineConfig } from '@rehearsal-labs/retest'
import { resolveSecrets, runFiles, SessionBudget, validateConfig } from '@rehearsal-labs/retest/runner'
import { join } from 'node:path'

const folder = process.argv.at(-1) ?? ''
const loaded = validateConfig(defineConfig({ apps: { web: chrome({ baseUrl: ${JSON.stringify(url)} }) } }), join(process.cwd(), 'host.config.ts'))
if (!loaded.ok) throw new Error(loaded.failure.message)
const secrets = resolveSecrets(loaded.config, {})
if (!secrets.ok) throw new Error(secrets.failure.message)
const budget = new SessionBudget({ perOwner: 1, host: 1 })
const timeouts = { collection: 5000, setup: 15000, action: 2000, navigation: 10000, assertion: 2000, test: 20000, cleanup: 5000 }
const stop = new AbortController()
const reservedA = Promise.withResolvers()
const times = {}
const reporter = (owner) => ({
  name: owner,
  onEvent: (event) => {
    if (event.type === 'session.reserved') {
      times[owner + ' reserved'] = performance.now()
      if (owner === 'owner-a') reservedA.resolve()
    }
    if (event.type === 'session.released') {
      times[owner + ' released'] = performance.now()
      times[owner + ' after'] = event.after
    }
  },
  onRunEnd: () => undefined,
})
const options = (owner, file, signal) => ({
  files: [file], rootDir: process.cwd(), apps: { kind: 'config', config: loaded.config, secrets: secrets.secrets }, timeouts,
  outputDir: join(folder, owner), headless: true, signal, workers: 1, lastRunFile: false, sessions: { owner, budget, waitMs: 60000 },
})
const first = runFiles(options('owner-a', 'tests/a.retest.ts', stop.signal), [reporter('owner-a')])
await reservedA.promise
const second = runFiles(options('owner-b', 'tests/b.retest.ts', new AbortController().signal), [reporter('owner-b')])
// Long enough for owner-a's page to hold the counter and owner-b to be waiting for the session.
await new Promise((resolve) => setTimeout(resolve, 1500))
const waiting = budget.snapshot().waiting
stop.abort({ class: 'interrupted', message: 'The host stopped the first owner while the second waited.' })
const [a, b] = await Promise.all([first, second])
process.stdout.write(JSON.stringify({ a: a.exitCode, b: b.exitCode, waiting, after: times['owner-a after'] }) + '\\n')
`
}

test('a stopped owner gives its session to the next only once its context is closed, so the app never sees both at once', async (t) => {
  const app = await openApp(t)
  const root = await writeProject(t, {
    'package.json': '{ "type": "module" }\n',
    'host.ts': abortedOwnerProgram(app.url),
    // The page's own script holds the counter, so the hold lasts until the context closes, not until a command stops.
    'tests/a.retest.ts': `import { expect, test } from '@rehearsal-labs/retest'\n\ntest('a holds the only session', async ({ page }) => {\n  await page.goto('/shared/holding?name=one-at-a-time&ms=9500')\n  await expect(page.getByTestId('holding')).toBeVisible()\n  await expect(page.getByTestId('never-shown')).toBeVisible({ timeout: 9000 })\n})\n`,
    'tests/b.retest.ts': `import { expect, test } from '@rehearsal-labs/retest'\n\ntest('b waits for it', async ({ page }) => {\n  await page.goto('/holders/hold?name=one-at-a-time&ms=500')\n  await expect(page.getByTestId('held-name')).toHaveText('one-at-a-time')\n})\n`,
  })
  const hosted = await runHostProgram(t, root, 'host.ts', ['owner-a', 'owner-b'])
  assert.equal(hosted.code, 0, hosted.stderr)
  const printed: unknown = JSON.parse(hosted.stdout.trim().split('\n').at(-1) ?? '{}')
  assert.deepEqual(printed, { a: 130, b: 0, waiting: 1, after: 'contexts_closed' }, 'owner-b waited, owner-a closed its context before giving the session back, and owner-b then ran')
  const counted = await holders(app.url, 'one-at-a-time')
  assert.deepEqual([counted.holds, counted.most, counted.current], [2, 1, 0], 'the app never saw both pages at once')
  const waited = reserved(hosted.runs['owner-b']?.events ?? [])
  assert.ok((waited[0]?.waitedMs ?? 0) > 200, `owner-b waited ${waited[0]?.waitedMs} ms for the session`)
  const released = eventsOf(hosted.runs['owner-a']?.events ?? [], 'session.released')
  assert.deepEqual(released.map((event) => event.after), ['contexts_closed'])
  const givenBack = Date.parse(released[0]?.time ?? '')
  const taken = Date.parse(waited[0]?.time ?? '')
  assert.ok(givenBack <= taken, `owner-a gave the session back at ${released[0]?.time}, before owner-b took it at ${waited[0]?.time}`)
})
