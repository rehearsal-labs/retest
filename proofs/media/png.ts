import { crc32, deflateSync, inflateSync } from 'node:zlib'

/** An image as rows of 8-bit RGB pixels, top to bottom. */
export type RgbImage = { width: number; height: number; rgb: Uint8Array }

const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/**
 * Writes an RGB image as a PNG. `level` 0 stores the pixels uncompressed, which makes a large frame from a small
 * pattern; 6 is zlib's usual balance.
 *
 * @example encodePng({ width: 2, height: 1, rgb: new Uint8Array([255, 0, 0, 0, 0, 255]) })
 */
export function encodePng(image: RgbImage, level = 6): Buffer {
  const stride = image.width * 3
  const rows = Buffer.alloc((stride + 1) * image.height)
  for (let y = 0; y < image.height; y += 1) {
    rows[y * (stride + 1)] = 0
    rows.set(image.rgb.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1)
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(image.width, 0)
  header.writeUInt32BE(image.height, 4)
  header.set([8, 2, 0, 0, 0], 8)
  return Buffer.concat([signature, chunk('IHDR', header), chunk('IDAT', deflateSync(rows, { level })), chunk('IEND', Buffer.alloc(0))])
}

function chunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, 'latin1')
  const out = Buffer.alloc(12 + data.byteLength)
  out.writeUInt32BE(data.byteLength, 0)
  typeBytes.copy(out, 4)
  data.copy(out, 8)
  out.writeUInt32BE(crc32(data, crc32(typeBytes)), 8 + data.byteLength)
  return out
}

/**
 * Reads a PNG of 8-bit RGB or RGBA pixels without interlacing, which is what Chrome's screenshots and ffmpeg's
 * PNG encoder write, and drops any alpha. Anything else throws, naming what it found.
 */
export function decodePng(bytes: Uint8Array): RgbImage {
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (!data.subarray(0, 8).equals(signature)) throw new Error('not a PNG: the signature is wrong')
  let width = 0
  let height = 0
  let channels = 0
  const compressed: Buffer[] = []
  for (let offset = 8; offset + 8 <= data.byteLength; ) {
    const length = data.readUInt32BE(offset)
    const type = data.toString('latin1', offset + 4, offset + 8)
    const body = data.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = body.readUInt32BE(0)
      height = body.readUInt32BE(4)
      const [depth, colour, , , interlace] = [body[8], body[9], body[10], body[11], body[12]]
      if (depth !== 8 || interlace !== 0 || (colour !== 2 && colour !== 6)) {
        throw new Error(`unsupported PNG: bit depth ${depth}, colour type ${colour}, interlace ${interlace}`)
      }
      channels = colour === 2 ? 3 : 4
    } else if (type === 'IDAT') {
      compressed.push(body)
    } else if (type === 'IEND') {
      break
    }
    offset += 12 + length
  }
  if (channels === 0) throw new Error('not a PNG: no IHDR chunk')
  return { width, height, rgb: unfilter(inflateSync(Buffer.concat(compressed)), width, height, channels) }
}

// Undoes PNG's per-row filters and keeps the first three channels of each pixel.
function unfilter(raw: Buffer, width: number, height: number, channels: number): Uint8Array {
  const stride = width * channels
  const current = new Uint8Array(stride)
  let previous = new Uint8Array(stride)
  const rgb = new Uint8Array(width * height * 3)
  for (let y = 0; y < height; y += 1) {
    const start = y * (stride + 1)
    const filter = raw[start] ?? 0
    for (let x = 0; x < stride; x += 1) {
      const value = raw[start + 1 + x] ?? 0
      const left = x >= channels ? (current[x - channels] ?? 0) : 0
      const up = previous[x] ?? 0
      const upLeft = x >= channels ? (previous[x - channels] ?? 0) : 0
      current[x] = (value + predict(filter, left, up, upLeft)) & 0xff
    }
    for (let x = 0; x < width; x += 1) {
      rgb.set(current.subarray(x * channels, x * channels + 3), (y * width + x) * 3)
    }
    previous = current.slice()
  }
  return rgb
}

function predict(filter: number, left: number, up: number, upLeft: number): number {
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
      const [toLeft, toUp, toUpLeft] = [Math.abs(estimate - left), Math.abs(estimate - up), Math.abs(estimate - upLeft)]
      if (toLeft <= toUp && toLeft <= toUpLeft) return left
      return toUp <= toUpLeft ? up : upLeft
    }
    default:
      throw new Error(`unsupported PNG row filter ${filter}`)
  }
}

/** A solid-colour RGB image. */
export function solidImage(width: number, height: number, colour: readonly [number, number, number]): RgbImage {
  const rgb = new Uint8Array(width * height * 3)
  for (let index = 0; index < rgb.length; index += 3) rgb.set(colour, index)
  return { width, height, rgb }
}
