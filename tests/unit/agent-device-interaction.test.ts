import type { InputDispatch } from '../../src/browser/contract.ts'
import type { AgentDeviceInteractionOptions } from '../../src/native/agent-device/interaction.ts'
import type { AgentDeviceAnswer, AgentDeviceMethod, AgentDevicePort } from '../../src/native/agent-device/package.ts'
import type { SnapshotNode } from '../../src/native/agent-device/tree.ts'
import type { NativeSecretField } from '../../src/native/input.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AgentDeviceInteraction } from '../../src/native/agent-device/interaction.ts'

// The agent-device interaction session against a stand-in for agent-device's client: what Retest sends, once, for each
// action, how it waits for an element, what it records when agent-device says the action did or may have reached the
// device, how a secret is kept to its app, and how each look reads the screen. The stand-in answers as agent-device
// 0.21.36 answered on the iOS simulator; nothing here touches a device.

const bundleId = 'dev.retest.fixtures.taskphone'
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')

type Call = { readonly method: AgentDeviceMethod; readonly options: Readonly<Record<string, unknown>> }
type Handler = (options: Readonly<Record<string, unknown>>, device: StandIn) => AgentDeviceAnswer | Promise<AgentDeviceAnswer>

const answered = (value: unknown = {}): AgentDeviceAnswer => ({ status: 'answered', value, durationMs: 1 })
const refused = (reason: string, code = 'COMMAND_FAILED'): AgentDeviceAnswer => ({ status: 'refused', code, reason, message: `refused: ${reason}`, durationMs: 1 })

/** A stand-in for agent-device: the screen it shows, every call it was sent, and what it answers each method. */
class StandIn {
  readonly calls: Call[] = []
  screen: SnapshotNode[]
  app: string | undefined = bundleId
  generation = 100
  truncated = false
  readonly handlers = new Map<AgentDeviceMethod, Handler>()
  readonly port: AgentDevicePort

  constructor(screen: SnapshotNode[]) {
    this.screen = screen
    this.port = {
      call: async (method, options) => {
        this.calls.push({ method, options })
        const handler = this.handlers.get(method)
        if (handler !== undefined) return handler(options, this)
        if (method === 'capture.snapshot') return answered({ nodes: this.screen, ...(this.app === undefined ? {} : { appBundleId: this.app }), refsGeneration: ++this.generation, truncated: this.truncated })
        return answered()
      },
    }
  }

  sent(method: AgentDeviceMethod): Call[] {
    return this.calls.filter((call) => call.method === method)
  }

  update(identifier: string, change: Partial<SnapshotNode>): void {
    this.screen = this.screen.map((node) => (node.identifier === identifier ? { ...node, ...change } : node))
  }
}

function signInScreen(): SnapshotNode[] {
  return [
    { index: 0, type: 'Other', label: 'TaskPhone', rect: { x: 0, y: 0, width: 402, height: 874 }, enabled: true, ref: 'e1' },
    { index: 1, parentIndex: 0, type: 'Cell', rect: { x: 16, y: 295, width: 370, height: 54 }, enabled: true, ref: 'e2' },
    { index: 2, parentIndex: 1, type: 'TextField', value: 'Account', placeholder: 'Account', identifier: 'account-field', rect: { x: 32, y: 311, width: 338, height: 23 }, enabled: true, ref: 'e3' },
    { index: 3, parentIndex: 0, type: 'Cell', rect: { x: 16, y: 350, width: 370, height: 54 }, enabled: true, ref: 'e4' },
    { index: 4, parentIndex: 3, type: 'SecureTextField', value: 'Password', placeholder: 'Password', identifier: 'password-field', rect: { x: 32, y: 365, width: 338, height: 23 }, enabled: true, password: true, ref: 'e5' },
    { index: 5, parentIndex: 0, type: 'Button', label: 'Sign in', identifier: 'sign-in-button', rect: { x: 16, y: 404, width: 370, height: 54 }, enabled: true, ref: 'e6' },
    { index: 6, parentIndex: 0, type: 'StaticText', label: 'Release checklist', rect: { x: 16, y: 470, width: 370, height: 20 }, enabled: true, ref: 'e7' },
    { index: 7, parentIndex: 0, type: 'StaticText', label: 'Release checklist', rect: { x: 16, y: 500, width: 370, height: 20 }, enabled: true, ref: 'e8' },
  ]
}

type Options = Partial<Omit<AgentDeviceInteractionOptions, 'port'>>

