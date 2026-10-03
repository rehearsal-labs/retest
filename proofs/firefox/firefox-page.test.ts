import type { TestContext } from 'node:test'
import type { BidiClient } from './bidi-client.ts'
import type { Tab } from './firefox-page.ts'
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { TASK_APP_PASSWORD } from '../../fixtures/task-app/sign-in.ts'
import { s } from '../../src/protocol/schema.ts'
import { readBidi } from './bidi-client.ts'
import { BidiProtocolError } from './bidi-errors.ts'
import {
  callInPage,
  callInSandbox,
  click,
  createUserContext,
  locateByRole,
  EventRecorder,
  locateByTestId,
  LocatorError,
  navigate,
  NotActionableError,
  openTab,
  readCookies,
  readText,
  readUntil,
  screenshot,
  typeText,
} from './firefox-page.ts'
import { commandMs, openApp, rejection, scratchFolder, sharedSession, viewport } from './harness.ts'
import { readPng } from './png.ts'

const session = sharedSession()
const treeSchema = s.object({ contexts: s.array(s.object({ context: s.string(), userContext: s.string() })) })
const navigationEventSchema = s.object({ context: s.string(), navigation: s.nullable(s.string()), url: s.string() })
const logEntrySchema = s.object({
  type: s.string(),
  level: s.string(),
  text: s.nullable(s.string()),
  method: s.optional(s.string()),
  source: s.object({ realm: s.string(), context: s.optional(s.string()) }),
})
const probeSchema = s.object({ cookie: s.string(), stored: s.nullable(s.string()) })

/** A tab in a user context of its own, removed with everything in it after the test. */
async function newTab(t: TestContext, client: BidiClient): Promise<Tab> {
  const userContext = await createUserContext(client, commandMs)
  t.after(() => client.request('browser.removeUserContext', { userContext }, s.object({})))
  return openTab(client, userContext, viewport, commandMs)
}

function setProbe(tab: Tab, value: string): Promise<null> {
  const set = "(value) => { document.cookie = 'retest-probe=' + value + '; path=/'; localStorage.setItem('retest-probe', value) }"
  return callInPage(tab, set, [value], s.literal(null), commandMs)
}

function readProbe(tab: Tab): Promise<{ cookie: string; stored: string | null }> {
  return callInSandbox(tab, "() => ({ cookie: document.cookie, stored: localStorage.getItem('retest-probe') })", [], probeSchema, commandMs)
}

test('a tab opens in a user context of its own, with the viewport that was set', async (t) => {
  const { client } = session()
  const app = await openApp(t)
  const tab = await newTab(t, client)
  const { contexts } = await client.request('browsingContext.getTree', {}, treeSchema)
  assert.equal(contexts.find((context) => context.context === tab.context)?.userContext, tab.userContext)
  assert.notEqual(tab.userContext, 'default')
  const { url } = await navigate(tab, `${app.url}/`, commandMs)
  assert.equal(url, `${app.url}/`)
  const size = await callInSandbox(tab, '() => [innerWidth, innerHeight, devicePixelRatio]', [], s.array(s.number()), commandMs)
  assert.deepEqual(size, [viewport.width, viewport.height, 1])
})

test('finds one element by role and name and one by test id, reads text, and real clicks and typing save a task', async (t) => {
  const { client } = session()
  const app = await openApp(t)
  const tab = await newTab(t, client)
  await navigate(tab, `${app.url}/`, commandMs)
  const save = await locateByRole(tab, 'button', 'Save', commandMs)
  assert.equal(await readText(tab, save, commandMs), 'Save')
  const title = await locateByTestId(tab, 'task-title', commandMs)
  await click(tab, title, commandMs)
  await typeText(tab, 'Release checklist', commandMs)
  assert.equal(await callInSandbox(tab, '(element) => element.value', [title], s.string(), commandMs), 'Release checklist')
  assert.equal(app.submissions(), 0, 'typing saves nothing')
  await click(tab, save, commandMs)
  const saved = await locateByTestId(tab, 'saved-task', commandMs)
  assert.equal(await readUntil(() => readText(tab, saved, commandMs), (text) => text === 'Release checklist', 5000), 'Release checklist')
  assert.equal(app.submissions(), 1, 'one click sends one save')
})

