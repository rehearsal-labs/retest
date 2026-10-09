import type { TestContext } from 'node:test'
import type { CaptureStart, CapturedFrame, FrameSource, Frozen } from '../../src/media/capture.ts'
import type { Ended, FrameFormat, FrameMapEntry } from '../../src/media/client.ts'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { promisify } from 'node:util'

// What every capture proof shares: the media binary and ffmpeg it needs, a page whose pixels say what time it is, an
// independent decode of the video and of the frames that went in, and the check that each video frame shows the frame
// its capture time maps to. Nothing here is Retest's own decoding: ffmpeg decodes every image and video.

const execute = promisify(execFile)
/** The independent decoder launches are recorded before their own bounded cleanup may signal them. */
function run(command: string, args: string[], options?: { encoding: 'utf8'; maxBuffer: number }): Promise<{ stdout: string; stderr: string }>
function run(command: string, args: string[], options: { encoding: 'buffer'; maxBuffer: number }): Promise<{ stdout: Buffer; stderr: Buffer }>
function run(command: string, args: string[], options: { encoding: 'utf8' | 'buffer'; maxBuffer: number } = { encoding: 'utf8', maxBuffer: 1024 * 1024 }): Promise<{ stdout: string | Buffer; stderr: string | Buffer }> {
  const launched = execute(command, args, { ...options, timeout: 60_000, killSignal: 'SIGKILL' })
  const folder = process.env['RETEST_CAPTURE_PROOF_OUT']
  if (folder !== undefined) {
    mkdirSync(folder, { recursive: true })
    appendFileSync(join(folder, 'decoder-processes.jsonl'), `${JSON.stringify({ pid: launched.child.pid, command, args })}\n`)
  }
  return launched
}
const repositoryRoot = resolve(import.meta.dirname, '../..')

/** The media binary, ffmpeg and ffprobe a proof needs. */
export type MediaPrerequisites = { readonly binary: string; readonly ffmpeg: string; readonly ffprobe: string }

function findOnPath(program: string): string | undefined {
  for (const folder of (process.env['PATH'] ?? '').split(delimiter)) {
    const candidate = join(folder, program)
    if (folder !== '' && existsSync(candidate)) return candidate
  }
  return undefined
}

/**
 * The media binary and ffmpeg a proof needs. On macOS, where the media process is built and verified, a missing one
 * fails the test with what to do; elsewhere the test is skipped by name.
 */
export function mediaPrerequisites(t: TestContext): MediaPrerequisites | undefined {
  const binary = process.env['RETEST_MEDIA_BINARY'] || join(repositoryRoot, 'media', 'target', 'release', 'retest-media')
  const ffmpeg = process.env['RETEST_FFMPEG'] || findOnPath('ffmpeg')
  const ffprobe = ffmpeg === undefined ? undefined : [join(ffmpeg, '..', 'ffprobe'), findOnPath('ffprobe')].find((path) => path !== undefined && existsSync(path))
  const missing = [
    ...(existsSync(binary) ? [] : [`the media binary at ${binary}; build it with: cargo build --release --manifest-path media/Cargo.toml`]),
    ...(ffmpeg === undefined || !existsSync(ffmpeg) ? ['ffmpeg; install it or set RETEST_FFMPEG'] : []),
    ...(ffprobe === undefined ? ['ffprobe, which comes with ffmpeg'] : []),
  ]
  if (missing.length === 0 && ffmpeg !== undefined && ffprobe !== undefined) return { binary, ffmpeg, ffprobe }
  if (process.platform === 'darwin') assert.fail(`This test needs ${missing.join(', and ')}.`)
  t.skip(`needs ${missing.join(', and ')}`)
  return undefined
}

/** A source that passes everything through and keeps every frame it handed over, in order, for the proof to read. */
export function watched(source: FrameSource): { readonly source: FrameSource; readonly frames: CapturedFrame[] } {
  const frames: CapturedFrame[] = []
  const wrapper: FrameSource = {
    name: source.name,
    identity: source.identity,
    availability: () => source.availability(),
    start: (capture): Promise<CaptureStart> => source.start({ ...capture, deliver: (frame) => (frames.push(frame), capture.deliver(frame)) }),
    stop: (timeoutMs) => source.stop(timeoutMs),
  }
  return { source: wrapper, frames }
}

// The ticker page: a grid of black and white cells showing, in Gray code, which tick of `tickMs` milliseconds of the
// epoch it is when the page paints, so any picture of it says when the page drew it, and two pictures one tick apart
// differ in one cell only. 12 cells count 4096 ticks before the count wraps.
const columns = 4
const rows = 3
const tickCount = 2 ** (columns * rows)

