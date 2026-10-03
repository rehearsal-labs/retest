import assert from 'node:assert/strict'
import { test } from 'node:test'
import { crc32, deflateSync } from 'node:zlib'
import { PngError, pngSignature, readPng } from './png.ts'

function headerOf(fields: { colorType: number; bitDepth: number; interlace: number }): Buffer {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(3, 0)
  header.writeUInt32BE(2, 4)
  header.writeUInt8(fields.bitDepth, 8)
  header.writeUInt8(fields.colorType, 9)
  header.writeUInt8(fields.interlace, 12)
  return header
}

// A 3 × 2 RGBA image: red, green, blue on the first row, and the second row filtered with Up, repeating it.
function samplePng(): Buffer {
  const header = headerOf({ colorType: 6, bitDepth: 8, interlace: 0 })
  const firstRow = [0, 255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255]
  const secondRow = [2, ...new Array<number>(12).fill(0)]
  return Buffer.concat([Buffer.from(pngSignature), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.from([...firstRow, ...secondRow]))), chunk('IEND', Buffer.alloc(0))])
}

function chunk(type: string, body: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(body.length)
  const typed = Buffer.concat([Buffer.from(type, 'latin1'), body])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typed))
  return Buffer.concat([length, typed, crc])
}

test('reads the size and format of a valid PNG and counts its colours', () => {
  assert.deepEqual(readPng(samplePng()), { width: 3, height: 2, bitDepth: 8, colorType: 6, chunks: ['IHDR', 'IDAT', 'IEND'], distinctColors: 3 })
})

test('refuses a file that is not a whole, valid PNG', () => {
  const valid = samplePng()
  const badSignature = Buffer.from(valid)
  badSignature[1] = 0
  const badCrc = Buffer.from(valid)
  badCrc[20] = (badCrc[20] ?? 0) ^ 0xff
  const cases: [Buffer, RegExp][] = [
    [badSignature, /PNG signature/],
    [badCrc, /IHDR chunk at byte 8 fails its CRC/],
    [valid.subarray(0, valid.length - 12), /does not end with an IEND chunk/],
    [valid.subarray(0, 40), /cut short/],
  ]
  for (const [bytes, problem] of cases) assert.throws(() => readPng(bytes), (error) => error instanceof PngError && problem.test(error.message))
})

test('refuses a type it does not decode instead of passing it unread', () => {
  const types = [
    { colorType: 3, bitDepth: 8, interlace: 0 },
    { colorType: 0, bitDepth: 8, interlace: 0 },
    { colorType: 6, bitDepth: 16, interlace: 0 },
    { colorType: 6, bitDepth: 8, interlace: 1 },
  ]
  for (const type of types) {
    const png = Buffer.concat([Buffer.from(pngSignature), chunk('IHDR', headerOf(type)), chunk('IDAT', deflateSync(Buffer.alloc(26))), chunk('IEND', Buffer.alloc(0))])
    const expected = `colour type ${type.colorType}, bit depth ${type.bitDepth}, interlace ${type.interlace}`
    assert.throws(() => readPng(png), (error) => error instanceof PngError && error.message.endsWith(`${expected}.`), JSON.stringify(type))
  }
})

test('refuses image data that does not fill the image', () => {
  const header = headerOf({ colorType: 6, bitDepth: 8, interlace: 0 })
  const short = Buffer.concat([Buffer.from(pngSignature), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.alloc(13))), chunk('IEND', Buffer.alloc(0))])
  assert.throws(() => readPng(short), (error) => error instanceof PngError && /holds 13 bytes, not the 26/.test(error.message))
})
