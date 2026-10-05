import type { TestContext } from 'node:test'
import type { AgentSession } from '../../src/agent/session.ts'
import type { RetestEvent } from '../../src/protocol/events.ts'
import type { RunResult } from '../../src/protocol/result.ts'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { lostBrowserGraceMs } from '../../src/agent/host.ts'
import { signalGroup } from '../../src/browser/chromium-process.ts'
import { eventsFile, resultFile, testId } from '../../src/protocol/run-folder.ts'
import { SessionBudget } from '../../src/runner/sessions.ts'
import { openApp } from './browser-harness.ts'
import { assertJudged, assertReleased, readEvents, readResult, RetestProcess, retestEntriesIn, scratchFolder, writeProject } from './cli-harness.ts'
import { engineUnderTest } from './engines.ts'
import { holders, resultNamed } from './participants-harness.ts'
import { agentHost, agentTarget, assertActed, engineName, openOn } from './agent-harness.ts'

// Owner and host capacity, and giving everything back, on a real browser: the task app's holders counter sees from the
// outside how many contexts hold a page open, so a session that ended under a hold that ran out, a caller gone silent, a
// stop or a lost browser can be seen to have let go, and the budget it drew on can be read. A refusal names only the
// asking owner's own sessions. The last case runs agent sessions and a test run against one budget in one host program,
// as Rehearsal's runner would.

// Opens the page that holds `name` at the task app for as long as the session's context lives.
async function hold(session: AgentSession, name: string): Promise<void> {
  assertActed(await session.act({ kind: 'goto', url: `/shared/holding?name=${name}&ms=20000` }), `${session.app} opened the holding page`)
}

async function holdersReach(url: string, name: string, current: number, timeoutMs = 10_000): Promise<void> {
  const deadline = performance.now() + timeoutMs
  for (;;) {
    const seen = await holders(url, name)
    if (seen.current === current) return
    if (performance.now() > deadline) assert.fail(`the app saw ${seen.current} holders of ${name}, expected ${current}`)
    await sleep(50)
  }
}

test('owner and host limits hold across sessions on a real browser, and an ended session lets the next one in', async (t) => {
  const app = await openApp(t)
  const budget = new SessionBudget({ perOwner: 2, host: 3 })
  const { host } = await agentHost(t, { budget })
  const first = await openOn(host, { app: 'one', purpose: 'discovery', baseUrl: app.url })
  const second = await openOn(host, { app: 'two', purpose: 'discovery', baseUrl: app.url })
  await Promise.all([hold(first, 'limits'), hold(second, 'limits')])
  await holdersReach(app.url, 'limits', 2)

  const third = await host.open({ owner: 'agent-1', app: 'three', purpose: 'discovery', target: 'browser', engine: engineName(), baseUrl: app.url, waitMs: 300 })
  assert.ok(!third.ok)
  assert.match(third.failure.message, /^Not run: 1 session for "agent-1" did not come free within 300 ms\. When it gave up, "agent-1" held 2 of 2 and the host 2 of 3\.$/)

  const other = await openOn(host, { owner: 'agent-2', app: 'one', purpose: 'discovery', baseUrl: app.url })
  await hold(other, 'limits')
  await holdersReach(app.url, 'limits', 3)
  const full = await host.open({ owner: 'agent-2', app: 'two', purpose: 'discovery', target: 'browser', engine: engineName(), baseUrl: app.url, waitMs: 300 })
  assert.ok(!full.ok)
  assert.match(full.failure.message, /"agent-2" held 1 of 2 and the host 3 of 3\.$/)
  // The refusal names agent-2's own session and only counts agent-1's two.
  assert.equal(full.failure.details?.['heldBy'], other.sessionId)
  assert.equal(full.failure.details?.['heldByOthers'], 2)
  assert.doesNotMatch(JSON.stringify(full.failure), new RegExp(`${first.sessionId}|${second.sessionId}`))

  const waiting = host.open({ owner: 'agent-2', app: 'two', purpose: 'discovery', target: 'browser', engine: engineName(), baseUrl: app.url, waitMs: 30_000 })
  assert.ok((await first.end()).ok)
  await holdersReach(app.url, 'limits', 2)
  const next = await waiting
  assert.ok(next.ok, next.ok ? '' : next.failure.message)
  await hold(next.session, 'limits')
  await holdersReach(app.url, 'limits', 3)
  const counted = await holders(app.url, 'limits')
  assert.ok(counted.most <= 3, `the app saw ${counted.most} contexts hold at once, at most the host's 3`)
  assert.ok(budget.peak().host <= 3 && (budget.peak().owners.get('agent-1') ?? 0) <= 2)
})