/** How long one tick of the ticker page lasts. */
export const tickMs = 20

function tickerPage(): string {
  const cells = Array.from({ length: columns * rows }, () => '<div></div>').join('')
  return `<!doctype html><html><head><meta charset="utf-8"><title>ticker</title><style>
html, body { margin: 0; height: 100%; background: rgb(128, 128, 128); overflow: hidden }
#grid { display: grid; grid-template-columns: repeat(${columns}, 1fr); grid-template-rows: repeat(${rows}, 1fr); width: 100vw; height: 100vh }
#grid div { background: rgb(0, 0, 0) }
</style></head><body><div id="grid">${cells}</div><script>
const cells = [...document.querySelectorAll('#grid div')]
function paint() {
  const tick = Math.floor((performance.timeOrigin + performance.now()) / ${tickMs}) % ${tickCount}
  const gray = tick ^ (tick >> 1)
  cells.forEach((cell, index) => { cell.style.background = (gray >> (${columns * rows - 1} - index)) & 1 ? 'rgb(255, 255, 255)' : 'rgb(0, 0, 0)' })
  requestAnimationFrame(paint)
}
requestAnimationFrame(paint)
requestAnimationFrame(() => requestAnimationFrame(() => { document.title = 'ticker-ready' }))
</script></body></html>`
}

/** Serves the ticker page on loopback until the test ends. */
export async function tickerServer(t: TestContext): Promise<string> {
  const page = tickerPage()
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    response.end(page)
  })
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  t.after(() => new Promise<void>((resolveClose) => server.close(() => resolveClose())))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('the ticker server has no port')
  return `http://127.0.0.1:${address.port}/`
}

/** A picture's pixels as ffmpeg decoded them: one byte of brightness each, row by row. */
export type Luma = { readonly width: number; readonly height: number; readonly pixels: Uint8Array }

/** What the ticker shows in a picture: the tick, or why it cannot be read, such as a cell neither black nor white. */
export type TickReading = { readonly ok: true; readonly tick: number } | { readonly ok: false; readonly problem: string }

/**
 * Reads the tick from a picture of the ticker page: the mean brightness of the middle half of each cell, black below
 * 64 and white above 192; anything between is unreadable rather than guessed.
 */
export function readTick(luma: Luma): TickReading {
  let gray = 0
  for (let index = 0; index < columns * rows; index++) {
    const column = index % columns
    const row = Math.floor(index / columns)
    const mean = meanBrightness(luma, { x: (column + 0.25) / columns, y: (row + 0.25) / rows, width: 0.5 / columns, height: 0.5 / rows })
    if (mean > 64 && mean < 192) return { ok: false, problem: `cell ${index} is neither black nor white (mean brightness ${mean.toFixed(1)})` }
    gray = (gray << 1) | (mean >= 192 ? 1 : 0)
  }
  let tick = gray
  for (let shift = gray >> 1; shift > 0; shift >>= 1) tick ^= shift
  return { ok: true, tick }
}

function meanBrightness(luma: Luma, area: { x: number; y: number; width: number; height: number }): number {
  const left = Math.floor(area.x * luma.width)
  const top = Math.floor(area.y * luma.height)
  const right = Math.max(left + 1, Math.floor((area.x + area.width) * luma.width))
  const bottom = Math.max(top + 1, Math.floor((area.y + area.height) * luma.height))
  let sum = 0
  for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) sum += luma.pixels[y * luma.width + x] ?? 0
  return sum / ((right - left) * (bottom - top))
}

/** The tick of the epoch a moment on the run's clock falls in, given when the run's clock read zero, in epoch milliseconds. */
export function tickAt(timestampUs: number, clockZeroEpochMs: number): number {
  return Math.floor((clockZeroEpochMs + timestampUs / 1000) / tickMs) % tickCount
}

/** How many ticks `later` is after `earlier`, counting across the wrap; negative when it is before. */
export function ticksBetween(earlier: number, later: number): number {
  const forward = (((later - earlier) % tickCount) + tickCount) % tickCount
  return forward > tickCount / 2 ? forward - tickCount : forward
}