async function opened(device: StandIn, options: Options = {}): Promise<{ readonly session: AgentDeviceInteraction; readonly lost: string[] }> {
  const lost: string[] = []
  const session = new AgentDeviceInteraction({
    port: device.port,
    session: 'retest-1-session',
    sessionId: 'attempt-1:phone',
    platform: 'ios-simulator',
    device: { platform: 'ios', udid: 'SIM-UDID' },
    bundleId,
    launch: { arguments: ['-reset'], environment: {} },
    redact: (text) => text.replaceAll('hunter-2-secret', '{{password}}'),
    install: () => Promise.resolve({ result: { ok: true }, input: 'sent' }),
    processes: () => Promise.resolve({ ok: true, running: true, pids: [4242] }),
    screen: () => Promise.resolve({ ok: true, png: new Uint8Array(png), source: 'simulator-display' }),
    onLost: (reason) => lost.push(reason),
    ...options,
  })
  const launched = await session.launch(5000)
  assert.ok(launched.result.ok, launched.result.ok ? '' : launched.result.failure.message)
  return { session, lost }
}

test('a launch opens the app afresh through agent-device with its arguments, and every call names the session and the simulator', async () => {
  const device = new StandIn(signInScreen())
  const { session } = await opened(device)
  assert.deepEqual(device.calls, [{ method: 'apps.open', options: { app: bundleId, relaunch: true, launchArgs: ['-reset'], platform: 'ios', udid: 'SIM-UDID', session: 'retest-1-session' } }])
  assert.equal(session.generation, 1)
  assert.equal(session.bundleId, bundleId)
})

test('a tap waits for the element to hold still across two looks, then sends one press to the ref of the latest look, pinned to its generation', async () => {
  const device = new StandIn(signInScreen())
  const { session } = await opened(device)
  const startedAt = performance.now()
  const tapped = await session.dispatch({ kind: 'tap', locator: { by: 'testId', value: 'sign-in-button' } }, 5000)
  assert.ok(tapped.result.ok, tapped.result.ok ? '' : tapped.result.failure.message)
  assert.equal(tapped.input, 'sent')
  assert.ok(performance.now() - startedAt >= 100, 'two looks at least 100 ms apart')
  const presses = device.sent('interactions.press')
  assert.equal(presses.length, 1)
  assert.equal(presses[0]?.options['ref'], `@e6~s${device.generation}`)
  assert.ok(device.sent('capture.snapshot').length >= 2)
  assert.deepEqual(session.inputs.map((record) => [record.kind, record.input]), [['tap', 'sent']])
  assert.deepEqual(session.unknownOutcomes, [])
})

test('a press agent-device refused unsent because the screen moved on is looked for again and sent once more; nothing else repeats', async () => {
  const device = new StandIn(signInScreen())
  let refusals = 1
  device.handlers.set('interactions.press', () => (refusals-- > 0 ? refused('ref_generation_mismatch') : answered({ message: 'Tapped' })))
  const { session } = await opened(device)
  const tapped = await session.dispatch({ kind: 'tap', locator: { by: 'testId', value: 'sign-in-button' } }, 5000)
  assert.ok(tapped.result.ok)
  assert.equal(device.sent('interactions.press').length, 2)
  assert.deepEqual(session.inputs.map((record) => record.input), ['sent'], 'the refused press never reached the device and is not kept')
})

test('a press that may have reached the device is never sent again: its outcome is unknown, and reconciling reads the app', async () => {
  const device = new StandIn(signInScreen())
  device.handlers.set('interactions.press', () => ({ status: 'failed', code: 'COMMAND_FAILED', message: 'the runner did not answer', durationMs: 1 }))
  const { session } = await opened(device)
  const tapped = await session.dispatch({ kind: 'tap', locator: { by: 'testId', value: 'sign-in-button' } }, 5000)
  assert.ok(!tapped.result.ok)
  assert.equal(tapped.result.failure.class, 'outcome_unknown')
  assert.equal(tapped.input, 'unknown')
  assert.equal(tapped.result.failure.details?.['inputSent'], 'unknown')
  assert.match(tapped.result.failure.message, /may have reached the device; Retest does not send it again/)
  assert.equal(device.sent('interactions.press').length, 1)
  const outcomes = await session.reconcile(5000)
  assert.equal(outcomes.length, 1)
  assert.equal(outcomes[0]?.source, 'input')
  assert.deepEqual(outcomes[0]?.outcome.reconciled, { ok: true, running: true, pids: [4242] })
})