test('a session that held its browser for its whole hold is ended: its context closes and its session comes back', async (t) => {
  const app = await openApp(t)
  const budget = new SessionBudget({ perOwner: 1, host: 1 })
  const { host } = await agentHost(t, { budget })
  const session = await openOn(host, { app: 'one', purpose: 'discovery', baseUrl: app.url, holdMs: 3000 })
  await hold(session, 'hold-ran-out')
  await holdersReach(app.url, 'hold-ran-out', 1)
  const ended = await session.ended
  assert.equal(ended.ok, true)
  assert.equal(ended.ending.kind, 'held_too_long')
  assert.equal(ended.ending.sessions, 'returned')
  await holdersReach(app.url, 'hold-ran-out', 0)
  assert.equal(budget.snapshot().host, 0)
  const after = await session.act({ kind: 'goto', url: '/account' })
  assert.ok(!after.result.ok)
  assert.equal(after.result.failure.class, 'timeout')
  assert.equal(after.input, 'not_sent')
  const next = await host.open({ owner: 'agent-1', app: 'two', purpose: 'discovery', target: 'browser', engine: engineName(), baseUrl: app.url, waitMs: 1000 })
  assert.ok(next.ok, 'the session came back to the budget')
})

test('a session whose caller goes silent for its whole lease is ended: its context closes and its session comes back', async (t) => {
  const app = await openApp(t)
  const budget = new SessionBudget({ perOwner: 1, host: 1 })
  const { host } = await agentHost(t, { budget, timeouts: { setup: 45_000, action: 5000, navigation: 10_000, assertion: 5000, cleanup: 5000, lease: 2000 } })
  const session = await openOn(host, { app: 'one', purpose: 'discovery', baseUrl: app.url })
  await hold(session, 'caller-silent')
  await holdersReach(app.url, 'caller-silent', 1)
  const ended = await session.ended
  assert.equal(ended.ok, true)
  assert.equal(ended.ending.kind, 'caller_silent')
  assert.equal(ended.ending.reason?.class, 'timeout')
  assert.deepEqual(ended.ending.reason?.details, { leaseMs: 2000 })
  assert.equal(ended.ending.sessions, 'returned')
  await holdersReach(app.url, 'caller-silent', 0)
  assert.equal(budget.snapshot().host, 0)
  const next = await host.open({ owner: 'agent-1', app: 'two', purpose: 'discovery', target: 'browser', engine: engineName(), baseUrl: app.url, waitMs: 1000 })
  assert.ok(next.ok, 'the session came back to the budget')
})

test('stopping the host stops an action waiting on the page, ends its session and gives everything back', async (t) => {
  const app = await openApp(t)
  const budget = new SessionBudget({ perOwner: 2, host: 2 })
  const { host } = await agentHost(t, { budget })
  const session = await openOn(host, { app: 'one', purpose: 'discovery', baseUrl: app.url })
  await hold(session, 'stopped')
  await holdersReach(app.url, 'stopped', 1)
  const startedAt = performance.now()
  const waiting = session.act({ kind: 'click', locator: { by: 'testId', value: 'never-there' } }, { timeoutMs: 20_000 })
  await sleep(300)
  host.stop({ class: 'interrupted', message: 'The worker stopped.' })
  const action = await waiting
  assert.ok(performance.now() - startedAt < 5000, 'the stop ended the wait')
  assert.ok(!action.result.ok)
  assert.equal(action.result.failure.class, 'interrupted')
  assert.equal(action.input, 'not_sent')
  const ended = await session.ended
  assert.equal(ended.ending.kind, 'stopped')
  await holdersReach(app.url, 'stopped', 0)
  assert.equal(budget.snapshot().host, 0)
})

