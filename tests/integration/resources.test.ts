import type { TestContext } from 'node:test'
import type { RetestEvent } from '../../src/protocol/events.ts'
import type { TestResult } from '../../src/protocol/result.ts'
import type { HostedRun } from './participants-harness.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { defaultTimeouts } from '../../src/protocol/timeouts.ts'
import { openApp } from './browser-harness.ts'
import { eventsOf, runCli, showEndingAfterFinishing, writeProject } from './cli-harness.ts'
import { holders, resultNamed, runHostProgram } from './participants-harness.ts'

// Resources and leases on real Chrome, through a host program that calls runFiles with session limits, as Rehearsal's
// runner does. The task app's holders counter sees from outside whether two holders of the inbox ever overlapped.

type Printed = Record<string, unknown>

// A host program: a config of two Chrome apps on the task app and the lock `inbox`, then `body`, which runs and prints
// one JSON line. `run(output, files, extra)` runs files on two workers into a folder of its own.
function hostProgram(url: string, body: string): string {
  return `import { chrome, defineConfig } from 'retest'
import { resolveSecrets, runFiles, SessionBudget, validateConfig } from 'retest/runner'
import { join } from 'node:path'

const folder = process.argv.at(-1) ?? ''
const loaded = validateConfig(defineConfig({ apps: { web: chrome({ baseUrl: ${JSON.stringify(url)} }), admin: chrome({ baseUrl: ${JSON.stringify(url)} }) }, defaultApp: 'web', locks: ['inbox'] }), join(process.cwd(), 'host.config.ts'))
if (!loaded.ok) throw new Error(loaded.failure.message)
const secrets = resolveSecrets(loaded.config, {})
if (!secrets.ok) throw new Error(secrets.failure.message)
const timeouts = ${JSON.stringify(defaultTimeouts)}
const run = (output, files, extra) => runFiles({
  files, rootDir: process.cwd(), apps: { kind: 'config', config: loaded.config, secrets: secrets.secrets }, timeouts,
  outputDir: join(folder, output), headless: true, signal: new AbortController().signal, workers: 2, lastRunFile: false, ...extra,
}, extra.reporters ?? [])
${body}
`
}

function printedOf(stdout: string): Printed {
  const parsed: unknown = JSON.parse(stdout.trim().split('\n').at(-1) ?? '{}')
  assert.ok(typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed))
  return Object.fromEntries(Object.entries(parsed))
}

function testsOf(run: HostedRun | undefined): TestResult[] {
  return run?.result?.files.flatMap((file) => file.tests) ?? []
}

// Each event of a run at its moment on the run's clock, with the test it is about, so a run that took too long says
// where its time went.
function timelineOf(run: HostedRun | undefined): string {
  const named = (event: RetestEvent): string => ('testId' in event && typeof event.testId === 'string' ? ` (${event.testId.split(' > ').at(-1) ?? ''})` : '')
  return (run?.events ?? []).map((event) => `${Math.round(event.elapsedMs)} ${event.type}${named(event)}`).join(', ')
}

function ofAttempt<Type extends RetestEvent['type']>(events: readonly RetestEvent[], type: Type, attemptId: string): Extract<RetestEvent, { type: Type }>[] {
  return eventsOf(events, type).filter((event) => 'attemptId' in event && event.attemptId === attemptId)
}

// A test that holds `name` at the task app for `ms`, then checks nobody held it beside it.
function holdingTest(title: string, options: string, name: string, ms: number): string {
  return `test('${title}', ${options}, async ({ page }) => {
  await page.goto('/holders/hold?name=${name}&ms=${ms}')
  await expect(page.getByTestId('overlap')).toHaveText('1')
})`
}

function file(...tests: string[]): string {
  return `import { expect, test } from 'retest'\n\n${tests.join('\n\n')}\n`
}

async function inspect(t: TestContext, root: string, run: HostedRun, testId?: string): Promise<string> {
  const shown = await runCli(t, ['inspect', run.output, ...(testId === undefined ? [] : ['--test', testId])], { cwd: root })
  assert.equal(shown.exit.code, 0, shown.stderr)
  return shown.stdout
}

