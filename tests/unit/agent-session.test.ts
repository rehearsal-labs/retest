import type { TestContext } from 'node:test'
import type { AgentHostOptions, AgentOpenRequest } from '../../src/agent/host.ts'
import type { AgentSession } from '../../src/agent/session.ts'
import type { AgentFakeOptions, AgentFakePage, FakeElement } from './agent-fakes.ts'
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { AgentHost, openProblem } from '../../src/agent/host.ts'
import { readCommand } from '../../src/agent/session.ts'
import { SessionBudget } from '../../src/runner/sessions.ts'
import { AgentFramedPage, agentFakeLauncher } from './agent-fakes.ts'

// An agent session's calls with a fake browser: looks hand out references with the session's id, an action on a
// reference reads the look again and refuses a stale one sending nothing, a reference acts only on the element it
// names (pinned on a driver that keys elements, its look's single element on one that cannot), a reference becomes a
// durable recipe only when a read proves it finds that element, one action runs at a time, a caller holds its session
// through a lease, saved state goes only where the host restores it, secrets are typed only on their origins and only
// by the sessions allowed them, never shown back, and frames carry the session.

type Opened = { session: AgentSession; page: AgentFakePage; host: AgentHost }

async function openSession(t: TestContext, options: { fake?: AgentFakeOptions; request?: Partial<AgentOpenRequest>; host?: Partial<AgentHostOptions> } = {}): Promise<Opened> {
  const { launch, browsers } = agentFakeLauncher(options.fake)
  const host = new AgentHost({
    targets: { chrome: { engine: 'chromium', executablePath: '/fake/chrome' } },
    budget: new SessionBudget({ perOwner: 4, host: 8 }),
    logFolder: '/tmp/retest-agent-unit-logs',
    launchers: { chromium: launch },
    timeouts: { setup: 2000, action: 1000, navigation: 1000, assertion: 300, cleanup: 300 },
    ...options.host,
  })
  t.after(() => host.close())
  const opened = await host.open({ owner: 'agent-1', app: 'owner', purpose: 'discovery', target: 'chrome', engine: 'chromium', baseUrl: 'http://127.0.0.1:4173', ...options.request })
  assert.ok(opened.ok, opened.ok ? '' : opened.failure.message)
  const page = browsers.at(-1)?.pages.at(-1)
  assert.ok(page !== undefined)
  return { session: opened.session, page, host }
}

const buttons = { by: 'role', role: 'button' } as const
const toolbar = [
  { role: 'button', name: 'Save', testId: 'save-task', text: 'Save' },
  { role: 'button', name: 'Cancel', testId: 'cancel', text: 'Cancel' },
  { role: 'button', name: 'Delete', testId: 'delete', text: 'Delete' },
]

