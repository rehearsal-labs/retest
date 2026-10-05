import assert from 'node:assert/strict'
import { test } from 'node:test'
import { bootstrapScript, guardInstallScript, relayedEvents, relayedWhileArmed } from '../../src/browser/webkit/relay.ts'
import { listKey, listPlanFunction } from '../../src/browser/webkit/select.ts'
import { guardScript, keyedObserveFunction, selectionFunction } from '../../src/browser/page-scripts.ts'

// The relays run in the page; these units check they cover what the shared guard listens for and are scripts a page
// can run. The integration tests show the relay working in the real build.

function guardedEvents(): Set<string> {
  const events = new Set<string>()
  for (const match of guardScript.matchAll(/events: \[([^\]]*)\]/g)) {
    for (const name of (match[1] ?? '').matchAll(/'([a-z]+)'/g)) if (name[1] !== undefined) events.add(name[1])
  }
  return events
}

test("the relay hands over every event the shared guard watches, and its select watch's input and change", { timeout: 10_000 }, () => {
  const watched = guardedEvents()
  assert.ok(watched.size >= 15, `read ${watched.size} events from the guard`)
  const relayed = new Set([...relayedEvents, ...relayedWhileArmed])
  for (const event of watched) assert.ok(relayed.has(event), `the relay does not hand over ${event}`)
  for (const event of ['input', 'change']) assert.ok(relayedEvents.includes(event))
  assert.deepEqual(relayedWhileArmed, ['wheel'], 'the wheel is listened for only while a scroll is armed, as the guard does')
})

test('both relays are scripts a page can parse, with the secret only as a string they hold', { timeout: 10_000 }, () => {
  const secret = 'retest-0d9f'
  for (const source of [bootstrapScript(secret), guardInstallScript(secret)]) {
    assert.doesNotThrow(() => new Function(source))
    assert.equal(source.split(JSON.stringify(secret)).length, 2, 'the secret is written once, as a string literal')
  }
  assert.ok(guardInstallScript(secret).includes(guardScript), 'the user world installs the shared guard unchanged')
})

test('the main-world relay takes the change binding off the window before the page runs, and keeps the DOM functions it uses', { timeout: 10_000 }, () => {
  const source = bootstrapScript('retest-1')
  assert.match(source, /const tell = globalThis\.retestChanged\s+try \{ delete globalThis\.retestChanged \} catch \{\}/)
  for (const kept of ['EventTarget.prototype.addEventListener', 'EventTarget.prototype.dispatchEvent', 'Event.prototype.stopImmediatePropagation', 'Element.prototype.getAttribute']) assert.ok(source.includes(kept), kept)
})

test("a WebKit list's plan is the shared selection function with its first line and last step replaced, checks the element an action is pinned to before it plans, and its keys are Home and the arrows, Shift widening", { timeout: 10_000 }, () => {
  assert.doesNotThrow(() => new Function(`return ${listPlanFunction}`))
  const head = 'function selection(choices, query, ...elements) {'
  assert.ok(selectionFunction.startsWith(head))
  const shared = selectionFunction.slice(head.length, selectionFunction.lastIndexOf('  return selectionOf(select, choices)'))
  assert.ok(listPlanFunction.includes(shared), 'the locator is resolved and the choices read by the shared code, whole')
  assert.ok(listPlanFunction.startsWith('function listPlan(request, query, ...elements) {\n  const { choices, element: pinned } = request\n'), 'the choices it reads are the ones it is given')
  const keyed = keyedObserveFunction.slice(keyedObserveFunction.indexOf('  const elementKeys = () => {'), keyedObserveFunction.indexOf('  const isKeyed = (element, key) =>'))
  assert.ok(keyed.length > 0 && listPlanFunction.includes(keyed), "a pin is read from the shared keyed look's own key store")
  const pinCheck = listPlanFunction.indexOf("if (typeof pinned === 'string' && !isKeyed(select, pinned)) return { status: 'moved' }")
  assert.ok(pinCheck > listPlanFunction.indexOf(shared) && pinCheck < listPlanFunction.indexOf("if (!select.multiple) return { status: 'single' }"), 'the pin is checked once the select is found and before anything is planned')
  assert.deepEqual(listKey({ key: 'Home', shift: false }), { kind: 'named', name: 'Home', held: [] })
  assert.deepEqual(listKey({ key: 'ArrowDown', shift: true }), { kind: 'named', name: 'ArrowDown', held: ['Shift'] })
})
