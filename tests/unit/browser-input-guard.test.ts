import type { ActionIntent } from '../../src/browser/element-queries.ts'
import type { GuardVerdict } from '../../src/browser/input-guard.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CdpTimeoutError } from '../../src/browser/cdp/errors.ts'
import { guardFailure, guardInput } from '../../src/browser/input-guard.ts'
import { IsolatedWorld } from '../../src/browser/isolated-world.ts'
import { disarmFunction, verdictFunction } from '../../src/browser/page-scripts.ts'
import { Deadline } from '../../src/protocol/deadline.ts'
import { protocolError, scriptedSession } from './browser-fixtures.ts'

const click: ActionIntent = { action: 'click', multiline: false }
const fill: ActionIntent = { action: 'fill', multiline: false }
const save = { by: 'testId', value: 'save' } as const
const cover = '<div data-testid="cover">'
const guard = { context: 7, token: 3 }
const goneContext = 'Execution context was destroyed.'

function seen(verdict: Partial<Extract<GuardVerdict, { kind: 'seen' }>>): GuardVerdict {
  return { kind: 'seen', reached: [], intercepted: null, landed: null, ...verdict }
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

test('input the page answered with a new document leaves the outcome unknown', () => {
  for (const intent of [click, fill]) {
    assert.deepEqual(guardFailure({ kind: 'replaced' }, intent, save), {
      class: 'outcome_unknown',
      message: `The page moved to a new document while Retest tried to ${intent.action} getByTestId('save'), so Retest cannot tell whether the ${intent.action} took effect.`,
      details: { reason: 'the page moved to a new document' },
    })
  }
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
      settled.resolve({ result: { value: { reached: ['pointerdown', 'click'], intercepted: null, landed: '<button>' } } })
      return { result: { value: true } }
    }
    throw new Error(`unexpected ${method}`)
  })
  const verdict = await guardInput(new IsolatedWorld(session, () => 'F1'), guard, new Deadline(1000), async () => {
    order.push('input')
  })
  assert.deepEqual(order, ['verdict asked', 'input', 'disarmed'])
  assert.deepEqual(verdict, { kind: 'seen', reached: ['pointerdown', 'click'], intercepted: null, landed: '<button>' })
  for (const command of sent) {
    assert.ok(typeof command.params === 'object' && command.params !== null && 'executionContextId' in command.params)
    assert.equal(command.params.executionContextId, guard.context)
  }
})

test('a document that went away before the guard was done makes the verdict replaced', async () => {
  const { session } = scriptedSession(async () => {
    throw protocolError('Runtime.callFunctionOn', goneContext)
  })
  const verdict = await guardInput(new IsolatedWorld(session, () => 'F1'), guard, new Deadline(1000), async () => {})
  assert.deepEqual(verdict, { kind: 'replaced' })
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
