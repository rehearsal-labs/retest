import { crc32, deflateSync, inflateSync } from 'node:zlib'

// PNG decoding and encoding for the pictures a screenshot comparison holds: what browsers write when asked for a PNG,
// 8-bit RGB or RGBA without interlacing, and the baselines and differences Retest writes back. Anything else is
// refused with a sentence that says what it was, so a baseline edited by another tool fails by name rather than
// comparing as something it is not. The format is the W3C's Portable Network Graphics specification, third edition.

/** A picture as Retest compares it: `width` by `height` pixels, four bytes each, red, green, blue and alpha, row by row. */
export type RgbaImage = { readonly width: number; readonly height: number; readonly data: Uint8Array }

/** A PNG as `readPng` reads it: its pixels as RGBA, and the text of its `tEXt` chunks by keyword. */
export type PngPicture = RgbaImage & { readonly text: Readonly<Record<string, string>> }

/** What `writePng` adds to the pixels: `tEXt` chunks, by keyword, each keyword 1 to 79 Latin-1 letters. */
export type PngWriteOptions = { readonly text?: Readonly<Record<string, string>> }

/** Thrown for bytes that are not a PNG Retest reads. The message says what the bytes were. */
export class PngError extends Error {
  override readonly name = 'PngError'
}

/** The most bytes a decoded picture may take, filter bytes included, so a damaged file cannot ask for all memory. */
export const maxPictureBytes: number = 512 * 1024 * 1024

const signature = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)
const readable = 'Retest reads 8-bit RGB and RGBA PNGs without interlacing, as browsers write them'
// Bytes per pixel by colour type, for the two types Retest reads: RGB and RGBA.
const channelsByType: Readonly<Record<number, number>> = { 2: 3, 6: 4 }
const typeNames: Readonly<Record<number, string>> = { 0: 'greyscale', 3: 'a palette of colours', 4: 'greyscale with alpha' }

/**
 * Decodes a PNG into RGBA pixels: 8-bit RGB or RGBA, not interlaced, its rows filtered with any of the five filters.
 * Every chunk's checksum is checked. RGB pixels get an alpha of 255. Throws `PngError` for anything else.
 *
 * @example readPng(bytes).width // 1280
 */
export function readPng(bytes: Uint8Array): PngPicture {
  if (bytes.length < signature.length || signature.some((byte, index) => bytes[index] !== byte)) throw new PngError('The file is not a PNG: it does not start with the PNG signature.')
  const chunks = readChunks(bytes)
  const [header] = chunks
  if (header === undefined || header.type !== 'IHDR' || header.data.length !== 13) throw new PngError('The PNG does not start with its header chunk.')
  const view = new DataView(header.data.buffer, header.data.byteOffset, header.data.byteLength)
  const width = view.getUint32(0)
  const height = view.getUint32(4)
  const [bitDepth, colourType, compression, filterMethod, interlace] = header.data.subarray(8)
  if (width === 0 || height === 0) throw new PngError(`The PNG is ${width} by ${height} pixels, and a picture needs at least one pixel each way.`)
  if (bitDepth !== 8) throw new PngError(`The PNG has ${String(bitDepth)}-bit channels. ${readable}.`)
  const channels = channelsByType[colourType ?? -1]
  if (channels === undefined) throw new PngError(`The PNG holds ${typeNames[colourType ?? -1] ?? `colour type ${String(colourType)}`}. ${readable}.`)
  if (interlace !== 0) throw new PngError(`The PNG is interlaced. ${readable}.`)
  if (compression !== 0 || filterMethod !== 0) throw new PngError('The PNG names a compression or filter method the format does not define.')
  const stride = width * channels
  const filtered = height * (stride + 1)
  if (!Number.isSafeInteger(filtered) || filtered > maxPictureBytes || width * height * 4 > maxPictureBytes) throw new PngError(`The PNG is ${width} by ${height} pixels, more than Retest decodes.`)
  const text: Record<string, string> = {}
  const compressed: Uint8Array[] = []
  let ended = false
  for (const chunk of chunks.slice(1)) {
    if (chunk.type === 'IEND') {
      ended = true
      break
    }
    if (chunk.type === 'IHDR') throw new PngError('The PNG has a second header chunk.')
    if (chunk.type === 'IDAT') compressed.push(chunk.data)
    else if (chunk.type === 'tEXt') readText(chunk.data, text)
    // A chunk whose type starts with a capital letter is critical: a reader that does not know it must not show the picture.
    else if (chunk.type !== 'PLTE' && isCritical(chunk.type)) throw new PngError(`The PNG holds a ${chunk.type} chunk, which Retest does not know and must not skip.`)
  }
  if (!ended) throw new PngError('The PNG ends before its end chunk, so it is cut short.')
  if (compressed.length === 0) throw new PngError('The PNG holds no image data.')
  let raw: Buffer
  try {
    raw = inflateSync(Buffer.concat(compressed), { maxOutputLength: filtered })
  } catch {
    throw new PngError(`The PNG's image data does not inflate to the ${width} by ${height} pixels its header states.`)
  }
  if (raw.length !== filtered) throw new PngError(`The PNG's image data holds ${raw.length} bytes, and ${width} by ${height} pixels need ${filtered}.`)
  return { width, height, data: toRgba(unfilter(raw, height, stride, channels), channels), text }
}

