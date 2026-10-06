import type { TestContext } from 'node:test'
import type { NativeKind } from '../../src/browser/contract.ts'
import type { NativePort, TreeLook } from '../../src/native/actionability.ts'
import type { FieldRead } from '../../src/native/input.ts'
import type { Failure } from '../../src/protocol/failures.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { locatorSubject, waitUntilActionable, waitUntilAppReady } from '../../src/native/actionability.ts'
import { answerAlert } from '../../src/native/alerts.ts'
import { performAction } from '../../src/native/input.ts'
import { dismissKeyboard, readTreeSteadily, waitForKeyboard } from '../../src/native/keyboard.ts'
import { parseNativeTree } from '../../src/native/locators.ts'
import { ExecutorClient, ExecutorElements, ExecutorSession } from '../../src/native/webdriver-client.ts'
import { Deadline } from '../../src/protocol/deadline.ts'
import { earlyClock, fullBudget } from './early-waits-clock.ts'

const locator = { by: 'testId', value: 'field' } as const
const reference = { sessionId: 'attempt:phone', instance: 'i', generation: 1, observationId: 'o1' }
const frame = { x: 10, y: 20, width: 50, height: 30 }
const treeFailure: Failure = { class: 'not_actionable', message: 'Tree not ready.', details: { check: 'tree' } }
const readTimeout: Failure = { class: 'timeout', message: 'Read timed out.' }

function tree(children = ''): Extract<TreeLook, { ok: true }> {
  const parsed = parseNativeTree(`<XCUIElementTypeApplication type="XCUIElementTypeApplication" name="App" label="App" enabled="true" visible="true" x="0" y="0" width="402" height="874">${children}</XCUIElementTypeApplication>`, 'ios-simulator')
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.problem)
  return { ok: true, tree: parsed.tree, reference }
}
const empty = tree()
const keyboard = tree('<XCUIElementTypeKeyboard type="XCUIElementTypeKeyboard" name="Keyboard" label="Keyboard" visible="true" x="0" y="600" width="402" height="274"><XCUIElementTypeButton type="XCUIElementTypeButton" name="Return" label="return" enabled="true" visible="true" x="10" y="20" width="50" height="30"/></XCUIElementTypeKeyboard>')
const field = tree('<XCUIElementTypeTextField type="XCUIElementTypeTextField" name="field" label="Title" value="" enabled="true" visible="true" x="10" y="20" width="50" height="30"/>')

function portFor(t: TestContext, platform: NativeKind = 'ios-simulator'): NativePort {
  const name = platform === 'macos' ? 'mac2' : 'webdriveragent'
  const client = new ExecutorClient({ executor: name, host: '127.0.0.1', port: 1 })
  const executor = new ExecutorSession(name, 'session', async () => ({ status: 'answered', value: null, durationMs: 0 }))
  const elements = new ExecutorElements(client, executor)
  t.mock.method(elements, 'findElements', async () => ({ status: 'answered', value: ['element'], durationMs: 0 }))
  t.mock.method(elements, 'elementRect', async () => ({ status: 'answered', value: frame, durationMs: 0 }))
  t.mock.method(elements, 'elementAttribute', async (_id: string, name: string) => ({ status: 'answered', value: name === 'name' ? 'Return' : name === 'label' ? 'return' : true, durationMs: 0 }))
  t.mock.method(executor, 'click', async () => ({ status: 'answered', value: null, durationMs: 0 }))
  t.mock.method(elements, 'alertButtons', async () => ({ status: 'answered', value: ['OK'], durationMs: 0 }))
  t.mock.method(elements, 'acceptAlert', async () => ({ status: 'answered', value: null, durationMs: 0 }))
  t.mock.method(elements, 'alertText', async () => ({ status: 'answered', value: 'Alert', durationMs: 0 }))
  return {
    platform, sessionId: reference.sessionId, elements, executor,
    readTree: async () => empty,
    readField: async () => ({ ok: false, failure: treeFailure }),
    frontProblem: async () => undefined, keysProblem: async () => undefined, checkReference: async () => undefined,
    recordInput: () => {}, aboutToSend: () => {}, noteReadBack: () => {},
    readFailure: (_answer, what) => ({ class: 'timeout', message: what }),
  }
}

function macReadyPort(t: TestContext): NativePort {
  const port = portFor(t, 'macos')
  const parsed = parseNativeTree('<XCUIElementTypeWindow type="XCUIElementTypeWindow" identifier="window" label="Window" enabled="true" visible="true" x="10" y="20" width="50" height="30"><XCUIElementTypeTextField type="XCUIElementTypeTextField" identifier="field" label="Title" value="" enabled="true" visible="true" x="10" y="20" width="50" height="30"/></XCUIElementTypeWindow>', 'macos')
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.problem)
  t.mock.method(port.elements, 'findElements', async (predicate: string) => ({ status: 'answered', value: [predicate.includes('window') ? 'window' : 'element'], durationMs: 0 }))
  t.mock.method(port.elements, 'elementAttribute', async (id: string, name: string) => ({ status: 'answered', value: name === 'identifier' ? (id === 'window' ? 'window' : 'field') : true, durationMs: 0 }))
  port.readTree = async () => ({ ok: true, tree: parsed.tree, reference })
  return port
}

