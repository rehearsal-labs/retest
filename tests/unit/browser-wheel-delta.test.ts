import assert from 'node:assert/strict'
import { test } from 'node:test'
import { wheelDelta, wheelUnits } from '../../src/browser/wheel-delta.ts'

// How a Chromium browser reads a wheel's delta, by the version it reports: in CSS pixels from Chrome 158.0.8111.0, the
// first build that scales the delta by the page's zoom itself, and in the viewport's own pixels before it.

test('Chrome reads a wheel delta in CSS pixels from build 158.0.8111.0 on, and in the viewport’s pixels up to 158.0.8110.0', () => {
  assert.equal(wheelUnits({ product: 'Chrome', version: '158.0.8110.0' }), 'viewport')
  assert.equal(wheelUnits({ product: 'Chrome', version: '158.0.8110.99' }), 'viewport')
  assert.equal(wheelUnits({ product: 'Chrome', version: '158.0.8111.0' }), 'css')
  assert.equal(wheelUnits({ product: 'Chrome', version: '158.0.8111.1' }), 'css')
})

test('the Chrome releases measured read the delta as the rule says', () => {
  assert.equal(wheelUnits({ product: 'Chrome', version: '158.0.8127.36' }), 'css')
  assert.equal(wheelUnits({ product: 'Chrome', version: '157.0.8103.79' }), 'viewport')
  assert.equal(wheelUnits({ product: 'Chrome', version: '156.0.8078.80' }), 'viewport')
  assert.equal(wheelUnits({ product: 'Chrome', version: '156.0.8078.79' }), 'viewport')
  assert.equal(wheelUnits({ product: 'Chrome', version: '153.0.8010.12' }), 'viewport')
  assert.equal(wheelUnits({ product: 'Chrome', version: '159.0.8129.0' }), 'css')
  assert.equal(wheelUnits({ product: 'Chrome', version: '1000.0.0.0' }), 'css')
})

test('the headless shell follows its build as Chrome does', () => {
  assert.equal(wheelUnits({ product: 'HeadlessChrome', version: '153.0.8010.12' }), 'viewport')
  assert.equal(wheelUnits({ product: 'HeadlessChrome', version: '157.0.8103.78' }), 'viewport')
  assert.equal(wheelUnits({ product: 'HeadlessChrome', version: '158.0.8110.0' }), 'viewport')
  assert.equal(wheelUnits({ product: 'HeadlessChrome', version: '158.0.8111.0' }), 'css')
})

test('an Electron app follows the Chromium it embeds, which its handshake names as Chrome', () => {
  assert.equal(wheelUnits({ product: 'Chrome', version: '152.0.7977.130' }), 'viewport')
})

test('a browser that numbers its own builds, such as Microsoft Edge, is read by its major version alone', () => {
  assert.equal(wheelUnits({ product: 'Edg', version: '156.0.4314.58' }), 'viewport')
  assert.equal(wheelUnits({ product: 'Edg', version: '157.0.4400.0' }), 'viewport')
  assert.equal(wheelUnits({ product: 'Edg', version: '158.0.4400.0' }), 'css')
  assert.equal(wheelUnits({ product: 'Edg', version: '159.0.4500.0' }), 'css')
})

test('a version that cannot be read is taken to read the delta in CSS pixels, as the protocol says', () => {
  for (const version of ['unknown', '158', '158.0.8111', '158.0.8111.0.1', '158.0.x.0', '']) {
    assert.equal(wheelUnits({ product: 'Chrome', version }), 'css', version)
  }
})

test('the delta sent is the CSS pixels times the page scale in the viewport’s pixels, and the CSS pixels themselves otherwise', () => {
  assert.deepEqual(wheelDelta({ x: 0, y: 60 }, 0.42, 'viewport'), { x: 0, y: 60 * 0.42 })
  assert.deepEqual(wheelDelta({ x: -30, y: 60 }, 2, 'viewport'), { x: -60, y: 120 })
  assert.deepEqual(wheelDelta({ x: -30, y: 60 }, 0.42, 'css'), { x: -30, y: 60 })
  assert.deepEqual(wheelDelta({ x: 0, y: 60 }, 1, 'viewport'), { x: 0, y: 60 })
})
