import type { ActionIntent } from '../../src/browser/element-queries.ts'
import type { GuardVerdict } from '../../src/browser/input-guard.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CdpAbortedError, CdpInvalidResponseError, CdpTimeoutError } from '../../src/browser/cdp/errors.ts'
import { guardFailure, guardInput, hoverFailure, keyFailure, selectKeyFailure, wheelFailure } from '../../src/browser/input-guard.ts'
import { IsolatedWorld } from '../../src/browser/isolated-world.ts'
import { disarmFunction, registrationFunction, strayFunction, verdictFunction } from '../../src/browser/page-scripts.ts'
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
    if (call === registrationFunction) {
      order.push('registered')
      return { result: { value: true } }
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
  assert.deepEqual(order, ['verdict asked', 'registered', 'input', 'disarmed'])
  assert.deepEqual(verdict, { kind: 'seen', reached: ['pointerdown', 'click'], intercepted: null, landed: '<button>', leaving: null })
  for (const command of sent) {
    assert.ok(typeof command.params === 'object' && command.params !== null && 'executionContextId' in command.params)
    assert.equal(command.params.executionContextId, guard.context)
  }
})

test('input waits for the matching verdict request to register, even when the first marker read reaches the browser first', async () => {
  const requested = Promise.withResolvers<void>()
  const ready = Promise.withResolvers<unknown>()
  let reads = 0
  let inputs = 0
  const { session, sent } = scriptedSession(async (_method, params) => {
    const call = functionOf(params)
    if (call === verdictFunction) return { result: { value: { reached: ['beforeinput', 'input'], intercepted: null, landed: '<input>', leaving: null } } }
    if (call === registrationFunction) {
      reads += 1
      if (reads === 1) return { result: { value: false } }
      requested.resolve()
      return ready.promise
    }
    if (call === disarmFunction) return { result: { value: true } }
    throw new Error('unexpected call')
  })
  const filling = guardInput(new IsolatedWorld(session, () => 'F1'), guard, new Deadline(1000), async () => { inputs += 1 })
  await requested.promise
  assert.equal(inputs, 0, 'neither a false marker nor a pending read lets input go')
  ready.resolve({ result: { value: true } })
  assert.equal((await filling).kind, 'seen')
  assert.equal(inputs, 1)
  assert.deepEqual(sent.map(({ params }) => functionOf(params)), [verdictFunction, registrationFunction, registrationFunction, disarmFunction])
  for (const { params } of sent) {
    assert.ok(typeof params === 'object' && params !== null && 'executionContextId' in params && 'arguments' in params)
    assert.equal(params.executionContextId, guard.context)
    assert.deepEqual(params.arguments, [{ value: guard.token }])
  }
})

test('a matching acknowledgement that arrives after the action deadline sends no input', async () => {
  const requested = Promise.withResolvers<void>()
  const ready = Promise.withResolvers<unknown>()
  let now = 0
  let inputs = 0
  const deadline = new Deadline(1000, { clock: () => now })
  const { session } = scriptedSession(async (_method, params) => {
    if (functionOf(params) === registrationFunction) {
      requested.resolve()
      return ready.promise
    }
    return new Promise(() => {})
  })
  const filling = guardInput(new IsolatedWorld(session, () => 'F1'), guard, deadline, async () => { inputs += 1 })
  await requested.promise
  now = 1001
  ready.resolve({ result: { value: true } })
  await assert.rejects(filling, CdpTimeoutError)
  assert.equal(inputs, 0)
})

test('an acknowledgement that stays false ends at the action deadline and sends no input', async () => {
  let inputs = 0
  const { session, sent } = scriptedSession(async (_method, params) => {
    if (functionOf(params) === registrationFunction) return { result: { value: false } }
    return new Promise(() => {})
  })
  await assert.rejects(guardInput(new IsolatedWorld(session, () => 'F1'), guard, new Deadline(30), async () => { inputs += 1 }), CdpTimeoutError)
  assert.equal(inputs, 0)
  assert.equal(sent.some(({ params }) => functionOf(params) === disarmFunction), false)
})

