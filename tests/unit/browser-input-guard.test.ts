import type { ActionIntent } from '../../src/browser/element-queries.ts'
import type { GuardVerdict } from '../../src/browser/input-guard.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CdpTimeoutError } from '../../src/browser/cdp/errors.ts'
import { guardFailure, guardInput, keyFailure } from '../../src/browser/input-guard.ts'
import { IsolatedWorld } from '../../src/browser/isolated-world.ts'
import { disarmFunction, strayFunction, verdictFunction } from '../../src/browser/page-scripts.ts'
import { Deadline } from '../../src/protocol/deadline.ts'
import { protocolError, scriptedSession } from './browser-fixtures.ts'

const click: ActionIntent = { action: 'click', multiline: false }
const tap: ActionIntent = { action: 'tap', multiline: false }
const fill: ActionIntent = { action: 'fill', multiline: false }
const save = { by: 'testId', value: 'save' } as const
const cover = '<div data-testid="cover">'
const guard = { context: 7, token: 3 }
const goneContext = 'Execution context was destroyed.'

function seen(verdict: Partial<Extract<GuardVerdict, { kind: 'seen' }>>): GuardVerdict {
  return { kind: 'seen', reached: [], intercepted: null, landed: null, leaving: null, ...verdict }
}

function functionOf(params: unknown): unknown {
  return typeof params === 'object' && params !== null && 'functionDeclaration' in params ? params.functionDeclaration : undefined
}

