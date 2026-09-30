import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyEmulation } from '../../src/browser/emulation.ts'
import { Deadline } from '../../src/protocol/deadline.ts'
import { scriptedSession } from './browser-fixtures.ts'

const phone = { viewport: { width: 412, height: 923 }, deviceScaleFactor: 2.625, touch: true, isMobile: true, userAgent: 'Mozilla/5.0 (Linux; Android 10; K)' }

test('a phone gets its metrics, a touch screen and its user agent', async () => {
  const { session, sent } = scriptedSession(() => Promise.resolve({}))
  await applyEmulation(session, phone, new Deadline(1000))
  assert.deepEqual(sent, [
    { method: 'Emulation.setDeviceMetricsOverride', params: { width: 412, height: 923, deviceScaleFactor: 2.625, mobile: true } },
    { method: 'Emulation.setTouchEmulationEnabled', params: { enabled: true, maxTouchPoints: 1 } },
    { method: 'Emulation.setUserAgentOverride', params: { userAgent: 'Mozilla/5.0 (Linux; Android 10; K)' } },
  ])
})

test('a screen without touch or a user agent changes only the metrics', async () => {
  const { session, sent } = scriptedSession(() => Promise.resolve({}))
  await applyEmulation(session, { viewport: { width: 800, height: 600 }, deviceScaleFactor: 1, touch: false, isMobile: false }, new Deadline(1000))
  assert.deepEqual(sent, [
    { method: 'Emulation.setDeviceMetricsOverride', params: { width: 800, height: 600, deviceScaleFactor: 1, mobile: false } },
  ])
})

test('a browser that refuses the emulation fails the page', async () => {
  const { session } = scriptedSession((method) => (method === 'Emulation.setTouchEmulationEnabled' ? Promise.reject(new Error('refused')) : Promise.resolve({})))
  await assert.rejects(applyEmulation(session, phone, new Deadline(1000)), /refused/)
})