test('a lost browser ends its sessions as lost and gives their sessions back; the next session gets a new browser', async (t) => {
  const app = await openApp(t)
  // The browsers of this case keep their profiles in a folder of its own, so what a lost browser left can be looked for.
  const tmp = await scratchFolder(t, 'retest-agent-lost-')
  const before = process.env['TMPDIR']
  process.env['TMPDIR'] = tmp
  t.after(() => {
    if (before === undefined) delete process.env['TMPDIR']
    else process.env['TMPDIR'] = before
  })
  const budget = new SessionBudget({ perOwner: 2, host: 2 })
  const { host } = await agentHost(t, { budget })
  const session = await openOn(host, { app: 'one', purpose: 'discovery', baseUrl: app.url })
  await hold(session, 'lost')
  await holdersReach(app.url, 'lost', 1)
  const [pid] = session.runtime.processIds
  assert.ok(pid !== undefined)
  const command = execFileSync('ps', ['-p', String(pid), '-o', 'args='], { encoding: 'utf8' })
  assert.ok(command.includes(session.runtime.executablePath), `pid ${pid} runs ${session.runtime.executablePath}, the browser this host started: ${command}`)
  // The browser is lost as its own driver's tests lose it: Chromium's whole group through the launch record this
  // process keeps, which the driver needs before it signals anything; Firefox's and WebKit's main process. A Chromium
  // whose main process alone is killed from outside leaves its driver unable to verify the group at close, though
  // nothing of it is left, and that close reports a cleanup failure; that belongs to the driver and is recorded for it.
  if (session.engine === 'chromium') signalGroup(pid, 'SIGKILL')
  else process.kill(pid, 'SIGKILL')
  const ended = await session.ended
  assert.equal(ended.ending.kind, 'lost')
  assert.equal(ended.ending.reason?.class, 'session_lost')
  assert.equal(budget.snapshot().host, 0)
  await holdersReach(app.url, 'lost', 0)
  // The host closes the lost browser a moment after its loss, through its driver's close, which removes its profile,
  // while the host itself stays open.
  await profilesGone(tmp, lostBrowserGraceMs + 10_000)
  const next = await openOn(host, { app: 'two', purpose: 'reproduction', baseUrl: app.url })
  assert.notDeepEqual(next.runtime.processIds, session.runtime.processIds)
  assertActed(await next.act({ kind: 'goto', url: '/account' }), 'the new browser opened a page')
  assert.deepEqual(await host.close(), { ok: true })
  const left = retestEntriesIn(tmp).filter((name) => !name.startsWith('retest-agent-test-'))
  assert.deepEqual(left, [], 'neither the lost browser nor the new one left a profile behind')
})

// Waits until no browser profile is left in `folder` but the host's own log folder.
async function profilesGone(folder: string, timeoutMs: number): Promise<void> {
  const deadline = performance.now() + timeoutMs
  for (;;) {
    const left = retestEntriesIn(folder).filter((name) => !name.startsWith('retest-agent-test-'))
    if (left.length === 0) return
    if (performance.now() > deadline) assert.fail(`the lost browser's profile was still there after ${timeoutMs} ms: ${left.join(', ')}`)
    await sleep(100)
  }
}

type HostedRun = { events: RetestEvent[]; result: RunResult | undefined }

