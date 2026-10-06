import type { TestContext } from 'node:test'
import type { AppPage } from '../../src/api/app-page.ts'
import type { Verdict } from '../../src/api/test-run.ts'
import type { EventBody } from '../../src/protocol/events.ts'
import type { BodyReport } from '../../src/runner/running-test.ts'
import type { InProcessRun, Responder } from '../support/api/in-process-run.ts'
import type { FakeElement, FakeInteraction } from './native-interaction-fake.ts'
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { expect } from '../../src/index.ts'
import { retestEventSchema } from '../../src/protocol/events.ts'
import { parse } from '../../src/protocol/schema.ts'
import { NativePageAdapter } from '../../src/runner/native-pool.ts'
import { RunningTest } from '../../src/runner/running-test.ts'
import { callLoosely } from '../support/api/call-loosely.ts'
import { appOf, inProcessRun, pageWithText } from '../support/api/in-process-run.ts'
import { quickTimeouts } from '../support/run-harness.ts'
import { ScriptedProcess, scriptedTest } from '../support/scripted-process.ts'
import { deskSignIn, openFake, phoneSignIn } from './native-interaction-fake.ts'

// The public helpers of a native app's handle: `locator(step)`, `swipe`, the software keyboard's controls and the alert
// answers. Each is checked twice: as the command the test file's process sends, and through the parent to a stand-in
// executor, as the parent routes it to the native interaction layer.

const file = 'tests/unit/api-native-helpers.test.ts'
const page = pageWithText('Release checklist')
const budgets = { ...quickTimeouts, action: 3000, assertion: 3000, test: 10_000 }
const click = 'POST /session/:session/element/:element/click'
const elements = 'POST /session/:session/elements'
const actions = 'POST /session/:session/actions'

/** The commands a test body sent, in order. */
async function sentBy(body: (handle: AppPage) => unknown): Promise<{ verdict: Verdict; run: InProcessRun }> {
  const run = inProcessRun(file, page)
  const verdict = await run.runPage(({ page: handle }) => body(handle))
  return { verdict, run }
}

