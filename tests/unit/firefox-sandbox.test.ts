import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'
import { createContext, runInContext } from 'node:vm'
import { relayedEvents, relayScript, wrapped } from '../../src/browser/firefox/sandbox.ts'
import { guardScript } from '../../src/browser/page-scripts.ts'

// The relays Retest's preload script adds in Firefox's sandbox, and the window its page functions see, run here on
// Node's own EventTarget and Event: the guard's listeners join the relays, hear events in the order they were added,
// and one that stops an event keeps the rest from hearing it, as listeners added to the window itself would.

afterEach(() => {
  for (const name of ['window', 'retestRelays', 'retestRelaysDocument', 'retestClaim', 'retestClaimed', 'retestUnclaimed']) Reflect.deleteProperty(globalThis, name)
})

function relays(): ReadonlyMap<string, { size: number }> | undefined {
  const value: unknown = Reflect.get(globalThis, 'retestRelays')
  return value instanceof Map ? value : undefined
}

const claimType = 'retest-claim-test'

// The relay script reads the tab's claim event type from the scope it runs in, as the preload script gives it.
function run(source: string): void {
  new Function('claimType', source)(claimType)
}

async function callWrapped(functionDeclaration: string, values: readonly unknown[]): Promise<unknown> {
  const call: unknown = new Function(`return (${wrapped(functionDeclaration)})`)()
  assert.equal(typeof call, 'function')
  if (typeof call !== 'function') return undefined
  const answer: unknown = await call(JSON.stringify(values.map((value) => ({ v: value }))))
  return typeof answer === 'string' ? JSON.parse(answer) : answer
}

describe("Retest's relays in Firefox's sandbox", () => {
  test('carry every event the guard listens for from the start of a document, and not the wheel', () => {
    const named = new Set([...guardScript.matchAll(/events: \[([^\]]*)\]/g)].flatMap((match) => [...(match[1] ?? '').matchAll(/'([a-z]+)'/g)].map((each) => each[1])))
    named.delete('wheel')
    for (const type of [...named, 'input', 'change']) assert.ok(relayedEvents.includes(type ?? ''), `${type} is relayed`)
    assert.equal(relayedEvents.includes('wheel'), false, 'a wheel listener that is not passive would make every scroll wait for it')
  })

  test("a page function's capturing listener joins the relay, hears the event, and one that stops it ends the relay", async () => {
    const window = new EventTarget()
    Reflect.set(globalThis, 'window', window)
    run(relayScript)
    const pageHeard: string[] = []
    window.addEventListener('keydown', () => pageHeard.push('page'), true)
    await callWrapped(`function listen() {
      globalThis.heard = []
      window.addEventListener('keydown', (event) => { globalThis.heard.push('first'); if (event.type === 'keydown') event.stopImmediatePropagation() }, true)
      window.addEventListener('keydown', () => globalThis.heard.push('second'), { capture: true })
    }`, [])
    window.dispatchEvent(new Event('keydown'))
    assert.deepEqual(Reflect.get(globalThis, 'heard'), ['first'], 'the listener after the one that stopped it heard nothing')
    assert.deepEqual(pageHeard, [], "the page's listener, added after the relays, heard nothing")
    Reflect.deleteProperty(globalThis, 'heard')
  })

  test('a listener that is not capturing, or for an event no relay carries, goes to the window itself, and removing takes it from both', async () => {
    const window = new EventTarget()
    Reflect.set(globalThis, 'window', window)
    run(relayScript)
    await callWrapped(`function listen() {
      globalThis.heard = []
      globalThis.onWheel = () => globalThis.heard.push('wheel')
      globalThis.onClick = () => globalThis.heard.push('click')
      window.addEventListener('wheel', globalThis.onWheel, { capture: true })
      window.addEventListener('click', globalThis.onClick, true)
      window.addEventListener('click', () => globalThis.heard.push('bubbling click'))
    }`, [])
    assert.equal(relays()?.get('click')?.size, 1)
    assert.equal(relays()?.has('wheel'), false)
    window.dispatchEvent(new Event('wheel'))
    window.dispatchEvent(new Event('click'))
    assert.deepEqual(Reflect.get(globalThis, 'heard'), ['wheel', 'click', 'bubbling click'])
    await callWrapped(`function unlisten() {
      window.removeEventListener('wheel', globalThis.onWheel, { capture: true })
      window.removeEventListener('click', globalThis.onClick, true)
    }`, [])
    assert.equal(relays()?.get('click')?.size, 0)
    window.dispatchEvent(new Event('wheel'))
    assert.deepEqual(Reflect.get(globalThis, 'heard'), ['wheel', 'click', 'bubbling click'])
    for (const name of ['heard', 'onWheel', 'onClick']) Reflect.deleteProperty(globalThis, name)
  })

  test('a document with no relays, such as one whose preload script has not run yet, gets the window itself', async () => {
    const window = new EventTarget()
    Reflect.set(globalThis, 'window', window)
    await callWrapped(`function listen() {
      globalThis.heard = []
      window.addEventListener('keydown', () => globalThis.heard.push('direct'), true)
    }`, [])
    window.dispatchEvent(new Event('keydown'))
    assert.deepEqual(Reflect.get(globalThis, 'heard'), ['direct'])
    Reflect.deleteProperty(globalThis, 'heard')
  })

  test('the relays are added once however often the script runs', () => {
    const window = new EventTarget()
    Reflect.set(globalThis, 'window', window)
    run(relayScript)
    const first = relays()
    run(relayScript)
    assert.equal(relays(), first)
  })
})

