import type { TestContext } from 'node:test'
import type { AgentHostOptions, AgentOpenRequest } from '../../src/agent/host.ts'
import type { AgentLauncher } from '../../src/agent/targets.ts'
import type { AgentFakeOptions } from './agent-fakes.ts'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { describe, test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { AgentHost, AgentHostError, lostBrowserGraceMs } from '../../src/agent/host.ts'
import { SessionBudget } from '../../src/runner/sessions.ts'
import { agentFakeLauncher, settle } from './agent-fakes.ts'

// The agent host's lifecycle rules with a fake browser: open on a named target and engine and never another, hold a
// lease through the resources table and the session budget a test run draws on, end, and give everything back on an
// end, a hold that runs out, a stop and a lost browser; a context that would not close keeps its session until its
// browser closes. Opening never throws, whatever a launcher does, and closing waits for a browser still starting.

type Made = { host: AgentHost; browsers: ReturnType<typeof agentFakeLauncher>['browsers']; budget: SessionBudget }

function makeHost(t: TestContext, options: { fake?: AgentFakeOptions; budget?: SessionBudget; host?: Partial<AgentHostOptions> } = {}): Made {
  const { launch, browsers } = agentFakeLauncher(options.fake)
  const budget = options.budget ?? new SessionBudget({ perOwner: 4, host: 8 })
  const host = new AgentHost({
    targets: { chrome: { engine: 'chromium', executablePath: '/fake/chrome' }, firefox: { engine: 'firefox', executablePath: '/fake/firefox' } },
    budget,
    logFolder: '/tmp/retest-agent-unit-logs',
    launchers: { chromium: launch, firefox: launch, webkit: launch },
    timeouts: { setup: 2000, action: 1000, navigation: 1000, assertion: 300, cleanup: 300 },
    ...options.host,
  })
  t.after(() => host.close())
  return { host, browsers, budget }
}

function request(overrides: Partial<AgentOpenRequest> = {}): AgentOpenRequest {
  return { owner: 'agent-1', app: 'owner', purpose: 'discovery', target: 'chrome', engine: 'chromium', baseUrl: 'http://127.0.0.1:4173', ...overrides }
}

describe('opening on a named target and engine', () => {
  test('a session opens in a new context of its target, named by its attempt and app, and records who holds it', async (t) => {
    const { host, browsers, budget } = makeHost(t)
    const opened = await host.open(request())
    assert.ok(opened.ok, opened.ok ? '' : opened.failure.message)
    const { session } = opened
    assert.match(session.sessionId, /^[a-z0-9]{10}:owner$/)
    assert.deepEqual([session.app, session.purpose, session.owner, session.target, session.engine], ['owner', 'discovery', 'agent-1', 'chrome', 'chromium'])
    assert.equal(session.identity.owner.runId, host.runId)
    assert.equal(session.runtime.engine, 'chromium')
    assert.equal(browsers.length, 1)
    assert.equal(browsers[0]?.pages[0]?.identified, session.sessionId, 'the page was named as the session')
    assert.equal(browsers[0]?.pages[0]?.options.baseUrl, 'http://127.0.0.1:4173')
    assert.equal(browsers[0]?.pages[0]?.options.storageState, undefined, 'a session without saved state starts empty')
    assert.equal(budget.snapshot().host, 1)
    assert.equal(budget.snapshot().owners.get('agent-1'), 1)
  })

  test('sessions of one target share its browser, each in a context of its own', async (t) => {
    const { host, browsers } = makeHost(t)
    const first = await host.open(request())
    const second = await host.open(request({ app: 'member' }))
    assert.ok(first.ok && second.ok)
    assert.equal(browsers.length, 1)
    assert.equal(browsers[0]?.pages.length, 2)
    assert.notEqual(first.session.sessionId, second.session.sessionId)
  })

  test('a target on another engine than the one asked for is refused by name, and nothing is launched or held', async (t) => {
    const { host, browsers, budget } = makeHost(t)
    const opened = await host.open(request({ target: 'chrome', engine: 'firefox' }))
    assert.ok(!opened.ok)
    assert.equal(opened.failure.class, 'setup_failed')
    assert.equal(opened.failure.message, 'The target "chrome" runs on chromium, and the session asked for firefox. Retest never runs one engine in another\'s place.')
    assert.equal(browsers.length, 0)
    assert.equal(budget.snapshot().host, 0)
  })

  test('a browser that says it is another engine than its target is closed and refused', async (t) => {
    const { host, browsers, budget } = makeHost(t, { fake: { states: 'webkit' } })
    const opened = await host.open(request())
    assert.ok(!opened.ok)
    assert.equal(opened.failure.class, 'setup_failed')
    assert.match(opened.failure.message, /^The target chrome runs on chromium, and the browser it started says it is webkit\. Retest never runs one engine in another's place, so it closed that browser\.$/)
    assert.equal(browsers[0]?.closed, true)
    assert.equal(budget.snapshot().host, 0)
  })

  test('a browser that states its own engine runs sessions of that engine', async (t) => {
    const { host } = makeHost(t, { fake: { states: 'firefox' } })
    const opened = await host.open(request({ target: 'firefox', engine: 'firefox' }))
    assert.ok(opened.ok)
    assert.equal(opened.session.runtime.engine, 'firefox')
  })

  test('a browser that will not start fails the open, holding nothing', async (t) => {
    const { host, budget } = makeHost(t, { fake: { launchFails: 'no such file' } })
    const opened = await host.open(request())
    assert.ok(!opened.ok)
    assert.equal(opened.failure.class, 'setup_failed')
    assert.match(opened.failure.message, /^The chromium browser of the target chrome could not start: no such file$/)
    assert.equal(budget.snapshot().host, 0)
  })

  test('an open request is read whole, and each problem is named', async (t) => {
    const { host } = makeHost(t)
    const opened = await host.open({ ...request(), owner: '', app: 'two words', target: 'safari', holdMs: 0, viewport: { width: 0, height: 10 } })
    assert.ok(!opened.ok)
    assert.equal(opened.failure.class, 'usage')
    for (const named of ['owner:', 'app:', 'target: the host has no target "safari"', 'holdMs:', 'viewport:']) assert.ok(opened.failure.message.includes(named), named)
  })

  test('host options are read whole when the host is made', () => {
    assert.throws(
      () => new AgentHost({ targets: {}, budget: new SessionBudget({ perOwner: 1, host: 1 }), logFolder: 'relative' }),
      (error: unknown) => error instanceof AgentHostError && error.failure.class === 'usage' && /targets:/.test(error.message) && /logFolder:/.test(error.message),
    )
  })
})

describe('owner and host capacity through the session budget', () => {
  test("an owner's sessions beyond its limit wait, then are refused naming the holders, holding nothing", async (t) => {
    const { host, budget } = makeHost(t, { budget: new SessionBudget({ perOwner: 2, host: 3 }) })
    const first = await host.open(request())
    const second = await host.open(request({ app: 'member' }))
    assert.ok(first.ok && second.ok)
    const third = await host.open(request({ app: 'viewer', waitMs: 50 }))
    assert.ok(!third.ok)
    assert.equal(third.failure.class, 'setup_failed')
    assert.match(third.failure.message, /^Not run: 1 session for "agent-1" did not come free within 50 ms\. When it gave up, "agent-1" held 2 of 2 and the host 2 of 3\.$/)
    assert.equal(third.failure.details?.['heldBy'], `${first.session.sessionId} and ${second.session.sessionId}`)
    assert.equal(budget.snapshot().host, 2)
  })

  test('a waiting session opens once another of its owner ends', async (t) => {
    const { host, budget } = makeHost(t, { budget: new SessionBudget({ perOwner: 1, host: 4 }) })
    const first = await host.open(request())
    assert.ok(first.ok)
    const waiting = host.open(request({ app: 'member', waitMs: 2000 }))
    await settle()
    assert.equal(budget.snapshot().waiting, 1)
    assert.ok((await first.session.end()).ok)
    const second = await waiting
    assert.ok(second.ok)
    assert.deepEqual([budget.snapshot().host, budget.peak().host], [1, 1])
  })

  test("the host's limit holds across owners", async (t) => {
    const { host } = makeHost(t, { budget: new SessionBudget({ perOwner: 2, host: 2 }) })
    assert.ok((await host.open(request())).ok)
    assert.ok((await host.open(request({ owner: 'agent-2' }))).ok)
    const third = await host.open(request({ owner: 'agent-3', waitMs: 30 }))
    assert.ok(!third.ok)
    assert.match(third.failure.message, /the host 2 of 2/)
  })

  test('a named lock keeps two sessions apart until the first ends', async (t) => {
    const { host } = makeHost(t)
    const first = await host.open(request({ locks: ['inbox'] }))
    assert.ok(first.ok)
    let opened = false
    const second = host.open(request({ app: 'member', locks: ['inbox'] })).then((answer) => {
      opened = true
      return answer
    })
    await sleep(50)
    assert.equal(opened, false, 'the second session waits for the lock')
    await first.session.end()
    assert.ok((await second).ok)
  })
})

describe('ending and giving back', () => {
  test('ending closes the context and gives the session back; a second end waits for the first', async (t) => {
    const { host, browsers, budget } = makeHost(t)
    const opened = await host.open(request())
    assert.ok(opened.ok)
    const [first, second] = await Promise.all([opened.session.end(), opened.session.end()])
    assert.deepEqual(first, { ok: true, ending: { kind: 'ended', sessions: 'returned' } })
    assert.deepEqual(second, first)
    assert.equal(browsers[0]?.pages[0]?.disposed, true)
    assert.equal(opened.session.state, 'ended')
    assert.equal(budget.snapshot().host, 0)
    assert.deepEqual(host.sessions(), [])
  })

  test('a session that held its browser for its whole hold is ended, its action stopped and everything given back', async (t) => {
    const { host, browsers, budget } = makeHost(t, { fake: { hold: 'click' } })
    const opened = await host.open(request({ holdMs: 150 }))
    assert.ok(opened.ok)
    const clicking = opened.session.act({ kind: 'click', locator: { by: 'testId', value: 'save-task' } }, { timeoutMs: 5000 })
    const ended = await opened.session.ended
    assert.equal(ended.ending.kind, 'held_too_long')
    assert.equal(ended.ending.reason?.class, 'timeout')
    assert.match(ended.ending.reason?.message ?? '', /held its browser for its whole 150 ms hold, so Retest ended it\.$/)
    const action = await clicking
    assert.ok(!action.result.ok)
    assert.equal(action.input, 'not_sent', 'the stopped click sent nothing')
    assert.equal(browsers[0]?.pages[0]?.disposed, true)
    assert.equal(budget.snapshot().host, 0)
    const after = await opened.session.act({ kind: 'goto', url: '/' })
    assert.ok(!after.result.ok)
    assert.equal(after.result.failure.class, 'timeout')
    assert.match(after.result.failure.message, /has ended, so Retest sent nothing to its page/)
  })

  test('an action whose input went keeps that answer when the hold ends it', async (t) => {
    const { host } = makeHost(t, { fake: { hold: 'click', holdSendsInput: true } })
    const opened = await host.open(request({ holdMs: 100 }))
    assert.ok(opened.ok)
    const action = await opened.session.act({ kind: 'click', locator: { by: 'testId', value: 'save-task' } }, { timeoutMs: 5000 })
    assert.ok(!action.result.ok)
    assert.equal(action.input, 'sent', 'input that went is reported as sent, never as undone')
  })

  test('stopping the host ends every session and withdraws a waiting open', async (t) => {
    const { host, budget } = makeHost(t, { budget: new SessionBudget({ perOwner: 1, host: 1 }), fake: { hold: 'click' } })
    const opened = await host.open(request())
    assert.ok(opened.ok)
    const clicking = opened.session.act({ kind: 'click', locator: { by: 'testId', value: 'save-task' } }, { timeoutMs: 5000 })
    const waiting = host.open(request({ app: 'member', waitMs: 5000 }))
    await settle()
    host.stop({ class: 'interrupted', message: 'The worker stopped.' })
    const [ended, action, withdrawn] = await Promise.all([opened.session.ended, clicking, waiting])
    assert.equal(ended.ending.kind, 'stopped')
    assert.deepEqual(ended.ending.reason, { class: 'interrupted', message: 'The worker stopped.' })
    assert.ok(!action.result.ok)
    assert.equal(action.result.failure.class, 'interrupted')
    assert.ok(!withdrawn.ok)
    assert.deepEqual(withdrawn.failure, { class: 'interrupted', message: 'The worker stopped.' })
    assert.equal(budget.snapshot().host, 0)
    assert.deepEqual((await host.open(request())).ok, false, 'a stopped host opens nothing')
  })

  test('a lost browser ends its sessions as lost and gives their sessions back', async (t) => {
    const { host, browsers, budget } = makeHost(t)
    const opened = await host.open(request())
    assert.ok(opened.ok)
    browsers[0]?.disconnect('the browser process ended with signal SIGKILL')
    const ended = await opened.session.ended
    assert.equal(ended.ending.kind, 'lost')
    assert.equal(ended.ending.reason?.class, 'session_lost')
    assert.equal(budget.snapshot().host, 0)
    const after = await opened.session.observe({ by: 'testId', value: 'save-task' })
    assert.ok(!after.ok)
    assert.equal(after.failure.class, 'session_lost')
    const again = await host.open(request())
    assert.ok(again.ok, 'the next session launches a new browser')
    assert.equal(browsers.length, 2)
    assert.deepEqual(await host.close(), { ok: true })
    assert.deepEqual(browsers.map((browser) => browser.closed), [true, true], 'the lost browser is closed with the host too, so what it left is removed')
  })

  test('a context that would not close keeps its session counted until its browser closes', async (t) => {
    const { host, browsers, budget } = makeHost(t, { fake: { disposeHangs: true } })
    const opened = await host.open(request())
    assert.ok(opened.ok)
    const ended = await opened.session.end()
    assert.ok(!ended.ok)
    assert.equal(ended.failure.class, 'cleanup_failed')
    assert.match(ended.failure.message, /did not finish within the 300 ms cleanup budget, so its session stays counted until its browser closes\./)
    assert.equal(ended.ending.sessions, 'held_until_browser_closed')
    assert.equal(budget.snapshot().host, 1, 'the context may still be open, so its session still counts')
    await browsers[0]?.close()
    await settle()
    assert.equal(budget.snapshot().host, 0)
  })

  test('closing the host ends every session and closes every browser it launched', async (t) => {
    const { host, browsers, budget } = makeHost(t)
    const first = await host.open(request())
    const second = await host.open(request({ target: 'firefox', engine: 'firefox' }))
    assert.ok(first.ok && second.ok)
    assert.deepEqual(await host.close(), { ok: true })
    assert.deepEqual([first.session.state, second.session.state], ['ended', 'ended'])
    assert.deepEqual(browsers.map((browser) => browser.closed), [true, true])
    assert.equal(budget.snapshot().host, 0)
  })

  test('a page that opens after the host stopped waiting is closed, and its session counts until then', async (t) => {
    const opening = Promise.withResolvers<void>()
    const { host, browsers, budget } = makeHost(t, { fake: { holdOpening: opening.promise }, host: { timeouts: { setup: 50, cleanup: 300 } } })
    const opened = await host.open(request())
    assert.ok(!opened.ok)
    assert.match(opened.failure.message, /could not open a page within 50 ms/)
    assert.equal(budget.snapshot().host, 1, 'a page may still come, so its session still counts')
    opening.resolve()
    await settle()
    assert.equal(browsers[0]?.pages[0]?.disposed, true)
    assert.equal(budget.snapshot().host, 0)
  })
})

describe('opening never throws, and every grant goes back once', () => {
  test('a launcher that throws before it returns fails each open by name, gives every session back, and the next open tries again', async (t) => {
    const { host, budget } = makeHost(t, { fake: { launchThrows: 'launcher threw before returning a promise' }, budget: new SessionBudget({ perOwner: 2, host: 2 }) })
    for (const attempt of [1, 2, 3]) {
      const opened = await host.open(request({ app: `app-${attempt}`, waitMs: 300 }))
      assert.ok(!opened.ok)
      assert.equal(opened.failure.class, 'setup_failed')
      assert.equal(opened.failure.message, 'The chromium browser of the target chrome could not start: launcher threw before returning a promise')
      assert.equal(budget.snapshot().host, 0, `open ${attempt} gave its session back`)
    }
    assert.deepEqual(await host.close(), { ok: true })
  })

  test('a launcher that throws before it returns is asked again by each open', async (t) => {
    const fake = agentFakeLauncher({ launchThrows: 'not today' })
    const host = new AgentHost({ targets: { chrome: { engine: 'chromium', executablePath: '/fake/chrome' } }, budget: new SessionBudget({ perOwner: 2, host: 2 }), logFolder: '/tmp/retest-agent-unit-logs', launchers: { chromium: fake.launch } })
    t.after(() => host.close())
    for (let attempt = 0; attempt < 3; attempt++) assert.equal((await host.open(request())).ok, false)
    assert.equal(fake.calls.count, 3, 'a failed launch is forgotten, so every open launches again')
  })

  test('a launch that fails after the open stopped waiting for it is forgotten, and leaves nothing unhandled', async (t) => {
    const failing = Promise.withResolvers<void>()
    const fake = agentFakeLauncher({ launchAfter: failing.promise })
    const budget = new SessionBudget({ perOwner: 2, host: 2 })
    const host = new AgentHost({ targets: { chrome: { engine: 'chromium', executablePath: '/fake/chrome' } }, budget, logFolder: '/tmp/retest-agent-unit-logs', launchers: { chromium: fake.launch }, timeouts: { setup: 30, cleanup: 300 } })
    t.after(() => host.close())
    const opened = await host.open(request())
    assert.ok(!opened.ok)
    assert.match(opened.failure.message, /did not start within 30 ms/)
    failing.reject(new Error('the browser exited during its start'))
    await settle()
    assert.equal(budget.snapshot().host, 0)
    assert.equal((await host.open(request())).ok, false)
    assert.equal(fake.calls.count, 2)
    assert.deepEqual(await host.close(), { ok: true })
  })

  test('a browser that arrives after the host closed is closed as it arrives, and close waits for it', async (t) => {
    const arriving = Promise.withResolvers<void>()
    const { host, browsers } = makeHost(t, { fake: { launchAfter: arriving.promise } })
    const opening = host.open(request())
    await sleep(30)
    const closing = host.close()
    setTimeout(() => arriving.resolve(), 100)
    const closed = await closing
    assert.deepEqual(closed, { ok: true })
    assert.equal(browsers.length, 1, 'close answered only once the browser had arrived')
    assert.equal(browsers[0]?.closed, true)
    const opened = await opening
    assert.ok(!opened.ok)
    assert.equal(opened.failure.class, 'interrupted')
  })

  test('a late browser whose close fails makes the host close say so', async (t) => {
    const arriving = Promise.withResolvers<void>()
    const { host, browsers } = makeHost(t, { fake: { launchAfter: arriving.promise, closeFails: 'the late browser would not close' } })
    const opening = host.open(request())
    await sleep(30)
    const closing = host.close()
    setTimeout(() => arriving.resolve(), 50)
    const closed = await closing
    assert.ok(!closed.ok)
    assert.equal(closed.failure.class, 'cleanup_failed')
    assert.match(closed.failure.message, /Closing a browser failed: the late browser would not close/)
    assert.equal(browsers[0]?.closed, true)
    assert.equal((await opening).ok, false)
  })

  test('a browser whose close throws before it returns makes the host close say so, and the close still settles', async (t) => {
    const fake = agentFakeLauncher()
    const throwing: AgentLauncher = async (options, timeoutMs) => {
      const browser = await fake.launch(options, timeoutMs)
      browser.close = () => {
        throw new Error('the browser would not close')
      }
      return browser
    }
    const host = new AgentHost({ targets: { chrome: { engine: 'chromium', executablePath: '/fake/chrome' } }, budget: new SessionBudget({ perOwner: 2, host: 2 }), logFolder: '/tmp/retest-agent-unit-logs', launchers: { chromium: throwing } })
    t.after(() => host.close())
    assert.ok((await host.open(request())).ok)
    const closed = await host.close()
    assert.ok(!closed.ok)
    assert.match(closed.failure.message, /Closing a browser failed: the browser would not close/)
  })

  test('no launcher fault leaves a rejection unhandled to crash the host process', () => {
    const program = fileURLToPath(new URL('agent-host-program.ts', import.meta.url))
    const ran = spawnSync(process.execPath, ['--conditions=retest-source', program], { encoding: 'utf8', timeout: 60_000 })
    assert.equal(ran.status, 0, ran.stderr)
    assert.doesNotMatch(ran.stderr, /unhandled|Unhandled/)
    const printed: unknown = JSON.parse(ran.stdout.trim().split('\n').at(-1) ?? '{}')
    assert.deepEqual(printed, {
      thrown: { opens: ['setup_failed', 'setup_failed'], held: 0, closed: true },
      lateFailure: { open: 'setup_failed', held: 0, closed: true },
      lateArrival: { open: 'interrupted', closed: false, browserClosed: true },
    })
  })
})

describe('capacity refusals and lost browsers', () => {
  test('a refusal names only the holders of the owner that asked, and counts the rest', async (t) => {
    const { host } = makeHost(t, { budget: new SessionBudget({ perOwner: 1, host: 3 }) })
    const acme = await host.open(request({ owner: 'workspace-acme', app: 'acme-billing-admin' }))
    const globex = await host.open(request({ owner: 'workspace-globex', app: 'globex-payroll' }))
    assert.ok(acme.ok && globex.ok)
    const again = await host.open(request({ owner: 'workspace-acme', app: 'acme-second', waitMs: 30 }))
    assert.ok(!again.ok)
    assert.equal(again.failure.details?.['heldBy'], acme.session.sessionId)
    assert.equal(again.failure.details?.['heldByOthers'], 1)
    const third = await host.open(request({ owner: 'workspace-initech', app: 'web', waitMs: 30 }))
    assert.ok(third.ok, 'the host has room for a third owner')
    const full = await host.open(request({ owner: 'workspace-hooli', app: 'web', waitMs: 30 }))
    assert.ok(!full.ok)
    assert.equal(full.failure.details?.['heldBy'], undefined, "no other owner's session is named")
    assert.equal(full.failure.details?.['heldByOthers'], 3)
    assert.doesNotMatch(JSON.stringify(full.failure), /acme|globex|initech/)
  })

  test('a lost browser is closed after a short grace, without waiting for the host to close', async (t) => {
    const { host, browsers } = makeHost(t)
    const opened = await host.open(request())
    assert.ok(opened.ok)
    browsers[0]?.disconnect('the browser process ended with signal SIGKILL')
    await opened.session.ended
    assert.equal(browsers[0]?.closed, false, 'the processes it started get a moment to go on their own')
    await sleep(lostBrowserGraceMs + 200)
    assert.equal(browsers[0]?.closed, true, "the lost browser was closed through its own driver's close")
    assert.deepEqual(await host.close(), { ok: true })
  })
})