test('a role and name that two elements share is refused, and so is one that no element has', async (t) => {
  const { client } = session()
  const app = await openApp(t, { mode: 'duplicate' })
  const tab = await newTab(t, client)
  await navigate(tab, `${app.url}/`, commandMs)
  const ambiguous = await rejection(locateByRole(tab, 'button', 'Save', commandMs))
  assert.ok(ambiguous instanceof LocatorError && /^More than one element has the role button and the name "Save"\.$/.test(ambiguous.message), String(ambiguous))
  const missing = await rejection(locateByRole(tab, 'button', 'Delete', commandMs))
  assert.ok(missing instanceof LocatorError && /^No element has/.test(missing.message), String(missing))
  // Firefox matches the whole name as written: no part of it, no other case, no trimming.
  for (const name of ['Sav', 'save', ' Save ']) {
    const inexact = await rejection(locateByRole(tab, 'button', name, commandMs))
    assert.ok(inexact instanceof LocatorError && /^No element has/.test(inexact.message), `${name}: ${String(inexact)}`)
  }
  const upperRole = await rejection(locateByRole(tab, 'BUTTON', 'Save', commandMs))
  assert.ok(upperRole instanceof LocatorError && /^No element has/.test(upperRole.message), `the role is matched as written too: ${String(upperRole)}`)
  assert.ok(await locateByRole(tab, 'textbox', 'Title', commandMs), 'a field takes its name from its label')
  const byText = await rejection(client.request('browsingContext.locateNodes', { context: tab.context, locator: { type: 'innerText', value: 'Save' } }, s.object({})))
  assert.ok(byText instanceof BidiProtocolError && byText.error === 'unsupported operation', `the innerText locator: ${String(byText)}`)
  const byTestId = await rejection(locateByTestId(tab, 'save-task', commandMs))
  assert.ok(byTestId instanceof LocatorError && /^More than one element has the test id "save-task"\.$/.test(byTestId.message), String(byTestId))
})

test('a button that another element covers is not clicked, and the page gets no input', async (t) => {
  const { client } = session()
  const app = await openApp(t, { mode: 'overlay' })
  const tab = await newTab(t, client)
  await navigate(tab, `${app.url}/`, commandMs)
  const failure = await rejection(click(tab, await locateByRole(tab, 'button', 'Save', commandMs), commandMs))
  assert.ok(failure instanceof NotActionableError && failure.message === 'Cannot click the element: another element covers its centre', String(failure))
  assert.equal(app.submissions(), 0)
})

test("Retest's sandbox and the page see one DOM and keep their globals apart", async (t) => {
  const { client } = session()
  const app = await openApp(t)
  const tab = await newTab(t, client)
  await navigate(tab, `${app.url}/`, commandMs)
  assert.equal(await callInPage(tab, "() => { window.retestPageValue = 'page'; return typeof window.retestPageValue }", [], s.string(), commandMs), 'string')
  assert.equal(await callInSandbox(tab, '() => typeof window.retestPageValue', [], s.string(), commandMs), 'undefined')
  await callInSandbox(tab, "() => { window.retestSandboxValue = 'retest'; document.querySelector('h1').dataset.seenBy = 'retest' }", [], s.literal(null), commandMs)
  assert.equal(await callInPage(tab, '() => typeof window.retestSandboxValue', [], s.string(), commandMs), 'undefined')
  assert.equal(await callInPage(tab, "() => document.querySelector('h1').dataset.seenBy", [], s.string(), commandMs), 'retest', 'both worlds share the document')
})

test('a screenshot is a PNG file of exactly the viewport, with the page drawn in it', async (t) => {
  const { client } = session()
  const app = await openApp(t)
  const tab = await newTab(t, client)
  const folder = await scratchFolder(t)
  await navigate(tab, `${app.url}/`, commandMs)
  const file = join(folder, 'viewport.png')
  await writeFile(file, await screenshot(tab, commandMs))
  const png = readPng(await readFile(file))
  assert.equal(png.width, viewport.width)
  assert.equal(png.height, viewport.height)
  assert.ok(png.distinctColors > 2, `${png.distinctColors} distinct colours`)
})

