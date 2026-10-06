import type { Recording, RecordingIdentity } from '../../src/media/client.ts'
import type { RgbImage } from './png.ts'
import { execFile, execFileSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { mkdir, readdir, readFile } from 'node:fs/promises'
import { delimiter, join, resolve } from 'node:path'
import { setTimeout as wait } from 'node:timers/promises'
import { promisify } from 'node:util'
import { isArray, isPlainObject } from '../../src/protocol/schema.ts'
import { decodePng } from './png.ts'

const run = promisify(execFile)

/** The identity the proofs' recordings carry: Retest's own ids, as a run would give them. */
export function proofIdentity(name: string): RecordingIdentity {
  return { runId: 'media-proof', attemptId: name, testId: `proofs/media > ${name}`, app: 'web', sessionId: `${name}:web` }
}

/** The Retest checkout these proofs belong to. */
export const repositoryRoot: string = resolve(import.meta.dirname, '../..')
const crateFolder = join(repositoryRoot, 'media')
const buildCommand = 'cargo build --release --manifest-path media/Cargo.toml'

/**
 * The `retest-media` binary to test: RETEST_MEDIA_BINARY, or the release build in `media/target`. A missing or
 * outdated binary throws, naming the command that builds it and whether cargo is there to run it.
 */
export function mediaBinary(): string {
  const configured = process.env['RETEST_MEDIA_BINARY']
  if (configured) {
    if (!existsSync(configured)) throw new Error(`RETEST_MEDIA_BINARY names ${configured}, which does not exist.`)
    return configured
  }
  const binary = join(crateFolder, 'target', 'release', 'retest-media')
  const cargo = findOnPath('cargo')
  const toolchain = cargo === undefined ? ' cargo is not on PATH: install Rust first, from https://rustup.rs.' : ''
  if (!existsSync(binary)) throw new Error(`The media binary is missing at ${binary}. Build it from ${repositoryRoot} with: ${buildCommand}.${toolchain}`)
  const newest = newestSource()
  if (statSync(binary).mtimeMs < newest.mtimeMs) {
    throw new Error(`The media binary at ${binary} is older than ${newest.path}. Rebuild it with: ${buildCommand}.${toolchain}`)
  }
  return binary
}

function newestSource(): { path: string; mtimeMs: number } {
  const sources = [join(crateFolder, 'Cargo.toml'), join(crateFolder, 'Cargo.lock'), join(crateFolder, 'build.rs'), ...rustFiles(join(crateFolder, 'src'))]
  let newest = { path: '', mtimeMs: 0 }
  for (const path of sources) {
    const { mtimeMs } = statSync(path)
    if (mtimeMs > newest.mtimeMs) newest = { path, mtimeMs }
  }
  return newest
}

function rustFiles(folder: string): string[] {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const path = join(folder, entry.name)
    if (entry.isDirectory()) return rustFiles(path)
    return entry.name.endsWith('.rs') ? [path] : []
  })
}

/** The ffmpeg the proofs encode with: RETEST_FFMPEG, or the one on PATH. Throws naming the prerequisite. */
export function ffmpegPath(): string {
  const path = process.env['RETEST_FFMPEG'] || findOnPath('ffmpeg')
  if (path === undefined || !existsSync(path)) throw new Error('ffmpeg is a prerequisite of the media proofs: install it (on macOS, brew install ffmpeg) or set RETEST_FFMPEG.')
  return path
}

/** The ffprobe beside ffmpeg, or on PATH. */
export function ffprobePath(): string {
  const beside = join(ffmpegPath(), '..', 'ffprobe')
  const path = existsSync(beside) ? beside : findOnPath('ffprobe')
  if (path === undefined) throw new Error('ffprobe is a prerequisite of the media proofs; it comes with ffmpeg.')
  return path
}

function findOnPath(program: string): string | undefined {
  for (const folder of (process.env['PATH'] ?? '').split(delimiter)) {
    const candidate = join(folder, program)
    if (folder !== '' && existsSync(candidate)) return candidate
  }
  return undefined
}

/** Whether a process exists. A reaped process does not; a zombie still would. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return isPlainObject(error) && error['code'] === 'EPERM'
  }
}

/** Whether any process is left in the group `pgid` leads; its id stays reserved while one is. */
export function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0)
    return true
  } catch (error) {
    return isPlainObject(error) && error['code'] === 'EPERM'
  }
}