for (const app of [false, true]) {
  test(`native ${app ? 'app-coordinate' : 'element'} readiness reads at the deadline through early timers and read timeouts`, async (t) => {
    const port = portFor(t)
    const clock = earlyClock(t)
    const reads: number[] = []
    port.readTree = async () => {
      reads.push(clock.now()); clock.spend()
      return { ok: false, failure: reads.length <= 2 ? readTimeout : treeFailure }
    }
    const stop = new AbortController()
    const deadline = new Deadline(120)
    const result = app
      ? await clock.run(waitUntilAppReady(port, { verb: 'scroll', at: 'point' }, deadline, stop.signal))
      : await clock.run(waitUntilActionable(port, locatorSubject(locator, 'tap'), { verb: 'tap', enabled: true }, deadline, stop.signal))
    assert.ok(!result.ok && result.failure.class === 'not_actionable')
    fullBudget(reads, clock.now())
  })
}

test('native steady-tree retries send their final read after early timers', async (t) => {
  const port = portFor(t); const clock = earlyClock(t); const reads: number[] = []
  port.readTree = async () => { reads.push(clock.now()); clock.spend(); return { ok: false, failure: reads.length === 2 ? readTimeout : treeFailure } }
  const result = await clock.run(readTreeSteadily(port, new Deadline(120), new AbortController().signal))
  assert.deepEqual(result, { ok: false, failure: treeFailure })
  fullBudget(reads, clock.now())
})

test('native keyboard-up verification sends a final tree read after an early timeout', async (t) => {
  const port = portFor(t); const clock = earlyClock(t); const reads: number[] = []
  port.readTree = async () => { reads.push(clock.now()); clock.spend(); return reads.length === 2 ? { ok: false, failure: readTimeout } : empty }
  const result = await clock.run(waitForKeyboard(port, new Deadline(120), new AbortController().signal))
  assert.ok(!result.ok && result.failure.details?.['check'] === 'keyboard')
  fullBudget(reads, clock.now())
})

test('native keyboard-dismiss verification reads at the deadline and never presses twice', async (t) => {
  const port = portFor(t); const clock = earlyClock(t); const reads: number[] = []
  let clicks = 0
  t.mock.method(port.executor, 'click', async () => { clicks++; return { status: 'answered', value: null, durationMs: 0 } })
  port.readTree = async () => { if (clicks) reads.push(clock.now()); clock.spend(); return clicks && reads.length === 1 ? { ok: false, failure: readTimeout } : keyboard }
  const result = await clock.run(dismissKeyboard(port, new Deadline(120), new AbortController().signal))
  assert.ok(!result.result.ok && result.result.failure.class === 'not_actionable', JSON.stringify(result))
  assert.equal(clicks, 1)
  fullBudget(reads, clock.now())
})

test('native alert-close verification sends its final tree and executor probe after early timeouts', async (t) => {
  const port = portFor(t); const clock = earlyClock(t); const reads: number[] = []; const probes: number[] = []
  let presses = 0
  t.mock.method(port.elements, 'acceptAlert', async () => { presses++; return { status: 'answered', value: null, durationMs: 0 } })
  t.mock.method(port.elements, 'alertText', async () => { probes.push(clock.now()); clock.spend(); return probes.length === 2 ? { status: 'not_sent', reason: 'timeout', message: 'early timeout' } : { status: 'answered', value: 'Alert', durationMs: 0 } })
  port.readTree = async () => { if (presses) reads.push(clock.now()); clock.spend(); return presses && reads.length === 2 ? { ok: false, failure: readTimeout } : empty }
  const result = await clock.run(answerAlert(port, { button: 'OK', route: 'accept' }, new Deadline(120), new AbortController().signal, (text) => text))
  assert.ok(!result.result.ok && result.result.failure.class === 'not_actionable')
  assert.equal(presses, 1)
  fullBudget(reads, clock.now()); fullBudget(probes, clock.now())
})

test('native field read-back retries send the final read and never type twice', async (t) => {
  const port = portFor(t); const clock = earlyClock(t); const reads: number[] = []
  let typed = 0
  t.mock.method(port.executor, 'typeText', async () => { typed++; return { status: 'answered', value: null, durationMs: 0 } })
  t.mock.method(port.elements, 'elementAttribute', async (_id: string, name: string) => ({ status: 'answered', value: name === 'name' ? 'field' : name === 'label' ? 'Title' : true, durationMs: 0 }))
  // Resolve the field from a tree that also shows the keyboard, avoiding optional keyboard discovery consuming time.
  const combined = tree('<XCUIElementTypeTextField type="XCUIElementTypeTextField" name="field" label="Title" value="" enabled="true" visible="true" x="10" y="20" width="50" height="30"/><XCUIElementTypeKeyboard type="XCUIElementTypeKeyboard" visible="true" x="0" y="600" width="402" height="274"/>')
  port.readTree = async () => combined
  port.readField = async (): Promise<FieldRead> => {
    if (!typed) { const element = field.tree.elements.find((item) => item.type === 'TextField'); assert.ok(element); return { ok: true, element, value: '', reading: 'read', reference } }
    reads.push(clock.now()); clock.spend(); return { ok: false, failure: reads.length === 1 ? readTimeout : treeFailure }
  }
  const result = await clock.run(performAction(port, { kind: 'fill', locator, text: 'Wanted' }, new Deadline(120), new AbortController().signal))
  assert.ok(!result.result.ok && result.result.failure.message === treeFailure.message)
  assert.equal(typed, 1)
  fullBudget(reads, clock.now())
})

