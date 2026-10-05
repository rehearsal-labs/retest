import type { Handler, Answer } from './firefox-scripted-bidi.ts'
import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'
import { elementsByRole } from '../../src/browser/accessibility.ts'
import { BrowserError } from '../../src/browser/browser-error.ts'
import { CdpBlockedError, CdpProtocolError } from '../../src/browser/cdp/errors.ts'
import { Dispatch } from '../../src/browser/dispatch.ts'
import { namedElements, roleWants } from '../../src/browser/firefox/accessible-names.ts'
import { BidiClient } from '../../src/browser/firefox/bidi-client.ts'
import { FirefoxBridge } from '../../src/browser/firefox/bridge.ts'
import { isGoneContext, IsolatedWorld, neverRan } from '../../src/browser/isolated-world.ts'
import { Deadline } from '../../src/protocol/deadline.ts'
import { s } from '../../src/protocol/schema.ts'
import { ScriptedBidi } from './firefox-scripted-bidi.ts'

// The bridge that lets the page helpers Retest shares with Chromium run on Firefox: each DevTools method they send,
// answered over a scripted BiDi endpoint, and every other method refused.

const context = 'tab-1'
let endpoint: ScriptedBidi
let client: BidiClient

before(async () => {
  endpoint = await ScriptedBidi.start()
  client = await BidiClient.connect(endpoint.url, { timeoutMs: 2000, onDiagnostic: () => {} })
})

after(async () => {
  client.close()
  await endpoint.close()
})

let realms = 0

// The tab's sandbox gets a realm of its own; a call in it answers what `answer` makes of the call's plan.
function scriptCalls(answer: (plan: unknown[], params: Record<string, unknown>) => Answer | Promise<Answer>): void {
  endpoint.on('script.callFunction', (params) => {
    const target = params['target']
    if (typeof target === 'object' && target !== null && 'sandbox' in target) {
      realms += 1
      return { result: { realm: `realm-${realms}`, type: 'success', result: { type: 'number', value: 0 } } }
    }
    const [plan] = Array.isArray(params['arguments']) ? params['arguments'] : []
    const text = typeof plan === 'object' && plan !== null && 'value' in plan && typeof plan.value === 'string' ? plan.value : '[]'
    const decoded: unknown = JSON.parse(text)
    return answer(Array.isArray(decoded) ? decoded : [], params)
  })
}

function answered(value: unknown): Answer {
  return { result: { realm: 'realm', type: 'success', result: { type: 'string', value: JSON.stringify({ v: value }) } } }
}

function bridge(): { bridge: FirefoxBridge; world: IsolatedWorld } {
  const made = new FirefoxBridge({ client, context, onListenerError: () => {} })
  return { bridge: made, world: new IsolatedWorld(made.session, () => context) }
}

function onScript(handler: Handler): void {
  endpoint.on('script.callFunction', (params, command) => String(params['functionDeclaration']).includes('function markupRefusal(') ? { result: { type: 'success', result: { type: 'string', value: '' } } } : handler(params, command))
}

beforeEach(() => {
  onScript(() => ({ result: { type: 'success', result: { type: 'string', value: '[]' } } }))
  endpoint.sent.length = 0
})

test('loose name confirmations start at every candidate for that name, including duplicates, and still require Firefox to confirm it', async () => {
  const nodes = ['one', 'two', 'three'].map((sharedId) => ({ sharedId }))
  const locator = { by: 'role', role: 'button', name: 'Item', exact: false } as const
  endpoint.on('browsingContext.locateNodes', (params) => {
    const name: unknown = Reflect.get(Object(Reflect.get(Object(params['locator']), 'value')), 'name')
    if (name === undefined) return { result: { nodes } }
    assert.deepEqual(params['startNodes'], name === 'Item' ? [{ sharedId: 'one' }, { sharedId: 'two' }] : [{ sharedId: 'three' }])
    return { result: { nodes: name === 'Item' ? nodes.slice(0, 2) : [] } }
  })
  onScript(() => ({ result: { type: 'success', result: { type: 'string', value: JSON.stringify([['Item'], ['Item'], ['Unconfirmed', '']]) } } }))
  await assert.rejects(namedElements({ client, context, deadline: new Deadline(2000) }, 'button', { locators: [locator], wants: roleWants(locator) }), (error: unknown) => error instanceof BrowserError && error.failure.class === 'unsupported')
  const confirmed = endpoint.commands('browsingContext.locateNodes').filter((command) => Reflect.get(Object(Reflect.get(Object(command.params['locator']), 'value')), 'name') !== undefined)
  assert.deepEqual(confirmed.map((command) => command.params['startNodes']), [[{ sharedId: 'one' }, { sharedId: 'two' }], [{ sharedId: 'three' }], [{ sharedId: 'three' }]])
})