test('a timeout after the press went is an unknown outcome kept in the ledger', async () => {
  const device = new StandIn(signInScreen())
  device.handlers.set('interactions.press', () => ({ status: 'timeout', message: 'agent-device did not answer interactions.press within 50 ms.', durationMs: 50 }))
  const { session } = await opened(device)
  const tapped = await session.dispatch({ kind: 'tap', locator: { by: 'testId', value: 'sign-in-button' } }, 5000)
  assert.equal(tapped.input, 'unknown')
  assert.ok(!tapped.result.ok && tapped.result.failure.class === 'timeout')
  assert.equal(session.unknownOutcomes.length, 1)
})

test("agent-device's runtime going away while a press is out loses the session: the press is unknown and nothing more is sent", async () => {
  const device = new StandIn(signInScreen())
  device.handlers.set('interactions.press', () => ({ status: 'lost', message: "agent-device's interactions.press failed outside agent-device: socket closed", durationMs: 1 }))
  const { session, lost } = await opened(device)
  const tapped = await session.dispatch({ kind: 'tap', locator: { by: 'testId', value: 'sign-in-button' } }, 5000)
  assert.ok(!tapped.result.ok && tapped.result.failure.class === 'outcome_unknown')
  assert.equal(lost.length, 1)
  const before = device.calls.length
  const looked = await session.observe({ by: 'testId', value: 'sign-in-button' }, 1000)
  assert.ok(!looked.ok && looked.failure.class === 'session_lost')
  assert.equal(device.calls.length, before, 'a lost session sends nothing')
})

test('several matches fail at once and nothing is pressed; a disabled element is waited for until the deadline', async () => {
  const device = new StandIn(signInScreen())
  const { session } = await opened(device)
  const several = await session.dispatch({ kind: 'tap', locator: { by: 'text', text: 'Release checklist' } }, 5000)
  assert.ok(!several.result.ok && several.result.failure.class === 'ambiguous')
  device.update('sign-in-button', { enabled: false })
  const disabled = await session.dispatch({ kind: 'tap', locator: { by: 'testId', value: 'sign-in-button' } }, 400)
  assert.ok(!disabled.result.ok)
  assert.equal(disabled.result.failure.class, 'not_actionable')
  assert.match(disabled.result.failure.message, /it is disabled/)
  assert.equal(disabled.input, 'not_sent')
  assert.equal(device.sent('interactions.press').length, 0)
})

// agent-device's mark is the only reading of what lies over an element: Retest's tree says where each element is, but
// not which of two overlapping elements is drawn on top.
test('an element agent-device marks covered is never pressed: Retest looks again within the action time, names the check, and taps once the mark is gone', async () => {
  const device = new StandIn(signInScreen())
  let covered = true
  device.handlers.set('capture.snapshot', (_options, standIn) => answered({ nodes: standIn.screen.map((node) => (covered && node.identifier === 'sign-in-button' ? { ...node, interactionBlocked: 'covered' } : node)), appBundleId: bundleId, refsGeneration: ++standIn.generation, truncated: false }))
  const { session } = await opened(device)
  const blocked = await session.dispatch({ kind: 'tap', locator: { by: 'testId', value: 'sign-in-button' } }, 400)
  assert.ok(!blocked.result.ok)
  assert.equal(blocked.input, 'not_sent')
  assert.equal(blocked.result.failure.class, 'not_actionable')
  assert.equal(blocked.result.failure.details?.['check'], 'covered')
  assert.match(blocked.result.failure.message, /within 400 ms: something lies over it: agent-device reads something else drawn over/)
  assert.ok(device.sent('capture.snapshot').length >= 3, 'it kept looking until its time ran out')
  assert.equal(device.sent('interactions.press').length, 0)
  covered = false
  const tapped = await session.dispatch({ kind: 'tap', locator: { by: 'testId', value: 'sign-in-button' } }, 5000)
  assert.ok(tapped.result.ok, tapped.result.ok ? '' : tapped.result.failure.message)
  assert.equal(device.sent('interactions.press').length, 1)
  // agent-device refuses a press it finds covered as it acts, sending nothing; Retest looks again and sends it once more.
  let refusals = 1
  device.handlers.set('interactions.press', () => (refusals-- > 0 ? refused('target_covered') : answered()))
  const again = await session.dispatch({ kind: 'tap', locator: { by: 'testId', value: 'sign-in-button' } }, 5000)
  assert.ok(again.result.ok, again.result.ok ? '' : again.result.failure.message)
  assert.equal(device.sent('interactions.press').length, 3)
  assert.deepEqual(session.inputs.map((record) => record.input), ['sent', 'sent'], 'the refused press never reached the device and is not kept')
})

