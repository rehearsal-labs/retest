import { crc32, deflateSync, inflateSync } from 'node:zlib'

// The PNGs native captures hand out: their size, and their 8-bit pixels decoded and encoded again. A macOS capture
// is the app's own window as the window server draws it, never a cut of the display, so it holds no other window.

/** A PNG's pixels, unfiltered: `channels` bytes per pixel, row by row. */
export type DecodedPng = { readonly width: number; readonly height: number; readonly channels: number; readonly pixels: Uint8Array }

const maxDecodedBytes = 256 * 1024 * 1024
const signature = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)
// Bytes per pixel at bit depth 8, by colour type: grey, RGB, grey with alpha, RGBA.
const channelsByType: Readonly<Record<number, number>> = { 0: 1, 2: 3, 4: 2, 6: 4 }
const typeByChannels: Readonly<Record<number, number>> = { 1: 0, 3: 2, 2: 4, 4: 6 }

/**
 * The size a PNG's header states, without decoding its pixels; undefined for bytes that are not a PNG.
 *
 * @example pngSize(capture) // { width: 1206, height: 2622 }
 */
export function pngSize(bytes: Uint8Array): { readonly width: number; readonly height: number } | undefined {
  if (bytes.length < 24 || signature.some((byte, index) => bytes[index] !== byte)) return undefined
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return { width: view.getUint32(16), height: view.getUint32(20) }
}

/**
 * Decodes an 8-bit, non-interlaced grey, RGB or RGBA PNG, which is what XCTest writes. Anything else throws, naming
 * what it was.
 *
 * @example decodePng(capture).width // 3456
 */
export function decodePng(bytes: Uint8Array): DecodedPng {
  const size = pngSize(bytes)
  if (size === undefined || bytes.length < 33) throw new Error('The data is not a PNG.')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const bitDepth = bytes[24]
  const colourType = bytes[25] ?? -1
  const interlace = bytes[28]
  const channels = channelsByType[colourType]
  if (bitDepth !== 8 || interlace !== 0 || channels === undefined) throw new Error(`The PNG has bit depth ${String(bitDepth)}, colour type ${colourType} and interlace ${String(interlace)}; only 8-bit grey, RGB and RGBA without interlace are read.`)
  const stride = size.width * channels
  const expectedBytes = size.height * (stride + 1)
  if (size.width < 1 || size.height < 1 || !Number.isSafeInteger(expectedBytes) || expectedBytes > maxDecodedBytes) throw new Error(`The PNG exceeds the decoded limit of ${maxDecodedBytes} bytes.`)
  const compressed: Uint8Array[] = []
  for (let offset = 8; offset + 8 <= bytes.length; ) {
    const length = view.getUint32(offset)
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8))
    if (type === 'IDAT') compressed.push(bytes.subarray(offset + 8, offset + 8 + length))
    if (type === 'IEND') break
    offset += 12 + length
  }
  let data: Buffer
  try { data = inflateSync(Buffer.concat(compressed), { maxOutputLength: expectedBytes }) }
  catch { throw new Error(`The PNG could not be inflated within ${expectedBytes} bytes.`) }
  if (data.length !== size.height * (stride + 1)) throw new Error(`The PNG holds ${data.length} bytes of pixels; ${size.width}x${size.height} needs ${size.height * (stride + 1)}.`)
  return { ...size, channels, pixels: unfilter(data, size.height, stride, channels) }
}

/**
 * Encodes pixels as a PNG, each row unfiltered.
 *
 * @example encodePng(decodePng(capture))
 */
export function encodePng(image: DecodedPng): Uint8Array {
  const colourType = typeByChannels[image.channels]
  if (colourType === undefined) throw new RangeError(`A PNG pixel has 1 to 4 channels, not ${image.channels}.`)
  const stride = image.width * image.channels
  const raw = new Uint8Array(image.height * (stride + 1))
  for (let row = 0; row < image.height; row += 1) raw.set(image.pixels.subarray(row * stride, (row + 1) * stride), row * (stride + 1) + 1)
  const header = new Uint8Array(13)
  const headerView = new DataView(header.buffer)
  headerView.setUint32(0, image.width)
  headerView.setUint32(4, image.height)
  header.set([8, colourType, 0, 0, 0], 8)
  return Buffer.concat([signature, chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', new Uint8Array(0))])
}

/**
 * How many distinct pixel values an image holds, counted up to `limit`, so a blank capture cannot pass for a picture.
 *
 * @example distinctColours(decodePng(capture)) // 4096
 */
export function distinctColours(image: DecodedPng, limit = 4096): number {
  const seen = new Set<string>()
  for (let index = 0; index < image.pixels.length && seen.size < limit; index += image.channels) seen.add(image.pixels.subarray(index, index + image.channels).join(','))
  return seen.size
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const head = new Uint8Array(8)
  const view = new DataView(head.buffer)
  view.setUint32(0, data.length)
  head.set(Buffer.from(type, 'ascii'), 4)
  const tail = new Uint8Array(4)
  new DataView(tail.buffer).setUint32(0, crc32(Buffer.concat([head.subarray(4), data])))
  return Buffer.concat([head, data, tail])
}

function unfilter(data: Uint8Array, height: number, stride: number, channels: number): Uint8Array {
  const out = new Uint8Array(height * stride)
  for (let row = 0; row < height; row += 1) {
    const filter = data[row * (stride + 1)]
    const source = row * (stride + 1) + 1
    const target = row * stride
    for (let column = 0; column < stride; column += 1) {
      const raw = data[source + column] ?? 0
      const left = column >= channels ? (out[target + column - channels] ?? 0) : 0
      const up = row > 0 ? (out[target + column - stride] ?? 0) : 0
      const upLeft = row > 0 && column >= channels ? (out[target + column - stride - channels] ?? 0) : 0
      out[target + column] = (raw + predict(filter, left, up, upLeft)) & 0xff
    }
  }
  return out
}

function predict(filter: number | undefined, left: number, up: number, upLeft: number): number {
  switch (filter) {
    case 0:
      return 0
    case 1:
      return left
    case 2:
      return up
    case 3:
      return Math.floor((left + up) / 2)
    case 4: {
      const estimate = left + up - upLeft
      const toLeft = Math.abs(estimate - left)
      const toUp = Math.abs(estimate - up)
      const toUpLeft = Math.abs(estimate - upLeft)
      if (toLeft <= toUp && toLeft <= toUpLeft) return left
      return toUp <= toUpLeft ? up : upLeft
    }
    default:
      throw new Error(`The PNG has an unknown row filter ${String(filter)}.`)
  }
}
