import type { ElementRef } from '../../src/agent/looks.ts'
import type { AgentSession } from '../../src/agent/session.ts'
import type { CapturedFrame } from '../../src/media/capture.ts'
import type { LocatorRecipe } from '../../src/protocol/locator.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { keptLooks } from '../../src/agent/looks.ts'
import { openApp, servePages } from './browser-harness.ts'
import { filesHolding } from './cli-harness.ts'
import { agentHost, assertActed, engineName, onlyElement, openOn, pinsOn, signIn, TASK_APP_PASSWORD, waitForText } from './agent-harness.ts'

// Agent sessions on a real browser, the engine tests/integration/engines.ts names (Chrome unless a file of an engine of
// its own imports this one): distinct discovery and reproduction sessions, saved sign-in reused only where the host
// restores it and only for the owner and app that saved it, references good only in their own session, while their look
// holds and for the one element they name, durable recipes made only when a read proves they find the referenced
// element, frames of the session's page, and one identity for a required check in every session. Chromium's driver
// pins elements, as Firefox and WebKit now do: a reference acts on the node its look listed, wherever that look listed
// it, and a recipe is proven by comparing nodes. Each case asserts which rule the engine is under (`pinsOn`), so an
// engine that loses element identity fails here rather than moving between cases quietly.

const toolbar = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Toolbar</title></head>
<body>
<div data-testid="toolbar">
<button type="button" data-testid="save" onclick="fetch('/clicked/save', { method: 'POST' })">Save</button>
<button type="button" data-testid="cancel" onclick="fetch('/clicked/cancel', { method: 'POST' })">Cancel</button>
<button type="button" data-testid="archive" onclick="fetch('/clicked/archive', { method: 'POST' })">Archive</button>
</div>
<div data-testid="row-1"><span>First</span> <button type="button" onclick="fetch('/clicked/delete-1', { method: 'POST' })">Delete</button></div>
<div data-testid="row-2"><span>Second</span> <button type="button" onclick="fetch('/clicked/delete-2', { method: 'POST' })">Delete</button></div>
<button type="button" data-testid="grow" onclick="const b = document.createElement('button'); b.textContent = 'Undo'; document.querySelector('[data-testid=toolbar]').prepend(b)">Grow</button>
<a href="/other" data-testid="other-link">Other page</a>
</body></html>`

const other = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Other</title></head><body><button type="button">Save</button></body></html>'

// Three empty fields, and a button that moves the last to the front, as an app that sorts its rows does. The second
// button locks the fields, then a moment later sorts them and unlocks them, as an app that sorts while it loads does.
const fields = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Fields</title></head>
<body>
<div data-testid="fields"><input data-testid="f-1" aria-label="First"><input data-testid="f-2" aria-label="Second"><input data-testid="f-3" aria-label="Third"></div>
<button type="button" data-testid="sort" onclick="const box = document.querySelector('[data-testid=fields]'); box.prepend(box.lastElementChild)">Sort</button>
<button type="button" data-testid="sort-later" onclick="const box = document.querySelector('[data-testid=fields]'); for (const field of box.children) field.readOnly = true; setTimeout(() => { box.prepend(box.lastElementChild); for (const field of box.children) field.readOnly = false }, 1500)">Sort later</button>
</body></html>`

async function posted(site: { posts(path: string): number }, path: string, count: number): Promise<void> {
  const deadline = performance.now() + 5000
  while (site.posts(path) < count) {
    if (performance.now() > deadline) assert.fail(`${path} was posted ${site.posts(path)} times, expected ${count}`)
    await sleep(20)
  }
}

function clicks(site: { posts(path: string): number }): Record<string, number> {
  return Object.fromEntries(['save', 'cancel', 'archive', 'delete-1', 'delete-2'].map((name) => [name, site.posts(`/clicked/${name}`)]))
}