describe('looks and references', () => {
  test('a look lists each element with a reference naming the session and the look', async (t) => {
    const { session, page } = await openSession(t)
    page.show(toolbar)
    const observed = await session.observe(buttons)
    assert.ok(observed.ok)
    const { look } = observed
    assert.equal(look.sessionId, session.sessionId)
    assert.equal(look.observationId, 'o1')
    assert.deepEqual(look.elements.map((element) => [element.text, element.ref]), [
      ['Save', { sessionId: session.sessionId, observationId: 'o1', element: 0 }],
      ['Cancel', { sessionId: session.sessionId, observationId: 'o1', element: 1 }],
      ['Delete', { sessionId: session.sessionId, observationId: 'o1', element: 2 }],
    ])
    assert.equal(look.observation.count, 3)
  })

  // Run on a driver that keys elements: on one that cannot, a reference into a list of three is refused by name (below).
  test('an action on a reference reads the look again, then acts on that element by its place', async (t) => {
    const { session, page } = await openSession(t, { fake: { identity: true } })
    page.show(toolbar)
    const observed = await session.observe(buttons)
    assert.ok(observed.ok)
    const target = observed.look.elements[1]
    assert.ok(target !== undefined)
    const action = await session.act({ kind: 'click', ref: target.ref })
    assert.ok(action.result.ok, action.result.ok ? '' : action.result.failure.message)
    assert.equal(action.input, 'sent')
    assert.deepEqual(action.locator, { by: 'role', role: 'button', pick: 1 })
    assert.deepEqual(page.commands.map((command) => command.kind), ['observe', 'observe', 'click'])
  })

  test('a reference whose look no longer matches the page is refused, and nothing is sent', async (t) => {
    const { session, page } = await openSession(t)
    page.show(toolbar)
    const observed = await session.observe(buttons)
    assert.ok(observed.ok)
    page.show(toolbar.slice(1))
    const ref = observed.look.elements[0]?.ref
    assert.ok(ref !== undefined)
    const action = await session.act({ kind: 'click', ref })
    assert.ok(!action.result.ok)
    assert.equal(action.input, 'not_sent')
    assert.equal(action.result.failure.details?.['refused'], 'changed')
    assert.match(action.result.failure.message, /^o1\.e0 of [a-z0-9]{10}:owner is stale: what o1 saw of getByRole\('button'\) has changed \(it saw 3 matches and the page now has 2\)\. Look again\.$/)
    assert.deepEqual(page.commands.map((command) => command.kind), ['observe', 'observe'], 'no click went')
  })

  test('a reference from before the page opened another document is refused without asking the page', async (t) => {
    const { session, page } = await openSession(t)
    page.show(toolbar)
    const observed = await session.observe(buttons)
    assert.ok(observed.ok)
    page.open('/tasks')
    const ref = observed.look.elements[0]?.ref
    assert.ok(ref !== undefined)
    const action = await session.act({ kind: 'click', ref })
    assert.ok(!action.result.ok)
    assert.equal(action.result.failure.details?.['refused'], 'new-document')
    assert.deepEqual(page.commands.map((command) => command.kind), ['observe'])
  })

  test("another session's reference is refused, even for a look with the same id on the same page", async (t) => {
    const discovery = await openSession(t)
    const reproduction = await openSession(t, { request: { purpose: 'reproduction' } })
    discovery.page.show(toolbar)
    reproduction.page.show(toolbar)
    const seen = await discovery.session.observe(buttons)
    const own = await reproduction.session.observe(buttons)
    assert.ok(seen.ok && own.ok)
    assert.equal(own.look.observationId, seen.look.observationId, 'both sessions served o1')
    const ref = seen.look.elements[0]?.ref
    assert.ok(ref !== undefined)
    const action = await reproduction.session.act({ kind: 'click', ref })
    assert.ok(!action.result.ok)
    assert.equal(action.result.failure.details?.['refused'], 'other-session')
    assert.deepEqual(reproduction.page.commands.map((command) => command.kind), ['observe'], 'the reproduction page got no click')
  })

  test('an action that names an element by a locator and a reference at once is refused', async (t) => {
    const { session } = await openSession(t)
    const both = { kind: 'click', locator: buttons, ref: { sessionId: session.sessionId, observationId: 'o1', element: 0 } }
    const read = readCommand(both)
    assert.ok(!read.ok)
    assert.match(read.failure.message, /a locator or by a reference, not both/)
    assert.ok(!readCommand({ kind: 'goto', url: '/', ref: { sessionId: 'a:b', observationId: 'o1', element: 0 } }).ok)
    assert.ok(!readCommand({ kind: 'observe', locator: buttons }).ok)
    assert.ok(!readCommand({ kind: 'tap', locator: buttons }).ok)
  })
})