test('typing into a new document is stopped before its guard is installed, and the guard inherits that stopped input', async () => {
  class KeyEvent extends Event {
    override get isTrusted(): boolean { return true }
  }
  const window = new EventTarget()
  Reflect.set(globalThis, 'window', window)
  Reflect.set(globalThis, 'KeyboardEvent', KeyEvent)
  Reflect.set(globalThis, 'location', { origin: 'https://elsewhere.test' })
  run(relayScript)
  let heard = 0
  window.addEventListener('keydown', () => { heard += 1 })
  const event = new KeyEvent('keydown', { cancelable: true })
  window.dispatchEvent(event)
  assert.equal(heard, 0)
  assert.equal(event.defaultPrevented, true)
  await callWrapped('function install() { globalThis.retestGuard = { stray: null } }', [])
  assert.deepEqual(Reflect.get(globalThis, 'retestGuard'), { stray: { event: 'keydown', by: 'the page', origin: 'https://elsewhere.test' } })
  for (const name of ['KeyboardEvent', 'location', 'retestGuard', 'retestUnguardedStray']) Reflect.deleteProperty(globalThis, name)
})

test('a second sandbox the preload script ran in stops stopping typing once the sandbox Retest calls claims the document, so the page hears what the guard counted', async () => {
  // Firefox ran the preload script in two sandboxes of the first document of a new window, and sent calls to one. Two
  // contexts here share one window, as those sandboxes share the page's.
  class KeyEvent extends Event {
    override get isTrusted(): boolean { return true }
  }
  const window = new EventTarget()
  const sandbox = () => createContext({ window, Event, KeyboardEvent: KeyEvent, InputEvent: KeyEvent, location: { origin: 'https://app.test' }, claimType })
  const called = sandbox()
  const other = sandbox()
  for (const each of [called, other]) runInContext(relayScript, each)
  const pageHeard: string[] = []
  window.addEventListener('keydown', () => pageHeard.push('keydown'))
  const early = new KeyEvent('keydown', { cancelable: true })
  window.dispatchEvent(early)
  assert.deepEqual([pageHeard, early.defaultPrevented], [[], true], 'typing before any guard is still stopped')
  // A call reaches one sandbox, and its page function installs a guard there that counts the keys it hears.
  const call = runInContext(`(${wrapped(`function install() {
    globalThis.retestGuard = { heard: 0 }
    window.addEventListener('keydown', () => { globalThis.retestGuard.heard += 1 }, true)
  }`)})`, called)
  assert.equal(typeof call, 'function')
  if (typeof call === 'function') await call('[]')
  const typed = new KeyEvent('keydown', { cancelable: true })
  window.dispatchEvent(typed)
  assert.equal(runInContext('globalThis.retestGuard.heard', called), 1, 'the guard counted the key')
  assert.deepEqual(pageHeard, ['keydown'], 'and the page heard it')
  assert.equal(typed.defaultPrevented, false, 'and its default action was left to happen')
  assert.equal(runInContext('globalThis.retestUnclaimed', other), true)
})

test('a sandbox that runs the script again in a new document adds its relays there and drops the guard it kept from the document before', () => {
  const window = new EventTarget()
  Reflect.set(globalThis, 'window', window)
  Reflect.set(globalThis, 'document', { name: 'first' })
  run(relayScript)
  const first = relays()
  Reflect.set(globalThis, 'retestGuard', { stray: null })
  Reflect.set(globalThis, 'document', { name: 'second' })
  run(relayScript)
  assert.notEqual(relays(), first, 'the second document has relays of its own')
  assert.equal(Reflect.get(globalThis, 'retestGuard'), undefined, "the first document's guard went with it")
  Reflect.deleteProperty(globalThis, 'document')
})