test('discovery and reproduction are distinct sessions: saved sign-in reaches only the session the host restores it into', async (t) => {
  const app = await openApp(t)
  const { host, logFolder } = await agentHost(t)
  const answers: unknown[] = []
  const discovery = await openOn(host, { app: 'owner', purpose: 'discovery', baseUrl: app.url })
  await signIn(discovery, 'owner-a')
  const saved = await discovery.saveState()
  assert.ok(saved.ok, saved.ok ? '' : saved.failure.message)
  assert.equal(saved.state.savedFrom, discovery.sessionId)
  assert.ok(saved.state.storage.cookies.some((cookie) => cookie.name === 'task-app-session'), 'the saved state holds the session cookie')
  assert.ok(saved.state.storage.origins.some((origin) => origin.localStorage.some((item) => item.value === 'owner-a')), 'and the name the page kept')

  // After saving, discovery signs in as someone else: what it does from now on is its own.
  await signIn(discovery, 'owner-b')

  const reproduction = await openOn(host, { app: 'owner', purpose: 'reproduction', baseUrl: app.url, state: saved.state })
  assert.notEqual(reproduction.sessionId, discovery.sessionId)
  assert.equal(reproduction.restoredFrom, discovery.sessionId)

  // The owner's state never restores into a session of another app or owner.
  for (const [changed, refused] of [[{ app: 'member' }, 'other-app'], [{ owner: 'agent-2' }, 'other-owner']] as const) {
    const borrowed = await host.open({ owner: 'agent-1', app: 'owner', purpose: 'reproduction', target: 'browser', engine: engineName(), baseUrl: app.url, state: saved.state, ...changed })
    assert.ok(!borrowed.ok)
    assert.equal(borrowed.failure.details?.['refused'], refused)
    answers.push(borrowed)
  }
  assertActed(await reproduction.act({ kind: 'goto', url: '/account' }), 'opened the account page')
  await waitForText(reproduction, { by: 'testId', value: 'account' }, 'Signed in as owner-a')
  await waitForText(reproduction, { by: 'testId', value: 'stored-user' }, 'owner-a')

  const fresh = await openOn(host, { app: 'owner', purpose: 'reproduction', baseUrl: app.url })
  assertActed(await fresh.act({ kind: 'goto', url: '/account' }), 'opened the account page')
  await waitForText(fresh, { by: 'testId', value: 'account' }, 'Signed out')
  await waitForText(fresh, { by: 'testId', value: 'stored-user' }, '')

  // What reproduction does never reaches discovery.
  await signIn(reproduction, 'member-z')
  assertActed(await discovery.act({ kind: 'goto', url: '/account' }), 'discovery opened its account page')
  await waitForText(discovery, { by: 'testId', value: 'account' }, 'Signed in as owner-b')

  // A reference is good only in the session that served its look, both ways, and nothing is sent.
  const discoveryRef = await onlyElement(discovery, { by: 'testId', value: 'tasks-link' })
  const reproductionRef = await onlyElement(reproduction, { by: 'testId', value: 'tasks-link' })
  assert.deepEqual([discoveryRef.sessionId, reproductionRef.sessionId], [discovery.sessionId, reproduction.sessionId])
  for (const [session, ref] of [[reproduction, discoveryRef], [discovery, reproductionRef]] as const) {
    const refused = await session.act({ kind: 'click', ref })
    answers.push(refused)
    assert.ok(!refused.result.ok)
    assert.equal(refused.input, 'not_sent')
    assert.equal(refused.result.failure.details?.['refused'], 'other-session')
  }
  const stillThere = await reproduction.observePage()
  assert.ok(stillThere.ok)
  assert.match(stillThere.page.url ?? '', /\/account$/, 'the refused click opened no page')

  // A look at a field holding the typed secret shows its placeholder, never its value.
  assertActed(await fresh.act({ kind: 'goto', url: '/login' }), 'opened the sign-in page')
  assertActed(await fresh.act({ kind: 'fill', ref: await onlyElement(fresh, { by: 'testId', value: 'password' }), value: { secret: 'password' } }), 'typed the password')
  const field = await fresh.observe({ by: 'testId', value: 'password' })
  assert.ok(field.ok)
  assert.equal(field.look.observation.value, '{{password}}')
  answers.push(saved.ok ? { savedFrom: saved.state.savedFrom } : saved, field)
  assert.equal(JSON.stringify(answers).includes(TASK_APP_PASSWORD), false, 'no answer holds the password')
  for (const session of [discovery, reproduction, fresh]) assert.ok((await session.end()).ok)
  assert.deepEqual(filesHolding(logFolder, TASK_APP_PASSWORD), [], 'no browser log holds the password')
})