test('two workers, a shared lock and session limits: holders never overlap, and a wait is recorded and left out of the duration', async (t) => {
  const app = await openApp(t)
  // The short test waits for the inbox longer than its whole budget and still passes. Its body asks the app one
  // question, so its budget bounds nothing but the wait.
  const budgetMs = 1500
  const held = `const held = async () => ((await (await fetch(new URL('/holders?name=inbox', ${JSON.stringify(app.url)}))).json()) as { current: number }).current`
  const waitsUntilHeld = `test('b waits until the inbox is held', async () => {
  await expect.poll(held, { timeout: 25000 }).toBe(1)
})`
  const shortBudget = `test('b has a short budget', { locks: ['inbox'], timeout: ${budgetMs} }, async () => {
  expect(await held()).toBe(0)
})`
  // Right after b's first test has seen the holder hold the inbox, b asks for it, and the holder lets go twice b's
  // budget after that test has finished.
  const body = `const letGo = async () => {
  await new Promise((resolve) => setTimeout(resolve, ${budgetMs * 2})) // a wait longer than a budget takes real time
  await fetch(new URL('/holders/release?name=inbox', ${JSON.stringify(app.url)}))
}
const releaser = { name: 'releaser', onEvent: (event) => { if (event.type === 'test.finished' && event.testId.endsWith(' > b waits until the inbox is held')) void letGo() }, onRunEnd: () => undefined }
const budget = new SessionBudget({ perOwner: 2, host: 2 })
const result = await run('shared', ['tests/a.retest.ts', 'tests/b.retest.ts'], { sessions: { owner: 'agent-1', budget, waitMs: 30000 }, reporters: [releaser] })
const peak = budget.peak()
const after = budget.snapshot()
process.stdout.write(JSON.stringify({ exitCode: result.exitCode, peak: peak.host, after: { host: after.host, waiting: after.waiting } }) + '\\n')`
  const root = await writeProject(t, {
    'package.json': '{ "type": "module" }\n',
    'host.ts': hostProgram(app.url, body),
    'tests/a.retest.ts': file(
      `test('a holds the inbox', { locks: ['inbox'] }, async ({ page }) => {
  await page.goto('/holders/hold?name=inbox&release=1')
  await expect(page.getByTestId('overlap')).toHaveText('1')
})`,
      `test('a uses both apps', { apps: ['web', 'admin'] }, async ({ web, admin }) => {
  await Promise.all([web.goto('/holders/hold?name=pair&ms=300'), admin.goto('/holders/hold?name=pair&ms=300')])
  await expect(web.getByTestId('held-name')).toHaveText('pair')
})`,
    ),
    'tests/b.retest.ts': file(held, waitsUntilHeld, shortBudget),
  })
  const hosted = await runHostProgram(t, root, 'host.ts', ['shared'])
  assert.equal(hosted.code, 0, hosted.stderr)
  const run = hosted.runs['shared']
  assert.ok(run?.result !== undefined)
  // A run can end in an error with every test passed, so the message names the run's and each file's own failure too.
  const why = { printed: printedOf(hosted.stdout), run: run.result.failure?.message, files: run.result.files.map((each) => [each.file, each.failure?.message]), tests: run.result.files.flatMap((each) => each.tests).map((each) => [each.name, each.status, each.failure?.message]) }
  assert.deepEqual(printedOf(hosted.stdout), { exitCode: 0, peak: 2, after: { host: 0, waiting: 0 } }, JSON.stringify(why))
  showEndingAfterFinishing(t, run, 'tests/b.retest.ts')
  assert.equal(run.result.counts.passed, 4)
  const inbox = await holders(app.url, 'inbox')
  assert.deepEqual([inbox.most, inbox.current, inbox.holds], [1, 0, 1], 'the holder held the inbox once, and let go')

  const holder = resultNamed(run.result, 'a holds the inbox')
  const short = resultNamed(run.result, 'b has a short budget')
  const acquired = ofAttempt(run.events, 'lock.acquired', short.attemptId)[0]
  assert.ok(acquired !== undefined)
  assert.ok(acquired.waitedMs > budgetMs, `it waited ${acquired.waitedMs} ms for the inbox, longer than its ${budgetMs} ms budget`)
  // Its time counts from once it held the lock: its recorded duration fits between the lock's grant and its end, both
  // whole milliseconds of the run's clock, so the span may read a millisecond short.
  const ended = ofAttempt(run.events, 'test.finished', short.attemptId)[0]
  assert.ok(ended !== undefined && short.durationMs <= ended.elapsedMs - acquired.elapsedMs + 1, `and passed, its ${short.durationMs} ms counted from the lock's grant, not from the ${acquired.waitedMs} ms wait`)
  assert.deepEqual(acquired.heldBy, [holder.testId])
  const reserved = ofAttempt(run.events, 'session.reserved', short.attemptId)[0]
  const taken = ofAttempt(run.events, 'lease.taken', short.attemptId)[0]
  assert.ok(reserved !== undefined && taken !== undefined && acquired.sequence < reserved.sequence && reserved.sequence < taken.sequence, 'the lock when granted, then the sessions, then the whole lease')
  assert.deepEqual(taken.lease.covers.map((part) => part.kind), ['lock', 'sessions'])
  for (const event of eventsOf(run.events, 'session.reserved')) assert.ok(event.active.host <= 2)
  for (const each of testsOf(run)) assert.deepEqual(each.execution?.sessions.map((session) => session.resource).filter((resource) => resource !== 'browser-context'), [], 'every Chrome session is a browser context')

  const report = await inspect(t, root, run)
  assert.match(report, /b has a short budget {2}(\d+ ms|[\d.]+s)\n {6}holds lock inbox, after waiting [\d.]+s\n {6}held by tests\/a\.retest\.ts > a holds the inbox\n/)
})