/** Waits for a file to appear, and fails naming it when it has not within `timeoutMs`. */
export async function waitForFile(path: string, timeoutMs: number): Promise<void> {
  const end = performance.now() + timeoutMs
  while (!existsSync(path)) {
    if (performance.now() > end) throw new Error(`${path} did not appear within ${timeoutMs} ms`)
    await wait(10)
  }
}

/** Waits for a process to go, and fails naming it when it has not within `timeoutMs`. */
export async function waitUntilGone(pid: number, timeoutMs: number): Promise<void> {
  const end = performance.now() + timeoutMs
  while (processAlive(pid)) {
    if (performance.now() > end) throw new Error(`process ${pid} still exists after ${timeoutMs} ms`)
    await wait(20)
  }
}

/**
 * Sends `bytes` as frames a tenth of a second apart until the recording's `.partial` file appears, which is the
 * encoder writing its container header: proof that frames reached it. With x264, that takes as many frames as
 * its lookahead holds. Returns how many were sent. The usual way to put a recording mid-flight before a test
 * breaks something, in place of a sleep.
 */
export async function frameUntilPartial(recording: Recording, bytes: Uint8Array, timeoutMs = 5000): Promise<number> {
  const partial = `${recording.started.path}.partial`
  const end = performance.now() + timeoutMs
  let sent = 0
  while (!existsSync(partial)) {
    if (performance.now() > end) throw new Error(`${partial} did not appear within ${timeoutMs} ms of ${sent} frames`)
    const outcome = recording.frame({ frameId: `partial-${sent}`, timestampUs: sent * 100_000, format: 'png', bytes })
    if (outcome !== 'sent') throw new Error(`frame ${sent} was ${outcome}`)
    sent += 1
    await wait(5)
  }
  return sent
}

/** Every process in a process group: pid and executable name, without arguments from unrelated apps. */
export function groupMembers(pgid: number): string[] {
  const listing = execFileSync('ps', ['-ax', '-o', 'pid=,pgid=,comm='], { encoding: 'utf8' })
  return listing
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter((words) => words[1] === String(pgid))
    .map((words) => `${words[0]} ${words.slice(2).join(' ')}`)
}

/** The child processes of `pid`. */
export function childrenOf(pid: number): number[] {
  const listing = execFileSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' })
  return listing
    .split('\n')
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter((pair) => pair[1] === pid && pair[0] !== undefined)
    .map((pair) => pair[0] ?? 0)
}

/** What ffprobe reads from a video's container and first video stream, with every frame counted by decoding. */
export type Probe = {
  formatName: string
  durationSeconds: number
  sizeBytes: number
  codec: string
  width: number
  height: number
  pixelFormat: string
  frameRate: string
  framesDecoded: number
}

export async function probeVideo(path: string): Promise<Probe> {
  const entries = 'stream=codec_name,width,height,pix_fmt,r_frame_rate,nb_read_frames:format=format_name,duration,size'
  const args = ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries', entries, '-of', 'json', path]
  const { stdout } = await run(ffprobePath(), args)
  const parsed: unknown = JSON.parse(stdout)
  if (!isPlainObject(parsed)) throw new Error(`ffprobe printed ${stdout}`)
  const format = parsed['format']
  const streams = parsed['streams']
  const stream = isArray(streams) ? streams[0] : undefined
  if (!isPlainObject(format) || !isPlainObject(stream)) throw new Error(`ffprobe found no video stream in ${path}: ${stdout}`)
  return {
    formatName: text(format['format_name']),
    durationSeconds: Number(text(format['duration'])),
    sizeBytes: Number(text(format['size'])),
    codec: text(stream['codec_name']),
    width: Number(stream['width']),
    height: Number(stream['height']),
    pixelFormat: text(stream['pix_fmt']),
    frameRate: text(stream['r_frame_rate']),
    framesDecoded: Number(text(stream['nb_read_frames'])),
  }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : String(value)
}

/** Decodes frame `index` of a video, counting from zero, to a PNG at `output`, and reads it back. */
export async function decodeFrame(video: string, index: number, output: string): Promise<RgbImage> {
  const args = ['-v', 'error', '-i', video, '-vf', `select=eq(n\\,${index})`, '-frames:v', '1', '-fps_mode', 'passthrough', '-y', output]
  await run(ffmpegPath(), args)
  return decodePng(await readFile(output))
}