test('a reference acts only on the one element its look listed, with the driver pinning rule asserted', async (t) => {
  const site = await servePages(t, { '/': toolbar, '/other': other })
  const { host } = await agentHost(t)
  const session = await openOn(host, { app: 'web', purpose: 'discovery', baseUrl: site.url })
  assertActed(await session.act({ kind: 'goto', url: '/' }), 'opened the toolbar')
  const look = await session.observe({ by: 'role', role: 'button', within: [{ by: 'testId', value: 'toolbar' }] })
  assert.ok(look.ok)
  assert.deepEqual(look.look.elements.map((element) => element.text), ['Save', 'Cancel', 'Archive'])
  const cancel = look.look.elements[1]
  assert.ok(cancel !== undefined)
  if (pinsOn(session)) {
    const pinned = await session.act({ kind: 'click', ref: cancel.ref })
    assertActed(pinned, 'the reference reaches its pinned Cancel node')
    await posted(site, '/clicked/cancel', 1)
    assert.deepEqual(clicks(site), { save: 0, cancel: 1, archive: 0, 'delete-1': 0, 'delete-2': 0 })
  } else {
    const refused = await session.act({ kind: 'click', ref: cancel.ref })
    assert.ok(!refused.result.ok)
    assert.equal(refused.input, 'not_sent')
    assert.deepEqual(refused.result.failure.details, { refused: 'unpinned', ref: `${cancel.ref.observationId}.e1`, sessionId: session.sessionId, engine: engineName() })
  }

  const named: LocatorRecipe = { by: 'role', role: 'button', name: 'Cancel', within: [{ by: 'testId', value: 'toolbar' }] }
  const action = await session.act({ kind: 'click', ref: await onlyElement(session, named) })
  assertActed(action, 'clicked the only element its look listed')
  assert.deepEqual(action.locator, pinsOn(session) ? { ...named, pick: 0 } : named, "the pinned recipe names its exact node; the unpinned rule keeps the look's own locator")
  await posted(site, '/clicked/cancel', pinsOn(session) ? 2 : 1)
  assert.deepEqual(clicks(site), { save: 0, cancel: pinsOn(session) ? 2 : 1, archive: 0, 'delete-1': 0, 'delete-2': 0 })
})

test('on a driver that pins, a reference to one of several elements, twins among them, acts on exactly that node', async (t) => {
  const site = await servePages(t, { '/': toolbar, '/other': other })
  const { host } = await agentHost(t)
  const session = await openOn(host, { app: 'web', purpose: 'discovery', baseUrl: site.url })
  assert.equal(pinsOn(session), true, 'every verified browser driver pins its element references')
  assertActed(await session.act({ kind: 'goto', url: '/' }), 'opened the toolbar')
  const toolbarButtons: LocatorRecipe = { by: 'role', role: 'button', within: [{ by: 'testId', value: 'toolbar' }] }
  const look = await session.observe(toolbarButtons)
  assert.ok(look.ok)
  assert.deepEqual(look.look.elements.map((element) => element.text), ['Save', 'Cancel', 'Archive'])
  const cancel = look.look.elements[1]
  assert.ok(cancel !== undefined)
  const clicked = await session.act({ kind: 'click', ref: cancel.ref })
  assertActed(clicked, 'clicked the second of three')
  assert.deepEqual(clicked.locator, { ...toolbarButtons, pick: 1 }, "the look's locator at the element's place, held to its node")
  await posted(site, '/clicked/cancel', 1)

  // Two buttons that show the same: each reference reaches its own row only.
  const deletes = await session.observe({ by: 'role', role: 'button', name: 'Delete' })
  assert.ok(deletes.ok)
  assert.deepEqual(deletes.look.elements.map((element) => element.text), ['Delete', 'Delete'])
  const [firstRow, secondRow] = deletes.look.elements
  assert.ok(firstRow !== undefined && secondRow !== undefined)
  assertActed(await session.act({ kind: 'click', ref: secondRow.ref }), "clicked the second row's Delete")
  await posted(site, '/clicked/delete-2', 1)
  assert.deepEqual(clicks(site), { save: 0, cancel: 1, archive: 0, 'delete-1': 0, 'delete-2': 1 })
  assertActed(await session.act({ kind: 'click', ref: firstRow.ref }), "clicked the first row's Delete")
  await posted(site, '/clicked/delete-1', 1)
  assert.deepEqual(clicks(site), { save: 0, cancel: 1, archive: 0, 'delete-1': 1, 'delete-2': 1 })
})