test('a test whose reservation runs out of time ends setup_failed, naming what it waited for and who held it', async (t) => {
  const app = await openApp(t)
  const body = `const budget = new SessionBudget({ perOwner: 1, host: 1 })
const result = await run('limited', ['tests/a.retest.ts', 'tests/b.retest.ts'], { sessions: { owner: 'agent-1', budget, waitMs: 800 } })
const after = budget.snapshot()
process.stdout.write(JSON.stringify({ exitCode: result.exitCode, after: { host: after.host, waiting: after.waiting } }) + '\\n')`
  const root = await writeProject(t, {
    'package.json': '{ "type": "module" }\n',
    'host.ts': hostProgram(app.url, body),
    'tests/a.retest.ts': file(holdingTest('a holds the only session', '{}', 'only', 3000)),
    'tests/b.retest.ts': file(holdingTest('b holds the only session', '{}', 'only', 3000)),
  })
  const hosted = await runHostProgram(t, root, 'host.ts', ['limited'])
  assert.equal(hosted.code, 0, hosted.stderr)
  assert.deepEqual(printedOf(hosted.stdout), { exitCode: 2, after: { host: 0, waiting: 0 } })
  const run = hosted.runs['limited']
  const ran = testsOf(run).find((each) => each.status === 'passed')
  const refused = testsOf(run).find((each) => each.status === 'not_run')
  assert.ok(run !== undefined && ran !== undefined && refused !== undefined, JSON.stringify(testsOf(run).map((each) => [each.name, each.status])))
  assert.equal(refused.failure?.class, 'setup_failed')
  assert.match(refused.failure?.message ?? '', /^Not run: 1 session for "agent-1" did not come free within 800 ms\. When it gave up, "agent-1" held 1 of 1 and the host 1 of 1\.$/)
  assert.equal(refused.failure?.details?.['waitedFor'], '1 session of agent-1')
  assert.equal(refused.failure?.details?.['heldBy'], ran.testId)
  assert.ok(Number(refused.failure?.details?.['waitedMs']) >= 800)
  assert.equal(refused.durationMs, 0, 'a test that never got what it needed took no time of its own')
  assert.deepEqual(ofAttempt(run.events, 'session.reserved', refused.attemptId), [], 'it reserved nothing')
  assert.equal((await holders(app.url, 'only')).most, 1)

  const card = await inspect(t, root, run, refused.testId)
  assert.match(card, /\n {4}Waited for {7}"1 session of agent-1"\n/)
  assert.match(card, new RegExp(`\\n {4}Held by {10}"${ran.testId.replaceAll('.', '\\.')}"\\n`))
})

// The stopped run is timed from the moment the stop was sent. Timed from the run's start, it also counted the machine's
// start-up: collecting the files, starting their processes, waiting for the inbox and launching the browser, which took
// it past the hold on a macOS machine with every CPU busy while nothing waited for the hold (17 November 2026). The hold
// begins only after the inbox is granted, so a run that ends sooner after the stop than the hold had left when the stop
// was sent ended before the hold could finish.
const holdMs = 8000

