import type { JsonValue } from './webdriver.ts'
import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { inflateSync } from 'node:zlib'
import { describeError } from './webdriver.ts'

/** Executors, builds, logs and artifacts live here, outside the repository. */
export const CACHE_ROOT: string = join(homedir(), 'Library', 'Caches', 'retest-proofs')

/** One proof run's folders: artifacts for screenshots, trees and the report, logs for every command. */
export type RunFolders = {
  readonly stamp: string
  readonly artifacts: string
  readonly logs: string
}

/**
 * Makes the folders for one run under the cache, named by the time it started.
 *
 * @example await createRunFolders('macos') // { stamp: '2026-10-03T01-50-00Z', artifacts: '…/artifacts/macos/2026-10-03T01-50-00Z', logs: '…/logs' }
 */
export async function createRunFolders(platform: 'macos' | 'ios'): Promise<RunFolders> {
  const stamp = new Date().toISOString().replace(/\.\d+Z$/, 'Z').replaceAll(':', '-')
  const artifacts = join(CACHE_ROOT, 'artifacts', platform, stamp)
  const logs = join(CACHE_ROOT, 'logs')
  await mkdir(artifacts, { recursive: true })
  await mkdir(logs, { recursive: true })
  return { stamp, artifacts, logs }
}

/** What a PNG holds, read from its own bytes. */
export type PngFacts = {
  readonly width: number
  readonly height: number
  readonly bytes: number
  /** Distinct pixel values, counted up to a limit. A blank or single-colour capture has one. */
  readonly distinctColors: number
}

const PNG_SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)
// Bytes per pixel at bit depth 8, by colour type: grey, RGB, grey with alpha, RGBA.
const PNG_CHANNELS: Readonly<Record<number, number>> = { 0: 1, 2: 3, 4: 2, 6: 4 }
const DISTINCT_COLOR_LIMIT = 4096

/** A PNG's pixels, decompressed and unfiltered: `channels` bytes per pixel, row by row. */
export type DecodedPng = {
  readonly width: number
  readonly height: number
  readonly channels: number
  readonly pixels: Uint8Array
}

/** A rectangle in image pixels. */
export type PixelRegion = {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/**
 * Decodes a PNG: signature, header and pixels, decompressed and unfiltered. Only 8-bit, non-interlaced grey, RGB
 * and RGBA images are decoded, which is what XCTest and simctl write; anything else throws with what it was.
 *
 * @example decodePng(await readFile('window.png')).width // 1172
 */
export function decodePng(bytes: Uint8Array): DecodedPng {
  if (bytes.length < 33 || PNG_SIGNATURE.some((byte, index) => bytes[index] !== byte)) throw new Error('The data does not start with the PNG signature')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const width = view.getUint32(16)
  const height = view.getUint32(20)
  const bitDepth = bytes[24]
  const colorType = bytes[25] ?? -1
  const interlace = bytes[28]
  const channels = PNG_CHANNELS[colorType]
  if (bitDepth !== 8 || interlace !== 0 || channels === undefined) {
    throw new Error(`Unsupported PNG layout: bit depth ${String(bitDepth)}, colour type ${colorType}, interlace ${String(interlace)}`)
  }
  const compressed: Uint8Array[] = []
  for (let offset = 8; offset + 8 <= bytes.length;) {
    const length = view.getUint32(offset)
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8))
    if (type === 'IDAT') compressed.push(bytes.subarray(offset + 8, offset + 8 + length))
    if (type === 'IEND') break
    offset += 12 + length
  }
  const data = inflateSync(Buffer.concat(compressed))
  const stride = width * channels
  if (data.length !== height * (stride + 1)) throw new Error(`PNG pixel data is ${data.length} bytes; ${width}x${height} needs ${height * (stride + 1)}`)
  return { width, height, channels, pixels: unfilter(data, { height, stride, channels }) }
}

/**
 * Reads a PNG's size and counts its distinct colours, so a capture that is not a real image or is one flat colour
 * cannot pass for a screenshot.
 *
 * @example inspectPng(await readFile('window.png')) // { width: 1172, height: 976, bytes: 83684, distinctColors: 2863 }
 */
export function inspectPng(bytes: Uint8Array): PngFacts {
  const image = decodePng(bytes)
  return { width: image.width, height: image.height, bytes: bytes.length, distinctColors: countColors(image.pixels, image.channels) }
}

/**
 * How many pixels inside `region` differ between two captures of the same size. The region is clipped to the image.
 *
 * @example countChangedPixels(before, after, { x: 0, y: 400, width: 1172, height: 576 }) // 2310
 */
export function countChangedPixels(before: DecodedPng, after: DecodedPng, region: PixelRegion): number {
  if (before.width !== after.width || before.height !== after.height || before.channels !== after.channels) {
    throw new Error(`The captures differ in size: ${before.width}x${before.height} and ${after.width}x${after.height}`)
  }
  const left = Math.max(0, Math.floor(region.x))
  const top = Math.max(0, Math.floor(region.y))
  const right = Math.min(before.width, Math.ceil(region.x + region.width))
  const bottom = Math.min(before.height, Math.ceil(region.y + region.height))
  let changed = 0
  for (let row = top; row < bottom; row += 1) {
    for (let column = left; column < right; column += 1) {
      const offset = (row * before.width + column) * before.channels
      for (let channel = 0; channel < before.channels; channel += 1) {
        if (before.pixels[offset + channel] !== after.pixels[offset + channel]) {
          changed += 1
          break
        }
      }
    }
  }
  return changed
}

