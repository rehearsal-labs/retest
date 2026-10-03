import assert from 'node:assert/strict'
import { test } from 'node:test'
import { crc32, deflateSync } from 'node:zlib'
import { keyStrokes } from './keys.ts'
import { inspectPng } from './png.ts'

test('types letters, capitals with Shift, digits, space and punctuation', () => {
  assert.deepEqual(keyStrokes('aZ 9.'), [
    { key: 'a', code: 'KeyA', keyCode: 65, text: 'a', shift: false },
    { key: 'Z', code: 'KeyZ', keyCode: 90, text: 'Z', shift: true },
    { key: ' ', code: 'Space', keyCode: 32, text: ' ', shift: false },
    { key: '9', code: 'Digit9', keyCode: 57, text: '9', shift: false },
    { key: '.', code: 'Period', keyCode: 190, text: '.', shift: false },
  ])
})

test('refuses a character it has no key for, naming its position and not the text', () => {
  assert.throws(() => keyStrokes('pass€word'), (error: unknown) => {
    assert.ok(error instanceof RangeError)
    assert.equal(error.message, 'Character 5 of the text has no key on the proof\'s keyboard')
    return true
  })
})

function chunk(type: string, body: Uint8Array): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(body.length)
  const typed = Buffer.concat([Buffer.from(type, 'latin1'), body])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typed))
  return Buffer.concat([length, typed, crc])
}

// A 2×2 RGBA image: red, green on the first row (filter None), blue, blue on the second (filter Up).
function smallPng(): Buffer {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(2, 0)
  header.writeUInt32BE(2, 4)
  header.set([8, 6, 0, 0, 0], 8)
  const rows = Buffer.from([0, 255, 0, 0, 255, 0, 255, 0, 255, 2, 1, 0, 255, 0, 0, 1, 255, 0])
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  return Buffer.concat([signature, chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', new Uint8Array())])
}

test('reads a PNG\'s size and decodes its pixels through the row filters', () => {
  assert.deepEqual(inspectPng(smallPng()), { width: 2, height: 2, bitDepth: 8, colorType: 6, distinctColors: 3 })
})

test('refuses a file that is not a whole, intact PNG', () => {
  const png = smallPng()
  assert.throws(() => inspectPng(Buffer.from('GIF89a')), /PNG signature/)
  assert.throws(() => inspectPng(png.subarray(0, png.length - 12)), /ends before its IEND/)
  const damaged = Buffer.from(png)
  damaged[20] = (damaged[20] ?? 0) ^ 0xff
  assert.throws(() => inspectPng(damaged), /IHDR chunk fails its CRC/)
})
