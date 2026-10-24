import assert from 'node:assert/strict'
import { test } from 'node:test'
import { subscribedSchema, unsubscribeParameters } from '../../src/browser/firefox/subscriptions.ts'
import { parse } from '../../src/protocol/schema.ts'

// What ends a Firefox subscription, as each Firefox answers `session.subscribe`: the protocol unit only. That a page's
// subscriptions end on each Firefox is the integration files' to show.

test('reads the answer of Firefox 133, which gives no id, and of a later Firefox, which gives one', () => {
  assert.deepEqual(parse(subscribedSchema, {}), { ok: true, value: {} })
  assert.deepEqual(parse(subscribedSchema, { subscription: '6f1c0a1e-2c43-4d55-9d1e-0b5e8f3f9a10' }), { ok: true, value: { subscription: '6f1c0a1e-2c43-4d55-9d1e-0b5e8f3f9a10' } })
  assert.equal(parse(subscribedSchema, { subscription: 7 }).ok, false)
})

test('ends a subscription by its id when the browser gave one, and by its events and contexts when it gave none', () => {
  const events = ['browsingContext', 'script']
  assert.deepEqual(unsubscribeParameters({ id: 'subscription-1', events, contexts: ['context-1'] }), { subscriptions: ['subscription-1'] })
  assert.deepEqual(unsubscribeParameters({ id: undefined, events, contexts: ['context-1'] }), { events, contexts: ['context-1'] })
})