test('fields that show the same, put in another order, are never typed into through a reference from before', async (t) => {
  const site = await servePages(t, { '/fields': fields })
  const { host } = await agentHost(t)
  const session = await openOn(host, { app: 'web', purpose: 'discovery', baseUrl: site.url })
  // A driver that pins reads the node gone from its place before it sends anything; one that cannot refuses any of three.
  const refusal = pinsOn(session) ? 'changed' : 'unpinned'
  assertActed(await session.act({ kind: 'goto', url: '/fields' }), 'opened the fields')
  const look = await session.observe({ by: 'role', role: 'textbox' })
  assert.ok(look.ok)
  assert.equal(look.look.elements.length, 3)
  const second = look.look.elements[1]
  assert.ok(second !== undefined)
  assertActed(await session.act({ kind: 'click', locator: { by: 'testId', value: 'sort' } }), 'sorted the fields')
  await waitForOrder(session, ['f-3', 'f-1', 'f-2'])
  const typed = await session.act({ kind: 'fill', ref: second.ref, value: 'meant for f-2' })
  assert.ok(!typed.result.ok)
  assert.equal(typed.input, 'not_sent')
  assert.equal(typed.result.failure.details?.['refused'], refusal)
  for (const field of ['f-1', 'f-2', 'f-3']) {
    const value = await session.observe({ by: 'testId', value: field })
    assert.ok(value.ok)
    assert.equal(value.look.observation.value, '', `${field} holds nothing`)
  }
})

test('on a driver that pins, fields put in another order while an action waits for its field are refused as moved, and nothing is typed', async (t) => {
  const site = await servePages(t, { '/fields': fields })
  const { host } = await agentHost(t)
  const session = await openOn(host, { app: 'web', purpose: 'discovery', baseUrl: site.url })
  if (!pinsOn(session)) {
    t.skip(`the ${engineName()} driver pins no element yet, so a reference into three fields is refused before it waits; the case before this one shows it`)
    return
  }
  assertActed(await session.act({ kind: 'goto', url: '/fields' }), 'opened the fields')
  // The page locks its fields now, and sorts and unlocks them a moment later, while the fill below waits to type.
  assertActed(await session.act({ kind: 'click', locator: { by: 'testId', value: 'sort-later' } }), 'asked the page to sort later')
  const look = await session.observe({ by: 'role', role: 'textbox' })
  assert.ok(look.ok)
  const second = look.look.elements[1]
  assert.ok(second !== undefined)
  const typed = await session.act({ kind: 'fill', ref: second.ref, value: 'meant for f-2' }, { timeoutMs: 5000 })
  assert.ok(!typed.result.ok)
  assert.equal(typed.input, 'not_sent')
  assert.equal(typed.result.failure.class, 'not_actionable', typed.result.failure.message)
  assert.deepEqual(typed.result.failure.details, { refused: 'moved', inputSent: false })
  await waitForOrder(session, ['f-3', 'f-1', 'f-2'])
  for (const field of ['f-1', 'f-2', 'f-3']) {
    const value = await session.observe({ by: 'testId', value: field })
    assert.ok(value.ok)
    assert.equal(value.look.observation.value, '', `${field} holds nothing`)
  }
})