describe('actions without an element', () => {
  // On a driver that keys elements, so the reference into a list of three is pinned rather than refused.
  test('a press and a scroll take a reference, a locator or neither, and a navigation takes none', async (t) => {
    const { session, page } = await openSession(t, { fake: { identity: true } })
    page.show(toolbar)
    const observed = await session.observe(buttons)
    assert.ok(observed.ok)
    const ref = observed.look.elements[2]?.ref
    assert.ok(ref !== undefined)
    const pressed = await session.act({ kind: 'press', ref, key: 'Enter' })
    assert.ok(pressed.result.ok, pressed.result.ok ? '' : pressed.result.failure.message)
    assert.deepEqual(pressed.locator, { by: 'role', role: 'button', pick: 2 })
    const keyboard = await session.act({ kind: 'press', key: 'Tab' })
    assert.ok(keyboard.result.ok)
    assert.equal(keyboard.locator, undefined)
    const scrolled = await session.act({ kind: 'scroll', x: 0, y: 200 })
    assert.ok(scrolled.result.ok)
    const badKey = await session.act({ kind: 'press', key: 'NoSuchKey' })
    assert.ok(!badKey.result.ok)
    assert.equal(badKey.input, 'not_sent')
    assert.deepEqual(page.commands.map((command) => command.kind), ['observe', 'observe', 'press', 'press', 'scroll'])
  })
})

describe('durable recipes from references', () => {
  // On a driver that keys elements, so the recipe is proven by the node it finds, not by the text it shows.
  test('a reference becomes a recipe by naming what it matched', async (t) => {
    const { session, page } = await openSession(t, { fake: { identity: true } })
    page.show(toolbar)
    const observed = await session.observe(buttons)
    assert.ok(observed.ok)
    const ref = observed.look.elements[0]?.ref
    assert.ok(ref !== undefined)
    const recipe = await session.recipe(ref, { by: 'testId', value: 'save-task' })
    assert.deepEqual(recipe, { ok: true, locator: { by: 'testId', value: 'save-task' }, described: "getByTestId('save-task')" })
    const wrong = await session.recipe(ref, { by: 'testId', value: 'cancel' })
    assert.ok(!wrong.ok)
    assert.equal(wrong.failure.details?.['refused'], 'other-element')
    const placed = await session.recipe(ref, { ...buttons, pick: 0 })
    assert.ok(!placed.ok)
    assert.equal(placed.failure.details?.['refused'], 'placed')
  })

  test('a stale reference becomes no recipe', async (t) => {
    const { session, page } = await openSession(t)
    page.show(toolbar)
    const observed = await session.observe(buttons)
    assert.ok(observed.ok)
    page.show([...toolbar, { role: 'button', name: 'Archive', text: 'Archive' }])
    const ref = observed.look.elements[0]?.ref
    assert.ok(ref !== undefined)
    const recipe = await session.recipe(ref, { by: 'testId', value: 'save-task' })
    assert.ok(!recipe.ok)
    assert.equal(recipe.failure.details?.['refused'], 'changed')
  })
})

describe('one action at a time', () => {
  test('an action or a look while an action runs is refused before the page is asked; a frame is taken beside it', async (t) => {
    const { session, page } = await openSession(t, { fake: { hold: 'click' } })
    page.show(toolbar)
    const clicking = session.act({ kind: 'click', locator: { by: 'testId', value: 'save-task' } })
    await new Promise((resolve) => setImmediate(resolve))
    const second = await session.act({ kind: 'click', locator: { by: 'testId', value: 'cancel' } })
    assert.ok(!second.result.ok)
    assert.equal(second.result.failure.class, 'concurrent_commands')
    assert.equal(second.input, 'not_sent')
    const look = await session.observe(buttons)
    assert.ok(!look.ok)
    assert.equal(look.failure.class, 'concurrent_commands')
    const frame = await session.frame()
    assert.ok(frame.ok)
    page.release()
    assert.ok((await clicking).result.ok)
    assert.deepEqual(page.commands.map((command) => command.kind), ['click'])
  })

  test('looks may run beside each other', async (t) => {
    const { session, page } = await openSession(t)
    page.show(toolbar)
    const [first, second] = await Promise.all([session.observe(buttons), session.observe({ by: 'testId', value: 'save-task' })])
    assert.ok(first.ok && second.ok)
    assert.deepEqual([first.look.observationId, second.look.observationId].sort(), ['o1', 'o2'])
  })
})