// ffmpeg guesses a file's format from its first bytes unless it is told. A picture of the ticker is mostly flat colour, and
// its PNG can compress to bytes with 0x47 every 204 bytes, which ffprobe takes for MPEG-TS packets: it then finds no
// stream and says "End of file" of a whole PNG. Each picture's format is named, as the media process names it to its
// encoder.
function demuxer(format: FrameFormat): string[] {
  return ['-f', format === 'png' ? 'png_pipe' : 'jpeg_pipe']
}

// The first video stream's fields as ffprobe prints them, one `key=value` a line. A picture's format is named.
async function streamFields(ffprobe: string, path: string, keys: readonly string[], format?: FrameFormat): Promise<Map<string, string>> {
  const named = format === undefined ? [] : demuxer(format)
  const probe = await run(ffprobe, ['-v', 'error', ...named, '-select_streams', 'v:0', '-show_entries', `stream=${keys.join(',')}`, '-of', 'default=noprint_wrappers=1', path])
  const fields = new Map<string, string>()
  for (const line of probe.stdout.split('\n')) {
    const at = line.indexOf('=')
    if (at > 0) fields.set(line.slice(0, at), line.slice(at + 1).trim())
  }
  for (const key of keys) if (!fields.has(key)) throw new Error(`ffprobe gave no ${key} for ${path}`)
  return fields
}

function sizeOf(fields: Map<string, string>): { width: number; height: number } {
  const width = Number(fields.get('width'))
  const height = Number(fields.get('height'))
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)) throw new Error('ffprobe gave no whole size')
  return { width, height }
}