test('a stale reference is refused and sends nothing: another document, a changed list, an expired look', async (t) => {
  const site = await servePages(t, { '/': toolbar, '/other': other })
  const { host } = await agentHost(t)
  const session = await openOn(host, { app: 'web', purpose: 'discovery', baseUrl: site.url })
  assertActed(await session.act({ kind: 'goto', url: '/' }), 'opened the toolbar')
  const buttons: LocatorRecipe = { by: 'role', role: 'button', within: [{ by: 'testId', value: 'toolbar' }] }

  // A changed list: a button appears at the start of the toolbar, so the look's places name other buttons now.
  const before = await session.observe(buttons)
  assert.ok(before.ok)
  assertActed(await session.act({ kind: 'click', locator: { by: 'testId', value: 'grow' } }), 'grew the toolbar')
  await waitForCount(session, buttons, 4)
  const save = before.look.elements[0]
  assert.ok(save !== undefined)
  const changed = await session.act({ kind: 'click', ref: save.ref })
  assert.ok(!changed.result.ok)
  assert.deepEqual([changed.input, changed.result.failure.details?.['refused']], ['not_sent', 'changed'])
  assert.match(changed.result.failure.message, /has changed \(it saw 3 matches and the page now has 4\)\. Look again\.$/)

  // An expired look: a session keeps its last looks only.
  const first = await session.observe(buttons)
  assert.ok(first.ok)
  for (let look = 0; look < keptLooks; look++) assert.ok((await session.observe(buttons)).ok)
  const expiredRef = first.look.elements[1]
  assert.ok(expiredRef !== undefined)
  const expired = await session.act({ kind: 'click', ref: expiredRef.ref })
  assert.ok(!expired.result.ok)
  assert.deepEqual([expired.input, expired.result.failure.details?.['refused']], ['not_sent', 'expired'])

  // Another document: the page moves on, and every look of the one before is stale, even where the new page shows the same.
  const current = await session.observe({ by: 'role', role: 'button', name: 'Save' })
  assert.ok(current.ok)
  assertActed(await session.act({ kind: 'click', locator: { by: 'testId', value: 'other-link' } }), 'followed the link')
  await waitForCount(session, { by: 'role', role: 'button', name: 'Save' }, 1, 'Other')
  const moved = current.look.elements[0]
  assert.ok(moved !== undefined)
  const stale = await session.act({ kind: 'click', ref: moved.ref })
  assert.ok(!stale.result.ok)
  assert.deepEqual([stale.input, stale.result.failure.details?.['refused']], ['not_sent', 'new-document'])
  assert.deepEqual(clicks(site), { save: 0, cancel: 0, archive: 0, 'delete-1': 0, 'delete-2': 0 }, 'no refused reference clicked anything')
})

test('a reference becomes a durable recipe only when one read proves the recipe finds its element', async (t) => {
  const site = await servePages(t, { '/': toolbar, '/other': other })
  const { host } = await agentHost(t)
  const session = await openOn(host, { app: 'web', purpose: 'discovery', baseUrl: site.url })
  const pins = pinsOn(session)
  assertActed(await session.act({ kind: 'goto', url: '/' }), 'opened the toolbar')
  const look = await session.observe({ by: 'role', role: 'button' })
  assert.ok(look.ok)
  assert.deepEqual(look.look.elements.map((element) => element.text), ['Save', 'Cancel', 'Archive', 'Delete', 'Delete', 'Grow'])
  const [save, , archive, firstDelete] = look.look.elements
  assert.ok(save !== undefined && archive !== undefined && firstDelete !== undefined)

  // A recipe other than the look's own locator. A driver that pins compares the node each finds, and each of these
  // finds the referenced node; on one that cannot, nothing the driver says ties the element found to the referenced one.
  const others: [ElementRef, LocatorRecipe][] = [
    [archive.ref, { by: 'testId', value: 'archive' }],
    [save.ref, { by: 'role', role: 'button', name: 'Save' }],
    [firstDelete.ref, { by: 'role', role: 'button', name: 'Delete', within: [{ by: 'testId', value: 'row-1' }] }],
  ]
  for (const [ref, locator] of others) {
    const recipe = await session.recipe(ref, locator)
    if (pins) {
      assert.ok(recipe.ok, recipe.ok ? '' : recipe.failure.message)
      assert.deepEqual(recipe.locator, locator)
      continue
    }
    assert.ok(!recipe.ok, JSON.stringify(locator))
    assert.deepEqual(recipe.failure.details, { refused: 'unproven', engine: engineName() })
  }
  if (pins) {
    // The second row's Delete shows what the first row's does, and is another node.
    const twin = await session.recipe(firstDelete.ref, { by: 'role', role: 'button', name: 'Delete', within: [{ by: 'testId', value: 'row-2' }] })
    assert.ok(!twin.ok)
    assert.equal(twin.failure.details?.['refused'], 'other-element', twin.failure.message)
  }
  const placed = await session.recipe(save.ref, { by: 'role', role: 'button', pick: 0 })
  assert.ok(!placed.ok)
  assert.equal(placed.failure.details?.['refused'], 'placed')

  // The look's own locator is proven only when that read finds one element: two Delete buttons are no recipe.
  const deletes: LocatorRecipe = { by: 'role', role: 'button', name: 'Delete' }
  const both = await session.observe(deletes)
  assert.ok(both.ok)
  const firstOfTwo = both.look.elements[0]
  assert.ok(firstOfTwo !== undefined)
  const twins = await session.recipe(firstOfTwo.ref, deletes)
  assert.ok(!twins.ok)
  assert.equal(twins.failure.class, 'ambiguous')

  // The second row's Delete, as a recipe: the row's button in a look that lists it alone, named by that look's locator.
  // Naming the first row's Delete instead, which shows the same text, is refused.
  const rowDelete: LocatorRecipe = { by: 'role', role: 'button', name: 'Delete', within: [{ by: 'testId', value: 'row-2' }] }
  const ref = await onlyElement(session, rowDelete)
  const wrongRow = await session.recipe(ref, { by: 'role', role: 'button', name: 'Delete', within: [{ by: 'testId', value: 'row-1' }] })
  assert.ok(!wrongRow.ok)
  assert.equal(wrongRow.failure.details?.['refused'], pins ? 'other-element' : 'unproven')
  const scoped = await session.recipe(ref, rowDelete)
  assert.ok(scoped.ok, scoped.ok ? '' : scoped.failure.message)
  assert.deepEqual(scoped.locator, rowDelete)
  assertActed(await session.act({ kind: 'click', locator: scoped.locator }), 'clicked through the durable recipe')
  await posted(site, '/clicked/delete-2', 1)
  assert.deepEqual(clicks(site), { save: 0, cancel: 0, archive: 0, 'delete-1': 0, 'delete-2': 1 })
})