describe('saved sign-in state', () => {
  test('state saved from one session restores into a new session only when the host passes it', async (t) => {
    const discovery = await openSession(t)
    discovery.page.show([{ testId: 'sign-in', text: 'Sign in' }])
    assert.ok((await discovery.session.act({ kind: 'click', locator: { by: 'testId', value: 'sign-in' } })).result.ok)
    const saved = await discovery.session.saveState()
    assert.ok(saved.ok)
    assert.equal(saved.state.savedFrom, discovery.session.sessionId)
    assert.equal(saved.state.storage.cookies[0]?.name, 'session')
    const reproduction = await openSession(t, { request: { purpose: 'reproduction', state: saved.state } })
    assert.deepEqual(reproduction.page.cookies, saved.state.storage.cookies)
    assert.equal(reproduction.session.restoredFrom, discovery.session.sessionId)
    const fresh = await openSession(t, { request: { purpose: 'reproduction' } })
    assert.deepEqual(fresh.page.cookies, [], 'without saved state a session starts empty')
    assert.equal(fresh.session.restoredFrom, undefined)
  })

  test('state that is not one a session saved is refused', () => {
    const targets = new Map([['chrome', { engine: 'chromium', executablePath: '/fake/chrome' } as const]])
    const problem = openProblem({ owner: 'agent-1', app: 'member', purpose: 'reproduction', target: 'chrome', engine: 'chromium', state: { storage: { cookies: 'all' }, savedFrom: 'x', savedAt: 'y' } }, targets)
    assert.equal(problem?.class, 'usage')
    assert.match(problem?.message ?? '', /state\.storage:/)
  })
})

describe('secrets', () => {
  const secrets = { values: { password: { value: 'correct horse battery staple' } } }

  test("a secret is typed only on its session's origin, and no answer shows it", async (t) => {
    const { session, page } = await openSession(t, { host: { secrets } })
    page.show([{ testId: 'password', text: '' }, { testId: 'echo', text: 'You typed correct horse battery staple' }])
    const offOrigin = await session.act({ kind: 'fill', locator: { by: 'testId', value: 'password' }, value: { secret: 'password' } })
    assert.ok(!offOrigin.result.ok, 'the page has opened no address yet')
    assert.equal(offOrigin.input, 'not_sent')
    assert.match(offOrigin.result.failure.message, /did not type the secret "password"/)
    assert.ok((await session.act({ kind: 'goto', url: '/login' })).result.ok)
    const typed = await session.act({ kind: 'fill', locator: { by: 'testId', value: 'password' }, value: { secret: 'password' } })
    assert.ok(typed.result.ok, typed.result.ok ? '' : typed.result.failure.message)
    assert.deepEqual(page.typed, [{ testId: 'password', value: 'correct horse battery staple', secret: 'password' }])
    const echoed = await session.observe({ by: 'testId', value: 'echo' })
    assert.ok(echoed.ok)
    assert.equal(echoed.look.elements[0]?.text, 'You typed {{password}}')
    assert.equal(JSON.stringify(echoed).includes('correct horse'), false)
  })

  test('a locator holding a secret never reaches the page', async (t) => {
    const { session, page } = await openSession(t, { host: { secrets } })
    const look = await session.observe({ by: 'text', text: 'correct horse battery staple' })
    assert.ok(!look.ok)
    assert.match(look.failure.message, /holds the value of a secret/)
    assert.deepEqual(page.commands, [])
  })

  test('a session without secrets refuses a secret fill by name', async (t) => {
    const { session } = await openSession(t)
    const action = await session.act({ kind: 'fill', locator: { by: 'testId', value: 'password' }, value: { secret: 'password' } })
    assert.ok(!action.result.ok)
    assert.match(action.result.failure.message, /This agent host holds none\./)
  })
})

