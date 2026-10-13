import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { crc32, deflateSync } from 'node:zlib'
import { decodePng } from '../../src/native/png.ts'
import { PngError, readPng, writePng } from '../../src/shared/png.ts'

// PNGs built by hand, byte by byte, so the decoder is checked against the format rather than against Retest's own
// encoder: each row's filter byte and filtered bytes are written out, then deflated and wrapped in checksummed chunks.

type Row = { filter: number; bytes: number[] }
type Built = { width: number; height: number; colourType?: number; bitDepth?: number; interlace?: number; rows: Row[]; extra?: Uint8Array[]; split?: boolean }

const signature = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)

function chunk(type: string, data: Uint8Array): Uint8Array {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const checksum = Buffer.alloc(4)
  checksum.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, checksum])
}

function header(width: number, height: number, bitDepth: number, colourType: number, interlace: number): Uint8Array {
  const data = Buffer.alloc(13)
  data.writeUInt32BE(width, 0)
  data.writeUInt32BE(height, 4)
  data.set([bitDepth, colourType, 0, 0, interlace], 8)
  return chunk('IHDR', data)
}

function built({ width, height, colourType = 2, bitDepth = 8, interlace = 0, rows, extra = [], split = false }: Built): Uint8Array {
  const raw = Uint8Array.from(rows.flatMap((row) => [row.filter, ...row.bytes]))
  const compressed = deflateSync(raw)
  const middle = Math.floor(compressed.length / 2)
  const data = split ? [chunk('IDAT', compressed.subarray(0, middle)), chunk('IDAT', compressed.subarray(middle))] : [chunk('IDAT', compressed)]
  return Buffer.concat([signature, header(width, height, bitDepth, colourType, interlace), ...extra, ...data, chunk('IEND', new Uint8Array(0))])
}

function rgba(...pixels: number[][]): number[] {
  return pixels.flat()
}

test('an RGB PNG reads as RGBA with every pixel opaque', () => {
  const picture = readPng(built({ width: 2, height: 1, rows: [{ filter: 0, bytes: [10, 20, 30, 40, 50, 60] }] }))
  assert.deepEqual([picture.width, picture.height], [2, 1])
  assert.deepEqual([...picture.data], rgba([10, 20, 30, 255], [40, 50, 60, 255]))
})

test('each of the five row filters is undone, wrapping round at 256', () => {
  const pixels = rgba([10, 20, 30, 255], [40, 50, 60, 255], [70, 80, 90, 255], [100, 110, 120, 255])
  const filtered: [string, Row][] = [
    ['up', { filter: 2, bytes: [60, 60, 60, 60, 60, 60] }],
    ['average', { filter: 3, bytes: [65, 70, 75, 45, 45, 45] }],
    ['paeth', { filter: 4, bytes: [60, 60, 60, 30, 30, 30] }],
  ]
  for (const [name, second] of filtered) {
    const picture = readPng(built({ width: 2, height: 2, rows: [{ filter: 1, bytes: [10, 20, 30, 30, 30, 30] }, second] }))
    assert.deepEqual([...picture.data], pixels, `the sub filter, then the ${name} filter`)
  }
  const wrapped = readPng(built({ width: 2, height: 1, rows: [{ filter: 1, bytes: [200, 0, 0, 156, 0, 0] }] }))
  assert.deepEqual([...wrapped.data], rgba([200, 0, 0, 255], [100, 0, 0, 255]))
})

test('an RGBA PNG keeps its alpha, and image data split over several chunks reads as one', () => {
  const rows = [{ filter: 0, bytes: [1, 2, 3, 4, 5, 6, 7, 8] }, { filter: 2, bytes: [1, 1, 1, 1, 1, 1, 1, 1] }]
  const picture = readPng(built({ width: 2, height: 2, colourType: 6, rows, split: true }))
  assert.deepEqual([...picture.data], [1, 2, 3, 4, 5, 6, 7, 8, 2, 3, 4, 5, 6, 7, 8, 9])
})

test('text chunks are read by keyword, and other ancillary chunks are skipped', () => {
  const text = chunk('tEXt', Buffer.from('retest:scale\u00002', 'latin1'))
  const gamma = chunk('gAMA', Buffer.from([0, 0, 0xb1, 0x8f]))
  const picture = readPng(built({ width: 1, height: 1, rows: [{ filter: 0, bytes: [9, 9, 9] }], extra: [gamma, text] }))
  assert.deepEqual(picture.text, { 'retest:scale': '2' })
})