test('a secret goes to the secure field once, kept out of agent-device diagnostics, and its masked read-back is checked', async () => {
  const device = new StandIn(signInScreen())
  device.handlers.set('interactions.fill', (options, standIn) => {
    standIn.update('password-field', { value: '•'.repeat(String(options['text']).length), focused: true })
    return answered({ text: '[REDACTED]' })
  })
  const { session } = await opened(device)
  const seen: (NativeSecretField | [InputDispatch, boolean])[] = []
  session.prepareSecretEntry({ begin: (field) => seen.push(field), end: (input, verified) => seen.push([input, verified]) })
  const filled = await session.dispatch({ kind: 'fill', locator: { by: 'testId', value: 'password-field' }, value: 'hunter-2-secret', secret: 'password' }, 5000)
  assert.ok(filled.result.ok, filled.result.ok ? '' : filled.result.failure.message)
  const [fill] = device.sent('interactions.fill')
  assert.equal(fill?.options['text'], 'hunter-2-secret')
  assert.equal(fill?.options['textStdin'], true)
  assert.deepEqual(seen, ['secure', ['sent', true]])
  assert.deepEqual(session.inputs.map((record) => [record.kind, record.readBack]), [['keys', 'length_matched']])
})

test('a secret is typed only into a screen of the app the config allows', async () => {
  const device = new StandIn(signInScreen())
  const { session } = await opened(device)
  device.app = 'com.example.other'
  const elsewhere = await session.dispatch({ kind: 'fill', locator: { by: 'testId', value: 'password-field' }, value: 'hunter-2-secret', secret: 'password' }, 400)
  assert.ok(!elsewhere.result.ok)
  assert.equal(device.sent('interactions.fill').length, 0)
  device.app = undefined
  const unnamed = await session.dispatch({ kind: 'fill', locator: { by: 'testId', value: 'password-field' }, value: 'hunter-2-secret', secret: 'password' }, 1000)
  assert.ok(!unnamed.result.ok)
  assert.equal(unnamed.result.failure.details?.['check'], 'destination')
  assert.match(unnamed.result.failure.message, /did not say which app/)
  assert.doesNotMatch(unnamed.result.failure.message, /hunter-2-secret/)
  assert.equal(device.sent('interactions.fill').length, 0)
})

test('on Android a secret is refused before anything is sent: agent-device types Android text through adb arguments', async () => {
  const device = new StandIn(signInScreen())
  const { session } = await opened(device, { platform: 'android', device: { platform: 'android', serial: 'emulator-5554' } })
  const before = device.calls.length
  const filled = await session.dispatch({ kind: 'fill', locator: { by: 'testId', value: 'password-field' }, value: 'hunter-2-secret', secret: 'password' }, 1000)
  assert.ok(!filled.result.ok && filled.result.failure.class === 'unsupported')
  assert.match(filled.result.failure.message, /process argument/)
  assert.equal(device.calls.length, before)
})

test('a plain fill whose field reads back other text fails, with the input sent and nothing typed again', async () => {
  const device = new StandIn(signInScreen())
  device.handlers.set('interactions.fill', (_options, standIn) => {
    standIn.update('account-field', { value: 'ad' })
    return answered()
  })
  const { session } = await opened(device)
  const filled = await session.dispatch({ kind: 'fill', locator: { by: 'testId', value: 'account-field' }, value: 'ada' }, 5000)
  assert.ok(!filled.result.ok)
  assert.equal(filled.input, 'sent')
  assert.equal(filled.result.failure.details?.['inputSent'], 'sent')
  assert.match(filled.result.failure.message, /reads back as "ad"/)
  assert.equal(device.sent('interactions.fill').length, 1)
})

test('a fill on an element that is not a field is refused unsent', async () => {
  const device = new StandIn(signInScreen())
  const { session } = await opened(device)
  const filled = await session.dispatch({ kind: 'fill', locator: { by: 'testId', value: 'sign-in-button' }, value: 'x' }, 5000)
  assert.ok(!filled.result.ok && filled.result.failure.class === 'unsupported')
  assert.equal(device.sent('interactions.fill').length, 0)
})

