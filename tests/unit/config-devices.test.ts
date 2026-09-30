import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { deviceNames, emulationFor, isDeviceName } from '../../src/config/devices.ts'
import { emulationSchema } from '../../src/protocol/emulation.ts'
import { parse } from '../../src/protocol/schema.ts'

describe('devices', () => {
  test('the table has the four devices the plan names', () => {
    assert.deepEqual([...deviceNames], ['Pixel 9', 'Galaxy S24', 'iPhone 17', 'iPad Pro 11'])
  })

  // TouchDeviceName is every device name; this keeps that type honest.
  test('every device has a touch screen and a mobile layout, in portrait', () => {
    for (const name of deviceNames) {
      const emulation = emulationFor(name, '154.0.7195.41')
      assert.equal(parse(emulationSchema, emulation).ok, true, name)
      assert.equal(emulation.touch, true, name)
      assert.equal(emulation.isMobile, true, name)
      assert.ok(emulation.viewport.height > emulation.viewport.width, name)
      assert.ok(emulation.deviceScaleFactor >= 1, name)
    }
  })

  test('an Android device says it runs the browser own major version of Chrome', () => {
    for (const name of ['Pixel 9', 'Galaxy S24'] as const) {
      assert.match(emulationFor(name, '154.0.7195.41').userAgent ?? '', /\(Linux; Android 10; K\).* Chrome\/154\.0\.0\.0 Mobile Safari\/537\.36$/)
    }
    assert.match(emulationFor('Pixel 9', '153').userAgent ?? '', /Chrome\/153\.0\.0\.0 /)
    assert.match(emulationFor('Pixel 9', 'unknown').userAgent ?? '', /Chrome\/unknown\.0\.0\.0 /)
  })

  test('an Apple device keeps its own Safari user agent', () => {
    assert.match(emulationFor('iPhone 17', '154.0.1.2').userAgent ?? '', /^Mozilla\/5\.0 \(iPhone; .* Mobile\/15E148 Safari\/604\.1$/)
    assert.match(emulationFor('iPad Pro 11', '154.0.1.2').userAgent ?? '', /^Mozilla\/5\.0 \(Macintosh; .* Safari\/605\.1\.15$/)
  })

  test('a screen of the config own is used as it is, and a copy is returned each time', () => {
    const own = { viewport: { width: 800, height: 600 }, deviceScaleFactor: 1, touch: false, isMobile: false }
    const emulation = emulationFor(own, '154.0.0.0')
    assert.deepEqual(emulation, own)
    assert.notEqual(emulation, own)
    assert.notEqual(emulation.viewport, own.viewport)
    assert.equal('userAgent' in emulation, false, 'without a user agent the browser keeps its own')
    const first = emulationFor('Pixel 9', '154')
    first.viewport.width = 1
    assert.equal(emulationFor('Pixel 9', '154').viewport.width, 412)
  })

  test('isDeviceName knows the table and nothing else', () => {
    assert.equal(isDeviceName('Pixel 9'), true)
    for (const name of ['pixel 9', 'Pixel 99', 'iPhone', '', 'constructor']) assert.equal(isDeviceName(name), false, name)
  })
})