describe('frames', () => {
  test('a frame is the PNG the driver gave, with the session', async (t) => {
    const { session } = await openSession(t)
    const framed = await session.frame()
    assert.ok(framed.ok)
    assert.deepEqual([...framed.frame.bytes.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47])
    assert.equal(framed.frame.format, 'png')
    assert.equal(framed.frame.sessionId, session.sessionId)
  })

  test("a driver's live frame source carries the session's identity, and stops when the session ends", async (t) => {
    const { session, page } = await openSession(t, { fake: { frameSource: true } })
    const granted = session.frameSource()
    assert.ok(granted.ok)
    assert.deepEqual(granted.source.identity, { testId: 'discovery', attemptId: session.identity.owner.attemptId, app: 'owner', sessionId: session.sessionId })
    await session.end()
    assert.ok(page instanceof AgentFramedPage)
    assert.equal(page.sources[0]?.stopped, 1)
  })

  test('a driver with no live frame source is refused by name', async (t) => {
    const { session } = await openSession(t)
    const granted = session.frameSource()
    assert.ok(!granted.ok)
    assert.equal(granted.failure.class, 'unsupported')
    assert.match(granted.failure.message, /^The chromium driver gives no live frame source of a page\./)
  })
})

// Three empty fields, each its own node, and the same three put in another order, as an app that sorts its rows does.
function fields(): { first: FakeElement; second: FakeElement; third: FakeElement; all: FakeElement[]; sorted: FakeElement[] } {
  const first = { testId: 'f-1', role: 'textbox', text: '' }
  const second = { testId: 'f-2', role: 'textbox', text: '' }
  const third = { testId: 'f-3', role: 'textbox', text: '' }
  return { first, second, third, all: [first, second, third], sorted: [third, first, second] }
}

const textboxes = { by: 'role', role: 'textbox' } as const

// Waits until the page holds a command of `kind`, so a test can change the page while that command waits.
async function heldCommand(page: AgentFakePage, kind: string): Promise<void> {
  for (let tick = 0; tick < 200 && !page.commands.some((command) => command.kind === kind); tick++) await new Promise((resolve) => setImmediate(resolve))
  assert.ok(page.commands.some((command) => command.kind === kind), `the page holds a ${kind}`)
}