describe('the commands a native helper sends', () => {
  test('locator(step) sends the recipe of the finder the step names, scoped and picked as the finders would', async () => {
    const { verdict, run } = await sentBy(async (handle) => {
      await handle.locator({ by: 'testId', value: 'task-title' }).fill('Release checklist')
      await handle.locator({ by: 'role', role: 'button', name: /save/i, pick: 'last' }).tap()
      await handle.getByTestId('tasks').locator({ by: 'text', text: 'Open', exact: false, pick: 1 }).tap()
      await handle.locator({ by: 'label', text: 'Title', pick: 'first' }).press('Enter')
      await handle.locator({ by: 'role', role: 'button', name: 'Save' }).tap()
      await handle.getByRole('button', { name: 'Save' }).tap()
      await handle.locator('.task').click()
      expect(1).toBe(1)
    })
    assert.equal(verdict.status, 'passed', verdict.failure?.message)
    assert.deepEqual(run.commands, [
      { kind: 'fill', locator: { by: 'testId', value: 'task-title' }, value: 'Release checklist' },
      { kind: 'tap', locator: { by: 'role', role: 'button', name: { pattern: 'save', flags: 'i' }, pick: 'last' } },
      { kind: 'tap', locator: { by: 'text', text: 'Open', exact: false, pick: 1, within: [{ by: 'testId', value: 'tasks' }] } },
      { kind: 'press', locator: { by: 'label', text: 'Title', pick: 'first' }, key: 'Enter' },
      { kind: 'tap', locator: { by: 'role', role: 'button', name: 'Save' } },
      { kind: 'tap', locator: { by: 'role', role: 'button', name: 'Save' } },
      { kind: 'click', locator: { by: 'css', selector: '.task' } },
    ])
  })

  // Each is a step the test process refuses before it sends anything: [what, the step, the message].
  const refusals: [string, unknown, string | RegExp][] = [
    ['a CSS step', { by: 'css', selector: '.task' }, "locator() takes a CSS selector, or on a native app a step by testId, role, label or text, received { by: 'css', selector: '.task' }."],
    ['a placeholder step', { by: 'placeholder', text: 'Title' }, "locator() takes a CSS selector, or on a native app a step by testId, role, label or text, received { by: 'placeholder', text: 'Title' }."],
    ['a step by nothing it knows', { by: 'xpath', value: '//button' }, "locator() takes a CSS selector, or on a native app a step by testId, role, label or text, received { by: 'xpath', value: '//button' }."],
    ['a key its finder does not take', { by: 'testId', value: 'task-title', name: 'Title' }, "A locator step by testId takes only value and pick, received { by: 'testId', value: 'task-title', name: 'Title' }."],
    ['a role that is not one', { by: 'role', role: 'buton' }, "getByRole() takes an ARIA role such as 'button', received 'buton'."],
    ['text of spaces', { by: 'text', text: '  ' }, "getByText() takes the text to find, or a RegExp, received '  '."],
    ['exact beside a pattern', { by: 'label', text: /Title/, exact: true }, /^getByLabel\(\) takes exact only with text/],
    ['a pick that is not one', { by: 'testId', value: 'task-title', pick: 'middle' }, "A locator step's pick is 'first', 'last' or an index from 0, received 'middle'."],
    ['an index that is not whole', { by: 'testId', value: 'task-title', pick: 1.5 }, /^nth\(\) takes a whole number/],
    ['a value that is not a step', 42, 'locator() takes a CSS selector as a string, received 42.'],
  ]
  for (const [what, step, message] of refusals) {
    test(`${what} is refused at the call and never sent`, async () => {
      const { verdict, run } = await sentBy((handle) => callLoosely(handle, 'locator', [step]))
      assert.deepEqual(run.commands, [])
      assert.equal(verdict.failure?.class, 'usage')
      if (typeof message === 'string') assert.equal(verdict.failure?.message, message)
      else assert.match(verdict.failure?.message ?? '', message)
      assert.equal(verdict.failure?.location?.file, 'tests/support/api/call-loosely.ts', 'located at the call that made it')
    })
  }

  test('a step that picked a match takes no second pick, as first() after nth() does not', async () => {
    const { verdict, run } = await sentBy((handle) => handle.locator({ by: 'testId', value: 'task-row', pick: 0 }).first())
    assert.deepEqual(run.commands, [])
    assert.equal(verdict.failure?.class, 'usage')
    assert.match(verdict.failure?.message ?? '', /^first\(\) chooses from a locator's matches, and this locator has chosen one already/)
  })

  test('swipe() sends its direction, on the page or on a locator, within the call timeout', async () => {
    const { verdict, run } = await sentBy(async (handle) => {
      await handle.swipe('up')
      await handle.getByTestId('task-list').swipe('left', { timeout: 1200 })
      await handle.locator({ by: 'role', role: 'list' }).swipe('down')
      await handle.swipe('right')
      expect(1).toBe(1)
    })
    assert.equal(verdict.status, 'passed', verdict.failure?.message)
    const sent = run.messages.flatMap((message) => (message.type === 'command' ? [message] : []))
    assert.deepEqual(
      sent.map(({ command, timeoutMs, callTimeoutMs }) => [command, timeoutMs, callTimeoutMs]),
      [
        [{ kind: 'swipe', direction: 'up' }, 500, undefined],
        [{ kind: 'swipe', locator: { by: 'testId', value: 'task-list' }, direction: 'left' }, 500, 1200],
        [{ kind: 'swipe', locator: { by: 'role', role: 'list' }, direction: 'down' }, 500, undefined],
        [{ kind: 'swipe', direction: 'right' }, 500, undefined],
      ],
    )
  })

  for (const direction of ['sideways', 'UP', undefined, 3]) {
    test(`swipe(${JSON.stringify(direction) ?? 'undefined'}) is refused at the call and never sent`, async () => {
      const { verdict, run } = await sentBy((handle) => callLoosely(handle, 'swipe', [direction]))
      assert.deepEqual(run.commands, [])
      assert.equal(verdict.failure?.class, 'usage')
      assert.match(verdict.failure?.message ?? '', /^swipe\(\) takes 'up', 'down', 'left' or 'right', received /)
    })
  }

  test('the keyboard waits for and dismisses the software keyboard and its first-run card, each one command', async () => {
    const { verdict, run } = await sentBy(async (handle) => {
      await handle.keyboard.wait()
      await handle.keyboard.dismissFirstRunCard()
      await handle.keyboard.dismiss({ timeout: 1500 })
      await handle.keyboard.press('Enter')
      expect(1).toBe(1)
    })
    assert.equal(verdict.status, 'passed', verdict.failure?.message)
    const sent = run.messages.flatMap((message) => (message.type === 'command' ? [message] : []))
    assert.deepEqual(
      sent.map(({ command, timeoutMs }) => [command, timeoutMs]),
      [
        [{ kind: 'nativeKeyboard', operation: 'wait' }, 500],
        [{ kind: 'nativeKeyboard', operation: 'dismissFirstRunCard' }, 500],
        [{ kind: 'nativeKeyboard', operation: 'dismiss' }, 500],
        [{ kind: 'press', key: 'Enter' }, 500],
      ],
    )
    assert.equal(sent[2]?.callTimeoutMs, 1500)
  })

  test('an alert is answered by the exact label of one button, through accept or dismiss', async () => {
    const { verdict, run } = await sentBy(async (handle) => {
      await handle.alert.accept('Allow')
      await handle.alert.dismiss("Don't Allow", { timeout: 900 })
      expect(1).toBe(1)
    })
    assert.equal(verdict.status, 'passed', verdict.failure?.message)
    assert.deepEqual(run.commands, [
      { kind: 'nativeAlert', operation: 'accept', button: 'Allow' },
      { kind: 'nativeAlert', operation: 'dismiss', button: "Don't Allow" },
    ])
  })

  for (const [operation, button] of [['accept', ''], ['accept', '   '], ['dismiss', undefined], ['dismiss', 7]] as const) {
    test(`alert.${operation}(${JSON.stringify(button) ?? 'undefined'}) names no button, so it is refused at the call and never sent`, async () => {
      const { verdict, run } = await sentBy((handle) => callLoosely(handle.alert, operation, [button]))
      assert.deepEqual(run.commands, [])
      assert.equal(verdict.failure?.class, 'usage')
      assert.match(verdict.failure?.message ?? '', new RegExp(`^alert\\.${operation}\\(\\) takes the label of the button to press, word for word, received `))
    })
  }

  // Options other than a timeout are refused under the call's own name: [the call, its owner, the method, the arguments].
  const optionRefusals: [string, (handle: AppPage) => unknown, string, readonly unknown[]][] = [
    ['swipe', (handle) => handle, 'swipe', ['up', { force: true }]],
    ['keyboard.wait', (handle) => handle.keyboard, 'wait', [{ force: true }]],
    ['keyboard.dismiss', (handle) => handle.keyboard, 'dismiss', [{ force: true }]],
    ['keyboard.dismissFirstRunCard', (handle) => handle.keyboard, 'dismissFirstRunCard', [{ force: true }]],
    ['alert.accept', (handle) => handle.alert, 'accept', ['Allow', { force: true }]],
    ['alert.dismiss', (handle) => handle.alert, 'dismiss', ['Not Now', { force: true }]],
    ['keyboard.press', (handle) => handle.keyboard, 'press', ['Enter', { force: true }]],
  ]
  for (const [call, on, method, args] of optionRefusals) {
    test(`${call}() with an option other than timeout is refused under its own name before anything is sent`, async () => {
      const { verdict, run } = await sentBy((handle) => callLoosely(on(handle), method, args))
      assert.deepEqual(run.commands, [])
      assert.equal(verdict.failure?.class, 'usage')
      assert.equal(verdict.failure?.message, `Unknown ${call}() option "force". Its only option is timeout.`)
    })
  }

  // A timeout outside its range: [the call, its owner, the method, the arguments].
  const timeoutRefusals: [string, (handle: AppPage) => unknown, string, readonly unknown[]][] = [
    ['keyboard.dismiss', (handle) => handle.keyboard, 'dismiss', [{ timeout: 0 }]],
    ['alert.accept', (handle) => handle.alert, 'accept', ['Allow', { timeout: 1.5 }]],
  ]
  for (const [call, on, method, args] of timeoutRefusals) {
    test(`${call}() with a timeout out of range names the call before anything is sent`, async () => {
      const { verdict, run } = await sentBy((handle) => callLoosely(on(handle), method, args))
      assert.deepEqual(run.commands, [])
      assert.equal(verdict.failure?.class, 'usage')
      assert.match(verdict.failure?.message ?? '', new RegExp(`^The timeout option of ${call.replace('.', '\\.')}\\(\\) must be a whole number of milliseconds from 1 to \\d+, received `))
    })
  }
})

type NativeHarness = { fake: FakeInteraction; events: EventBody[]; run: InProcessRun; app: string; finish: () => Promise<BodyReport> }

/**
 * A test on a native app whose commands cross to a parent, as the IPC messages the test file's process sends, and go
 * from the parent's `RunningTest` through `NativePageAdapter` to the interaction layer on a stand-in executor.
 */
async function nativeHarness(t: TestContext, platform: 'ios-simulator' | 'macos', screen: () => FakeElement[]): Promise<NativeHarness> {
  const fake = await openFake(t, { platform, screen })
  const app = platform === 'macos' ? 'desk' : 'phone'
  const testId = `${file} > in process`
  const attemptId = 'attempt-1'
  const child = new ScriptedProcess()
  const events: EventBody[] = []
  const running = new RunningTest({ process: child, pages: new Map([[app, new NativePageAdapter(fake.interaction)]]), testId, attemptId, timeouts: budgets, emit: (event) => events.push(event) })
  const report = running.run()
  // The message the test process wrote for this command is the one the parent receives, location and timeouts included.
  const respond: Responder = (command) => {
    const message = run.messages.findLast((each) => each.type === 'command' && each.command === command)
    if (message?.type !== 'command') throw new Error('the command has no message')
    child.deliver(message)
    return child.answer(message.id)
  }
  const run = inProcessRun(file, respond, { apps: [app], timeouts: budgets })
  const finish = async (): Promise<BodyReport> => {
    child.deliver({ type: 'test-finished', testId, attemptId, status: 'passed', assertionCount: 0, durationMs: 0 })
    const ended = await report
    await running.settle(1000)
    running.close()
    for (const [index, event] of events.entries()) {
      const stamped = { schemaVersion: 1, runId: 'run', sequence: index, time: '2026-10-04T09:00:00.000Z', elapsedMs: 1, origin: 'parent', ...event }
      const parsed = parse(retestEventSchema, stamped)
      assert.ok(parsed.ok, parsed.ok ? '' : `${event.type}: ${JSON.stringify(parsed.issues)}`)
    }
    return ended
  }
  return { fake, events, run, app, finish }
}

function actionsOf(events: readonly EventBody[]): [string, string, string | undefined][] {
  return events.flatMap((event) => (event.type === 'action.completed' || event.type === 'action.failed' ? [[event.type, event.command, event.type === 'action.failed' ? event.failure.class : undefined]] : []))
}

function deleteAlert(platform: 'ios-simulator' | 'macos'): FakeElement {
  const y = platform === 'macos' ? 100 : 300
  return { type: platform === 'macos' ? 'Sheet' : 'Alert', frame: { x: 40, y, width: 300, height: 160 }, children: [
    { type: 'StaticText', label: 'Delete this task?', value: 'Delete this task?', frame: { x: 60, y: y + 20, width: 260, height: 20 } },
    { type: 'Button', label: 'Cancel', frame: { x: 60, y: y + 100, width: 100, height: 40 } },
    { type: 'Button', label: 'Delete', frame: { x: 200, y: y + 100, width: 100, height: 40 } },
  ] }
}

const taskList: FakeElement = { type: 'CollectionView', identifier: 'task-list', frame: { x: 0, y: 420, width: 402, height: 300 } }

describe('the parent routes each native helper to the native interaction layer', () => {
  test('on iOS, a locator step taps the element its finder names, and a swipe is one touch drag on the app or the element', async (t) => {
    const { fake, events, run, app, finish } = await nativeHarness(t, 'ios-simulator', () => [...phoneSignIn(), { ...taskList }])
    const verdict = await run.runTest({
      apps: [app],
      body: async (context) => {
        const phone = appOf(context, app)
        await phone.locator({ by: 'role', role: 'button', name: 'Sign in' }).tap()
        await phone.swipe('up')
        await phone.locator({ by: 'testId', value: 'task-list' }).swipe('left')
        expect(fake.app.on(actions).length).toBe(2)
      },
    })
    assert.equal(verdict.status, 'passed', verdict.failure?.message)
    assert.equal(fake.app.on(click).length, 1)
    // The role step found the Sign in button in the tree, and the executor resolved that element by its identifier.
    assert.deepEqual(fake.app.on(elements).map((request) => JSON.parse(request.body).value)[0], 'type == "XCUIElementTypeButton" AND name == "sign-in-button" AND label == "Sign in"')
    const drags = fake.app.on(actions).map((request) => JSON.parse(request.body).actions[0].actions.map((step: { x?: number; y?: number }) => [step.x, step.y]))
    assert.deepEqual(drags, [
      // From the centre of the app's 402 by 874 screen, a third of its height up.
      [[201, 437], [undefined, undefined], [201, 146], [undefined, undefined]],
      // From the centre of the list, a third of its width to the left.
      [[201, 570], [undefined, undefined], [67, 570], [undefined, undefined]],
    ])
    assert.deepEqual((await finish()).observed ?? [], [])
    assert.deepEqual(actionsOf(events), [
      ['action.completed', 'tap', undefined],
      ['action.completed', 'swipe', undefined],
      ['action.completed', 'swipe', undefined],
    ])
  })

  test('on iOS, the keyboard is waited for, its first-run card pressed away, and the keyboard dismissed by its return key', async (t) => {
    const { fake, events, run, app, finish } = await nativeHarness(t, 'ios-simulator', phoneSignIn)
    fake.app.firstRunCard = true
    fake.app.find('account-field').returnDismisses = true
    const clicksAt: number[] = []
    const queries: string[] = []
    const verdict = await run.runTest({
      apps: [app],
      body: async (context) => {
        const phone = appOf(context, app)
        await phone.locator({ by: 'testId', value: 'account-field' }).tap()
        clicksAt.push(fake.app.on(click).length)
        await phone.keyboard.wait()
        clicksAt.push(fake.app.on(click).length)
        await phone.keyboard.dismissFirstRunCard()
        clicksAt.push(fake.app.on(click).length)
        queries.push(JSON.parse(fake.app.on(elements).at(-1)?.body ?? '{}').value)
        await phone.keyboard.dismiss()
        clicksAt.push(fake.app.on(click).length)
        queries.push(JSON.parse(fake.app.on(elements).at(-1)?.body ?? '{}').value)
        expect(fake.app.keyboardShown).toBe(false)
      },
    })
    assert.equal(verdict.status, 'passed', verdict.failure?.message)
    assert.deepEqual(clicksAt, [1, 1, 2, 3], 'the wait pressed nothing, and each dismissal pressed once')
    assert.deepEqual(queries, ['type == "XCUIElementTypeButton" AND label == "Continue"', 'type == "XCUIElementTypeButton" AND name == "Return" AND label == "done"'])
    assert.equal(fake.app.keyboardShown, false)
    assert.deepEqual((await finish()).observed ?? [], [])
    assert.deepEqual(actionsOf(events), [
      ['action.completed', 'tap', undefined],
      ['action.completed', 'nativeKeyboard', undefined],
      ['action.completed', 'nativeKeyboard', undefined],
      ['action.completed', 'nativeKeyboard', undefined],
    ])
  })

  test("on iOS, an alert in the app's tree is accepted and a system alert dismissed, each through its route with the one named button", async (t) => {
    const { fake, events, run, app, finish } = await nativeHarness(t, 'ios-simulator', phoneSignIn)
    fake.app.alert = deleteAlert('ios-simulator')
    const verdict = await run.runTest({
      apps: [app],
      body: async (context) => {
        const phone = appOf(context, app)
        await phone.alert.accept('Delete')
        fake.app.systemAlert = { text: 'Allow notifications?', buttons: ["Don't Allow", 'Allow'] }
        await phone.alert.dismiss("Don't Allow")
        expect(fake.app.on('POST /session/:session/alert/dismiss').length).toBe(1)
      },
    })
    assert.equal(verdict.status, 'passed', verdict.failure?.message)
    assert.deepEqual(fake.app.on('POST /session/:session/alert/accept').map((request) => request.body), ['{"name":"Delete"}'])
    assert.deepEqual(fake.app.on('POST /session/:session/alert/dismiss').map((request) => request.body), ['{"name":"Don\'t Allow"}'])
    assert.equal(fake.app.alert, undefined)
    assert.equal(fake.app.systemAlert, undefined)
    assert.deepEqual((await finish()).observed ?? [], [])
    assert.deepEqual(actionsOf(events), [
      ['action.completed', 'nativeAlert', undefined],
      ['action.completed', 'nativeAlert', undefined],
    ])
  })

  test('on iOS, an alert answer whose button is not on the alert presses nothing and fails the test', async (t) => {
    const { fake, events, run, app, finish } = await nativeHarness(t, 'ios-simulator', phoneSignIn)
    fake.app.alert = deleteAlert('ios-simulator')
    const verdict = await run.runTest({ apps: [app], body: (context) => appOf(context, app).alert.accept('Archive') })
    assert.equal(verdict.status, 'failed')
    assert.equal(verdict.failure?.class, 'not_found')
    assert.equal(fake.app.requests.some((request) => request.route.includes('/alert/accept') || request.route.includes('/alert/dismiss')), false)
    assert.deepEqual((await finish()).observed?.map((problem) => problem.class), ['not_found'])
    assert.deepEqual(actionsOf(events), [['action.failed', 'nativeAlert', 'not_found']])
  })

  test("on macOS, a sheet's named button is clicked once inside the sheet, and a locator step clicks what its finder names", async (t) => {
    const { fake, events, run, app, finish } = await nativeHarness(t, 'macos', deskSignIn)
    const sheet = deleteAlert('macos')
    const remove = sheet.children?.[2]
    if (remove !== undefined) remove.onClick = (stand) => { stand.alert = undefined }
    fake.app.alert = sheet
    const queries: string[] = []
    const verdict = await run.runTest({
      apps: [app],
      body: async (context) => {
        const desk = appOf(context, app)
        await desk.alert.accept('Delete')
        expect(fake.app.alert).toBe(undefined)
        queries.push(JSON.parse(fake.app.on('POST /session/:session/element/:element/elements').at(-1)?.body ?? '{}').value)
        await desk.locator({ by: 'testId', value: 'sign-in-button' }).click()
      },
    })
    assert.equal(verdict.status, 'passed', verdict.failure?.message)
    assert.deepEqual(queries, ['elementType == 9 AND label == "Delete"'])
    assert.equal(fake.app.on(click).length, 2)
    assert.equal(fake.app.requests.some((request) => request.route.includes('/alert/')), false, "the macOS runner's alert routes are never used")
    assert.deepEqual((await finish()).observed ?? [], [])
    assert.deepEqual(actionsOf(events), [
      ['action.completed', 'nativeAlert', undefined],
      ['action.completed', 'click', undefined],
    ])
  })

  // What a macOS app refuses though a JavaScript caller can send it: [the call, the message].
  const deskRefusals: [string, (desk: AppPage) => Promise<void>, string][] = [
    ['swipe', (desk) => desk.swipe('up'), 'A macOS app takes no swipe in Retest. Scroll it instead.'],
    ['keyboard.wait', (desk) => desk.keyboard.wait(), 'A macOS app has no software keyboard.'],
    ['keyboard.dismiss', (desk) => desk.keyboard.dismiss(), 'A macOS app has no software keyboard.'],
  ]
  for (const [call, act, message] of deskRefusals) {
    test(`on macOS, ${call}() is refused as unsupported and sends no input`, async (t) => {
      const { fake, events, run, app, finish } = await nativeHarness(t, 'macos', deskSignIn)
      const verdict = await run.runTest({ apps: [app], body: (context) => act(appOf(context, app)) })
      assert.equal(verdict.status, 'failed')
      assert.equal(verdict.failure?.class, 'unsupported')
      assert.equal(verdict.failure?.message, message)
      assert.deepEqual(fake.app.on(actions), [])
      assert.deepEqual(fake.app.on(click), [])
      assert.deepEqual((await finish()).observed?.map((problem) => problem.class), ['unsupported'])
      assert.equal(actionsOf(events).length, 1)
    })
  }

  test('a web page refuses each native command by name, and the page receives none of them', async () => {
    const scripted = await scriptedTest()
    const commands = [
      { kind: 'swipe', direction: 'up' },
      { kind: 'nativeKeyboard', operation: 'dismiss' },
      { kind: 'nativeAlert', operation: 'accept', button: 'OK' },
    ] as const
    for (const [index, command] of commands.entries()) {
      const answer = await scripted.command(index + 1, command)
      assert.deepEqual(answer, { ok: false, failure: { class: 'unsupported', message: `${command.kind} needs a native app session.` } })
    }
    assert.deepEqual(scripted.page.commandTokens, [])
    assert.deepEqual((await scripted.finish()).observed?.map((problem) => problem.class), ['unsupported', 'unsupported', 'unsupported'])
  })
})