test('stopping a pending acknowledgement sends no input, and a late marker cannot start it', async () => {
  const requested = Promise.withResolvers<void>()
  const ready = Promise.withResolvers<unknown>()
  const stop = new AbortController()
  let inputs = 0
  const { session } = scriptedSession(async (_method, params) => {
    if (functionOf(params) === registrationFunction) {
      requested.resolve()
      return ready.promise
    }
    return new Promise(() => {})
  })
  const filling = guardInput(new IsolatedWorld(session, () => 'F1'), guard, new Deadline(1000, { signal: stop.signal }), async () => { inputs += 1 })
  await requested.promise
  stop.abort()
  await assert.rejects(filling, CdpAbortedError)
  ready.resolve({ result: { value: true } })
  await Promise.resolve()
  assert.equal(inputs, 0)
})

test('stopping between false marker reads sends no input and reports the protocol cancellation', async () => {
  const stop = new AbortController()
  let reads = 0
  let inputs = 0
  const { session } = scriptedSession(async (_method, params) => {
    if (functionOf(params) === registrationFunction) {
      reads += 1
      setImmediate(() => stop.abort())
      return { result: { value: false } }
    }
    return new Promise(() => {})
  })
  const filling = guardInput(new IsolatedWorld(session, () => 'F1'), guard, new Deadline(1000, { signal: stop.signal }), async () => { inputs += 1 })
  await assert.rejects(filling, CdpAbortedError)
  assert.equal(inputs, 0)
  assert.ok(reads >= 1, 'the acknowledgement was false when the caller stopped waiting')
})

test('a document lost before acknowledgement sends no input and refuses the action', async () => {
  let inputs = 0
  const { session, sent } = scriptedSession(async (_method, params) => {
    if (functionOf(params) === registrationFunction) throw protocolError('Runtime.callFunctionOn', goneContext)
    return new Promise(() => {})
  })
  const verdict = await guardInput(new IsolatedWorld(session, () => 'F1'), guard, new Deadline(30), async () => { inputs += 1 })
  assert.deepEqual(verdict, { kind: 'unregistered' })
  assert.equal(inputs, 0)
  assert.deepEqual(sent.map(({ params }) => functionOf(params)), [verdictFunction, registrationFunction])
})

test('a document lost before input is a refusal for each action and the direct guard failure helpers', () => {
  const verdict = { kind: 'unregistered' } as const
  const choosing: ActionIntent = { action: 'select', choices: [{ label: 'Canada' }], multiple: false, multiline: false }
  for (const intent of [click, tap, fill, { action: 'check', pointer: 'click', multiline: false }, { action: 'uncheck', pointer: 'tap', multiline: false }, { action: 'hover', multiline: false }, { action: 'scroll', multiline: false }, { action: 'press', key: 'Enter', strokes: 1, multiline: false }, choosing] satisfies ActionIntent[]) {
    const failure = guardFailure(verdict, intent, save)
    assert.ok(failure !== undefined)
    assert.equal(failure.class, 'not_actionable')
    assert.equal(failure.details?.['inputSent'], false)
    assert.match(failure.message, /the page moved to a new document before Retest sent input/)
  }
  for (const failure of [keyFailure(verdict, 'Enter', undefined), wheelFailure(verdict, undefined), hoverFailure(verdict, save), selectKeyFailure(verdict, choosing, save)]) {
    assert.ok(failure !== undefined)
    assert.equal(failure.class, 'not_actionable')
    assert.deepEqual(failure.details, { reason: 'the page moved to a new document', inputSent: false })
  }
})