/**
 * Encodes RGBA pixels as a PNG: RGB when every pixel is opaque, RGBA otherwise, each row with the filter that leaves the
 * smallest sum, as libpng chooses, and any `tEXt` chunks the options name.
 *
 * @example writePng({ width: 1, height: 1, data: Uint8Array.of(255, 0, 0, 255) }, { text: { 'retest:scale': '2' } })
 */
export function writePng(image: RgbaImage, options: PngWriteOptions = {}): Uint8Array {
  const { width, height, data } = image
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) throw new RangeError(`A picture is at least 1 by 1 pixel, not ${width} by ${height}.`)
  if (data.length !== width * height * 4) throw new RangeError(`${width} by ${height} RGBA pixels take ${width * height * 4} bytes, not ${data.length}.`)
  const opaque = isOpaque(data)
  const channels = opaque ? 3 : 4
  const pixels = opaque ? toRgb(data) : data
  const header = new Uint8Array(13)
  const view = new DataView(header.buffer)
  view.setUint32(0, width)
  view.setUint32(4, height)
  header.set([8, opaque ? 2 : 6, 0, 0, 0], 8)
  const texts = Object.entries(options.text ?? {}).map(([keyword, value]) => chunk('tEXt', textData(keyword, value)))
  const compressed = deflateSync(filterRows(pixels, height, width * channels, channels))
  return Buffer.concat([signature, chunk('IHDR', header), ...texts, chunk('IDAT', compressed), chunk('IEND', new Uint8Array(0))])
}

type Chunk = { readonly type: string; readonly data: Uint8Array }

function readChunks(bytes: Uint8Array): Chunk[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const chunks: Chunk[] = []
  let offset = signature.length
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) throw new PngError('The PNG is cut short inside a chunk.')
    const length = view.getUint32(offset)
    const end = offset + 12 + length
    if (end > bytes.length) throw new PngError('The PNG is cut short inside a chunk.')
    const typeBytes = bytes.subarray(offset + 4, offset + 8)
    const type = String.fromCharCode(...typeBytes)
    if (!/^[A-Za-z]{4}$/.test(type)) throw new PngError('The PNG holds a chunk whose type is not four letters, so it is damaged.')
    const data = bytes.subarray(offset + 8, offset + 8 + length)
    const stated = view.getUint32(offset + 8 + length)
    if (crc32(bytes.subarray(offset + 4, offset + 8 + length)) !== stated) throw new PngError(`The PNG's ${type} chunk fails its checksum, so the file is damaged.`)
    chunks.push({ type, data })
    offset = end
    if (type === 'IEND') break
  }
  return chunks
}

function isCritical(type: string): boolean {
  const first = type.charCodeAt(0)
  return first >= 0x41 && first <= 0x5a
}

function readText(data: Uint8Array, text: Record<string, string>): void {
  const separator = data.indexOf(0)
  if (separator < 1 || separator > 79) return
  text[Buffer.from(data.subarray(0, separator)).toString('latin1')] = Buffer.from(data.subarray(separator + 1)).toString('latin1')
}