// Runs a host program of the test's own, in its own process group and temporary folder, and reads each run it wrote.
// Every browser and test process it started must be gone once it ends, its agent host's browsers among them, and
// nothing of Retest's may be left in its temporary folder.
async function runProgram(t: TestContext, root: string, runs: readonly string[], env: Readonly<Record<string, string>>): Promise<{ code: number | null; stdout: string; stderr: string; runs: Record<string, HostedRun> }> {
  const folder = await scratchFolder(t, 'retest-agent-hosted-')
  const retest = await RetestProcess.start(t, { cwd: root, command: [process.execPath, '--conditions=retest-source', 'host.ts'], args: [folder], env })
  const exit = await retest.exited
  const written: Record<string, HostedRun> = {}
  for (const name of runs) {
    const output = join(folder, name)
    const events = existsSync(join(output, eventsFile)) ? readEvents(readFileSync(join(output, eventsFile), 'utf8')) : []
    assertJudged(events)
    written[name] = { events, result: existsSync(join(output, resultFile)) ? readResult(readFileSync(join(output, resultFile), 'utf8')) : undefined }
  }
  await assertReleased(retest, Object.values(written).flatMap((run) => run.events))
  return { code: exit.code, stdout: retest.stdout, stderr: retest.stderr, runs: written }
}

// A host program: one budget with room for one session, an agent host and a test run that both draw on it.
// It imports the agent API by the package's own `./agent` subpath, as a program that depends on Retest does.
function sharedBudgetProgram(input: { appUrl: string; config: string; file: string; target: string; engine: string }): string {
  return `import { chrome, chromium, defineConfig } from '@rehearsal-labs/retest'
import { AgentHost } from '@rehearsal-labs/retest/agent'
import { resolveSecrets, runFiles, SessionBudget, validateConfig } from '@rehearsal-labs/retest/runner'
import { join } from 'node:path'

const folder = process.argv.at(-1) ?? ''
const loaded = validateConfig(defineConfig(${input.config}), join(process.cwd(), 'host.config.ts'))
if (!loaded.ok) throw new Error(loaded.failure.message)
const secrets = resolveSecrets(loaded.config, {})
if (!secrets.ok) throw new Error(secrets.failure.message)
const budget = new SessionBudget({ perOwner: 1, host: 1 })
const check = { kind: 'text', id: 'sign-in-shown', text: 'User name' }
const timeouts = { collection: 10000, setup: 45000, action: 5000, navigation: 10000, assertion: 5000, test: 30000, cleanup: 5000 }
const run = (output, waitMs) => runFiles({
  files: [${JSON.stringify(input.file)}], rootDir: process.cwd(), apps: { kind: 'config', config: loaded.config, secrets: secrets.secrets }, timeouts,
  outputDir: join(folder, output), headless: true, signal: new AbortController().signal, lastRunFile: false,
  sessions: { owner: 'worker-1', budget, waitMs }, hostChecks: { ${JSON.stringify(input.file)}: [check] }, requirement: { version: 'shared-v1' },
}, [])
const host = new AgentHost({ targets: { browser: ${input.target} }, budget, logFolder: folder })
const agent = await host.open({ owner: 'agent-1', app: 'web', purpose: 'discovery', target: 'browser', engine: ${JSON.stringify(input.engine)}, baseUrl: ${JSON.stringify(input.appUrl)} })
if (!agent.ok) throw new Error(agent.failure.message)
const blocked = await run('blocked', 1500)
await agent.session.end()
// While the test run holds the host's one session, an agent session waits for it and does not open.
let settled = false
const testing = run('ran', 30000).finally(() => { settled = true })
while (!settled && budget.snapshot().host === 0) await new Promise((resolve) => setTimeout(resolve, 10))
const during = settled ? 'the run ended before its session was seen' : await host.open({ owner: 'agent-1', app: 'web', purpose: 'reproduction', target: 'browser', engine: ${JSON.stringify(input.engine)}, baseUrl: ${JSON.stringify(input.appUrl)}, waitMs: 300 })
const ran = await testing
const again = await host.open({ owner: 'agent-1', app: 'web', purpose: 'reproduction', target: 'browser', engine: ${JSON.stringify(input.engine)}, baseUrl: ${JSON.stringify(input.appUrl)}, waitMs: 30000 })
if (!again.ok) throw new Error(again.failure.message)
const opened = await again.session.act({ kind: 'goto', url: '/login' })
const checked = await again.session.check(check, { version: 'shared-v1' })
const pids = again.session.runtime.processIds
await again.session.end()
const closed = await host.close()
console.log(JSON.stringify({ blocked: blocked.exitCode, ran: ran.exitCode, opened: opened.result.ok, check: checked.ok ? { status: checked.check.status, identity: checked.check.identity } : checked.failure.message, peak: budget.peak().host, after: budget.snapshot().host, closed: closed.ok, pids, during: typeof during === 'string' ? during : during.ok ? 'opened' : { message: during.failure.message, heldByOthers: during.failure.details?.heldByOthers } }))
`
}