describe('a reference acts only on the element it names', () => {
  test('on a driver that cannot pin, a reference into fields that show the same is refused by name after a re-sort, and nothing is typed', async (t) => {
    const { session, page } = await openSession(t)
    assert.equal(session.pinsElements, false)
    const { all, sorted } = fields()
    page.show(all)
    const look = await session.observe(textboxes)
    assert.ok(look.ok)
    const second = look.look.elements[1]
    assert.ok(second !== undefined)
    page.show(sorted)
    const acted = await session.act({ kind: 'fill', ref: second.ref, value: 'meant for f-2' })
    assert.ok(!acted.result.ok)
    assert.equal(acted.input, 'not_sent')
    assert.deepEqual(acted.result.failure.details, { refused: 'unpinned', ref: 'o1.e1', sessionId: session.sessionId, engine: 'chromium' })
    assert.match(acted.result.failure.message, /^o1\.e1 of [a-z0-9]{10}:owner is one of 3 elements o1 lists of getByRole\('textbox'\), and the chromium driver cannot hold one element from a look to an action, so the page could put another of them in its place before the input goes\. Retest sent nothing\./)
    assert.deepEqual(page.typed, [])
  })

  test('on a driver that cannot pin, a reference into a longer list is refused by name, even with every element showing its own text', async (t) => {
    const { session, page } = await openSession(t)
    page.show(toolbar)
    const look = await session.observe(buttons)
    assert.ok(look.ok)
    const cancel = look.look.elements[1]
    assert.ok(cancel !== undefined)
    const acted = await session.act({ kind: 'click', ref: cancel.ref })
    assert.ok(!acted.result.ok)
    assert.equal(acted.result.failure.details?.['refused'], 'unpinned')
    assert.deepEqual(page.commands.map((command) => command.kind), ['observe', 'observe'], 'no click went')
  })

  test('on a driver that cannot pin, a reference to a look that keeps a match by its place is refused by name', async (t) => {
    const { session, page } = await openSession(t)
    page.show(toolbar)
    const look = await session.observe({ ...buttons, pick: 'first' })
    assert.ok(look.ok)
    const first = look.look.elements[0]
    assert.ok(first !== undefined)
    const acted = await session.act({ kind: 'click', ref: first.ref })
    assert.ok(!acted.result.ok)
    assert.equal(acted.result.failure.details?.['refused'], 'unpinned')
    assert.match(acted.result.failure.message, /^o1 keeps a match of getByRole\('button'\)\.first\(\) by its place/)
  })

  test("a reference to the only element its look listed acts through the look's own locator, so an element that appears beside it before the input goes refuses the action instead of moving it", async (t) => {
    const { session, page } = await openSession(t, { fake: { hold: 'click' } })
    const save = { role: 'button', name: 'Save', testId: 'save-task', text: 'Save' }
    page.show([save])
    const look = await session.observe({ by: 'role', role: 'button', name: 'Save' })
    assert.ok(look.ok)
    const only = look.look.elements[0]
    assert.ok(only !== undefined)
    const clicking = session.act({ kind: 'click', ref: only.ref })
    await heldCommand(page, 'click')
    page.show([{ role: 'button', name: 'Save', testId: 'save-draft', text: 'Save' }, save])
    page.release()
    const acted = await clicking
    assert.ok(!acted.result.ok)
    assert.equal(acted.result.failure.class, 'ambiguous')
    assert.equal(acted.input, 'not_sent')
    assert.deepEqual(acted.locator, { by: 'role', role: 'button', name: 'Save' }, "the look's own locator, keeping no place")
  })

  test('on a driver that pins, a reference into fields that show the same acts on its own node', async (t) => {
    const { session, page } = await openSession(t, { fake: { identity: true } })
    assert.equal(session.pinsElements, true)
    const { all } = fields()
    page.show(all)
    const look = await session.observe(textboxes)
    assert.ok(look.ok)
    const second = look.look.elements[1]
    assert.ok(second !== undefined)
    const acted = await session.act({ kind: 'fill', ref: second.ref, value: 'meant for f-2' })
    assert.ok(acted.result.ok, acted.result.ok ? '' : acted.result.failure.message)
    assert.deepEqual(page.typed, [{ testId: 'f-2', value: 'meant for f-2' }])
  })

  test('on a driver that pins, a re-sort before the action is refused as stale, and one while the action waits is refused as moved; nothing is typed', async (t) => {
    const { session, page } = await openSession(t, { fake: { identity: true, hold: 'fill' } })
    const { all, sorted } = fields()
    page.show(all)
    const before = await session.observe(textboxes)
    assert.ok(before.ok)
    const stale = before.look.elements[1]
    assert.ok(stale !== undefined)
    page.show(sorted)
    const refused = await session.act({ kind: 'fill', ref: stale.ref, value: 'meant for f-2' })
    assert.ok(!refused.result.ok)
    assert.deepEqual([refused.input, refused.result.failure.details?.['refused']], ['not_sent', 'changed'])

    page.show(all)
    const again = await session.observe(textboxes)
    assert.ok(again.ok)
    const second = again.look.elements[1]
    assert.ok(second !== undefined)
    const filling = session.act({ kind: 'fill', ref: second.ref, value: 'meant for f-2' })
    await heldCommand(page, 'fill')
    page.show(sorted)
    page.release()
    const moved = await filling
    assert.ok(!moved.result.ok)
    assert.equal(moved.input, 'not_sent')
    assert.equal(moved.result.failure.details?.['refused'], 'moved')
    assert.deepEqual(page.typed, [])
  })
})