test('an unreadable acknowledgement sends no input and keeps the protocol failure', async () => {
  let inputs = 0
  const { session } = scriptedSession(async (_method, params) => {
    if (functionOf(params) === registrationFunction) return { result: { value: 'ready' } }
    return new Promise(() => {})
  })
  await assert.rejects(guardInput(new IsolatedWorld(session, () => 'F1'), guard, new Deadline(30), async () => { inputs += 1 }), CdpInvalidResponseError)
  assert.equal(inputs, 0)
})

// The document that replaced the guard's is asked whether it stopped typing meant for the one before it.
function replacedBy(stray: unknown) {
  const contexts: number[] = []
  const verdict = Promise.withResolvers<unknown>()
  const { session, sent } = scriptedSession(async (method, params) => {
    if (method === 'Page.createIsolatedWorld') return { executionContextId: 9 }
    if (functionOf(params) === verdictFunction) return verdict.promise
    if (functionOf(params) === registrationFunction) return { result: { value: true } }
    if (functionOf(params) === strayFunction) {
      if (typeof params === 'object' && params !== null && 'executionContextId' in params) contexts.push(Number(params.executionContextId))
      return { result: { value: stray } }
    }
    throw protocolError('Runtime.callFunctionOn', goneContext)
  })
  return { session, sent, contexts, input: async () => { verdict.reject(protocolError('Runtime.callFunctionOn', goneContext)) } }
}

test('a document that went away before the guard was done makes the verdict replaced, once the new document reports no stray typing', async () => {
  const { session, contexts, input } = replacedBy(null)
  let inputs = 0
  const verdict = await guardInput(new IsolatedWorld(session, () => 'F1'), guard, new Deadline(1000), async () => { inputs += 1; await input() })
  assert.equal(inputs, 1, 'input went after acknowledgement before its verdict context was lost')
  assert.deepEqual(verdict, { kind: 'replaced' })
  assert.deepEqual(contexts, [9], 'the new document was asked, in its own world')
})

test('a new document that stopped typing meant for the old one makes the verdict stopped, naming the document', async () => {
  const stray = { event: 'beforeinput', by: '<input autofocus>', origin: 'https://evil.example' }
  const { session, input } = replacedBy(stray)
  let inputs = 0
  const verdict = await guardInput(new IsolatedWorld(session, () => 'F1'), guard, new Deadline(1000), async () => { inputs += 1; await input() })
  assert.equal(inputs, 1, 'stray typing is checked when input went after acknowledgement')
  assert.deepEqual(verdict, { kind: 'stopped', ...stray })
})

test('input that fails ends the guard there, with the input failure and no disarm', async () => {
  const { session, sent } = scriptedSession((_method, params) => functionOf(params) === registrationFunction ? Promise.resolve({ result: { value: true } }) : new Promise(() => {}))
  const failure = new CdpTimeoutError({ method: 'Input.dispatchMouseEvent', sessionId: 'S1' }, { timeoutMs: 50, written: true })
  const guarding = guardInput(new IsolatedWorld(session, () => 'F1'), guard, new Deadline(50), async () => {
    throw failure
  })
  await assert.rejects(guarding, (error) => error === failure)
  assert.deepEqual(
    sent.map((command) => functionOf(command.params)),
    [verdictFunction, registrationFunction],
  )
})

test('a disarm the page does not answer fails the action with that timeout, even when the verdict confirmed input', async () => {
  let inputs = 0
  const { session, sent } = scriptedSession(async (_method, params) => {
    if (functionOf(params) === registrationFunction) return { result: { value: true } }
    if (functionOf(params) === verdictFunction) return { result: { value: { reached: ['pointerdown', 'click'], intercepted: null, landed: '<button>', leaving: null } } }
    return new Promise(() => {})
  })
  const guarding = guardInput(new IsolatedWorld(session, () => 'F1'), guard, new Deadline(50), async () => { inputs += 1 })
  await assert.rejects(guarding, CdpTimeoutError)
  assert.equal(inputs, 1)
  assert.deepEqual(sent.map(({ params }) => functionOf(params)), [verdictFunction, registrationFunction, disarmFunction])
})