test('a click whose press reached the element, with nothing taken by another, succeeds', () => {
  const verdict = seen({ reached: ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'], landed: '<button>' })
  assert.equal(guardFailure(verdict, click, save), undefined)
})

test('a click that another element took names it and the part of the click it took', () => {
  const cases = [
    ['pointerdown', `another element, ${cover}, was on top of it when Retest pressed. Retest stopped the click before the page received it.`],
    ['pointerup', `it took the press, but another element, ${cover}, took the release. Retest stopped the release and the click before the page received them.`],
    ['click', `it took the press and the release, but the click went to another element, ${cover}. Retest stopped the click before the page received it.`],
  ] as const
  for (const [event, reason] of cases) {
    const failure = guardFailure(seen({ reached: ['pointerdown'], intercepted: { event, by: cover } }), click, save)
    assert.deepEqual(failure, {
      class: 'not_actionable',
      message: `Could not click getByTestId('save'): ${reason}`,
      details: { check: 'hit-target', interceptedBy: cover, event },
    })
  }
})

test('a press that never reached the element document leaves the outcome unknown and names what is there', () => {
  assert.deepEqual(guardFailure(seen({ landed: '<iframe>' }), click, save), {
    class: 'outcome_unknown',
    message: `Retest pressed at the centre of getByTestId('save'), but the press never reached the element's document, and <iframe> is at that point. Retest cannot tell what received the click.`,
    details: { landed: '<iframe>' },
  })
  assert.match(guardFailure(seen({}), click, save)?.message ?? '', /and no element is at that point/)
})

test('a tap whose touch reached the element succeeds, even when the page cancelled the click it would make', () => {
  assert.equal(guardFailure(seen({ reached: ['pointerdown', 'touchstart', 'pointerup', 'touchend'] }), tap, save), undefined)
  assert.equal(guardFailure(seen({ reached: ['touchstart'] }), tap, save), undefined)
})

test('a tap that another element took names it and the part of the tap it took', () => {
  const cases = [
    ['pointerdown', `another element, ${cover}, was on top of it when Retest touched it. Retest stopped the tap before the page received it.`],
    ['touchstart', `another element, ${cover}, was on top of it when Retest touched it. Retest stopped the tap before the page received it.`],
    ['touchend', `it took the touch, but another element, ${cover}, took the release. Retest stopped the release and the click before the page received them.`],
    ['mousedown', `it took the touch, but the click that follows a tap went to another element, ${cover}. Retest stopped the click before the page received it.`],
    ['click', `it took the touch, but the click that follows a tap went to another element, ${cover}. Retest stopped the click before the page received it.`],
  ] as const
  for (const [event, reason] of cases) {
    const failure = guardFailure(seen({ reached: ['pointerdown'], intercepted: { event, by: cover } }), tap, save)
    assert.deepEqual(failure, {
      class: 'not_actionable',
      message: `Could not tap getByTestId('save'): ${reason}`,
      details: { check: 'hit-target', interceptedBy: cover, event },
    })
  }
})

test('a touch that never reached the element document leaves the outcome unknown and names what is there', () => {
  assert.deepEqual(guardFailure(seen({ landed: '<iframe>' }), tap, save), {
    class: 'outcome_unknown',
    message: `Retest touched the centre of getByTestId('save'), but the touch never reached the element's document, and <iframe> is at that point. Retest cannot tell what received the tap.`,
    details: { landed: '<iframe>' },
  })
})

test('typing that reached the field succeeds, even when the page itself cancelled the key', () => {
  assert.equal(guardFailure(seen({ reached: ['beforeinput', 'input'] }), fill, save), undefined)
  assert.equal(guardFailure(seen({ reached: ['keydown', 'keyup'] }), fill, save), undefined)
})

test('typing that another element took names where the focus went', () => {
  const failure = guardFailure(seen({ intercepted: { event: 'beforeinput', by: '<input id="other">' } }), fill, save)
  assert.deepEqual(failure, {
    class: 'not_actionable',
    message: `Could not fill getByTestId('save'): the keyboard focus moved to another element, <input id="other">, before Retest typed. Retest stopped the typing before the page received it.`,
    details: { check: 'focused', focus: '<input id="other">', event: 'beforeinput' },
  })
})

test('typing that never reached the field document leaves the outcome unknown and names the focus', () => {
  assert.deepEqual(guardFailure(seen({ landed: '<iframe>' }), fill, save), {
    class: 'outcome_unknown',
    message: `Retest typed into getByTestId('save'), but the text never reached the element's document, and the keyboard focus is on <iframe>. Retest cannot tell what received the text.`,
    details: { focus: '<iframe>' },
  })
})

test('typing held back from a page that set off for another document names that origin, and says nothing was typed', () => {
  const bound: ActionIntent = { ...fill, secret: 'password', allowedOrigins: ['http://127.0.0.1:4173'] }
  const verdict = seen({ landed: '<input>', leaving: 'https://evil.example' })
  assert.deepEqual(guardFailure(verdict, bound, save), {
    class: 'not_actionable',
    message:
      "Could not fill getByTestId('save') with {{password}}: the page started to open https://evil.example before Retest typed. Retest kept the page where it was and did not type {{password}}.",
    details: { origin: 'https://evil.example', leaving: true },
  })
  const opaque = guardFailure(seen({ leaving: 'null' }), { ...fill, allowedOrigins: [] }, save)
  assert.equal(
    opaque?.message,
    "Could not fill getByTestId('save') with the text: the page started to open a page with no web origin before Retest typed. Retest kept the page where it was and did not type the text.",
  )
  assert.deepEqual(opaque?.details, { origin: null, leaving: true })
})

test('input the page answered with a new document leaves the outcome unknown', () => {
  for (const intent of [click, tap, fill]) {
    assert.deepEqual(guardFailure({ kind: 'replaced' }, intent, save), {
      class: 'outcome_unknown',
      message: `The page moved to a new document while Retest tried to ${intent.action} getByTestId('save'), so Retest cannot tell whether the ${intent.action} took effect.`,
      details: { reason: 'the page moved to a new document' },
    })
  }
})

test('typing the new document stopped names that document and says nothing was typed, for a secret or plain text', () => {
  const stopped = { kind: 'stopped', event: 'beforeinput', by: '<input id="password">', origin: 'https://evil.example' } as const
  assert.deepEqual(guardFailure(stopped, { ...fill, secret: 'password', allowedOrigins: ['http://127.0.0.1:4173'] }, save), {
    class: 'not_actionable',
    message:
      "Could not fill getByTestId('save') with {{password}}: the page moved to https://evil.example before the text arrived. Retest stopped the typing before that document received it, and typed nothing.",
    details: { origin: 'https://evil.example', moved: true },
  })
  assert.match(guardFailure(stopped, fill, save)?.message ?? '', /^Could not fill getByTestId\('save'\) with the text: the page moved to https:\/\/evil\.example before/)
  const opaque = guardFailure({ ...stopped, origin: 'null' }, fill, save)
  assert.match(opaque?.message ?? '', /the page moved to a page with no web origin before the text arrived/)
  assert.deepEqual(opaque?.details, { origin: null, moved: true })
  // A press has no typing to stop; a new document with stray typing from before still leaves a press unknown.
  assert.equal(guardFailure(stopped, click, save)?.class, 'outcome_unknown')
})

test('the verdict is asked for before the input goes and settled by disarming after it, all in the guard document', async () => {
  const order: string[] = []
  const settled = Promise.withResolvers<unknown>()
  const { session, sent } = scriptedSession(async (method, params) => {
    const call = functionOf(params)
    if (call === verdictFunction) {
      order.push('verdict asked')
      return settled.promise
    }
    if (call === disarmFunction) {
      order.push('disarmed')
      settled.resolve({ result: { value: { reached: ['pointerdown', 'click'], intercepted: null, landed: '<button>', leaving: null } } })
      return { result: { value: true } }
    }
    throw new Error(`unexpected ${method}`)
  })
  const verdict = await guardInput(new IsolatedWorld(session, () => 'F1'), guard, new Deadline(1000), async () => {
    order.push('input')
  })
  assert.deepEqual(order, ['verdict asked', 'input', 'disarmed'])
  assert.deepEqual(verdict, { kind: 'seen', reached: ['pointerdown', 'click'], intercepted: null, landed: '<button>', leaving: null })
  for (const command of sent) {
    assert.ok(typeof command.params === 'object' && command.params !== null && 'executionContextId' in command.params)
    assert.equal(command.params.executionContextId, guard.context)
  }
})

// The document that replaced the guard's is asked whether it stopped typing meant for the one before it.
function replacedBy(stray: unknown) {
  const contexts: number[] = []
  const { session, sent } = scriptedSession(async (method, params) => {
    if (method === 'Page.createIsolatedWorld') return { executionContextId: 9 }
    if (functionOf(params) === strayFunction) {
      if (typeof params === 'object' && params !== null && 'executionContextId' in params) contexts.push(Number(params.executionContextId))
      return { result: { value: stray } }
    }
    throw protocolError('Runtime.callFunctionOn', goneContext)
  })
  return { session, sent, contexts }
}

test('a document that went away before the guard was done makes the verdict replaced, once the new document reports no stray typing', async () => {
  const { session, contexts } = replacedBy(null)
  const verdict = await guardInput(new IsolatedWorld(session, () => 'F1'), guard, new Deadline(1000), async () => {})
  assert.deepEqual(verdict, { kind: 'replaced' })
  assert.deepEqual(contexts, [9], 'the new document was asked, in its own world')
})

test('a new document that stopped typing meant for the old one makes the verdict stopped, naming the document', async () => {
  const stray = { event: 'beforeinput', by: '<input autofocus>', origin: 'https://evil.example' }
  const { session } = replacedBy(stray)
  const verdict = await guardInput(new IsolatedWorld(session, () => 'F1'), guard, new Deadline(1000), async () => {})
  assert.deepEqual(verdict, { kind: 'stopped', ...stray })
})

test('input that fails ends the guard there, with the input failure and no disarm', async () => {
  const { session, sent } = scriptedSession(() => new Promise(() => {}))
  const failure = new CdpTimeoutError({ method: 'Input.dispatchMouseEvent', sessionId: 'S1' }, { timeoutMs: 50, written: true })
  const guarding = guardInput(new IsolatedWorld(session, () => 'F1'), guard, new Deadline(50), async () => {
    throw failure
  })
  await assert.rejects(guarding, (error) => error === failure)
  assert.deepEqual(
    sent.map((command) => functionOf(command.params)),
    [verdictFunction],
  )
})

test('a disarm the page does not answer fails the action with that timeout', async () => {
  const { session } = scriptedSession(() => new Promise(() => {}))
  const guarding = guardInput(new IsolatedWorld(session, () => 'F1'), guard, new Deadline(50), async () => {})
  await assert.rejects(guarding, CdpTimeoutError)
})

const search = { by: 'label', text: 'Search' } as const
const press: ActionIntent = { action: 'press', key: 'Enter', multiline: false }

test('a key whose keydown reached the element succeeds, whatever the rest of the keystroke did, and even when the page cancelled it', () => {
  assert.equal(keyFailure(seen({ reached: ['keydown'], landed: '<input id="next">' }), 'Enter', search), undefined)
  assert.equal(keyFailure(seen({ reached: ['keydown'] }), 'Tab', undefined), undefined)
  assert.equal(guardFailure(seen({ reached: ['keydown'] }), press, search), undefined, 'guardFailure hands a press to keyFailure')
})

test('a keydown another element took names it, and says the key was stopped before the page received it', () => {
  const failure = keyFailure(seen({ intercepted: { event: 'keydown', by: '<div data-testid="dialog">' } }), 'Enter', search)
  assert.deepEqual(failure, {
    class: 'not_actionable',
    message: `Could not press Enter on getByLabel('Search'): the keyboard focus moved to another element, <div data-testid="dialog">, before the key arrived. Retest stopped the key before the page received it.`,
    details: { check: 'focused', focus: '<div data-testid="dialog">', event: 'keydown' },
  })
  assert.deepEqual(guardFailure(seen({ intercepted: { event: 'keydown', by: '<div>' } }), press, search)?.class, 'not_actionable')
})

test('a key that never reached the document leaves the outcome unknown and names where the focus is', () => {
  assert.deepEqual(keyFailure(seen({ landed: '<iframe data-testid="frame">' }), 'a', undefined), {
    class: 'outcome_unknown',
    message: `Retest pressed a, but the key never reached the page's document, and the keyboard focus is on <iframe data-testid="frame">. Retest cannot tell what received the key.`,
    details: { focus: '<iframe data-testid="frame">' },
  })
  assert.deepEqual(keyFailure(seen({}), 'Shift+Tab', search)?.message, `Retest pressed Shift+Tab on getByLabel('Search'), but the key never reached the element's document, and the keyboard focus is on no element. Retest cannot tell what received the key.`)
})

test('a key whose document was replaced first leaves the outcome unknown, for a locator and for the keyboard', () => {
  const stopped = { kind: 'stopped', event: 'keydown', by: '<input>', origin: 'https://evil.example' } as const
  for (const verdict of [{ kind: 'replaced' } as const, stopped]) {
    assert.deepEqual(keyFailure(verdict, 'Enter', search), {
      class: 'outcome_unknown',
      message: `The page moved to a new document while Retest pressed Enter on getByLabel('Search'), so Retest cannot tell whether the key took effect.`,
      details: { reason: 'the page moved to a new document' },
    })
    assert.match(keyFailure(verdict, 'Enter', undefined)?.message ?? '', /^The page moved to a new document while Retest pressed Enter, so/)
  }
})

test('a long key is cut short in a message', () => {
  const key = 'k'.repeat(300)
  const message = keyFailure({ kind: 'replaced' }, key, undefined)?.message ?? ''
  assert.ok(message.length < 300 + 100 && message.includes('k'.repeat(200) + '…'), message)
})