test('a run stopped while tests wait for the inbox withdraws them, and leaves nothing held or waiting', async (t) => {
  const app = await openApp(t)
  const body = `const budget = new SessionBudget({ perOwner: 3, host: 3 })
const stop = new AbortController()
let waitingWhenStopped = -1
let grantedAt = -1
let stoppedAt = -1
const stopper = {
  name: 'stopper',
  onEvent: (event) => {
    if (event.type !== 'lock.acquired' || stop.signal.aborted) return
    grantedAt = performance.now()
    setTimeout(() => {
      waitingWhenStopped = budget.snapshot().waiting
      stoppedAt = performance.now()
      stop.abort({ class: 'interrupted', message: 'The host stopped the run while tests waited for the inbox.' })
    }, 400)
  },
  onRunEnd: () => undefined,
}
const startedAt = performance.now()
const stopped = await run('stopped', ['tests/a.retest.ts', 'tests/b.retest.ts', 'tests/c.retest.ts'], { workers: 3, signal: stop.signal, reporters: [stopper], sessions: { owner: 'agent-1', budget, waitMs: 60000 } })
const endedAt = performance.now()
const timing = { runMs: Math.round(endedAt - startedAt), grantToStopMs: Math.round(stoppedAt - grantedAt), sinceStopMs: Math.round(endedAt - stoppedAt) }
const after = budget.snapshot()
const next = await run('next', ['tests/next.retest.ts'], { sessions: { owner: 'agent-1', budget, waitMs: 60000 } })
process.stdout.write(JSON.stringify({ stopped: stopped.exitCode, timing, waitingWhenStopped, after: { host: after.host, waiting: after.waiting }, next: next.exitCode }) + '\\n')`
  const files: Record<string, string> = { 'package.json': '{ "type": "module" }\n', 'host.ts': hostProgram(app.url, body) }
  for (const letter of ['a', 'b', 'c']) files[`tests/${letter}.retest.ts`] = file(holdingTest(`${letter} holds the inbox`, "{ locks: ['inbox'] }", 'stopped', holdMs))
  files['tests/next.retest.ts'] = file(holdingTest('takes a session at once', '{}', 'next', 0))
  const root = await writeProject(t, files)
  const hosted = await runHostProgram(t, root, 'host.ts', ['stopped', 'next'])
  assert.equal(hosted.code, 0, hosted.stderr)
  const printed = printedOf(hosted.stdout)
  const stopped = hosted.runs['stopped']
  const timing = printed['timing']
  assert.ok(typeof timing === 'object' && timing !== null && 'runMs' in timing && 'grantToStopMs' in timing && 'sinceStopMs' in timing, JSON.stringify(printed))
  const { runMs, grantToStopMs, sinceStopMs } = timing
  assert.ok(typeof runMs === 'number' && typeof grantToStopMs === 'number' && typeof sinceStopMs === 'number' && grantToStopMs >= 0, JSON.stringify(timing))
  t.diagnostic(`The stopped run took ${runMs} ms, ${sinceStopMs} ms of them after the stop, sent ${grantToStopMs} ms after the inbox was granted: ${timelineOf(stopped)}`)
  assert.ok(sinceStopMs < holdMs - grantToStopMs, `the stopped run ended ${sinceStopMs} ms after the stop, sent ${grantToStopMs} ms after the inbox was granted, so before the hold could finish: ${timelineOf(stopped)}`)
  assert.deepEqual({ ...printed, timing: 0 }, { stopped: 130, timing: 0, waitingWhenStopped: 0, after: { host: 0, waiting: 0 }, next: 0 }, 'the waiters waited for the inbox, not for sessions; afterwards nothing is held or waiting')

  assert.ok(stopped?.result !== undefined)
  assert.equal(stopped.result.status, 'interrupted')
  const acquired = eventsOf(stopped.events, 'lock.acquired')
  assert.equal(acquired.length, 1, 'one test held the inbox')
  const [held] = acquired
  assert.ok(held !== undefined)
  const waiters = testsOf(stopped).filter((each) => each.attemptId !== held.attemptId)
  assert.deepEqual(
    waiters.map((each) => [each.status, each.ending?.kind]),
    [
      ['not_run', 'cancelled'],
      ['not_run', 'cancelled'],
    ],
  )
  for (const waiter of waiters) assert.deepEqual([...ofAttempt(stopped.events, 'lock.acquired', waiter.attemptId), ...ofAttempt(stopped.events, 'session.reserved', waiter.attemptId)], [], 'a withdrawn waiter held nothing')
  for (const reserved of eventsOf(stopped.events, 'session.reserved')) assert.equal(ofAttempt(stopped.events, 'session.released', reserved.attemptId).length, 1, 'every session reserved was given back')
  assert.equal((await holders(app.url, 'stopped')).current, 0)

  const report = await inspect(t, root, stopped)
  assert.match(report, /Not run\n/)
  for (const waiter of waiters) {
    const shown = await inspect(t, root, stopped, waiter.testId)
    assert.doesNotMatch(shown, /holds lock|holds \d+ session/, `${waiter.name} shows nothing held`)
  }
  const next = hosted.runs['next']
  assert.ok(next?.result !== undefined)
  // Each run has a lock table of its own, so the next run says nothing about the stopped run's locks; the session budget
  // is the one they share.
  const quick = resultNamed(next.result, 'takes a session at once')
  // It took its session at once, and nothing else was active when it did. A free session is granted inside the
  // request, so waitedMs measures only that bookkeeping on the real clock, which a stalled macOS runner stretched to
  // 2 ms; runner-sessions.test.ts holds it to exactly 0 on a clock of its own. A request that had to wait here would
  // wait for a session nothing in this host gives back, for its whole 60 s, so a second tells a wait from a stall.
  const reserved = ofAttempt(next.events, 'session.reserved', quick.attemptId)
  assert.deepEqual(reserved.map((event) => [event.active.owner, event.active.host]), [[1, 1]], 'the next run on the same budget found every session free')
  assert.ok(reserved.every((event) => event.waitedMs < 1000), `the next run on the same budget took a session at once, not after ${JSON.stringify(reserved.map((event) => event.waitedMs))} ms`)
})
