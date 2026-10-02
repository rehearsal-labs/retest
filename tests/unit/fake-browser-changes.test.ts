import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { FakeBrowser } from '../support/fake-browser.ts'

const locator = { by: 'testId', value: 'saved-task' } as const

async function fakePage() {
  const browser = new FakeBrowser({}, { executablePath: '/fake/chromium', logFile: '/dev/null', headless: true })
  const page = await browser.newPage({ baseUrl: 'http://app.test' }, 1000)
  return { browser, page }
}

describe('the fake page counts its changes as the real page does', () => {
  test('every command that took effect is a change, and a look says how many there were', async () => {
    const { page } = await fakePage()
    const before = await page.execute({ kind: 'observe', locator }, 1000)
    assert.ok(before.ok && before.kind === 'observe')
    assert.equal(before.changes, 0)
    await page.execute({ kind: 'goto', url: '/' }, 1000)
    await page.execute({ kind: 'fill', locator: { by: 'testId', value: 'task-title' }, value: 'Release' }, 1000)
    const after = await page.execute({ kind: 'observe', locator }, 1000)
    assert.ok(after.ok && after.kind === 'observe')
    assert.equal(after.changes, 2)
    assert.equal(after.waitedMs, undefined)
  })

  test('a look with after answers as soon as the page changes, and says how long it waited', async () => {
    const { page } = await fakePage()
    const looking = page.execute({ kind: 'observe', locator, after: { changes: 0, waitMs: 2000 } }, 5000)
    await delay(30)
    page.changed()
    const result = await looking
    assert.ok(result.ok && result.kind === 'observe')
    assert.equal(result.changes, 1)
    assert.ok(result.waitedMs !== undefined && result.waitedMs >= 20 && result.waitedMs < 1000, `waited ${result.waitedMs} ms`)
  })

  test('a look with after on a page that does not change answers after waitMs, and at once when it already has', async () => {
    const { page } = await fakePage()
    const quiet = await page.execute({ kind: 'observe', locator, after: { changes: 0, waitMs: 40 } }, 1000)
    assert.ok(quiet.ok && quiet.kind === 'observe')
    assert.ok(quiet.waitedMs !== undefined && quiet.waitedMs >= 39, `waited ${quiet.waitedMs} ms`)
    page.changed()
    const already = await page.execute({ kind: 'observe', locator, after: { changes: 0, waitMs: 1000 } }, 1000)
    assert.ok(already.ok && already.kind === 'observe')
    assert.equal(already.waitedMs, undefined)
    assert.equal(already.changes, 1)
  })
})
