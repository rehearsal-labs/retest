import type { Durations, Inventory, Platform, PlatformSeconds } from './test-plan.ts'
import { readdirSync, readFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { assignedTo, platformNames } from './test-plan.ts'

// The planner balances each platform's shards by that platform's times in test-durations.json. These read the
// results.json each CI shard keeps, as scripts/ci/run-tests.ts writes it, and turn them into new durations: for each
// file and platform, its slowest passing time there. A file that failed, was killed or was cut off says nothing about
// how long it takes, so it is not read.

/** One passing file's run in a shard, and the platform the shard ran on. */
export type MeasuredFile = { readonly file: string; readonly platform: Platform; readonly durationMs: number }

/** A file a refresh should have timed on a platform, and has no passing time for. */
export type MissingTime = { readonly file: string; readonly platforms: readonly Platform[] }

/**
 * The new durations; which files have a new time on any platform, which keep only earlier times, and which were dropped
 * because the repository no longer holds them; and every file still missing a platform's passing time.
 */
export type RefreshedDurations = {
  readonly durations: Record<string, PlatformSeconds>
  readonly measured: string[]
  readonly kept: string[]
  readonly dropped: string[]
  readonly missing: MissingTime[]
}

const testPath = /^tests\/(?:unit|integration)\/(?:[a-z0-9-]+\/)*[a-z0-9-]+\.test\.ts$/

// The artifact names ci.yml gives each shard's results: unit-<platform>-<shard>-<attempt>,
// integration-<linux or windows platform>-<shard>-<attempt> and integration-macos-<lane>-<shard>-<attempt>.
const artifactPlatform = /^(?:unit-(macos-arm64|linux-x64|linux-arm64|windows-x64)|integration-(linux-x64|linux-arm64|windows-x64)|integration-(macos)-(?:web|native))-\d+-\d+$/

function ordered(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isPlatform(value: string): value is Platform {
  return platformNames.some((platform) => platform === value)
}

/**
 * The platform a results.json came from, read from the artifact folder that holds it.
 *
 * @example platformOfArtifact('integration-macos-web-1-1') // 'macos-arm64'
 */
export function platformOfArtifact(folder: string): Platform | undefined {
  const match = artifactPlatform.exec(folder)
  if (match === null) return undefined
  const named = match[1] ?? match[2] ?? (match[3] === undefined ? undefined : 'macos-arm64')
  return named !== undefined && isPlatform(named) ? named : undefined
}

/**
 * Every passing file run recorded by a results.json anywhere under `folder`, as `gh run download` lays out a run's
 * artifacts, with the platform its artifact's name gives. A results.json that is not the shape run-tests.ts writes, or
 * whose folder names no platform, is refused by its path, so a wrong folder changes nothing.
 *
 * @example readShardResults('/tmp/run-38176885689') // { results: 26, named: […], files: [{ file: 'tests/unit/png.test.ts', platform: 'linux-x64', durationMs: 412 }, …] }
 */
export function readShardResults(folder: string): { readonly results: number; readonly named: string[]; readonly files: MeasuredFile[] } {
  const paths = readdirSync(folder, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name === 'results.json')
    .map((entry) => resolve(entry.parentPath, entry.name))
    .sort(ordered)
  if (paths.length === 0) throw new Error(`No results.json under ${folder}.`)
  const named = new Set<string>()
  const files: MeasuredFile[] = []
  for (const path of paths) {
    const name = relative(folder, path)
    const platform = platformOfArtifact(basename(dirname(path)))
    if (platform === undefined) throw new Error(`${name} is in a folder whose name gives no platform, such as unit-linux-x64-1-1 or integration-macos-web-1-1.`)
    const document: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (!isRecord(document) || document['schemaVersion'] !== 1 || !Array.isArray(document['files'])) throw new Error(`${name} is not a CI results file with schema version 1.`)
    const entries: readonly unknown[] = document['files']
    for (const entry of entries) {
      if (!isRecord(entry)) throw new Error(`${name} holds a file result that is not an object.`)
      const file = entry['file']
      const durationMs = entry['durationMs']
      const exitCode = entry['exitCode']
      const signal = entry['signal']
      if (typeof file !== 'string' || !testPath.test(file)) throw new Error(`${name} names ${JSON.stringify(file)}, which is not a test file path.`)
      if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs < 0) throw new Error(`${name} gives ${file} a duration that is not a finite number of milliseconds.`)
      if ((exitCode !== null && typeof exitCode !== 'number') || (signal !== null && typeof signal !== 'string')) throw new Error(`${name} gives ${file} no exit code or signal.`)
      named.add(file)
      if (exitCode === 0 && signal === null) files.push({ file, platform, durationMs })
    }
  }
  return { results: paths.length, named: [...named].sort(ordered), files }
}

/**
 * New durations in whole seconds: for each file and platform, the slowest passing measurement, rounded up, or the
 * earlier time there when no passing measurement names it. A file the repository no longer holds is dropped. `missing`
 * lists each file that is still in the repository and either had a time before or was run now, with every platform
 * that runs it and has no passing measurement; a complete refresh has none.
 *
 * @example refreshDurations({ previous: {}, measured: [{ file: 'tests/unit/a.test.ts', platform: 'linux-x64', durationMs: 1200 }], named: ['tests/unit/a.test.ts'], inventory })
 * // { durations: { 'tests/unit/a.test.ts': { 'linux-x64': 2 } }, measured: ['tests/unit/a.test.ts'], kept: [], dropped: [],
 * //   missing: [{ file: 'tests/unit/a.test.ts', platforms: ['macos-arm64', 'linux-arm64', 'windows-x64'] }] }
 */
export function refreshDurations(options: { readonly previous: Durations; readonly measured: readonly MeasuredFile[]; readonly named: readonly string[]; readonly inventory: Inventory }): RefreshedDurations {
  const present = new Set([...options.inventory.unit, ...options.inventory.integration])
  const slowest = new Map<string, Map<Platform, number>>()
  for (const { file, platform, durationMs } of options.measured) {
    const times = slowest.get(file) ?? new Map<Platform, number>()
    times.set(platform, Math.max(times.get(platform) ?? 0, durationMs))
    slowest.set(file, times)
  }
  const durations: Record<string, PlatformSeconds> = {}
  const measured: string[] = []
  const kept: string[] = []
  const dropped: string[] = []
  const missing: MissingTime[] = []
  for (const file of [...new Set([...Object.keys(options.previous), ...options.named, ...slowest.keys()])].sort(ordered)) {
    if (!present.has(file)) {
      dropped.push(file)
      continue
    }
    const times = slowest.get(file)
    const earlier = options.previous[file] ?? {}
    const entry: Partial<Record<Platform, number>> = {}
    const lacking: Platform[] = []
    for (const platform of platformNames) {
      if (!assignedTo(platform, file)) continue
      const milliseconds = times?.get(platform)
      if (milliseconds !== undefined) {
        // A file that took no measurable time still costs a shard something; zero would also fail the planner's check.
        entry[platform] = Math.max(1, Math.ceil(milliseconds / 1000))
        continue
      }
      lacking.push(platform)
      const before = earlier[platform]
      if (before !== undefined) entry[platform] = before
    }
    if (lacking.length > 0) missing.push({ file, platforms: lacking })
    if (Object.keys(entry).length > 0) durations[file] = entry
    if (times !== undefined) measured.push(file)
    else if (file in durations) kept.push(file)
  }
  return { durations, measured, kept, dropped, missing }
}

/** test-durations.json as the repository keeps it: sorted by path, platforms in a fixed order, two-space indented. */
export function formatDurations(durations: Durations): string {
  const sorted: Record<string, Partial<Record<Platform, number>>> = {}
  for (const file of Object.keys(durations).sort(ordered)) {
    const entry: Partial<Record<Platform, number>> = {}
    for (const platform of platformNames) {
      const seconds = durations[file]?.[platform]
      if (seconds !== undefined) entry[platform] = seconds
    }
    sorted[file] = entry
  }
  return `${JSON.stringify(sorted, null, 2)}\n`
}

/** Reads a durations file, refusing anything but positive finite seconds by platform and test path. */
export function readDurations(path: string): Record<string, PlatformSeconds> {
  const document: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (!isRecord(document)) throw new Error(`${path} is not an object of durations.`)
  const durations: Record<string, PlatformSeconds> = {}
  for (const [file, times] of Object.entries(document)) {
    if (!testPath.test(file) || !isRecord(times) || Object.keys(times).length === 0) throw new Error(`${path} gives ${file} no seconds by platform.`)
    const entry: Partial<Record<Platform, number>> = {}
    for (const [platform, seconds] of Object.entries(times)) {
      if (!isPlatform(platform) || typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) throw new Error(`${path} gives ${file} ${JSON.stringify(seconds)} on ${platform}, not positive seconds on a CI platform.`)
      entry[platform] = seconds
    }
    durations[file] = entry
  }
  return durations
}

/**
 * The sentence a refresh refuses with when the artifacts lack a platform's passing time for some file.
 *
 * @example describeMissing([{ file: 'tests/unit/a.test.ts', platforms: ['linux-arm64'] }]) // 'The artifacts have no passing time for 1 file on some platform: …'
 */
export function describeMissing(missing: readonly MissingTime[]): string {
  const first = missing.slice(0, 5).map((each) => `${each.file} on ${each.platforms.join(', ')}`).join('; ')
  const more = missing.length > 5 ? `; and ${missing.length - 5} more` : ''
  return `The artifacts have no passing time for ${missing.length} ${missing.length === 1 ? 'file' : 'files'} on some platform: ${first}${more}. Download a full run whose files all passed, or pass --partial to keep their earlier times.`
}

export const durationsPath: string = join('scripts', 'ci', 'test-durations.json')