test('Enter goes to the focused field through the keyboard, a character is typed, and other keys are refused by name', async () => {
  const device = new StandIn(signInScreen())
  device.update('account-field', { focused: true })
  const { session } = await opened(device)
  const enter = await session.dispatch({ kind: 'press', locator: { by: 'testId', value: 'account-field' }, key: 'Enter' }, 5000)
  assert.ok(enter.result.ok, enter.result.ok ? '' : enter.result.failure.message)
  assert.equal(device.sent('command.keyboard')[0]?.options['action'], 'enter')
  const character = await session.dispatch({ kind: 'press', key: 'a' }, 5000)
  assert.ok(character.result.ok)
  assert.equal(device.sent('interactions.type')[0]?.options['text'], 'a')
  const tab = await session.dispatch({ kind: 'press', key: 'Tab' }, 5000)
  assert.ok(!tab.result.ok && tab.result.failure.class === 'unsupported')
  const button = await session.dispatch({ kind: 'press', locator: { by: 'testId', value: 'sign-in-button' }, key: 'Enter' }, 5000)
  assert.ok(!button.result.ok && button.result.failure.class === 'unsupported')
  assert.equal(device.sent('command.keyboard').length, 1)
})

test('a field without the focus is tapped once to take it before its key, and one that does not take it gets no key', async () => {
  const device = new StandIn(signInScreen())
  device.handlers.set('interactions.press', (_options, standIn) => {
    standIn.update('account-field', { focused: true })
    return answered()
  })
  const { session } = await opened(device)
  const pressed = await session.dispatch({ kind: 'press', locator: { by: 'testId', value: 'account-field' }, key: 'Enter' }, 5000)
  assert.ok(pressed.result.ok, pressed.result.ok ? '' : pressed.result.failure.message)
  assert.deepEqual(device.calls.filter((call) => call.method !== 'capture.snapshot' && call.method !== 'apps.open').map((call) => call.method), ['interactions.press', 'command.keyboard'])
  device.handlers.set('interactions.press', () => answered())
  device.update('account-field', { focused: false })
  const unfocused = await session.dispatch({ kind: 'press', locator: { by: 'testId', value: 'account-field' }, key: 'Enter' }, 5000)
  assert.ok(!unfocused.result.ok)
  assert.equal(unfocused.input, 'sent', 'the tap went')
  assert.equal(device.sent('command.keyboard').length, 1, 'no key without the focus')
})

test('a scroll is one gesture over the screen in one direction; an element, two axes or none are refused', async () => {
  const device = new StandIn(signInScreen())
  const { session } = await opened(device)
  const down = await session.dispatch({ kind: 'scroll', x: 0, y: 120 }, 5000)
  assert.ok(down.result.ok)
  const up = await session.dispatch({ kind: 'scroll', x: 0, y: -40 }, 5000)
  assert.ok(up.result.ok)
  assert.deepEqual(device.sent('interactions.scroll').map((call) => [call.options['direction'], call.options['pixels']]), [['down', 120], ['up', 40]])
  for (const command of [{ kind: 'scroll' as const, locator: { by: 'testId' as const, value: 'account-field' }, x: 0, y: 10 }, { kind: 'scroll' as const, x: 10, y: 10 }]) {
    const refusal = await session.dispatch(command, 5000)
    assert.ok(!refusal.result.ok && refusal.result.failure.class === 'unsupported')
  }
  const none = await session.dispatch({ kind: 'scroll', x: 0, y: 0 }, 5000)
  assert.ok(!none.result.ok && none.result.failure.class === 'usage')
  assert.equal(device.sent('interactions.scroll').length, 2)
  // A gesture agent-device saw move nothing went all the same: the content was at its end.
  device.handlers.set('interactions.scroll', () => ({ status: 'failed', code: 'COMMAND_FAILED', reason: 'scroll_no_progress', message: 'scroll down moved nothing', durationMs: 1 }))
  const atEnd = await session.dispatch({ kind: 'scroll', x: 0, y: 120 }, 5000)
  assert.ok(atEnd.result.ok)
  assert.equal(atEnd.input, 'sent')
  // Any other failure of the gesture keeps its unknown outcome.
  device.handlers.set('interactions.scroll', () => ({ status: 'failed', code: 'COMMAND_FAILED', reason: 'gesture_failed', message: 'the runner did not answer', durationMs: 1 }))
  const unknown = await session.dispatch({ kind: 'scroll', x: 0, y: 120 }, 5000)
  assert.ok(!unknown.result.ok && unknown.result.failure.class === 'outcome_unknown')
  assert.equal(session.unknownOutcomes.length, 1)
})