test('agent sessions and a test run draw on one budget, and a required check has one identity in both', async (t) => {
  const app = await openApp(t)
  const engine = engineUnderTest()
  const file = 'tests/sign-in.retest.ts'
  const config = `{ apps: { web: ${engine.target(`baseUrl: ${JSON.stringify(app.url)}`)} } }`
  const tests = `import { expect, test } from '@rehearsal-labs/retest'

test('the sign-in page asks for a user name', async ({ page }) => {
  await page.goto('/login')
  await expect(page.getByTestId('user')).toBeVisible()
  // Holds the host's one session well past the agent's 300 ms wait, so that open is refused for want of it and can
  // never be granted as this test ends.
  await new Promise((resolve) => setTimeout(resolve, 1500))
})
`
  const target = JSON.stringify(agentTarget())
  const root = await writeProject(t, { 'package.json': '{ "type": "module" }\n', 'host.ts': sharedBudgetProgram({ appUrl: app.url, config, file, target, engine: engine.name }), [file]: tests })
  const hosted = await runProgram(t, root, ['blocked', 'ran'], engine.environment)
  assert.equal(hosted.code, 0, hosted.stderr)
  const printed: unknown = JSON.parse(hosted.stdout.trim().split('\n').at(-1) ?? '{}')
  assert.ok(typeof printed === 'object' && printed !== null)
  const { blocked, ran, opened, check, peak, after, closed, pids, during } = Object.fromEntries(Object.entries(printed))
  assert.deepEqual({ blocked, ran, opened, peak, after, closed }, { blocked: 2, ran: 0, opened: true, peak: 1, after: 0, closed: true })
  assert.deepEqual(during, { message: 'Not run: 1 session for "agent-1" did not come free within 300 ms. When it gave up, "agent-1" held 0 of 1 and the host 1 of 1.', heldByOthers: 1 }, 'while the test held the one session, the agent waited and did not open')

  // While the agent held the host's one session, the test waited for it and did not run.
  const name = 'the sign-in page asks for a user name'
  const refused = resultNamed(hosted.runs['blocked']?.result, name)
  assert.equal(refused.status, 'not_run')
  assert.match(refused.failure?.message ?? '', /^Not run: 1 session for "worker-1" did not come free within 1500 ms\. When it gave up, "worker-1" held 0 of 1 and the host 1 of 1\.$/)

  // Once the agent let go, the test ran, and its recorded check has the identity the agent's session gave the same check.
  const passed = resultNamed(hosted.runs['ran']?.result, name)
  assert.equal(passed.status, 'passed', passed.failure?.message)
  assert.equal(passed.testId, testId(file, name))
  const recorded = passed.execution?.requirement
  assert.ok(recorded !== undefined)
  assert.ok(typeof check === 'object' && check !== null && 'identity' in check && 'status' in check, JSON.stringify(check))
  assert.equal(check.status, 'passed')
  assert.deepEqual(check.identity, { version: recorded.version, ...recorded.checks[0] })
  assert.ok(Array.isArray(pids))
  for (const pid of pids) {
    assert.ok(typeof pid === 'number')
    assert.throws(() => process.kill(pid, 0), 'the agent host closed its browser')
  }
})