describe('the Firefox bridge', () => {
  test("a page function runs in Retest's sandbox realm, its values sent as one JSON plan and its answer read as JSON", async () => {
    scriptCalls((plan) => answered({ echoed: plan }))
    const { world } = bridge()
    const value = await world.call('function echo(a, b) { return [a, b] }', [1, { text: 'Save' }], s.object({ echoed: s.array(s.object({ v: s.union([s.number(), s.object({ text: s.string() })]) })) }), new Deadline(2000))
    assert.deepEqual(value, { echoed: [{ v: 1 }, { v: { text: 'Save' } }] })
    const [made, called] = endpoint.commands('script.callFunction')
    assert.deepEqual(made?.params['target'], { context, sandbox: 'retest' })
    assert.deepEqual(called?.params['target'], { realm: `realm-${realms}` })
    const declaration = String(called?.params['functionDeclaration'])
    assert.match(declaration, /function echo\(a, b\)/)
    assert.match(declaration, /globalThis\.navigation = \{ addEventListener\(\) \{\} \}/, 'a sandbox with no Navigation API gets the object the shared guard listens on')
  })

  test("a page function that throws fails as Retest's page script failing, with Firefox's text", async () => {
    scriptCalls(() => ({ result: { realm: 'realm', type: 'exception', exceptionDetails: { text: 'TypeError: nope' } } }))
    const { world } = bridge()
    await assert.rejects(world.call('function fails() { throw new TypeError("nope") }', [], s.string(), new Deadline(2000)), /Retest's page script failed: TypeError: nope/)
  })

  test("a realm that is gone answers as a context that never ran, so the world is made again in the document's new realm", async () => {
    let gone = true
    scriptCalls(() => {
      if (!gone) return answered('fresh')
      gone = false
      return { error: 'no such frame', message: 'Realm with id realm-1 not found' }
    })
    const { world } = bridge()
    assert.equal(await world.call('function read() { return 1 }', [], s.string(), new Deadline(2000)), 'fresh')
    const made = endpoint.commands('script.callFunction').filter((command) => JSON.stringify(command.params['target']).includes('sandbox'))
    assert.equal(made.length, 2, 'the world was made again')
  })

  test('a call whose realm Firefox destroys while it waits is made again at once in the realm of the document that followed', async () => {
    let answering = false
    scriptCalls(() => (answering ? answered('fresh') : 'silent'))
    const { bridge: made, world } = bridge()
    const realmId = realms + 1
    const waiting = world.call('function reads() {}', [], s.string(), new Deadline(5000))
    await new Promise((resolve) => setTimeout(resolve, 50))
    const startedAt = performance.now()
    answering = true
    endpoint.emit('script.realmDestroyed', { realm: `realm-${realmId}` })
    assert.equal(await waiting, 'fresh')
    assert.ok(performance.now() - startedAt < 1000, 'Firefox never answers a call whose realm went, so the bridge does not wait for one')
    made.dispose()
  })

  test('callIn a destroyed realm is a gone context the shared helpers recognise', async () => {
    scriptCalls(() => 'silent')
    const { bridge: made, world } = bridge()
    const created = await world.enter('function first() { return 1 }', [], s.number(), new Deadline(200)).catch(() => undefined)
    assert.equal(created, undefined, 'the first call waited and timed out')
    const context = 1
    const waiting = world.callIn(context, 'function waits() {}', [], s.string(), new Deadline(5000)).catch((error: unknown) => error)
    await new Promise((resolve) => setTimeout(resolve, 50))
    const startedAt = performance.now()
    endpoint.emit('script.realmDestroyed', { realm: `realm-${realms}` })
    const error = await waiting
    const waited = performance.now() - startedAt
    assert.ok(waited >= 200 && waited < 1000, `failed ${Math.round(waited)} ms after the realm's end, after a short grace for a late answer`)
    assert.ok(isGoneContext(error), String(error))
    assert.equal(neverRan(error), false, 'a call that may have begun is not counted as never run')
    made.dispose()
  })

  test("a call answered just after Firefox tells of its realm's end keeps its answer", async () => {
    let release: (() => void) | undefined
    scriptCalls((_plan, params) => {
      if (!String(params['functionDeclaration']).includes('verdict')) return answered(1)
      return new Promise<Answer>((resolve) => {
        release = () => resolve(answered('settled as the document went'))
      })
    })
    const { bridge: made, world } = bridge()
    const context = await world.enter('function first() { return 1 }', [], s.number(), new Deadline(2000)).then(() => 1)
    const late = world.callIn(context, 'function verdict() {}', [], s.string(), new Deadline(5000))
    await new Promise((resolve) => setTimeout(resolve, 50))
    endpoint.emit('script.realmDestroyed', { realm: `realm-${realms}` })
    await new Promise((resolve) => setTimeout(resolve, 50))
    release?.()
    assert.equal(await late, 'settled as the document went')
    made.dispose()
  })

  test('input waits until a page function on its way tells it waits in the page, since Firefox runs commands in no fixed order', async () => {
    let tell: (() => void) | undefined
    let release: (() => void) | undefined
    scriptCalls((_plan, params) => {
      if (!String(params['functionDeclaration']).includes('verdict')) return answered(1)
      const [, id, channel] = Array.isArray(params['arguments']) ? params['arguments'] : []
      assert.deepEqual(channel, { type: 'channel', value: { channel: `retest-started-${context}`, ownership: 'none' } })
      tell = () => endpoint.emit('script.message', { channel: `retest-started-${context}`, data: { type: 'string', value: Reflect.get(Object(id), 'value') }, source: { realm: 'realm', context } })
      return new Promise<Answer>((resolve) => {
        release = () => resolve(answered('heard'))
      })
    })
    const { bridge: made, world } = bridge()
    await world.enter('function first() { return 1 }', [], s.number(), new Deadline(2000))
    assert.equal(await Promise.race([made.callsStarted(1000).then(() => 'none waiting'), new Promise((resolve) => setTimeout(() => resolve('waited'), 50))]), 'none waiting')
    const verdict = world.callIn(1, 'function verdict() {}', [], s.string(), new Deadline(5000))
    await new Promise((resolve) => setTimeout(resolve, 30))
    let started = false
    const waiting = made.callsStarted(2000).then(() => {
      started = true
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(started, false, 'the call has not told it waits')
    tell?.()
    await waiting
    assert.equal(started, true)
    release?.()
    assert.equal(await verdict, 'heard')
    const startedAt = performance.now()
    scriptCalls(() => 'silent')
    const silent = world.callIn(1, 'function verdict() {}', [], s.string(), new Deadline(5000)).catch(() => undefined)
    await made.callsStarted(100)
    assert.ok(performance.now() - startedAt < 1000, 'a call that never tells is waited for no longer than asked')
    endpoint.emit('script.realmDestroyed', { realm: `realm-${realms}` })
    await silent
    made.dispose()
  })

  test("element references from the accessibility query travel as BiDi shared references, never as values", async () => {
    endpoint.on('browsingContext.locateNodes', (params) => {
      const locator = params['locator']
      const value = typeof locator === 'object' && locator !== null && 'value' in locator ? locator.value : undefined
      const named = typeof value === 'object' && value !== null && 'name' in value
      return { result: { nodes: named ? [{ type: 'node', sharedId: 'save-button', value: { localName: 'button' } }] : [{ type: 'node', sharedId: 'save-button' }, { type: 'node', sharedId: 'other-button' }] } }
    })
    onScript(() => ({ result: { type: 'success', result: { type: 'string', value: JSON.stringify([['Save'], ['Other']]) } } }))
    const { bridge: made } = bridge()
    const scope = { session: made.session, context: 7, objectGroup: 'group' }
    const elements = await made.resolving({ by: 'role', role: 'button', name: 'Save' }, () => elementsByRole(scope, { roles: ['button'], name: 'Save', exact: true }, new Deadline(2000)))
    assert.deepEqual(elements, [{ objectId: 'save-button' }])
    const asked = endpoint.commands('browsingContext.locateNodes').map((command) => command.params['locator'])
    assert.deepEqual(asked, [{ type: 'accessibility', value: { role: 'button', name: 'Save' } }, { type: 'accessibility', value: { role: 'button' } }], 'raw candidates are checked for names that normalize alike')
  })

  test("an image is asked of Firefox by the role name its locator knows, image, and a cell by name is refused before anything is sent", async () => {
    endpoint.on('browsingContext.locateNodes', () => ({ result: { nodes: [{ type: 'node', sharedId: 'badge', value: { localName: 'svg' } }] } }))
    const { bridge: made } = bridge()
    const scope = { session: made.session, context: 7, objectGroup: 'group' }
    onScript(() => ({ result: { type: 'success', result: { type: 'string', value: JSON.stringify([['Badge']]) } } }))
    const images = await made.resolving({ by: 'role', role: 'img', name: 'Badge' }, () => elementsByRole(scope, { roles: ['image'], name: 'Badge', exact: true }, new Deadline(2000)))
    assert.deepEqual(images, [{ objectId: 'badge' }])
    assert.deepEqual(endpoint.commands('browsingContext.locateNodes').map((command) => command.params['locator']), [{ type: 'accessibility', value: { role: 'image', name: 'Badge' } }, { type: 'accessibility', value: { role: 'image' } }])
    endpoint.sent.length = 0
    const refused = await made.resolving({ by: 'role', role: 'cell', name: 'Grace Hopper' }, async () => assert.fail('nothing is looked up')).catch((error: unknown) => error)
    assert.ok(refused instanceof BrowserError)
    assert.equal(refused.failure.class, 'unsupported')
    assert.match(refused.failure.message, /^Could not look up getByRole\('cell', \{ name: 'Grace Hopper' \}\): Chrome names a cell from its text, and Firefox's accessibility tree does not/)
    assert.equal(endpoint.sent.length, 0)
    const any = await made.resolving({ by: 'role', role: 'cell' }, async () => 'looked up')
    assert.equal(any, 'looked up', 'every cell, by no name, is looked up as on Chrome')
  })

  test('a loose name reads every name of the role from Firefox: the names the markup suggests, each confirmed by an exact match', async () => {
    endpoint.on('browsingContext.locateNodes', (params) => {
      const value = Reflect.get(Object(params['locator']), 'value')
      const name: unknown = Reflect.get(Object(value), 'name')
      const all = [{ type: 'node', sharedId: 'a', value: { localName: 'button' } }, { type: 'node', sharedId: 'b', value: { localName: 'button' } }]
      if (name === undefined) return { result: { nodes: all } }
      return { result: { nodes: name === 'Save draft' ? [all[0]] : name === 'Cancel' ? [all[1]] : [] } }
    })
    onScript(() => ({ result: { realm: 'r', type: 'success', result: { type: 'string', value: JSON.stringify([['Save draft', 'Save'], ['Cancel']]) } } }))
    const { bridge: made } = bridge()
    const scope = { session: made.session, context: 7, objectGroup: 'group' }
    const elements = await made.resolving({ by: 'role', role: 'button', name: 'save', exact: false }, () => elementsByRole(scope, { roles: ['button'], name: 'save', exact: false }, new Deadline(2000)))
    assert.deepEqual(elements, [{ objectId: 'a' }])
  })

  test('a loose name is refused by name when Firefox computed a name for an element that none of its markup confirms', async () => {
    endpoint.on('browsingContext.locateNodes', (params) => {
      const name: unknown = Reflect.get(Object(Reflect.get(Object(params['locator']), 'value')), 'name')
      return { result: { nodes: name === undefined ? [{ type: 'node', sharedId: 'a', value: { localName: 'button' } }] : [] } }
    })
    onScript(() => ({ result: { realm: 'r', type: 'success', result: { type: 'string', value: JSON.stringify([['Guess']]) } } }))
    const { bridge: made } = bridge()
    const scope = { session: made.session, context: 7, objectGroup: 'group' }
    const refused = await made.resolving({ by: 'role', role: 'button', name: { pattern: 'sa', flags: '' } }, () => elementsByRole(scope, { roles: ['button'], name: { pattern: 'sa', flags: '' }, exact: true }, new Deadline(2000))).catch((error: unknown) => error)
    assert.ok(refused instanceof BrowserError)
    assert.equal(refused.failure.class, 'unsupported')
    assert.match(refused.failure.message, /Firefox computed an accessible name for a button, <button>, that Retest could not read back/)
  })

  // Review F-1: the names a lookup asks for were kept in one field per page, so a second look started meanwhile
  // answered the first look's query with its own names, and a visible button counted 0.
  test('two looks at once each ask Firefox for their own names, however their round trips interleave', async () => {
    const nodes: Record<string, { type: 'node'; sharedId: string; value: { localName: string } }> = {
      Delete: { type: 'node', sharedId: 'delete-button', value: { localName: 'button' } },
      Publish: { type: 'node', sharedId: 'publish-button', value: { localName: 'button' } },
    }
    endpoint.on('browsingContext.locateNodes', async (params) => {
      const name: unknown = Reflect.get(Object(Reflect.get(Object(params['locator']), 'value')), 'name')
      // The second look's match is slow, so the first look's query is made while the second is still on its way.
      if (name === 'Publish') await new Promise((resolve) => setTimeout(resolve, 100))
      const node = typeof name === 'string' ? nodes[name] : undefined
      return { result: { nodes: node === undefined ? [] : [node] } }
    })
    const { bridge: made } = bridge()
    const scope = { session: made.session, context: 7, objectGroup: 'group' }
    const { promise: firstMayAsk, resolve: letFirstAsk } = Promise.withResolvers<void>()
    const first = made.resolving({ by: 'role', role: 'button', name: 'Delete' }, async () => {
      await firstMayAsk
      return elementsByRole(scope, { roles: ['button'], name: 'Delete', exact: true }, new Deadline(2000))
    })
    const second = made.resolving({ by: 'role', role: 'button', name: 'Publish' }, () => elementsByRole(scope, { roles: ['button'], name: 'Publish', exact: true }, new Deadline(2000)))
    await new Promise((resolve) => setTimeout(resolve, 20))
    letFirstAsk()
    assert.deepEqual(await Promise.all([first, second]), [[{ objectId: 'delete-button' }], [{ objectId: 'publish-button' }]])
    const asked = endpoint.commands('browsingContext.locateNodes').map((command) => Reflect.get(Object(Reflect.get(Object(command.params['locator']), 'value')), 'name'))
    assert.deepEqual(asked.filter((name) => name !== undefined).sort(), ['Delete', 'Publish'], 'each look asked for its own name once')
  })

  // Review F-9: each round trip of a loose name was given the whole budget again, so a look of many confirmations
  // answered long after its deadline.
  test('a loose name over many names is bounded by the look\'s own deadline, not by each round trip', async () => {
    const count = 48
    const all = Array.from({ length: count }, (_, index) => ({ type: 'node', sharedId: `node-${index}`, value: { localName: 'button' } }))
    endpoint.on('browsingContext.locateNodes', async (params) => {
      const name: unknown = Reflect.get(Object(Reflect.get(Object(params['locator']), 'value')), 'name')
      if (name === undefined) return { result: { nodes: all } }
      await new Promise((resolve) => setTimeout(resolve, 100))
      const index = typeof name === 'string' ? Number(name.slice('name '.length)) : -1
      return { result: { nodes: all[index] === undefined ? [] : [all[index]] } }
    })
    onScript(() => ({ result: { realm: 'r', type: 'success', result: { type: 'string', value: JSON.stringify(all.map((_, index) => [`name ${index}`])) } } }))
    const { bridge: made } = bridge()
    const scope = { session: made.session, context: 7, objectGroup: 'group' }
    const startedAt = performance.now()
    const looked = await made.resolving({ by: 'role', role: 'button', name: 'name', exact: false }, () => elementsByRole(scope, { roles: ['button'], name: 'name', exact: false }, new Deadline(150))).then(
      () => 'answered',
      (error: unknown) => error,
    )
    const elapsedMs = performance.now() - startedAt
    assert.ok(elapsedMs < 260, `the look ended within its budget of 150 ms and a margin, after ${Math.round(elapsedMs)} ms`)
    assert.ok(looked instanceof Error, `the look that ran out of time failed rather than answering late: ${String(looked)}`)
  })

  test('input goes to Firefox as a BiDi command, counted by the same dispatch as on Chromium', async () => {
    endpoint.accept('input.performActions')
    const { bridge: made } = bridge()
    const dispatch = new Dispatch()
    await dispatch.send(made.session, 'input.performActions', { context, actions: [] }, new Deadline(2000))
    assert.equal(dispatch.input, 'sent')
    endpoint.on('input.performActions', () => ({ error: 'invalid argument', message: 'Expected "value" to be a single code point, got hunter2' }))
    const failed = new Dispatch()
    const error = await failed.send(made.session, 'input.performActions', { context, actions: [] }, new Deadline(2000)).catch((caught: unknown) => caught)
    assert.ok(error instanceof CdpProtocolError)
    assert.equal(error.protocolMessage, 'invalid argument', "Firefox's message, which quotes what was typed, is dropped")
    assert.equal(failed.input, 'unknown', 'an input Firefox answered with an error may still have gone')
  })

  test("a navigation Firefox refuses at once keeps Firefox's reason and nothing else of its message", async () => {
    endpoint.on('browsingContext.navigate', () => ({ error: 'unknown error', message: 'Error: deniedPortAccess' }))
    const { bridge: made } = bridge()
    const error = await made.session.send('browsingContext.navigate', { context, url: 'http://127.0.0.1:1/', wait: 'none' }).catch((caught: unknown) => caught)
    assert.ok(error instanceof CdpProtocolError)
    assert.equal(error.protocolMessage, 'unknown error: deniedPortAccess')
  })

  test('a DevTools method the helpers never send is refused by name', async () => {
    const { bridge: made } = bridge()
    await assert.rejects(made.session.send('Page.navigate', { url: 'http://127.0.0.1/' }), /The Firefox driver does not answer the DevTools method Page\.navigate\./)
  })

  test('a prompt that holds the page fails the calls waiting on it, and refuses new ones, until it closes', async () => {
    scriptCalls(() => 'silent')
    const { bridge: made, world } = bridge()
    const waiting = world.call('function waits() {}', [], s.string(), new Deadline(5000)).catch((error: unknown) => error)
    await new Promise((resolve) => setTimeout(resolve, 30))
    made.channel.block('a JavaScript alert dialog holds the page')
    const blocked = await waiting
    assert.ok(blocked instanceof CdpBlockedError, String(blocked))
    assert.equal(blocked.written, true)
    const refused = await made.session.send('input.performActions', {}).catch((error: unknown) => error)
    assert.ok(refused instanceof CdpBlockedError)
    assert.equal(refused.written, false)
    made.channel.unblock()
    endpoint.accept('input.performActions')
    assert.deepEqual(await made.session.send('input.performActions', {}), {})
  })
})

test('an exact name is confirmed against raw candidates whose whitespace Retest normalizes', async () => {
  endpoint.on('browsingContext.locateNodes', (params) => {
    const name: unknown = Reflect.get(Object(Reflect.get(Object(params['locator']), 'value')), 'name')
    return { result: { nodes: name === undefined || name === 'Save\u00a0now' ? [{ type: 'node', sharedId: 'save', value: { localName: 'button' } }] : [] } }
  })
  onScript(() => ({ result: { type: 'success', result: { type: 'string', value: JSON.stringify([['Save\u00a0now']]) } } }))
  const { bridge: made } = bridge()
  const scope = { session: made.session, context: 7, objectGroup: 'group' }
  try {
    assert.deepEqual(await made.resolving({ by: 'role', role: 'button', name: 'Save now' }, () => elementsByRole(scope, { roles: ['button'], name: 'Save now', exact: true }, new Deadline(2000))), [{ objectId: 'save' }])
  } finally { made.dispose() }
})

test('a lookup whose role membership differs is refused by its own name before it can return a count', async () => {
  const { bridge: made } = bridge()
  try {
    for (const role of ['none', 'presentation', 'rowgroup', 'gridcell'] as const) {
      const error = await made.resolving({ by: 'role', role }, async () => 0).catch((caught: unknown) => caught)
      assert.ok(error instanceof BrowserError)
      assert.equal(error.failure.class, 'unsupported')
      assert.equal(error.failure.details?.['role'], role)
      assert.match(error.failure.message, new RegExp(`^Could not look up getByRole\\('` + role))
    }
  } finally { made.dispose() }
})
