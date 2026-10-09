import type { TestContext } from 'node:test'
import type { CapturedFrame } from '../../src/media/capture.ts'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { test } from 'node:test'
import { crc32 } from 'node:zlib'
import { decodeFrames, imageSize, wholeImage } from '../integration/capture-proof.ts'

const identity = { testId: 'decode', attemptId: 'a1', app: 'web', sessionId: 'a1:web' }
const jpeg = Uint8Array.of(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0xff, 0xd9)

function chunk(type: string, data: Uint8Array): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.byteLength, 0)
  head.write(type, 4, 'latin1')
  const sum = Buffer.alloc(4)
  sum.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'latin1'), data])) >>> 0)
  return Buffer.concat([head, data, sum])
}

// A whole 255 by 32 grey PNG whose pixels are kept in a stored deflate block, so they stand in the file as written, and
// carry 0x47 at a steady stride with the next bytes but two marked as an MPEG-TS adaptation field: a file ffmpeg takes
// for MPEG-TS packets when it guesses the format from the bytes, as it did a Firefox frame of the ticker page.
function transportLookingPng(stride: number): Buffer {
  const width = 255
  const height = 32
  const raw = Buffer.alloc(height * (width + 1))
  // The pixels begin 48 bytes into the file: the signature, IHDR, IDAT's header, and the zlib and stored block headers.
  for (let at = 176; at - 48 + 3 < raw.byteLength; at += stride) {
    const index = at - 48
    if (index % (width + 1) === 0 || (index + 3) % (width + 1) === 0) continue
    raw[index] = 0x47
    raw[index + 3] = 0x30
  }
  let low = 1
  let high = 0
  for (const byte of raw) {
    low = (low + byte) % 65521
    high = (high + low) % 65521
  }
  const adler = Buffer.alloc(4)
  adler.writeUInt32BE(((high << 16) | low) >>> 0)
  const length = raw.byteLength
  const stored = Buffer.concat([Buffer.from([0x78, 0x01, 0x01, length & 0xff, length >> 8, ~length & 0xff, (~length >> 8) & 0xff]), raw, adler])
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', stored), chunk('IEND', new Uint8Array())])
}

function frame(bytes: Uint8Array, format: CapturedFrame['format'] = 'png'): CapturedFrame {
  return { identity, timestampUs: 1000, format, bytes }
}

// ffmpeg and ffprobe from the PATH, or a skip that names them.
function decoders(t: TestContext): { binary: string; ffmpeg: string; ffprobe: string } | undefined {
  const found = (program: string): string | undefined => (process.env['PATH'] ?? '').split(delimiter).map((folder) => join(folder, program)).find((path) => existsSync(path))
  const ffmpeg = found('ffmpeg')
  const ffprobe = found('ffprobe')
  if (ffmpeg !== undefined && ffprobe !== undefined) return { binary: '', ffmpeg, ffprobe }
  t.skip('needs ffmpeg and ffprobe on the PATH')
  return undefined
}

test('a whole PNG or JPEG is whole, and one cut short, run on or missing its end is not', () => {
  const png = transportLookingPng(204)
  assert.equal(wholeImage(png, 'png'), true)
  assert.equal(wholeImage(Buffer.concat([Buffer.alloc(5), png]).subarray(5), 'png'), true, 'a view into a larger buffer is read from its own start')
  assert.equal(wholeImage(png.subarray(0, png.byteLength - 1), 'png'), false, 'cut inside IEND')
  assert.equal(wholeImage(png.subarray(0, 2000), 'png'), false, 'cut inside IDAT')
  assert.equal(wholeImage(png.subarray(0, png.byteLength - 12), 'png'), false, 'no IEND')
  assert.equal(wholeImage(Buffer.concat([png, Buffer.of(0)]), 'png'), false, 'bytes after IEND')
  assert.equal(wholeImage(png.subarray(1), 'png'), false, 'no signature')
  assert.equal(wholeImage(jpeg, 'jpeg'), true)
  assert.equal(wholeImage(jpeg.subarray(0, jpeg.byteLength - 1), 'jpeg'), false)
  assert.equal(wholeImage(png, 'jpeg'), false)
})

for (const stride of [188, 204]) {
  test(`a whole PNG whose bytes look like ${stride}-byte MPEG-TS packets is read as the PNG it is`, async (t) => {
    const needs = decoders(t)
    if (needs === undefined) return
    const png = transportLookingPng(stride)
    assert.deepEqual(await imageSize(needs.ffprobe, png, 'png'), { width: 255, height: 32 })
    const [picture] = await decodeFrames(needs, [frame(png)])
    assert.deepEqual([picture?.width, picture?.height, picture?.pixels.byteLength], [255, 32, 255 * 32])
  })
}

test('a frame cut short fails by its index before ffmpeg reads it', async (t) => {
  const needs = decoders(t)
  if (needs === undefined) return
  const png = transportLookingPng(204)
  await assert.rejects(decodeFrames(needs, [frame(png), frame(png.subarray(0, 4000))]), /frame 1 is not a whole PNG: its 4000 bytes end before the image does$/)
  await assert.rejects(decodeFrames(needs, [frame(jpeg.subarray(0, 6), 'jpeg')]), /frame 0 is not a whole JPEG: its 6 bytes end before the image does/)
})