/** The size of a picture, as ffprobe reads it. */
export async function imageSize(ffprobe: string, bytes: Uint8Array, format: 'png' | 'jpeg'): Promise<{ width: number; height: number }> {
  const folder = await mkdtemp(join(tmpdir(), 'retest-capture-size-'))
  try {
    const path = join(folder, format === 'png' ? 'image.png' : 'image.jpg')
    await writeFile(path, bytes)
    return sizeOf(await streamFields(ffprobe, path, ['width', 'height'], format))
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
}

/** Every frame of a video, decoded by ffmpeg to brightness at the video's own size. */
export async function decodeVideo(needs: MediaPrerequisites, path: string): Promise<{ readonly frames: Luma[]; readonly fps: string; readonly codec: string }> {
  const fields = await streamFields(needs.ffprobe, path, ['codec_name', 'width', 'height', 'r_frame_rate'])
  const { width, height } = sizeOf(fields)
  const decoded = await run(needs.ffmpeg, ['-v', 'error', '-i', path, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { encoding: 'buffer', maxBuffer: 2 * 1024 * 1024 * 1024 })
  const size = width * height
  assert.equal(decoded.stdout.byteLength % size, 0, 'the decoded video is whole frames')
  const frames: Luma[] = []
  for (let offset = 0; offset + size <= decoded.stdout.byteLength; offset += size) frames.push({ width, height, pixels: new Uint8Array(decoded.stdout.subarray(offset, offset + size)) })
  return { frames, fps: fields.get('r_frame_rate') ?? '', codec: fields.get('codec_name') ?? '' }
}

/**
 * Each captured frame decoded by ffmpeg to brightness, at `size` when given, or at its own size. A frame whose bytes are
 * not one whole image, or whose file on disk is not all of them, fails by its index before ffmpeg reads it.
 */
export async function decodeFrames(needs: MediaPrerequisites, frames: readonly CapturedFrame[], size?: { width: number; height: number }): Promise<Luma[]> {
  const folder = await mkdtemp(join(tmpdir(), 'retest-capture-frames-'))
  try {
    const decoded: Luma[] = []
    for (const [index, frame] of frames.entries()) {
      assert.ok(wholeImage(frame.bytes, frame.format), `frame ${index} is not a whole ${frame.format === 'png' ? 'PNG' : 'JPEG'}: its ${frame.bytes.byteLength} bytes end before the image does`)
      const path = join(folder, `frame-${index}.${frame.format === 'png' ? 'png' : 'jpg'}`)
      await writeFile(path, frame.bytes)
      assert.equal((await stat(path)).size, frame.bytes.byteLength, `frame ${index} was written whole to ${path}`)
      const own = size ?? sizeOf(await streamFields(needs.ffprobe, path, ['width', 'height'], frame.format))
      const scale = size === undefined ? [] : ['-vf', `scale=${size.width}:${size.height}`]
      const output = await run(needs.ffmpeg, ['-v', 'error', ...demuxer(frame.format), '-i', path, ...scale, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { encoding: 'buffer', maxBuffer: 512 * 1024 * 1024 })
      assert.equal(output.stdout.byteLength, own.width * own.height, `frame ${index} decodes to one picture`)
      decoded.push({ width: own.width, height: own.height, pixels: new Uint8Array(output.stdout) })
    }
    return decoded
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
}

const pngSignature = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)

/**
 * Whether `bytes` are one whole image: a PNG from its signature through the IEND chunk that ends them, each chunk as
 * long as its length says, or a JPEG from its start-of-image marker to the end-of-image marker that ends them. What the
 * chunks hold, and their checksums, is ffmpeg's to read.
 *
 * @example wholeImage(png.subarray(0, png.byteLength - 1), 'png') // false
 */
export function wholeImage(bytes: Uint8Array, format: FrameFormat): boolean {
  if (format === 'jpeg') return bytes.byteLength >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9
  if (bytes.byteLength < pngSignature.byteLength || pngSignature.some((byte, index) => bytes[index] !== byte)) return false
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let offset = pngSignature.byteLength; offset + 12 <= bytes.byteLength; ) {
    const end = offset + 12 + view.getUint32(offset)
    if (end > bytes.byteLength) return false
    if (Buffer.from(bytes.buffer, bytes.byteOffset + offset + 4, 4).toString('latin1') === 'IEND') return end === bytes.byteLength
    offset = end
  }
  return false
}

/**
 * Which frame each video frame shows, by the recording's frame map: a frame `shown` from `videoUs` for `outputFrames`
 * frames covers those video frames, at the recording's `fps`. Gives the frame id for each video frame, or undefined where the map names none.
 */
export function shownFrameIds(ended: Frozen<Ended>, videoFrames: number, fps: number): (string | undefined)[] {
  const shown: (string | undefined)[] = Array.from({ length: videoFrames }, () => undefined)
  const frameUs = 1_000_000 / fps
  for (const entry of ended.frameMap) {
    if (entry.fate !== 'shown' || entry.videoUs === undefined || entry.outputFrames === undefined) continue
    const first = Math.round(entry.videoUs / frameUs)
    for (let index = first; index < first + entry.outputFrames && index < videoFrames; index++) shown[index] = entry.frameId
  }
  return shown
}

/** How many pixels of two pictures of one size differ in brightness by more than `threshold`. */
export function differingPixels(left: Luma, right: Luma, threshold = 48): number {
  assert.equal(left.pixels.byteLength, right.pixels.byteLength, 'pictures of one size are compared')
  let count = 0
  for (let index = 0; index < left.pixels.byteLength; index++) if (Math.abs((left.pixels[index] ?? 0) - (right.pixels[index] ?? 0)) > threshold) count += 1
  return count
}

/**
 * Pins each video frame to the captured frame the frame map says it shows, as the Phase 1 media proof did: that frame
 * must match it better than every source distinguishable at the unchanged brightness threshold. Equal scores
 * for sources indistinguishable at that threshold are resolved by capture timestamp order. Gives the frame it
 * shows, its difference from it, and the smallest difference from any other frame that is not its twin.
 */
export function matchVideo(video: readonly Luma[], frames: readonly Luma[], ids: readonly (string | undefined)[], timing: { readonly timestampsUs: readonly number[]; readonly fps: number }): { readonly matched: { video: number; frame: number; own: number; nearestOther: number | undefined }[]; readonly unmapped: number[] } {
  const matched: { video: number; frame: number; own: number; nearestOther: number | undefined }[] = []
  const unmapped: number[] = []
  assert.equal(timing.timestampsUs.length, frames.length, 'every source has its capture timestamp')
  assert.ok(Number.isFinite(timing.fps) && timing.fps > 0, 'the video rate is known')
  const origin = timing.timestampsUs[0] ?? 0
  const ticks = timing.timestampsUs.map((time, index) => {
    assert.ok(Number.isSafeInteger(time) && time >= origin && (index === 0 || time >= (timing.timestampsUs[index - 1] ?? origin)), 'source timestamps are ordered')
    return Math.round((time - origin) * timing.fps / 1_000_000)
  })
  for (const [videoIndex, picture] of video.entries()) {
    const id = ids[videoIndex]
    const frameIndex = id === undefined ? -1 : Number(id) - 1
    const expected = frames[frameIndex]
    if (expected === undefined) {
      unmapped.push(videoIndex)
      continue
    }
    const own = differingPixels(picture, expected)
    let nearestOther: number | undefined
    let timestampTie = false
    for (const [otherIndex, other] of frames.entries()) {
      if (otherIndex === frameIndex) continue
      const difference = differingPixels(picture, other)
      if (difference === own && differingPixels(expected, other) === 0) {
        timestampTie = true
        continue
      }
      nearestOther = nearestOther === undefined ? difference : Math.min(nearestOther, difference)
    }
    if (timestampTie && ticks.findLastIndex(tick => tick <= videoIndex) !== frameIndex) {
      unmapped.push(videoIndex)
      continue
    }
    matched.push({ video: videoIndex, frame: frameIndex, own, nearestOther })
  }
  return { matched, unmapped }
}

/** The shown entries of a frame map, in capture order. */
export function shownEntries(ended: Frozen<Ended>): Frozen<FrameMapEntry>[] {
  return ended.frameMap.filter((entry) => entry.fate === 'shown')
}

/**
 * What the frames of a ticker capture show: each frame's tick, how far behind the moment it reached Retest it is, in
 * milliseconds, and the frames that break the rules. A frame cannot show a moment after it arrived, so one more than a
 * tick ahead of its arrival, the slack for the page's and the run's clocks, is `future`; `backwards` frames show an
 * earlier tick than the frame before them; `unreadable` frames could not be read at all.
 */
export type TickerFrames = { readonly ticks: (number | undefined)[]; readonly lagsMs: number[]; readonly unreadable: string[]; readonly future: number[]; readonly backwards: number[]; readonly distinct: number }

export function tickerFrames(frames: readonly CapturedFrame[], pictures: readonly Luma[], clockZeroEpochMs: number): TickerFrames {
  const ticks: (number | undefined)[] = []
  const lagsMs: number[] = []
  const unreadable: string[] = []
  const future: number[] = []
  const backwards: number[] = []
  let previous: number | undefined
  for (const [index, picture] of pictures.entries()) {
    const reading = readTick(picture)
    const frame = frames[index]
    if (!reading.ok || frame === undefined) {
      ticks.push(undefined)
      unreadable.push(`frame ${index + 1}: ${reading.ok ? 'no frame' : reading.problem}`)
      continue
    }
    ticks.push(reading.tick)
    const behind = ticksBetween(reading.tick, tickAt(frame.timestampUs, clockZeroEpochMs))
    if (behind < -1) future.push(index + 1)
    lagsMs.push(behind * tickMs)
    if (previous !== undefined && ticksBetween(previous, reading.tick) < 0) backwards.push(index + 1)
    previous = reading.tick
  }
  return { ticks, lagsMs, unreadable, future, backwards, distinct: new Set(ticks.filter((tick) => tick !== undefined)).size }
}

/**
 * Reads each video frame's tick and compares it with the tick of the frame the frame map says it shows. Every video
 * frame must show exactly that tick.
 */
export function videoAgainstTicks(video: readonly Luma[], ids: readonly (string | undefined)[], frameTicks: readonly (number | undefined)[]): { readonly checked: number; readonly mismatched: string[]; readonly unmapped: number[] } {
  const mismatched: string[] = []
  const unmapped: number[] = []
  let checked = 0
  for (const [index, picture] of video.entries()) {
    const id = ids[index]
    const expected = id === undefined ? undefined : frameTicks[Number(id) - 1]
    if (expected === undefined) {
      unmapped.push(index)
      continue
    }
    const reading = readTick(picture)
    checked += 1
    if (!reading.ok) mismatched.push(`video frame ${index}: ${reading.problem}`)
    else if (reading.tick !== expected) mismatched.push(`video frame ${index} shows tick ${reading.tick}, its frame ${id} showed ${expected}`)
  }
  return { checked, mismatched, unmapped }
}

/** The smallest, middle and largest of some numbers, and how many. */
export function spread(values: readonly number[]): { count: number; min?: number; median?: number; max?: number } {
  if (values.length === 0) return { count: 0 }
  const sorted = [...values].sort((left, right) => left - right)
  return { count: sorted.length, min: sorted[0] ?? 0, median: sorted[Math.floor(sorted.length / 2)] ?? 0, max: sorted.at(-1) ?? 0 }
}

/** The pauses between consecutive frames' timestamps, in milliseconds. */
export function pausesMs(frames: readonly CapturedFrame[]): number[] {
  return frames.slice(1).map((frame, index) => (frame.timestampUs - (frames[index]?.timestampUs ?? frame.timestampUs)) / 1000)
}

/** A side made even, as H.264 in 4:2:0 needs. */
export function even(side: number): number {
  return side % 2 === 0 ? side : side - 1
}