const search = { by: 'label', text: 'Search' } as const
const press: ActionIntent = { action: 'press', key: 'Enter', strokes: 1, multiline: false }

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

test('a check or uncheck is judged as the click or tap that made it, and named by its own verb', () => {
  const check: ActionIntent = { action: 'check', pointer: 'click', multiline: false }
  const uncheck: ActionIntent = { action: 'uncheck', pointer: 'tap', multiline: false }
  assert.equal(guardFailure(seen({ reached: ['pointerdown'] }), check, save), undefined)
  assert.equal(guardFailure(seen({ reached: ['touchstart'] }), uncheck, save), undefined)
  assert.deepEqual(guardFailure(seen({ reached: [], intercepted: { event: 'pointerdown', by: cover } }), check, save), {
    class: 'not_actionable',
    message: `Could not check getByTestId('save'): another element, ${cover}, was on top of it when Retest pressed. Retest stopped the click before the page received it.`,
    details: { check: 'hit-target', interceptedBy: cover, event: 'pointerdown' },
  })
  assert.match(
    guardFailure(seen({ reached: [], intercepted: { event: 'touchend', by: cover } }), uncheck, save)?.message ?? '',
    /^Could not uncheck getByTestId\('save'\): it took the touch, but another element/,
  )
  assert.deepEqual(guardFailure({ kind: 'replaced' }, uncheck, save), {
    class: 'outcome_unknown',
    message: "The page moved to a new document while Retest tried to uncheck getByTestId('save'), so Retest cannot tell whether the uncheck took effect.",
    details: { reason: 'the page moved to a new document' },
  })
})

test('a hover whose move reached the element succeeds; one another element took is stopped and named; one that never arrived is unknown', () => {
  const menu = { by: 'testId', value: 'menu' } as const
  const hover: ActionIntent = { action: 'hover', multiline: false }
  assert.equal(guardFailure(seen({ reached: ['pointerover', 'pointermove', 'mouseover', 'mousemove'] }), hover, menu), undefined)
  assert.equal(guardFailure(seen({ reached: ['pointermove', 'mousemove'] }), hover, menu), undefined, 'a pointer already over the element only moves')
  assert.deepEqual(guardFailure(seen({ intercepted: { event: 'pointerover', by: '<div class="cover">' } }), hover, menu), {
    class: 'not_actionable',
    message: `Could not hover getByTestId('menu'): another element, <div class="cover">, was at its centre when the mouse arrived. Retest stopped the mouse events before the page's listeners heard them.`,
    details: { check: 'hit-target', interceptedBy: '<div class="cover">', event: 'pointerover' },
  })
  assert.equal(guardFailure(seen({ landed: '<iframe>' }), hover, menu)?.class, 'outcome_unknown')
  assert.equal(guardFailure({ kind: 'replaced' }, hover, menu)?.class, 'outcome_unknown')
})

test("a select's key that the focus did not take is stopped and names the select's choice", () => {
  const country = { by: 'label', text: 'Country' } as const
  const typing: ActionIntent = { action: 'select', choices: [{ label: 'Canada' }], multiple: false, multiline: false, typing: { strokes: 1 } }
  assert.equal(guardFailure(seen({ reached: ['keydown', 'keypress', 'keyup'] }), typing, country), undefined)
  assert.deepEqual(guardFailure(seen({ intercepted: { event: 'keydown', by: '<input id="next">' } }), typing, country), {
    class: 'not_actionable',
    message: "Could not select 'Canada' in getByLabel('Country'): the keyboard focus moved to another element, <input id=\"next\">, before a key arrived. Retest stopped the key before the page received it.",
    details: { check: 'focused', focus: '<input id="next">', event: 'keydown' },
  })
  assert.match(guardFailure({ kind: 'replaced' }, typing, country)?.message ?? '', /^The page moved to a new document while Retest typed to select 'Canada' in getByLabel\('Country'\), so Retest cannot tell what the select chose\.$/)
})