test('two user contexts on one origin keep cookies, localStorage and the server session apart', async (t) => {
  const { client } = session()
  const app = await openApp(t)
  const tabA = await newTab(t, client)
  const tabB = await newTab(t, client)

  await navigate(tabA, `${app.url}/login`, commandMs)
  await click(tabA, await locateByTestId(tabA, 'user', commandMs), commandMs)
  await typeText(tabA, 'ada', commandMs)
  await click(tabA, await locateByTestId(tabA, 'password', commandMs), commandMs)
  await typeText(tabA, TASK_APP_PASSWORD, commandMs)
  const recorder = new EventRecorder(client, ['browsingContext.load'])
  await client.request('session.subscribe', { events: ['browsingContext.load'], contexts: [tabA.context] }, s.object({}))
  await click(tabA, await locateByRole(tabA, 'button', 'Sign in', commandMs), commandMs)
  await recorder.waitFor('browsingContext.load', (params) => readBidi(navigationEventSchema, params, 'load').url === `${app.url}/account`, commandMs)
  await client.request('session.unsubscribe', { events: ['browsingContext.load'], contexts: [tabA.context] }, s.object({}))
  recorder.stop()
  assert.equal(await readText(tabA, await locateByTestId(tabA, 'account', commandMs), commandMs), 'Signed in as ada')
  await setProbe(tabA, 'a')

  await navigate(tabB, `${app.url}/account`, commandMs)
  assert.equal(await readText(tabB, await locateByTestId(tabB, 'account', commandMs), commandMs), 'Signed out', 'the server sees no session from B')
  await setProbe(tabB, 'b')

  assert.deepEqual(await readProbe(tabA), { cookie: 'task-app-remember=ada; retest-probe=a', stored: 'a' })
  assert.deepEqual(await readProbe(tabB), { cookie: 'retest-probe=b', stored: 'b' })
  const namesA = (await readCookies(client, tabA.userContext, commandMs)).map((cookie) => `${cookie.name}${cookie.httpOnly ? ' HttpOnly' : ''}`)
  assert.deepEqual(namesA.toSorted(), ['retest-probe', 'task-app-remember', 'task-app-session HttpOnly'])
  const cookiesB = await readCookies(client, tabB.userContext, commandMs)
  assert.deepEqual(cookiesB.map((cookie) => [cookie.name, cookie.value]), [['retest-probe', 'b']])

  const secondA = await openTab(client, tabA.userContext, viewport, commandMs)
  await navigate(secondA, `${app.url}/account`, commandMs)
  assert.equal(await readText(secondA, await locateByTestId(secondA, 'account', commandMs), commandMs), 'Signed in as ada', 'tabs of one user context share it')
  assert.equal((await readProbe(secondA)).stored, 'a')
})

test('navigation events and console messages arrive, each naming its navigation or its context', async (t) => {
  const { client } = session()
  const app = await openApp(t, { mode: 'noisy' })
  const tab = await newTab(t, client)
  const methods = ['browsingContext.navigationStarted', 'browsingContext.domContentLoaded', 'browsingContext.load', 'log.entryAdded']
  const recorder = new EventRecorder(client, methods)
  const { records } = recorder
  await client.request('session.subscribe', { events: methods, contexts: [tab.context] }, s.object({}))

  const { navigation } = await navigate(tab, `${app.url}/`, commandMs)
  await click(tab, await locateByRole(tab, 'button', 'Save', commandMs), commandMs)
  await callInPage(tab, "() => { setTimeout(() => { throw new Error('thrown by the test') }, 0) }", [], s.literal(null), commandMs)
  const logs = () => records.filter((record) => record.method === 'log.entryAdded').map((record) => readBidi(logEntrySchema, record.params, 'log.entryAdded'))
  await readUntil(async () => logs(), (entries) => entries.some((entry) => entry.type === 'javascript') && entries.some((entry) => entry.method === 'error'), 5000)
  // Before the user context goes, which takes the tab this subscription names with it.
  await client.request('session.unsubscribe', { events: methods, contexts: [tab.context] }, s.object({}))
  recorder.stop()

  const ofNavigation = records
    .filter((record) => record.method !== 'log.entryAdded')
    .map((record) => ({ method: record.method, event: readBidi(navigationEventSchema, record.params, record.method) }))
    .filter(({ event }) => event.navigation === navigation)
  assert.deepEqual(
    ofNavigation.map(({ method }) => method),
    ['browsingContext.navigationStarted', 'browsingContext.domContentLoaded', 'browsingContext.load'],
  )
  assert.ok(ofNavigation.every(({ event }) => event.context === tab.context && event.url === `${app.url}/`))
  const seen = logs().map((entry) => [entry.type, entry.level, entry.method ?? null, entry.text, entry.source.context])
  assert.deepEqual(seen, [
    ['console', 'info', 'log', '{"schemaVersion":1,"type":"run.finished","status":"passed","exitCode":0}', tab.context],
    ['console', 'warn', 'warn', 'page warning from the task app', tab.context],
    ['console', 'error', 'error', 'page error line from the task app', tab.context],
    ['javascript', 'error', null, 'Error: thrown by the test', tab.context],
  ])
})