test('a frame of the page is the PNG the driver gave, with the session', async (t) => {
  const site = await servePages(t, { '/': toolbar, '/other': other })
  const { host } = await agentHost(t)
  const session = await openOn(host, { app: 'web', purpose: 'discovery', baseUrl: site.url, viewport: { width: 640, height: 400 } })
  assertActed(await session.act({ kind: 'goto', url: '/' }), 'opened the toolbar')
  const framed = await session.frame()
  assert.ok(framed.ok, framed.ok ? '' : framed.failure.message)
  assert.deepEqual([...framed.frame.bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  assert.equal(framed.frame.sessionId, session.sessionId)
})

test("the browser frame source carries the session's identity and keeps its frames encoded in its exact capture mode", async (t) => {
  const site = await servePages(t, { '/': toolbar, '/other': other })
  const { host } = await agentHost(t)
  const session = await openOn(host, { app: 'web', purpose: 'discovery', baseUrl: site.url })
  assertActed(await session.act({ kind: 'goto', url: '/' }), 'opened the toolbar')
  const granted = session.frameSource()
  assert.ok(granted.ok, granted.ok ? '' : granted.failure.message)
  const frames: CapturedFrame[] = []
  const started = await granted.source.start({ fps: 5, clock: () => Math.round(performance.now() * 1000), deliver: (frame) => frames.push(frame), ended: () => undefined, timeoutMs: 5000 })
  assert.deepEqual(started, { ok: true, mode: engineName() === 'chromium' ? 'screencast' : 'screenshot-loop' })
  assertActed(await session.act({ kind: 'click', locator: { by: 'testId', value: 'grow' } }), 'changed the page')
  const deadline = performance.now() + 5000
  while (frames.length === 0 && performance.now() < deadline) await sleep(50)
  await granted.source.stop(2000)
  const [frame] = frames
  assert.ok(frame !== undefined, 'the source handed over a frame')
  assert.deepEqual(frame.identity, { testId: 'discovery', attemptId: session.identity.owner.attemptId, app: 'web', sessionId: session.sessionId })
  if (engineName() === 'chromium') {
    assert.equal(frame.format, 'jpeg')
    assert.deepEqual([...frame.bytes.subarray(0, 3)], [0xff, 0xd8, 0xff], 'a JPEG as the browser encoded it')
  } else {
    assert.equal(frame.format, 'png')
    assert.deepEqual([...frame.bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  }
})

test('ending a session stops its granted frame source and refuses another source', async (t) => {
  const site = await servePages(t, { '/': toolbar, '/other': other })
  const { host } = await agentHost(t)
  const session = await openOn(host, { app: 'web', purpose: 'discovery', baseUrl: site.url })
  assertActed(await session.act({ kind: 'goto', url: '/' }), 'opened the toolbar')
  const granted = session.frameSource()
  assert.ok(granted.ok, granted.ok ? '' : granted.failure.message)
  let delivered = 0
  assert.deepEqual(await granted.source.start({ fps: 5, clock: () => Math.round(performance.now() * 1000), deliver: () => { delivered += 1 }, ended: () => undefined, timeoutMs: 5000 }),
    { ok: true, mode: engineName() === 'chromium' ? 'screencast' : 'screenshot-loop' })
  const deadline = performance.now() + 5000
  while (delivered === 0 && performance.now() < deadline) await sleep(20)
  assert.ok(delivered > 0, 'the source actually captured this session')
  assert.ok((await session.end()).ok)
  const final = delivered
  await sleep(250)
  assert.equal(delivered, final, 'ending the session leaves no subsequent delivery')
  assert.equal((await granted.source.stop(2000)).delivered, final)
  const refused = session.frameSource()
  assert.ok(!refused.ok)
  assert.equal(refused.failure.class, 'usage')
})

test('a required check has one identity in every session that runs it', async (t) => {
  const app = await openApp(t)
  const { host } = await agentHost(t)
  const signedIn = { kind: 'text', id: 'signed-in-as-owner', text: 'Signed in as owner-a' } as const
  const requirement = { version: 'sessions-v1' }
  const discovery = await openOn(host, { app: 'owner', purpose: 'discovery', baseUrl: app.url })
  await signIn(discovery, 'owner-a')
  const saved = await discovery.saveState()
  assert.ok(saved.ok)
  const reproduction = await openOn(host, { app: 'owner', purpose: 'reproduction', baseUrl: app.url, state: saved.state })
  assertActed(await reproduction.act({ kind: 'goto', url: '/account' }), 'opened the account page')
  const results = []
  for (const session of [discovery, reproduction] satisfies AgentSession[]) {
    const checked = await session.check(signedIn, requirement)
    assert.ok(checked.ok, checked.ok ? '' : checked.failure.message)
    results.push(checked.check)
  }
  const [first, second] = results
  assert.ok(first !== undefined && second !== undefined)
  assert.deepEqual([first.status, second.status], ['passed', 'passed'])
  assert.deepEqual(first.identity, second.identity)
  assert.equal(first.identity.version, 'sessions-v1')
  assert.match(first.identity.sha256, /^[0-9a-f]{64}$/)
  assert.deepEqual([first.sessionId, second.sessionId], [discovery.sessionId, reproduction.sessionId])

  // Frozen, the requirement refuses a changed check by name, in any session.
  const frozen = { version: 'sessions-v1', checks: { [first.identity.id]: first.identity.sha256 } }
  const changed = await reproduction.check({ ...signedIn, text: 'Signed in as owner-b' }, frozen)
  assert.ok(!changed.ok)
  assert.match(changed.failure.message, /changed since the requirement "sessions-v1" froze it/)
  const failing = await reproduction.check({ kind: 'text', id: 'signed-in-as-member', text: 'Signed in as member-b', timeoutMs: 2000 }, requirement)
  assert.ok(failing.ok)
  assert.equal(failing.check.status, 'failed')
  assert.equal(failing.check.failure?.class, 'host_check_failed', failing.check.failure?.message)
  assert.equal(failing.check.failure?.details?.['checkId'], 'signed-in-as-member')
})

// Waits until the fields stand in `order`, by their test ids, as the page's sort left them.
async function waitForOrder(session: AgentSession, order: readonly string[]): Promise<void> {
  const deadline = performance.now() + 5000
  for (;;) {
    const places = await Promise.all(order.map((testId, place) => session.observe({ by: 'css', selector: `[data-testid=fields] > input:nth-child(${place + 1})[data-testid=${testId}]` })))
    if (places.every((look) => look.ok && look.look.observation.count === 1)) return
    if (performance.now() > deadline) assert.fail(`the fields did not reach the order ${order.join(', ')}`)
    await sleep(50)
  }
}

async function waitForCount(session: AgentSession, locator: LocatorRecipe, count: number, title?: string): Promise<void> {
  const deadline = performance.now() + 5000
  for (;;) {
    const look = await session.observe(locator)
    const page = title === undefined ? undefined : await session.observePage()
    const titled = title === undefined || (page?.ok === true && page.page.title === title)
    if (look.ok && look.look.observation.count === count && titled) return
    if (performance.now() > deadline) assert.fail(`${JSON.stringify(locator)} did not reach ${count} matches`)
    await sleep(50)
  }
}