test('what Retest does not read is refused with a sentence naming it', () => {
  const one = [{ filter: 0, bytes: [0, 0, 0] }]
  const refusals: [string, Uint8Array, RegExp][] = [
    ['not a PNG', Buffer.from('GIF89a, not a PNG at all'), /does not start with the PNG signature/],
    ['16-bit', built({ width: 1, height: 1, bitDepth: 16, rows: [{ filter: 0, bytes: [0, 0, 0, 0, 0, 0] }] }), /16-bit channels\. Retest reads 8-bit RGB and RGBA PNGs/],
    ['palette', built({ width: 1, height: 1, colourType: 3, rows: [{ filter: 0, bytes: [0] }] }), /holds a palette of colours/],
    ['greyscale', built({ width: 1, height: 1, colourType: 0, rows: [{ filter: 0, bytes: [0] }] }), /holds greyscale\./],
    ['interlaced', built({ width: 1, height: 1, interlace: 1, rows: one }), /is interlaced/],
    ['unknown filter', built({ width: 1, height: 1, rows: [{ filter: 5, bytes: [0, 0, 0] }] }), /row 1 names filter 5/],
    ['too little data', built({ width: 2, height: 1, rows: one }), /does not inflate|holds 4 bytes/],
    ['unknown critical chunk', built({ width: 1, height: 1, rows: one, extra: [chunk('ABCD', new Uint8Array(1))] }), /ABCD chunk, which Retest does not know/],
  ]
  for (const [name, bytes, message] of refusals) {
    assert.throws(() => readPng(bytes), (error: unknown) => error instanceof PngError && message.test(error.message), name)
  }
  const good = built({ width: 1, height: 1, rows: one })
  const damaged = Uint8Array.from(good)
  damaged[30] = (damaged[30] ?? 0) ^ 0xff
  assert.throws(() => readPng(damaged), /chunk fails its checksum/)
  assert.throws(() => readPng(good.subarray(0, good.length - 12)), /ends before its end chunk/)
  assert.throws(() => readPng(good.subarray(0, good.length - 3)), /cut short inside a chunk/)
})

test('a written PNG reads back with the same pixels and text, as RGB when opaque and RGBA when not', () => {
  const width = 37
  const height = 23
  const data = new Uint8Array(width * height * 4)
  // A gradient, flat runs and noise, so every filter the encoder may choose is exercised.
  for (let index = 0; index < width * height; index++) {
    const x = index % width
    const y = Math.floor(index / width)
    data.set([(x * 7) & 0xff, y < 10 ? 128 : (x * y * 31) & 0xff, (index * 2654435761) >>> 24, 255], index * 4)
  }
  const opaque = writePng({ width, height, data }, { text: { 'retest:scale': '2' } })
  assert.equal(opaque[25], 2, 'colour type RGB')
  const read = readPng(opaque)
  assert.deepEqual([read.width, read.height], [width, height])
  assert.deepEqual(read.data, data)
  assert.deepEqual(read.text, { 'retest:scale': '2' })
  const translucent = Uint8Array.from(data)
  translucent[3] = 17
  const written = writePng({ width, height, data: translucent })
  assert.equal(written[25], 6, 'colour type RGBA')
  assert.deepEqual(readPng(written).data, translucent)
  assert.throws(() => writePng({ width: 2, height: 2, data: new Uint8Array(15) }), /take 16 bytes, not 15/)
})

test('real screenshots from Chrome, Firefox and WebKit read as the native decoder reads them, and survive a round trip', () => {
  const folder = new URL('../../fixtures/evaluation-corpus/captures/screenshots/', import.meta.url)
  for (const name of ['chromium-saved.png', 'firefox-saved.png', 'webkit-saved.png']) {
    const bytes = readFileSync(new URL(name, folder))
    const picture = readPng(bytes)
    const reference = decodePng(bytes)
    assert.deepEqual([picture.width, picture.height], [reference.width, reference.height], name)
    const expected = new Uint8Array(reference.width * reference.height * 4)
    for (let pixel = 0; pixel < reference.width * reference.height; pixel++) {
      for (let channel = 0; channel < reference.channels; channel++) expected[pixel * 4 + channel] = reference.pixels[pixel * reference.channels + channel] ?? 0
      if (reference.channels === 3) expected[pixel * 4 + 3] = 255
    }
    assert.ok(Buffer.from(picture.data).equals(Buffer.from(expected)), `${name} reads as the native decoder reads it`)
    assert.ok(Buffer.from(readPng(writePng(picture)).data).equals(Buffer.from(picture.data)), `${name} survives a round trip`)
  }
})
