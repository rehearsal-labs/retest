import type { TestContext } from 'node:test'
import type { OwnedPage } from '../../src/browser/contract.ts'
import type { StorageState } from '../../src/protocol/storage-state.ts'
import type { TaskApp } from '../../fixtures/task-app/server.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { WORKER_ANSWERS_KEY } from '../../fixtures/task-app/service-worker.ts'
import { REMEMBER_COOKIE, SESSION_COOKIE, STORED_USER_KEY, TASK_APP_PASSWORD } from '../../fixtures/task-app/sign-in.ts'
import { BrowserError } from '../../src/browser/browser-error.ts'
import { parse } from '../../src/protocol/schema.ts'
import { storageStateSchema } from '../../src/protocol/storage-state.ts'
import { assertOk, click, fill, goto, observe, observeUntil, openApp, openPage, setupMs, sharedBrowser } from './browser-harness.ts'

const browser = sharedBrowser()

async function signIn(page: OwnedPage, user: string): Promise<void> {
  assertOk(await goto(page, '/login'))
  assertOk(await fill(page, 'user', user))
  assertOk(await fill(page, 'password', TASK_APP_PASSWORD))
  assertOk(await click(page, 'sign-in'))
  await observeUntil(page, 'account', (seen) => seen.text === `Signed in as ${user}`)
}

async function account(page: OwnedPage, app: TaskApp): Promise<{ account: string | null; stored: string | null }> {
  assertOk(await goto(page, `${app.url}/account`))
  return { account: (await observe(page, 'account')).text, stored: (await observe(page, 'stored-user')).text }
}

async function signedInState(t: TestContext, app: TaskApp, user = 'alice'): Promise<StorageState> {
  const page = await openPage(t, browser(), app.url)
  await signIn(page, user)
  return page.captureState(setupMs)
}

test('capture saves the session cookies and the localStorage the sign-in wrote', async (t) => {
  const app = await openApp(t)
  const state = await signedInState(t, app)
  assert.equal(parse(storageStateSchema, state).ok, true)
  const session = state.cookies.find((cookie) => cookie.name === SESSION_COOKIE)
  assert.deepEqual({ ...session, value: '<token>' }, {
    name: SESSION_COOKIE,
    value: '<token>',
    domain: '127.0.0.1',
    path: '/',
    expires: -1,
    httpOnly: true,
    secure: false,
    sameSite: 'Lax',
  })
  const remember = state.cookies.find((cookie) => cookie.name === REMEMBER_COOKIE)
  assert.equal(remember?.value, 'alice')
  assert.equal(remember?.sameSite, 'Strict')
  const inADay = Date.now() / 1000 + 86_400
  assert.ok(remember !== undefined && Math.abs(remember.expires - inADay) < 60, `expires ${remember?.expires}`)
  assert.deepEqual(state.origins, [{ origin: app.url, localStorage: [{ name: STORED_USER_KEY, value: 'alice' }] }])
})

test('restored state starts a new context signed in, with localStorage there before the page scripts run', async (t) => {
  const app = await openApp(t)
  const state = await signedInState(t, app)
  const restored = await openPage(t, browser(), app.url, { storageState: state })
  assert.deepEqual(await account(restored, app), { account: 'Signed in as alice', stored: 'alice' })
})

test('a new context without state starts signed out', async (t) => {
  const app = await openApp(t)
  await signedInState(t, app)
  const fresh = await openPage(t, browser(), app.url)
  assert.deepEqual(await account(fresh, app), { account: 'Signed out', stored: '' })
})

test('capturing and restoring state send the site no request', async (t) => {
  const app = await openApp(t)
  const page = await openPage(t, browser(), app.url)
  await signIn(page, 'alice')
  const before = app.requests()
  const state = await page.captureState(setupMs)
  await openPage(t, browser(), app.url, { storageState: state })
  assert.equal(app.requests(), before)
})