function textData(keyword: string, value: string): Uint8Array {
  if (!/^[\x20-\x7e\xa1-\xff]{1,79}$/.test(keyword) || keyword !== keyword.trim()) throw new RangeError(`A PNG text keyword is 1 to 79 Latin-1 letters, not ${JSON.stringify(keyword)}.`)
  if (!/^[\n\x20-\x7e\xa1-\xff]*$/.test(value)) throw new RangeError('A PNG text holds Latin-1 letters and line feeds only.')
  return Buffer.concat([Buffer.from(keyword, 'latin1'), Uint8Array.of(0), Buffer.from(value, 'latin1')])
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const head = new Uint8Array(8)
  const view = new DataView(head.buffer)
  view.setUint32(0, data.length)
  head.set(Buffer.from(type, 'latin1'), 4)
  const tail = new Uint8Array(4)
  new DataView(tail.buffer).setUint32(0, crc32(Buffer.concat([head.subarray(4), data])))
  return Buffer.concat([head, data, tail])
}

// Each row is stored as a filter byte and the row's bytes, each the difference from a prediction made from the byte to
// its left, the one above it and the one above and to the left. Undoing it adds the prediction back, row by row.
function unfilter(raw: Uint8Array, height: number, stride: number, channels: number): Uint8Array {
  const out = new Uint8Array(height * stride)
  for (let row = 0; row < height; row++) {
    const filter = raw[row * (stride + 1)]
    const source = row * (stride + 1) + 1
    const target = row * stride
    const above = target - stride
    if (filter === undefined || filter > 4) throw new PngError(`The PNG's row ${row + 1} names filter ${String(filter)}, and the format has filters 0 to 4.`)
    for (let column = 0; column < stride; column++) {
      const left = column >= channels ? (out[target + column - channels] ?? 0) : 0
      const up = row > 0 ? (out[above + column] ?? 0) : 0
      const upLeft = row > 0 && column >= channels ? (out[above + column - channels] ?? 0) : 0
      out[target + column] = ((raw[source + column] ?? 0) + predict(filter, left, up, upLeft)) & 0xff
    }
  }
  return out
}

function predict(filter: number, left: number, up: number, upLeft: number): number {
  switch (filter) {
    case 1:
      return left
    case 2:
      return up
    case 3:
      return (left + up) >> 1
    case 4:
      return paeth(left, up, upLeft)
    default:
      return 0
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

// Each row gets the filter whose output, read as signed bytes, has the smallest sum of magnitudes: the heuristic the
// specification suggests, which keeps flat colour and gradients small for deflate.
function filterRows(pixels: Uint8Array, height: number, stride: number, channels: number): Uint8Array {
  const out = new Uint8Array(height * (stride + 1))
  const candidate = new Uint8Array(stride)
  for (let row = 0; row < height; row++) {
    const target = row * (stride + 1)
    let best = Number.POSITIVE_INFINITY
    for (let filter = 0; filter <= 4; filter++) {
      let sum = 0
      for (let column = 0; column < stride; column++) {
        const at = row * stride + column
        const left = column >= channels ? (pixels[at - channels] ?? 0) : 0
        const up = row > 0 ? (pixels[at - stride] ?? 0) : 0
        const upLeft = row > 0 && column >= channels ? (pixels[at - stride - channels] ?? 0) : 0
        const value = ((pixels[at] ?? 0) - predict(filter, left, up, upLeft)) & 0xff
        candidate[column] = value
        sum += value < 128 ? value : 256 - value
      }
      if (sum >= best) continue
      best = sum
      out[target] = filter
      out.set(candidate, target + 1)
    }
  }
  return out
}

function isOpaque(data: Uint8Array): boolean {
  for (let index = 3; index < data.length; index += 4) if (data[index] !== 255) return false
  return true
}

function toRgb(data: Uint8Array): Uint8Array {
  const out = new Uint8Array((data.length / 4) * 3)
  for (let from = 0, to = 0; from < data.length; from += 4, to += 3) {
    out[to] = data[from] ?? 0
    out[to + 1] = data[from + 1] ?? 0
    out[to + 2] = data[from + 2] ?? 0
  }
  return out
}

function toRgba(pixels: Uint8Array, channels: number): Uint8Array {
  if (channels === 4) return pixels
  const out = new Uint8Array((pixels.length / 3) * 4)
  for (let from = 0, to = 0; from < pixels.length; from += 3, to += 4) {
    out[to] = pixels[from] ?? 0
    out[to + 1] = pixels[from + 1] ?? 0
    out[to + 2] = pixels[from + 2] ?? 0
    out[to + 3] = 255
  }
  return out
}