test('native waits preserve a non-time failure in the last fraction without sleeping or replacing it', async (t) => {
  const port = portFor(t); const clock = earlyClock(t)
  const failure: Failure = { class: 'session_lost', message: 'Executor went away.' }
  port.readTree = async () => { clock.spend(119.5); return { ok: false, failure } }
  const result = await clock.run(waitForKeyboard(port, new Deadline(120), new AbortController().signal))
  assert.deepEqual(result, { ok: false, failure })
  assert.equal(clock.now(), 119.5)
})

for (const app of [false, true]) for (const frontAt of [249.5, 250.1]) {
  test(`native ${app ? 'app-coordinate' : 'element'} readiness keeps observing after a front check at ${frontAt} ms`, async (t) => {
    const port = macReadyPort(t); const clock = earlyClock(t); const reads: number[] = []; let fronts = 0
    const readTree = port.readTree
    port.readTree = async (timeoutMs, signal) => { reads.push(clock.now()); clock.spend(); return readTree(timeoutMs, signal) }
    port.frontProblem = async () => {
      fronts++; if (fronts === 2) clock.spend(Math.max(0, frontAt - clock.now()))
      return fronts === 1 ? 'The earlier window is in front.' : frontAt >= 250 ? 'Retest could not read the processes behind the windows on screen.' : 'The later window is in front.'
    }
    const stop = new AbortController(); const deadline = new Deadline(250)
    const result = app
      ? await clock.run(waitUntilAppReady(port, { verb: 'press', at: 'keys' }, deadline, stop.signal))
      : await clock.run(waitUntilActionable(port, locatorSubject(locator, 'tap'), { verb: 'tap', enabled: true }, deadline, stop.signal))
    assert.ok(!result.ok && result.failure.class === 'not_actionable')
    assert.match(result.failure.message, frontAt >= 250 ? /The earlier window is in front/ : /The later window is in front/)
    fullBudget(reads, clock.now(), 250)
  })
}

test('optional native keyboard discovery caps its pause at the remaining stage and action budget', async (t) => {
  const port = portFor(t); const clock = earlyClock(t); let clicks = 0
  t.mock.method(port.elements, 'elementAttribute', async (_id: string, name: string) => ({ status: 'answered', value: name === 'name' ? 'field' : name === 'label' ? 'Title' : true, durationMs: 0 }))
  t.mock.method(port.executor, 'click', async () => { clicks++; clock.spend(Math.max(0, 118.2 - clock.now())); return { status: 'answered', value: null, durationMs: 0 } })
  port.readTree = async () => { if (clicks) clock.spend(); return field }
  const failure: Failure = { class: 'unsupported', message: 'The field cannot be read.' }
  port.readField = async () => ({ ok: false, failure })
  const result = await clock.run(performAction(port, { kind: 'fill', locator, text: 'Wanted' }, new Deadline(120), new AbortController().signal))
  assert.ok(!result.result.ok && result.result.failure.message === failure.message)
  assert.equal(clicks, 1)
  assert.ok(clock.now() < 120.2, `optional discovery overran to ${clock.now()}`)
})

test('native keyboard-up verification preserves an unanswered first read through the full deadline', async (t) => {
  const port = portFor(t); const clock = earlyClock(t); const reads: number[] = []
  port.readTree = async () => { reads.push(clock.now()); clock.spend(); return { ok: false, failure: readTimeout } }
  const result = await clock.run(waitForKeyboard(port, new Deadline(120), new AbortController().signal))
  assert.deepEqual(result, { ok: false, failure: readTimeout })
  fullBudget(reads, clock.now())
})

for (const app of [false, true]) {
  test(`native ${app ? 'app-coordinate' : 'element'} stability proof keeps the full frame gap after early timers`, async (t) => {
    const port = macReadyPort(t); const clock = earlyClock(t); const frames: number[] = []
    t.mock.method(port.elements, 'elementRect', async () => { frames.push(clock.now()); return { status: 'answered', value: frame, durationMs: 0 } })
    const stop = new AbortController(); const deadline = new Deadline(120)
    const result = app
      ? await clock.run(waitUntilAppReady(port, { verb: 'press', at: 'keys' }, deadline, stop.signal))
      : await clock.run(waitUntilActionable(port, locatorSubject(locator, 'click'), { verb: 'click', enabled: true }, deadline, stop.signal))
    assert.ok(result.ok)
    assert.ok((frames[0] ?? -1) >= 100, `second frame read at ${frames[0]}`)
    assert.ok(clock.now() < 120)
  })
}
