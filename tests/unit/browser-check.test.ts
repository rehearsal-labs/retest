import type { SentCommand } from './browser-fixtures.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkedFunction, disarmFunction, prepareFunction, registrationFunction, verdictFunction } from '../../src/browser/page-scripts.ts'
import { scriptedPage, value } from './browser-fixtures.ts'

const page = { href: 'http://app.test/settings', title: 'Settings' }
const facts = { url: 'http://app.test/settings', title: 'Settings' }
const clicked = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']
const agree = { by: 'testId', value: 'agree' } as const

type Script = { readiness?: unknown; states?: (boolean | null)[]; reached?: string[] }

// A page whose look answers `readiness`, whose guard saw `reached`, and whose control reads each of `states` in turn,
// then the last one again.
function checkPage({ readiness, states = [true], reached = clicked }: Script, touch = false) {
  let read = 0
  const ready = readiness ?? { status: 'ready', point: { x: 10, y: 20 }, token: 1, via: null, scale: 1, page, plan: null }
  const emulation = touch ? { emulation: { viewport: { width: 400, height: 800 }, deviceScaleFactor: 2, touch: true, isMobile: true } } : {}
  return scriptedPage({
    ...emulation,
    other: () => Promise.resolve({}),
    call: (source) => {
      if (source === prepareFunction) return value(ready)
      if (source === registrationFunction) return value(true)
      if (source === verdictFunction) return value({ reached, intercepted: null, landed: '<label>', leaving: null })
      if (source === disarmFunction) return value(true)
      if (source === checkedFunction) return value(states[Math.min(read++, states.length - 1)])
      return Promise.reject(new Error('unexpected call'))
    },
  })
}

function pointerInput(sent: SentCommand[]): unknown[] {
  return sent.flatMap(({ method, params }) => (method === 'Input.dispatchMouseEvent' || method === 'Input.dispatchTouchEvent' ? [params] : []))
}

test('a control already as asked is left alone: nothing is sent, and the result says it did not change', async () => {
  const { page: owned, sent } = checkPage({ readiness: { status: 'unchanged', page } })
  assert.deepEqual(await owned.execute({ kind: 'check', locator: agree }, 1000), { ok: true, kind: 'check', changed: false, page: facts })
  assert.deepEqual(pointerInput(sent), [])
})

test('a control is clicked once, and passes once it reads as asked', async () => {
  const { page: owned, sent } = checkPage({ states: [false, false, true] })
  assert.deepEqual(await owned.execute({ kind: 'check', locator: agree }, 1000), { ok: true, kind: 'check', changed: true, page: facts })
  assert.deepEqual(pointerInput(sent), [
    { type: 'mouseMoved', x: 10, y: 20 },
    { type: 'mousePressed', x: 10, y: 20, button: 'left', clickCount: 1, buttons: 1 },
    { type: 'mouseReleased', x: 10, y: 20, button: 'left', clickCount: 1, buttons: 0 },
  ])
})

test('a hidden control clicked through its label says so', async () => {
  const readiness = { status: 'ready', point: { x: 10, y: 20 }, token: 1, via: 'label', scale: 1, page, plan: null }
  const { page: owned } = checkPage({ readiness, states: [false] })
  assert.deepEqual(await owned.execute({ kind: 'uncheck', locator: agree }, 1000), { ok: true, kind: 'uncheck', changed: true, via: 'label', page: facts })
})

test('a control that took the click and stayed as it was fails after one click, and is never clicked again', async () => {
  const { page: owned, sent } = checkPage({ states: [false] })
  assert.deepEqual(await owned.execute({ kind: 'check', locator: agree }, 150), {
    ok: false,
    failure: {
      class: 'not_actionable',
      message: "Could not check getByTestId('agree'): Retest clicked it once, and it stayed unchecked. Retest does not click again.",
      details: { check: 'state', inputSent: true },
    },
  })
  assert.equal(pointerInput(sent).filter((params) => JSON.stringify(params).includes('mousePressed')).length, 1)
  const label = checkPage({ readiness: { status: 'ready', point: { x: 10, y: 20 }, token: 1, via: 'label', scale: 1, page, plan: null }, states: [null] })
  const failure = await label.page.execute({ kind: 'uncheck', locator: agree }, 100)
  assert.ok(!failure.ok)
  assert.equal(
    failure.failure.message,
    "Could not uncheck getByTestId('agree'): Retest clicked its label once, and then no single control it matched showed whether it is unchecked. Retest does not click again.",
  )
})

test('on a touch screen the control is tapped once, and a tap that did nothing says so', async () => {
  const { page: owned, sent } = checkPage({ states: [false], reached: ['pointerdown', 'touchstart', 'pointerup', 'touchend'] }, true)
  const result = await owned.execute({ kind: 'check', locator: agree }, 100)
  assert.ok(!result.ok)
  assert.equal(result.failure.message, "Could not check getByTestId('agree'): Retest tapped it once, and it stayed unchecked. Retest does not tap again.")
  assert.deepEqual(pointerInput(sent), [
    { type: 'touchStart', touchPoints: [{ x: 10, y: 20 }] },
    { type: 'touchEnd', touchPoints: [] },
  ])
})

test('a click another element took fails the check by its name, and its state is never read', async () => {
  const { page: owned, sent } = scriptedPage({
    other: () => Promise.resolve({}),
    call: (source) => {
      if (source === prepareFunction) return value({ status: 'ready', point: { x: 10, y: 20 }, token: 1, via: null, scale: 1, page, plan: null })
      if (source === registrationFunction) return value(true)
      if (source === verdictFunction) return value({ reached: [], intercepted: { event: 'pointerdown', by: '<div class="cookie-banner">' }, landed: '<div>', leaving: null })
      if (source === disarmFunction) return value(true)
      return Promise.reject(new Error('unexpected call'))
    },
  })
  assert.deepEqual(await owned.execute({ kind: 'check', locator: agree }, 1000), {
    ok: false,
    failure: {
      class: 'not_actionable',
      message: `Could not check getByTestId('agree'): another element, <div class="cookie-banner">, was on top of it when Retest pressed. Retest stopped the click before the page received it.`,
      details: { check: 'hit-target', interceptedBy: '<div class="cookie-banner">', event: 'pointerdown' },
    },
  })
  assert.equal(sent.filter(({ params }) => JSON.stringify(params).includes('function checked')).length, 0)
})
