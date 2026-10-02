import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { ITEMS, startSearchApp, type SearchApp } from '../../fixtures/search-app/server.ts'

describe('the search app', () => {
  let app: SearchApp
  before(async () => {
    app = await startSearchApp({ apiDelayMs: 40, debounceMs: 10 })
  })
  after(() => app.close())

  test('serves its page with the debounce it was given', async () => {
    const response = await fetch(`${app.url}/`)
    assert.equal(response.status, 200)
    assert.match(await response.text(), /const DEBOUNCE_MS = 10\n/)
  })

  test('lists every item, after its API delay', async () => {
    const started = Date.now()
    const response = await fetch(`${app.url}/api/items`)
    // A libuv timer can fire a millisecond before Date.now agrees, so the bound allows one.
    assert.ok(Date.now() - started >= 39, 'answered before the API delay')
    assert.deepEqual(await response.json(), { items: ITEMS })
  })

  test('finds exactly three releases, whatever the case', async () => {
    const response = await fetch(`${app.url}/api/search?q=RELEASE`)
    const body: unknown = await response.json()
    assert.deepEqual(body, { items: ['Release checklist', 'Release notes', 'Prepare the release branch'] })
  })

  test('refuses other paths and methods', async () => {
    assert.equal((await fetch(`${app.url}/nope`)).status, 404)
    assert.equal((await fetch(`${app.url}/api/items`, { method: 'POST' })).status, 405)
    assert.equal(app.requests(), 5)
  })
})
