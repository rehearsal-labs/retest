import { crc32, inflateSync } from 'node:zlib'

/**
 * What a PNG file holds, as read from its bytes. `distinctColors` counts the different pixel values, up to
 * `colorLimit`.
 */
export type PngFacts = { width: number; height: number; bitDepth: number; colorType: number; chunks: string[]; distinctColors: number }

/** A file that is not a whole, valid PNG of a type the reader decodes. The message names the first problem. */
export class PngError extends Error {
  override readonly name = 'PngError'
}

export const pngSignature: readonly number[] = [137, 80, 78, 71, 13, 10, 26, 10]

// Enough to tell a rendered page from a blank or single-colour image without counting every colour of a photo.
const colorLimit = 4096
// The reader decodes the two types a browser screenshot comes in: 8-bit RGB and RGBA, without interlacing.
const channelsByColorType: Readonly<Record<number, number>> = { 2: 3, 6: 4 }

/**
 * Reads a PNG: checks its signature and every chunk's CRC, reads its header, inflates its image data, checks it holds
 * exactly one filtered row of pixels per line of the image, and undoes each row's filter to count its colours. Any
 * other type than 8-bit RGB or RGBA without interlacing is refused rather than passed unread.
 *
 * @example const { width, height } = readPng(await readFile('viewport.png'))
 */
export function readPng(bytes: Uint8Array): PngFacts {
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (data.length < 8 || pngSignature.some((byte, index) => data[index] !== byte)) throw new PngError('The file does not start with the PNG signature.')
  const chunks: string[] = []
  const imageData: Buffer[] = []
  let header: Buffer | undefined
  let offset = 8
  while (offset < data.length) {
    if (offset + 12 > data.length) throw new PngError(`A chunk at byte ${offset} is cut short.`)
    const length = data.readUInt32BE(offset)
    const type = data.toString('latin1', offset + 4, offset + 8)
    const end = offset + 12 + length
    if (end > data.length) throw new PngError(`The ${type} chunk at byte ${offset} is cut short.`)
    const body = data.subarray(offset + 8, offset + 8 + length)
    if (crc32(data.subarray(offset + 4, offset + 8 + length)) !== data.readUInt32BE(offset + 8 + length)) {
      throw new PngError(`The ${type} chunk at byte ${offset} fails its CRC.`)
    }
    chunks.push(type)
    if (type === 'IHDR') header = body
    if (type === 'IDAT') imageData.push(body)
    offset = end
    if (type === 'IEND') break
  }
  if (chunks[0] !== 'IHDR' || header === undefined || header.length !== 13) throw new PngError('The file does not begin with a valid IHDR chunk.')
  if (chunks.at(-1) !== 'IEND') throw new PngError('The file does not end with an IEND chunk.')
  if (imageData.length === 0) throw new PngError('The file has no image data.')
  const width = header.readUInt32BE(0)
  const height = header.readUInt32BE(4)
  const bitDepth = header.readUInt8(8)
  const colorType = header.readUInt8(9)
  const interlace = header.readUInt8(12)
  const channels = channelsByColorType[colorType]
  if (channels === undefined || bitDepth !== 8 || interlace !== 0) {
    throw new PngError(`The reader decodes 8-bit RGB and RGBA without interlacing; this file has colour type ${colorType}, bit depth ${bitDepth}, interlace ${interlace}.`)
  }
  const pixels = inflateSync(Buffer.concat(imageData))
  const stride = width * channels
  if (pixels.length !== height * (stride + 1)) {
    throw new PngError(`The image data holds ${pixels.length} bytes, not the ${height * (stride + 1)} a ${width} × ${height} image needs.`)
  }
  const distinctColors = countColors(pixels, { width, height, channels, stride })
  return { width, height, bitDepth, colorType, chunks, distinctColors }
}

type Layout = { width: number; height: number; channels: number; stride: number }

// Undoes each row's filter, as the PNG specification defines them, and counts the distinct pixels it finds.
function countColors(filtered: Buffer, { width, height, channels, stride }: Layout): number {
  const colors = new Set<string>()
  let previous = Buffer.alloc(stride)
  for (let row = 0; row < height; row += 1) {
    const start = row * (stride + 1)
    const filter = filtered.readUInt8(start)
    const current = Buffer.from(filtered.subarray(start + 1, start + 1 + stride))
    for (let index = 0; index < stride; index += 1) {
      const left = index >= channels ? (current[index - channels] ?? 0) : 0
      const up = previous[index] ?? 0
      const upLeft = index >= channels ? (previous[index - channels] ?? 0) : 0
      current[index] = ((current[index] ?? 0) + predictor(filter, left, up, upLeft)) & 0xff
    }
    for (let column = 0; column < width && colors.size < colorLimit; column += 1) {
      colors.add(current.toString('hex', column * channels, (column + 1) * channels))
    }
    previous = current
  }
  return colors.size
}

function predictor(filter: number, left: number, up: number, upLeft: number): number {
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
      throw new PngError(`A row uses the filter ${filter}, which PNG does not define.`)
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