describe('a recipe is proven, never guessed from text', () => {
  const rows = (): FakeElement[] => [
    { testId: 'row-1-delete', role: 'button', name: 'Delete', text: 'Delete' },
    { testId: 'row-2-delete', role: 'button', name: 'Delete', text: 'Delete' },
  ]

  test('on a driver that cannot compare elements, a recipe naming another element that shows the same text is refused by name', async (t) => {
    const { session, page } = await openSession(t)
    page.show(rows())
    const row2 = await session.observe({ by: 'testId', value: 'row-2-delete' })
    assert.ok(row2.ok)
    const ref = row2.look.elements[0]?.ref
    assert.ok(ref !== undefined)
    const recipe = await session.recipe(ref, { by: 'testId', value: 'row-1-delete' })
    assert.ok(!recipe.ok)
    assert.deepEqual(recipe.failure.details, { refused: 'unproven', engine: 'chromium' })
    const own = await session.recipe(ref, { by: 'testId', value: 'row-2-delete' })
    assert.deepEqual(own, { ok: true, locator: { by: 'testId', value: 'row-2-delete' }, described: "getByTestId('row-2-delete')" }, "the look's own locator, finding one element, is the recipe")
  })

  test('on a driver that keys elements, a recipe finding another node is refused, and one finding the referenced node is proven', async (t) => {
    const { session, page } = await openSession(t, { fake: { identity: true } })
    page.show(rows())
    const row2 = await session.observe({ by: 'testId', value: 'row-2-delete' })
    assert.ok(row2.ok)
    const ref = row2.look.elements[0]?.ref
    assert.ok(ref !== undefined)
    const other = await session.recipe(ref, { by: 'testId', value: 'row-1-delete' })
    assert.ok(!other.ok)
    assert.equal(other.failure.details?.['refused'], 'other-element')
    const both = await session.recipe(ref, { by: 'role', role: 'button', name: 'Delete' })
    assert.ok(!both.ok)
    assert.equal(both.failure.class, 'ambiguous')
    const deletes = await session.observe({ by: 'role', role: 'button', name: 'Delete' })
    assert.ok(deletes.ok)
    const second = deletes.look.elements[1]?.ref
    assert.ok(second !== undefined)
    assert.ok((await session.recipe(second, { by: 'testId', value: 'row-2-delete' })).ok, 'the second Delete of the look is the node row-2-delete finds')
  })
})

describe("the caller's lease and the host's hold", () => {
  test("an open asking to stay longer than the host's hold is refused by name, holding nothing", async (t) => {
    const { launch, browsers } = agentFakeLauncher()
    const budget = new SessionBudget({ perOwner: 4, host: 8 })
    const host = new AgentHost({ targets: { chrome: { engine: 'chromium', executablePath: '/fake/chrome' } }, budget, logFolder: '/tmp/retest-agent-unit-logs', launchers: { chromium: launch }, timeouts: { hold: 1000 } })
    t.after(() => host.close())
    const opened = await host.open({ owner: 'agent-1', app: 'owner', purpose: 'discovery', target: 'chrome', engine: 'chromium', holdMs: 2_147_483_647 })
    assert.ok(!opened.ok)
    assert.equal(opened.failure.class, 'usage')
    assert.equal(opened.failure.details?.['refused'], 'hold')
    assert.match(opened.failure.message, /this host keeps a session open at most 1000 ms, its timeouts\.hold, and the request asked for 2147483647\.$/)
    assert.deepEqual([browsers.length, budget.snapshot().host], [0, 0])
  })

  test('a session whose caller goes silent for its whole lease is ended, its context closed and its session given back', async (t) => {
    const budget = new SessionBudget({ perOwner: 1, host: 1 })
    const { session, page } = await openSession(t, { host: { budget, timeouts: { setup: 2000, action: 1000, navigation: 1000, assertion: 300, cleanup: 300, lease: 150 } } })
    assert.equal(session.leaseMs, 150)
    const ended = await session.ended
    assert.deepEqual(ended, { ok: true, ending: { kind: 'caller_silent', reason: { class: 'timeout', message: `Session ${session.sessionId} heard nothing from its caller for its whole 150 ms lease, so Retest ended it.`, details: { leaseMs: 150 } }, sessions: 'returned' } })
    assert.equal(page.disposed, true)
    assert.equal(budget.snapshot().host, 0)
    const after = await session.observe(buttons)
    assert.ok(!after.ok)
    assert.equal(after.failure.class, 'timeout')
    assert.deepEqual(session.renew().ok, false)
  })

  test('every call and renew() keep the lease, and a call running past it is not silence', async (t) => {
    const { session, page } = await openSession(t, { fake: { hold: 'click' }, host: { timeouts: { setup: 2000, action: 5000, navigation: 1000, assertion: 300, cleanup: 300, lease: 200 } } })
    for (let beat = 0; beat < 5; beat++) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      assert.deepEqual(session.renew(), { ok: true, leaseMs: 200 })
    }
    const clicking = session.act({ kind: 'click', locator: { by: 'testId', value: 'save-task' } })
    await heldCommand(page, 'click')
    await new Promise((resolve) => setTimeout(resolve, 450))
    assert.equal(session.state, 'open', 'a call the caller waits for keeps the lease')
    page.show(toolbar)
    page.release()
    await clicking
    assert.equal(session.state, 'open')
    const ended = await session.ended
    assert.equal(ended.ending.kind, 'caller_silent')
  })
})

