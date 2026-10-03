import { crc32, inflateSync } from 'node:zlib'

/** What a PNG file holds, read from its own bytes. */
export type PngFacts = {
  readonly width: number
  readonly height: number
  readonly bitDepth: number
  readonly colorType: number
  /** How many different pixel values the decoded image has. A blank frame has one. */
  readonly distinctColors: number
}

const SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)
// Bytes per pixel at bit depth 8, by colour type: grey, RGB, grey with alpha, RGBA. Palettes are not expected.
const channels: Readonly<Record<number, number>> = { 0: 1, 2: 3, 4: 2, 6: 4 }
const distinctColorLimit = 4096

/**
 * Reads a PNG from its bytes: the signature, every chunk's CRC, the header, and the pixels, decompressed and
 * unfiltered row by row. Anything else, including a cut-off file, throws with what was wrong.
 *
 * @example inspectPng(await readFile('page.png')) // { width: 1280, height: 720, bitDepth: 8, colorType: 6, distinctColors: 312 }
 */
export function inspectPng(bytes: Uint8Array): PngFacts {
  if (bytes.length < SIGNATURE.length || SIGNATURE.some((byte, index) => bytes[index] !== byte)) {
    throw new Error('The file does not start with the PNG signature')
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const data: Uint8Array[] = []
  let header: { width: number; height: number; bitDepth: number; colorType: number; interlace: number } | undefined
  let ended = false
  for (let offset = SIGNATURE.length; !ended; ) {
    if (offset + 12 > bytes.length) throw new Error('The PNG ends before its IEND chunk')
    const length = view.getUint32(offset)
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8))
    const end = offset + 12 + length
    if (end > bytes.length) throw new Error(`The PNG's ${type} chunk runs past the end of the file`)
    const body = bytes.subarray(offset + 8, offset + 8 + length)
    if (crc32(bytes.subarray(offset + 4, offset + 8 + length)) !== view.getUint32(offset + 8 + length)) {
      throw new Error(`The PNG's ${type} chunk fails its CRC`)
    }
    if (type === 'IHDR') header = readHeader(body)
    if (type === 'IDAT') data.push(body)
    ended = type === 'IEND'
    offset = end
  }
  if (header === undefined) throw new Error('The PNG has no IHDR chunk')
  if (header.bitDepth !== 8 || header.interlace !== 0 || channels[header.colorType] === undefined) {
    throw new Error(`The PNG uses colour type ${header.colorType}, bit depth ${header.bitDepth}, interlace ${header.interlace}, which this check does not decode`)
  }
  const pixels = unfilter(inflateSync(Buffer.concat(data)), header.width, header.height, channels[header.colorType] ?? 0)
  return { width: header.width, height: header.height, bitDepth: header.bitDepth, colorType: header.colorType, distinctColors: countColors(pixels, channels[header.colorType] ?? 0) }
}

function readHeader(body: Uint8Array) {
  if (body.length !== 13) throw new Error('The PNG header is not 13 bytes long')
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength)
  return { width: view.getUint32(0), height: view.getUint32(4), bitDepth: body[8] ?? 0, colorType: body[9] ?? 0, interlace: body[12] ?? 0 }
}

// Reverses the five PNG row filters. Each row starts with its filter type.
function unfilter(raw: Uint8Array, width: number, height: number, bytesPerPixel: number): Uint8Array {
  const stride = width * bytesPerPixel
  if (raw.length !== height * (stride + 1)) {
    throw new Error(`The PNG's pixel data is ${raw.length} bytes, but ${width}×${height} needs ${height * (stride + 1)}`)
  }
  const pixels = new Uint8Array(height * stride)
  for (let row = 0; row < height; row += 1) {
    const filter = raw[row * (stride + 1)]
    for (let column = 0; column < stride; column += 1) {
      const value = raw[row * (stride + 1) + 1 + column] ?? 0
      const left = column >= bytesPerPixel ? (pixels[row * stride + column - bytesPerPixel] ?? 0) : 0
      const up = row > 0 ? (pixels[(row - 1) * stride + column] ?? 0) : 0
      const upLeft = row > 0 && column >= bytesPerPixel ? (pixels[(row - 1) * stride + column - bytesPerPixel] ?? 0) : 0
      pixels[row * stride + column] = (value + predict(filter, left, up, upLeft)) & 0xff
    }
  }
  return pixels
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
    case 4:
      return paeth(left, up, upLeft)
    default:
      throw new Error(`The PNG uses row filter ${filter}, which does not exist`)
  }
}

function paeth(left: number, up: number, upLeft: number): number {
  const estimate = left + up - upLeft
  const toLeft = Math.abs(estimate - left)
  const toUp = Math.abs(estimate - up)
  const toUpLeft = Math.abs(estimate - upLeft)
  if (toLeft <= toUp && toLeft <= toUpLeft) return left
  return toUp <= toUpLeft ? up : upLeft
}

// Counting stops at a limit; past it the frame is plainly not blank.
function countColors(pixels: Uint8Array, bytesPerPixel: number): number {
  const seen = new Set<number>()
  for (let offset = 0; offset < pixels.length && seen.size < distinctColorLimit; offset += bytesPerPixel) {
    let value = 0
    for (let channel = 0; channel < bytesPerPixel; channel += 1) value = value * 256 + (pixels[offset + channel] ?? 0)
    seen.add(value)
  }
  return seen.size
}