test('a swipe, the keyboard helpers, alerts and a click are refused by name and send nothing', async () => {
  const device = new StandIn(signInScreen())
  const { session } = await opened(device)
  const before = device.calls.length
  const swipe = await session.gesture({ kind: 'swipe', direction: 'up' }, 1000)
  assert.ok(!swipe.result.ok && swipe.result.failure.class === 'unsupported')
  const dismiss = await session.dismissKeyboard(1000)
  assert.ok(!dismiss.result.ok && dismiss.result.failure.class === 'unsupported')
  const wait = await session.waitForKeyboard(1000)
  assert.ok(!wait.ok && wait.failure.class === 'unsupported')
  const alert = await session.answerAlert({ button: 'Allow', route: 'accept' }, 1000)
  assert.ok(!alert.result.ok && alert.result.failure.class === 'unsupported')
  const click = await session.dispatch({ kind: 'click', locator: { by: 'testId', value: 'sign-in-button' } }, 1000)
  assert.ok(!click.result.ok && click.result.failure.class === 'unsupported')
  assert.equal(device.calls.length, before)
})

test('a look serves an observation of its own launch; a relaunch makes it stale, and a tree cut short or of another app is a look that saw nothing', async () => {
  const device = new StandIn(signInScreen())
  const { session } = await opened(device)
  const looked = await session.observe({ by: 'testId', value: 'account-field' }, 5000)
  assert.ok(looked.ok)
  assert.equal(looked.look.observation.count, 1)
  assert.equal(looked.look.observation.value, null, 'a value equal to the placeholder is not read either way')
  assert.equal(session.checkReference(looked.look.reference), undefined)
  const relaunched = await session.launch(5000)
  assert.ok(relaunched.result.ok)
  assert.equal(session.checkReference(looked.look.reference)?.class, 'not_actionable')
  device.truncated = true
  const cut = await session.observe({ by: 'testId', value: 'account-field' }, 1000)
  assert.ok(!cut.ok && cut.failure.details?.['check'] === 'tree')
  device.truncated = false
  device.app = 'com.apple.springboard'
  const other = await session.observe({ by: 'testId', value: 'account-field' }, 1000)
  assert.ok(!other.ok && other.failure.details?.['check'] === 'tree')
})

test("a launch whose outcome is unknown is kept as a lifecycle outcome, and a capture is the runtime's PNG with this session's reference", async () => {
  const device = new StandIn(signInScreen())
  const { session } = await opened(device)
  device.handlers.set('apps.open', () => ({ status: 'failed', code: 'COMMAND_FAILED', message: 'simctl launch did not answer', durationMs: 1 }))
  const launched = await session.launch(5000)
  assert.equal(launched.input, 'unknown')
  assert.deepEqual(session.unknownOutcomes.map((entry) => [entry.source, entry.outcome.kind]), [['lifecycle', 'launch']])
  const captured = await session.capture(5000)
  assert.ok(captured.ok)
  assert.deepEqual([captured.capture.source, captured.capture.width, captured.capture.height, captured.capture.reference.sessionId], ['simulator-display', 1, 1, 'attempt-1:phone'])
})

test('disposing closes the app through agent-device once, and the session then refuses every request', async () => {
  const device = new StandIn(signInScreen())
  const { session } = await opened(device)
  await session.dispose(5000)
  await session.dispose(5000)
  assert.deepEqual(device.sent('apps.close').map((call) => call.options['app']), [bundleId])
  const after = await session.dispatch({ kind: 'tap', locator: { by: 'testId', value: 'sign-in-button' } }, 1000)
  assert.ok(!after.result.ok && after.input === 'not_sent')
})

test('a message from agent-device is redacted before it reaches a failure', async () => {
  const device = new StandIn(signInScreen())
  device.handlers.set('interactions.press', () => refused('ambiguous_target hunter-2-secret', 'AMBIGUOUS_MATCH'))
  const { session } = await opened(device)
  const tapped = await session.dispatch({ kind: 'tap', locator: { by: 'testId', value: 'sign-in-button' } }, 5000)
  assert.ok(!tapped.result.ok)
  assert.equal(tapped.input, 'not_sent')
  assert.doesNotMatch(tapped.result.failure.message, /hunter-2-secret/)
  assert.match(tapped.result.failure.message, /\{\{password\}\}/)
})
