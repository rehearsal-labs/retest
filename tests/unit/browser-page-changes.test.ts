import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { observeFunction } from '../../src/browser/page-scripts.ts'
import { observationOf } from '../support/observation.ts'
import { mainFrame, scriptedPage, value } from './browser-fixtures.ts'

const facts = { href: 'http://app.test/start?token=1', title: 'Start' }
const locator = { by: 'testId', value: 'saved-task' } as const

function pageShowing(text: string) {
  return scriptedPage({
    call: (functionDeclaration) => {
      if (functionDeclaration === observeFunction) return value({ observation: observationOf([{ text, visible: true }]), page: facts })
      return Promise.reject(new Error('unexpected call'))
    },
  })
}

test('a look counts the changes the page has told, and one with after answers on the next change', async () => {
  const { page, emit } = pageShowing('Saved')
  const first = await page.execute({ kind: 'observe', locator }, 1000)
  assert.ok(first.ok && first.kind === 'observe')
  assert.equal(first.changes, 0)
  assert.equal(first.waitedMs, undefined)
  const waiting = page.execute({ kind: 'observe', locator, after: { changes: 0, waitMs: 2000 } }, 5000)
  await delay(20)
  emit('Runtime.bindingCalled', { name: 'retestChanged', payload: '', executionContextId: 5 })
  const woken = await waiting
  assert.ok(woken.ok && woken.kind === 'observe')
  assert.equal(woken.changes, 1)
  assert.ok(woken.waitedMs !== undefined && woken.waitedMs >= 10 && woken.waitedMs < 1000, `waited ${woken.waitedMs} ms`)
})

test('a look with after on a page that does not change answers when its wait runs out, within the command\'s time', async () => {
  const { page } = pageShowing('Saving…')
  const started = performance.now()
  const quiet = await page.execute({ kind: 'observe', locator, after: { changes: 0, waitMs: 60 } }, 1000)
  assert.ok(quiet.ok && quiet.kind === 'observe')
  assert.ok(performance.now() - started >= 55, 'answered before the wait ran out')
  assert.ok(quiet.waitedMs !== undefined && quiet.waitedMs >= 55, `waited ${quiet.waitedMs} ms`)
  const short = await page.execute({ kind: 'observe', locator, after: { changes: 0, waitMs: 5000 } }, 80)
  assert.ok(short.ok && short.kind === 'observe', JSON.stringify(short))
  assert.ok(performance.now() - started < 1000, 'the wait outlived the command')
})

test('a change the page already told, and a new document, both count, so a look with an older count does not wait', async () => {
  const { page, emit } = pageShowing('Saved')
  emit('Runtime.bindingCalled', { name: 'retestChanged', payload: '', executionContextId: 5 })
  emit('Runtime.bindingCalled', { name: 'other', payload: '', executionContextId: 5 })
  emit('Page.frameNavigated', { frame: { id: mainFrame, url: 'http://app.test/next', loaderId: 'L2' } })
  const started = performance.now()
  const result = await page.execute({ kind: 'observe', locator, after: { changes: 1, waitMs: 2000 } }, 5000)
  assert.ok(result.ok && result.kind === 'observe')
  assert.equal(result.changes, 2)
  assert.equal(result.waitedMs, undefined)
  assert.ok(performance.now() - started < 500, 'waited although the page had changed')
})
