import type { EventBody } from '../../src/protocol/events.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { startAppServer } from '../../src/runner/app-server.ts'
import { decideHostCheck } from '../../src/runner/run-host-checks.ts'
import { RunningTest } from '../../src/runner/running-test.ts'
import { FakeBrowser } from '../support/fake-browser.ts'
import { quickTimeouts } from '../support/run-harness.ts'
import { ScriptedProcess } from '../support/scripted-process.ts'
import { earlyClock, fullBudget } from './early-waits-clock.ts'

for (const succeedsAtLimit of [true, false]) {
  test(`host checks send their last probe at the clock limit, success ${succeedsAtLimit}`, async t => {
    const clock = earlyClock(t)
    const reads: number[] = []
    const result = await clock.run(decideHostCheck({ check: { kind: 'text', text: 'ready' }, app: 'web', timeoutMs: 120, stopped: new Promise(() => undefined), interruption: () => undefined, redact: text => text, page: {
      connected: () => true,
      readPage: async () => {
        reads.push(clock.now())
        clock.spend()
        return { url: 'http://127.0.0.1/', navigating: false, found: [succeedsAtLimit && (reads.at(-1) ?? -1) >= 120] }
      },
    } }))
    assert.ok(result.kind === 'done')
    assert.equal(result.status, succeedsAtLimit ? 'passed' : 'failed')
    fullBudget(reads, clock.now())
  })
}

for (const succeedsAtLimit of [true, false]) {
  test(`app readiness sends its last probe at the clock limit, success ${succeedsAtLimit}`, async t => {
    const clock = earlyClock(t)
    const probes: number[] = []
    let failedAt: number | undefined
    const work = startAppServer({ name: 'web', start: { command: 'stand-in', ready: 'http://127.0.0.1/health', cwd: '/' }, logFile: '/dev/null' }, 120, {
      probe: async () => {
        probes.push(clock.now())
        clock.spend()
        return succeedsAtLimit && (probes.at(-1) ?? -1) >= 120
      },
      launch: async () => ({ pid: 4242, exit: undefined, settle: () => undefined, stop: async () => undefined, fail: async problem => { failedAt = clock.now(); throw new Error(problem.message) } }),
    })
    if (succeedsAtLimit) assert.equal((await clock.run(work)).status, 'started')
    else { await assert.rejects(clock.run(work), /did not answer/); assert.ok((failedAt ?? -1) >= 120) }
    fullBudget(probes, clock.now())
  })
}

for (const kind of ['command', 'evaluate'] as const) {
  test(`a ${kind} with a fractional test budget left is accepted`, async t => {
    const browser = new FakeBrowser({}, { executablePath: '/fake/chrome', logFile: '/dev/null', headless: true })
    const page = await browser.newPage({ baseUrl: 'http://127.0.0.1/' }, 1000)
    const clock = earlyClock(t)
    const process = new ScriptedProcess()
    const events: EventBody[] = []
    const calls: number[] = []
    const scope = { testId: 'a.retest.ts > one', attemptId: 'attempt1' }
    const running = new RunningTest({ process, pages: new Map([['page', page]]), ...scope, timeouts: { ...quickTimeouts, test: 120 }, emit: event => { events.push(event) }, evaluations: {
      request: async call => { calls.push(clock.now()); return { checkId: 'one', mode: call.mode, verdict: 'pass', criteria: [] } }, cancel: () => undefined,
    } })
    running.run()
    try {
      clock.spend(119.6)
      if (kind === 'command') {
        process.deliver({ type: 'command', ...scope, id: 1, app: 'page', command: { kind: 'observe', locator: { by: 'testId', value: 'save-task' } }, timeoutMs: 500 })
        assert.equal((await process.answer(1)).ok, true)
      } else {
        process.deliver({ type: 'evaluate', ...scope, id: 1, call: { criteria: [{ id: 'one', requirement: 'the control is visible' }], evidence: [{ kind: 'screenshot' }], mode: 'required' } })
        await nextTurn()
        assert.deepEqual(calls, [119.6])
      }
      assert.equal(process.sent.some(message => message.type === 'abort'), false)
      assert.equal(events.some(event => event.type === 'action.failed'), false)
    } finally { running.close() }
  })
}

test('an early test timer is rearmed until the deadline clock reaches its limit', async t => {
  const clock = earlyClock(t)
  const aborted = Promise.withResolvers<number>()
  const process = new ScriptedProcess(message => { if (message.type === 'abort') aborted.resolve(clock.now()) })
  const running = new RunningTest({ process, pages: new Map(), testId: 'a.retest.ts > one', attemptId: 'attempt1', timeouts: { ...quickTimeouts, test: 120 }, emit: () => undefined })
  running.run()
  try { assert.ok((await clock.run(aborted.promise)) >= 120) } finally { running.close() }
})