/** A rectangle of an image, in pixels. */
export type Box = { left: number; top: number; width: number; height: number }

/** The smallest box holding every pixel where any image differs from the first. */
export function changingBox(images: readonly RgbImage[]): Box | undefined {
  const first = images[0]
  if (first === undefined) return undefined
  let [left, top, right, bottom] = [first.width, first.height, -1, -1]
  for (const image of images.slice(1)) {
    for (let y = 0; y < first.height; y += 1) {
      for (let x = 0; x < first.width; x += 1) {
        const at = (y * first.width + x) * 3
        if (image.rgb[at] === first.rgb[at] && image.rgb[at + 1] === first.rgb[at + 1] && image.rgb[at + 2] === first.rgb[at + 2]) continue
        left = Math.min(left, x)
        top = Math.min(top, y)
        right = Math.max(right, x)
        bottom = Math.max(bottom, y)
      }
    }
  }
  if (right < 0) return undefined
  return { left, top, width: right - left + 1, height: bottom - top + 1 }
}

/**
 * The brightness of every pixel inside `box`, row by row, on a scale of 0 to 255. Brightness, not colour: 4:2:0
 * video keeps luma for every pixel but colour for each 2 by 2 block, so a thin coloured line, such as a focus
 * ring, changes colour in any honest encoding while text keeps its shape. BT.601 weights, ffmpeg's default here.
 */
export function lumaInBox(image: RgbImage, box: Box): Float32Array {
  const luma = new Float32Array(box.width * box.height)
  for (let y = 0; y < box.height; y += 1) {
    for (let x = 0; x < box.width; x += 1) {
      const at = ((box.top + y) * image.width + box.left + x) * 3
      luma[y * box.width + x] = 0.299 * (image.rgb[at] ?? 0) + 0.587 * (image.rgb[at + 1] ?? 0) + 0.114 * (image.rgb[at + 2] ?? 0)
    }
  }
  return luma
}

/** How many pixels of two brightness maps of one box differ by more than `threshold`. */
export function differingPixels(one: Float32Array, other: Float32Array, threshold: number): number {
  let count = 0
  for (let index = 0; index < one.length; index += 1) {
    if (Math.abs((one[index] ?? 0) - (other[index] ?? 0)) > threshold) count += 1
  }
  return count
}

/** Whether two images have exactly the same pixels inside `box`. */
export function samePixels(one: RgbImage, other: RgbImage, box: Box): boolean {
  for (let y = box.top; y < box.top + box.height; y += 1) {
    const start = (y * one.width + box.left) * 3
    const end = start + box.width * 3
    for (let at = start; at < end; at += 1) {
      if (one.rgb[at] !== other.rgb[at]) return false
    }
  }
  return true
}

/** Decodes every frame of a video to `folder/prefix-NNN.png`, in order, and reads them back. */
export async function decodeAllFrames(video: string, folder: string, prefix: string): Promise<RgbImage[]> {
  await mkdir(folder, { recursive: true })
  await run(ffmpegPath(), ['-v', 'error', '-i', video, '-fps_mode', 'passthrough', '-y', join(folder, `${prefix}-%03d.png`)])
  const files = (await readdir(folder)).filter((name) => name.startsWith(`${prefix}-`) && name.endsWith('.png')).sort()
  return Promise.all(files.map(async (name) => decodePng(await readFile(join(folder, name)))))
}

/** Reads `/usr/bin/time -l` output: each timed run's seconds and peak memory, in the order they ended. */
export type TimedRun = { realSeconds: number; userSeconds: number; systemSeconds: number; maxResidentBytes: number; peakFootprintBytes: number | undefined }

export function parseTimeOutput(output: string): TimedRun[] {
  const runs: TimedRun[] = []
  for (const block of output.split(/(?=^\s*[\d.]+ real)/m)) {
    const times = /([\d.]+) real\s+([\d.]+) user\s+([\d.]+) sys/.exec(block)
    const resident = /(\d+)\s+maximum resident set size/.exec(block)
    if (times === null || resident === null) continue
    const footprint = /(\d+)\s+peak memory footprint/.exec(block)
    runs.push({
      realSeconds: Number(times[1]),
      userSeconds: Number(times[2]),
      systemSeconds: Number(times[3]),
      maxResidentBytes: Number(resident[1]),
      peakFootprintBytes: footprint === null ? undefined : Number(footprint[1]),
    })
  }
  return runs
}