describe('what a session may take from its host', () => {
  test('a session types only the secrets its open request names, and reads no other', async (t) => {
    const reads: string[] = []
    const secrets = { values: { password: { value: 'correct horse battery staple' }, 'admin-password': { read: async () => { reads.push('admin-password'); return 'the admin passphrase' } } } }
    const { session, page } = await openSession(t, { host: { secrets }, request: { secrets: ['password'] } })
    page.show([{ testId: 'password', text: '' }])
    assert.ok((await session.act({ kind: 'goto', url: '/login' })).result.ok)
    const refused = await session.act({ kind: 'fill', locator: { by: 'testId', value: 'password' }, value: { secret: 'admin-password' } })
    assert.ok(!refused.result.ok)
    assert.equal(refused.input, 'not_sent')
    assert.equal(refused.result.failure.details?.['refused'], 'secret-not-allowed')
    assert.match(refused.result.failure.message, /may type only "password", so Retest did not type secret\("admin-password"\) and read nothing\.$/)
    assert.deepEqual(reads, [])
    assert.ok((await session.act({ kind: 'fill', locator: { by: 'testId', value: 'password' }, value: { secret: 'password' } })).result.ok)
    assert.deepEqual(page.typed.map((typed) => typed.secret), ['password'])
  })

  test('an open naming a secret the host does not hold is refused by name', async (t) => {
    const { launch } = agentFakeLauncher()
    const host = new AgentHost({ targets: { chrome: { engine: 'chromium', executablePath: '/fake/chrome' } }, budget: new SessionBudget({ perOwner: 4, host: 8 }), logFolder: '/tmp/retest-agent-unit-logs', launchers: { chromium: launch }, secrets: { values: { password: { value: 'correct horse battery staple' } } } })
    t.after(() => host.close())
    const opened = await host.open({ owner: 'agent-1', app: 'owner', purpose: 'discovery', target: 'chrome', engine: 'chromium', secrets: ['password', 'admin-password'] })
    assert.ok(!opened.ok)
    assert.equal(opened.failure.details?.['refused'], 'unknown-secret')
    assert.match(opened.failure.message, /this host holds no secret "admin-password"\.$/)
  })

  test('saved state restores only into a session of the owner and app that saved it', async (t) => {
    const discovery = await openSession(t)
    discovery.page.show([{ testId: 'sign-in', text: 'Sign in' }])
    assert.ok((await discovery.session.act({ kind: 'click', locator: { by: 'testId', value: 'sign-in' } })).result.ok)
    const saved = await discovery.session.saveState()
    assert.ok(saved.ok)
    assert.deepEqual([saved.state.owner, saved.state.app], ['agent-1', 'owner'])
    const { host } = discovery
    const request = { owner: 'agent-1', app: 'owner', purpose: 'reproduction', target: 'chrome', engine: 'chromium', state: saved.state } as const
    const member = await host.open({ ...request, app: 'member' })
    assert.ok(!member.ok)
    assert.equal(member.failure.details?.['refused'], 'other-app')
    assert.match(member.failure.message, /^The state was saved by session [a-z0-9]{10}:owner, of "agent-1" as "owner", and this session would be "member"\. Retest restores a state only into a session of the owner and app that saved it\.$/)
    const otherOwner = await host.open({ ...request, owner: 'agent-2' })
    assert.ok(!otherOwner.ok)
    assert.equal(otherOwner.failure.details?.['refused'], 'other-owner')
    const same = await host.open(request)
    assert.ok(same.ok, same.ok ? '' : same.failure.message)
  })
})