test('capture reads the localStorage of an origin the page left, and restore brings it back', async (t) => {
  const accounts = await openApp(t)
  const tasks = await openApp(t)
  const page = await openPage(t, browser(), accounts.url)
  await signIn(page, 'alice')
  assertOk(await goto(page, `${tasks.url}/`))
  assertOk(await fill(page, 'task-title', 'Release checklist'))
  assertOk(await click(page, 'save-task'))
  await observeUntil(page, 'saved-task', (seen) => seen.text === 'Release checklist')
  const accountsRequests = accounts.requests()
  const state = await page.captureState(setupMs)
  assert.equal(accounts.requests(), accountsRequests, 'reading the storage of the origin the page left reached its server')
  assert.deepEqual(new Map(state.origins.map(({ origin, localStorage }) => [origin, localStorage])), new Map([
    [tasks.url, [{ name: 'last-saved', value: 'Release checklist' }]],
    [accounts.url, [{ name: STORED_USER_KEY, value: 'alice' }]],
  ]))
  const restored = await openPage(t, browser(), accounts.url, { storageState: state })
  assert.deepEqual(await account(restored, accounts), { account: 'Signed in as alice', stored: 'alice' })
  assertOk(await goto(restored, `${tasks.url}/`))
  assert.equal((await observe(restored, 'last-saved')).text, 'Release checklist')
})

test('a service worker of an origin the page left does not answer the document Retest reads it from', async (t) => {
  const site = await openApp(t)
  const elsewhere = await openApp(t)
  const page = await openPage(t, browser(), site.url)
  assertOk(await goto(page, '/service-worker'))
  await observeUntil(page, 'worker', (seen) => seen.text === 'Ready')
  assertOk(await goto(page, '/account'))
  await observeUntil(page, 'worker-answer', (seen) => seen.count === 1)
  assertOk(await goto(page, `${elsewhere.url}/`))
  const requests = site.requests()
  const state = await page.captureState(setupMs)
  assert.deepEqual(state.origins, [{ origin: site.url, localStorage: [{ name: WORKER_ANSWERS_KEY, value: '1' }] }])
  assert.equal(site.requests(), requests)
})

test('state restored and captured again comes back the same', async (t) => {
  const app = await openApp(t)
  const state = await signedInState(t, app)
  const restored = await openPage(t, browser(), app.url, { storageState: state })
  assert.deepEqual(await restored.captureState(setupMs), state)
})

test('restore writes every value exactly as saved', async (t) => {
  const app = await openApp(t)
  const value = `zoë "quoted" \\ <b>bold</b> \n next line`
  const items = [{ name: STORED_USER_KEY, value }, { name: '', value: '' }]
  const state: StorageState = { cookies: [], origins: [{ origin: app.url, localStorage: items }] }
  const page = await openPage(t, browser(), app.url, { storageState: state })
  assert.equal((await account(page, app)).stored, value)
  const [origin, ...others] = (await page.captureState(setupMs)).origins
  assert.deepEqual(others, [])
  assert.equal(origin?.origin, app.url)
  // localStorage keeps no order, so the browser lists the items in its own.
  assert.deepEqual(new Set(origin?.localStorage.map((item) => JSON.stringify(item))), new Set(items.map((item) => JSON.stringify(item))))
})

test('sessionStorage is not part of the state', async (t) => {
  const app = await openApp(t)
  const page = await openPage(t, browser(), app.url)
  assertOk(await goto(page, '/'))
  assert.deepEqual(await page.captureState(setupMs), { cookies: [], origins: [] })
})

test('a page that opened nothing has an empty state', async (t) => {
  const page = await openPage(t, browser())
  assert.deepEqual(await page.captureState(setupMs), { cookies: [], origins: [] })
})

test('a state that names an origin other than http or https is refused before any page opens', async (t) => {
  for (const origin of ['file:///tmp', 'not a url', 'http://127.0.0.1:1/path']) {
    const state: StorageState = { cookies: [], origins: [{ origin, localStorage: [{ name: 'a', value: 'b' }] }] }
    await assert.rejects(browser().newPage({ storageState: state }, setupMs), (error) => {
      assert.ok(error instanceof BrowserError)
      assert.equal(error.failure.class, 'setup_failed')
      assert.equal(error.failure.message, `Could not restore the saved state: ${JSON.stringify(origin)} is not an http or https origin.`)
      return true
    })
  }
  const page = await openPage(t, browser())
  assert.deepEqual(await page.captureState(setupMs), { cookies: [], origins: [] })
})

test('capture on a closed page fails as a lost session', async (t) => {
  const app = await openApp(t)
  const page = await openPage(t, browser(), app.url)
  await page.dispose(2000)
  await assert.rejects(page.captureState(setupMs), (error) => {
    assert.ok(error instanceof BrowserError)
    assert.equal(error.failure.class, 'session_lost')
    assert.equal(error.failure.message, 'Retest lost the page before it could save the sign-in state: the page was closed.')
    return true
  })
})