function unfilter(data: Uint8Array, layout: { readonly height: number; readonly stride: number; readonly channels: number }): Uint8Array {
  const { height, stride, channels } = layout
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
      out[target + column] = (raw + predict(filter, { left, up, upLeft })) & 0xff
    }
  }
  return out
}

function predict(filter: number | undefined, neighbours: { readonly left: number; readonly up: number; readonly upLeft: number }): number {
  const { left, up, upLeft } = neighbours
  switch (filter) {
    case 0: return 0
    case 1: return left
    case 2: return up
    case 3: return Math.floor((left + up) / 2)
    case 4: {
      const estimate = left + up - upLeft
      const toLeft = Math.abs(estimate - left)
      const toUp = Math.abs(estimate - up)
      const toUpLeft = Math.abs(estimate - upLeft)
      if (toLeft <= toUp && toLeft <= toUpLeft) return left
      return toUp <= toUpLeft ? up : upLeft
    }
    default: throw new Error(`Unknown PNG row filter ${String(filter)}`)
  }
}

function countColors(pixels: Uint8Array, channels: number): number {
  const seen = new Set<string>()
  for (let index = 0; index < pixels.length && seen.size < DISTINCT_COLOR_LIMIT; index += channels) {
    seen.add(pixels.subarray(index, index + channels).join(','))
  }
  return seen.size
}

/** How a step ended. `blocked` means the machine needs a person: a permission, a download, a busy port. */
export type StepOutcome = 'passed' | 'failed' | 'blocked'

/** One recorded step. */
export type StepRecord = {
  readonly name: string
  readonly outcome: StepOutcome
  readonly durationMs: number
  readonly notes: readonly string[]
  readonly error?: string
}

/** Thrown inside a step when the machine, not the code, stops the proof. */
export class Blocked extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'Blocked'
  }
}

/** Thrown by `step` after it has recorded a failure, so the proof stops issuing commands. */
export class StepStopped extends Error {
  readonly outcome: StepOutcome

  constructor(name: string, outcome: StepOutcome) {
    super(`Stopped at "${name}"`)
    this.name = 'StepStopped'
    this.outcome = outcome
  }
}

/**
 * The record of one proof run. Each step prints one line as it ends. The first step that fails stops the proof;
 * cleanup steps always run and never stop anything.
 */
export class ProofRecord {
  readonly title: string
  readonly steps: StepRecord[] = []
  readonly facts: Record<string, JsonValue> = {}
  readonly artifacts: string[] = []

  constructor(title: string) {
    this.title = title
    process.stdout.write(`${title}\n`)
  }

  /**
   * Runs one step. `note` adds a fact to its line. A thrown error marks the step failed, or blocked for a Blocked
   * error, and is rethrown as StepStopped.
   *
   * @example await record.step('read the tree', async (note) => { note('412 elements') })
   */
  async step<T>(name: string, action: (note: (fact: string) => void) => Promise<T>): Promise<T> {
    const notes: string[] = []
    const started = Date.now()
    try {
      const value = await action((fact) => notes.push(fact))
      this.#add({ name, outcome: 'passed', durationMs: Date.now() - started, notes })
      return value
    } catch (error) {
      const outcome: StepOutcome = error instanceof Blocked ? 'blocked' : 'failed'
      this.#add({ name, outcome, durationMs: Date.now() - started, notes, error: describeError(error) })
      throw new StepStopped(name, outcome)
    }
  }

  /** Runs a cleanup step. Its failure is recorded and fails the proof, but never stops the remaining cleanup. */
  async cleanup(name: string, action: (note: (fact: string) => void) => Promise<void>): Promise<void> {
    try {
      await this.step(name, action)
    } catch (error) {
      if (!(error instanceof StepStopped)) throw error
    }
  }

  /** Remembers an artifact path for the report and the summary. */
  artifact(path: string): void {
    this.artifacts.push(path)
  }

  /** 0 when every step passed, 2 when the machine blocked the proof and nothing else failed, otherwise 1. */
  get exitCode(): number {
    if (this.steps.some((step) => step.outcome === 'failed')) return 1
    if (this.steps.some((step) => step.outcome === 'blocked')) return 2
    return 0
  }

  /** Writes `report.json` beside the artifacts and prints where everything is. */
  async finish(folder: string): Promise<void> {
    const path = join(folder, 'report.json')
    const verdict = this.exitCode === 0 ? 'passed' : this.exitCode === 2 ? 'blocked' : 'failed'
    const report = { schemaVersion: 1, title: this.title, verdict, at: new Date().toISOString(), facts: this.facts, steps: this.steps, artifacts: this.artifacts }
    await writeFile(path, `${JSON.stringify(report, null, 2)}\n`)
    process.stdout.write(`\n${verdict}: ${this.steps.filter((step) => step.outcome === 'passed').length} of ${this.steps.length} steps passed\n`)
    for (const artifact of [...this.artifacts, path]) process.stdout.write(`  ${artifact}\n`)
  }

  #add(record: StepRecord): void {
    this.steps.push(record)
    const seconds = `${(record.durationMs / 1000).toFixed(1)}s`.padStart(6)
    const label = record.outcome === 'passed' ? 'ok     ' : record.outcome === 'blocked' ? 'blocked' : 'failed '
    const details = [...record.notes, ...(record.error === undefined ? [] : [record.error])].join('; ')
    process.stdout.write(`  ${label} ${seconds}  ${record.name}${details.length > 0 ? `  ${details}` : ''}\n`)
  }
}
