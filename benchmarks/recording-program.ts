import { spawn } from 'node:child_process'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { OwnedProcessGroup } from '../src/shared/process-ownership.ts'
import { isMissingFile } from '../src/shared/error-code.ts'
import { isRecord, readArray, readNumber, readString, type JsonRecord } from './json.ts'
import { assertSucceeded, runProgram } from './programs.ts'
import { outcomeFromEvents } from './runners/retest.ts'
import { outcomeFromReport } from './runners/playwright.ts'
import type { RunOutcome } from './phases.ts'
import type { RecordingOptions } from './recording-options.ts'

export type ResourceReading = {
  readonly pid: number
  readonly parentPid: number
  readonly startIdentity: string
  readonly path: string
  readonly samples: number
  readonly userCpuMs: number
  readonly systemCpuMs: number
  readonly peakFootprintBytes: number
  readonly sampledPeakRssBytes: number
  readonly lastSampleElapsedMs: number
}
export type OwnResources = { readonly pid: number; readonly userCpuMs: number; readonly systemCpuMs: number; readonly peakRssBytes: number }
export type MeasuredRun = {
  readonly outcome: RunOutcome
  readonly wallMs: number
  readonly runner: OwnResources | null
  readonly runnerNative: ResourceReading | null
  readonly media: readonly ResourceReading[]
  readonly encoder: readonly ResourceReading[]
  readonly largestSampleGapMs: number
  readonly artifactBytes: number
  readonly runFolderBytes: number
  readonly videos: readonly JsonRecord[]
  readonly evidenceProblems: readonly string[]
  readonly resourcesFile: string
  readonly command: readonly string[]
  readonly cwd: string
  readonly loadBefore: readonly number[]
  readonly loadAfter: readonly number[]
}

function number(record: JsonRecord, key: string): number {
  const value = readNumber(record, key)
  if (value === undefined || value < 0) throw new Error(`Missing or invalid resource field ${key}`)
  return value
}
function string(record: JsonRecord, key: string): string {
  const value = readString(record, key)
  if (value === undefined) throw new Error(`Missing resource field ${key}`)
  return value
}
async function objectFile(path: string): Promise<JsonRecord> {
  const value: unknown = JSON.parse(await readFile(path, 'utf8'))
  if (!isRecord(value)) throw new Error(`Expected an object in ${path}`)
  return value
}

async function bytes(folder: string): Promise<number> {
  let entries
  try { entries = await readdir(folder, { withFileTypes: true }) }
  catch (error) { if (isMissingFile(error)) return 0; throw error }
  let total = 0
  for (const entry of entries) {
    const path = join(folder, entry.name)
    if (entry.isDirectory()) total += await bytes(path)
    else if (entry.isFile()) total += (await stat(path)).size
    else throw new Error(`Unmeasured nonregular artifact ${path}`)
  }
  return total
}

export async function measureProgram(options: RecordingOptions, target: {
  readonly entry: string; readonly cwd: string; readonly folder: string; readonly cache: string
  readonly tool: 'retest' | 'playwright'; readonly record: boolean; readonly load: () => number[]
}): Promise<MeasuredRun> {
  await mkdir(target.folder, { recursive: true })
  const output = join(target.folder, 'run')
  const resourceFile = join(target.folder, 'runner-resource.json')
  const preload = fileURLToPath(new URL('./recording-preload.ts', import.meta.url))
  const args = ['--import', preload, target.entry, ...(target.tool === 'retest'
    ? ['run', '--no-agent', '--workers', '1', '--browsers', '1', '--output', output]
    : ['test', '--reporter=json', '--workers=1', '--output', join(output, 'artifacts')])]
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_COMPILE_CACHE: target.cache, RETEST_FIREFOX_ROUTE: 'launch-services',
    RETEST_MEDIA_BINARY: options.media, RETEST_FFMPEG: options.ffmpeg, RETEST_BENCH_RESOURCE_OUTPUT: resourceFile, RETEST_BENCH_ROOT_ENTRY: target.entry }
  // No inherited instrumentation or compile-cache disabling may change this experiment.
  delete env['NODE_OPTIONS']
  delete env['NODE_DISABLE_COMPILE_CACHE']
  const loadBefore = target.load()
  const startedAt = Date.now()
  const started = performance.now()
  const child = spawn(process.execPath, args, { cwd: target.cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  if (child.pid === undefined) throw new Error('The benchmark CLI did not get a pid.')
  const pid = child.pid
  // Capture launch ancestry for emergency cleanup before any timeout can stop the root.
  const ownership = new OwnedProcessGroup(pid)
  await writeFile(join(target.folder, 'launch.json'), `${JSON.stringify({ pid, at: new Date(startedAt).toISOString(), command: [process.execPath, ...args], cwd: target.cwd })}\n`)
  const observed = runProgram(options.observer, [String(pid), '120000'], { cwd: target.cwd, timeoutMs: 125000 })
  let stdout = '', stderr = '', timedOut = false
  child.stdout.setEncoding('utf8').on('data', (value: string) => { stdout += value })
  child.stderr.setEncoding('utf8').on('data', (value: string) => { stderr += value })
  const limit = setTimeout(() => {
    timedOut = true
    const problems = [...ownership.capture(), ...ownership.signal('SIGKILL')]
    if (problems.length > 0) stderr += `\nbenchmark cleanup: ${problems.join('; ')}\n`
  }, 90000)
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; wallMs: number; endedAt: number }>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal, wallMs: performance.now() - started, endedAt: Date.now() }))
  }).finally(() => clearTimeout(limit))
  const observation = await observed
  await writeFile(join(target.folder, 'resources.json'), observation.stdout)
  await writeFile(join(target.folder, 'observer.stderr.txt'), observation.stderr)
  await writeFile(join(target.folder, 'stdout.txt'), stdout)
  await writeFile(join(target.folder, 'stderr.txt'), stderr)
  assertSucceeded(observation, 'resource observer')
  const resources: unknown = JSON.parse(observation.stdout)
  if (!isRecord(resources)) throw new Error('The observer did not return an object.')
  const processes: ResourceReading[] = readArray(resources, 'processes').map(value => {
    if (!isRecord(value)) throw new Error('Invalid observed process.')
    return { pid: number(value, 'pid'), parentPid: number(value, 'parentPid'), startIdentity: string(value, 'startIdentity'), path: string(value, 'path'), samples: number(value, 'samples'), userCpuMs: number(value, 'userCpuMs'), systemCpuMs: number(value, 'systemCpuMs'), peakFootprintBytes: number(value, 'peakFootprintBytes'), sampledPeakRssBytes: number(value, 'sampledPeakRssBytes'), lastSampleElapsedMs: number(value, 'lastSampleElapsedMs') }
  })
  let runner: OwnResources | null = null
  try {
    const own = await objectFile(resourceFile)
    runner = { pid: number(own, 'pid'), userCpuMs: number(own, 'userCpuMs'), systemCpuMs: number(own, 'systemCpuMs'), peakRssBytes: number(own, 'peakRssBytes') }
    if (runner.pid !== pid) throw new Error('The resource preload named a different CLI pid.')
  } catch (error) { if (!isMissingFile(error)) throw error }
  const facts = { startedAt, endedAt: exit.endedAt, code: exit.code, timedOut, timeoutMs: 90000 }
  let events: string | undefined
  if (target.tool === 'retest') {
    try { events = await readFile(join(output, 'events.jsonl'), 'utf8') }
    catch (error) { if (!isMissingFile(error)) throw error }
  }
  const outcome = target.tool === 'retest' ? outcomeFromEvents(events, facts, 1, 'no events.jsonl') : outcomeFromReport(stdout, stderr, facts, 1)
  const evidenceProblems: string[] = []
  const videos: JsonRecord[] = []
  // Fork children briefly inherit the worker's executable before exec. Only the CLI's direct worker is media.
  const media = processes.filter(value => value.parentPid === pid && basename(value.path) === basename(options.media))
  const runnerNative = processes.find(value => value.pid === pid) ?? null
  if (runnerNative === null) evidenceProblems.push('Native CLI resource reading unavailable.')
  if (target.record && media.length !== 1) evidenceProblems.push(`Observed ${media.length} media workers; expected one.`)
  if (!target.record && media.length !== 0) evidenceProblems.push('Recording off started media.')
  if (runner === null) evidenceProblems.push('CLI resource reading unavailable.')
  for (const line of events?.split('\n') ?? []) {
    if (line === '') continue
    const event: unknown = JSON.parse(line)
    if (!isRecord(event)) throw new Error('Invalid benchmark event.')
    if (readString(event, 'type') === 'recording.finished') {
      const recording = event['recording']
      if (!isRecord(recording)) throw new Error('Missing recording record.')
      videos.push(recording)
      if (readString(recording, 'status') !== 'complete') evidenceProblems.push(`Recording ${readString(recording, 'status') ?? 'has no status'}`)
    }
    if (readString(event, 'type') === 'media.started') {
      const detail = event['media']
      if (!isRecord(detail) || !media.some(value => value.pid === readNumber(detail, 'pid'))) evidenceProblems.push('The media event pid was not sampled.')
    }
  }
  if (target.record && videos.length !== 1) evidenceProblems.push(`Finished ${videos.length} recordings; expected one.`)
  if (!target.record && videos.length > 0) evidenceProblems.push('Recording off produced a recording.')
  for (const recording of videos) {
    const path = readString(recording, 'path')
    if (path === undefined) { evidenceProblems.push('Recording has no artifact path.'); continue }
    const probe = await runProgram(options.ffprobe, ['-v', 'error', '-count_frames', '-show_entries', 'stream=codec_name,width,height,nb_read_frames:format=duration', '-of', 'json', join(output, path)], { cwd: target.cwd, timeoutMs: 15000 })
    await writeFile(join(target.folder, 'ffprobe.json'), probe.stdout)
    await writeFile(join(target.folder, 'ffprobe.stderr.txt'), probe.stderr)
    if (probe.code !== 0) { evidenceProblems.push(`Independent ffprobe failed, exit ${probe.code ?? probe.signal}.`); continue }
    let probed: unknown
    try { probed = JSON.parse(probe.stdout) }
    catch { evidenceProblems.push('Independent ffprobe returned invalid JSON.'); continue }
    const video = recording['video']
    const stream = isRecord(probed) ? readArray(probed, 'streams')[0] : undefined
    const format = isRecord(probed) ? probed['format'] : undefined
    if (!isRecord(video) || !isRecord(stream) || !isRecord(format)
      || readString(stream, 'codec_name') !== readString(video, 'codec')
      || readNumber(stream, 'width') !== readNumber(video, 'width') || readNumber(stream, 'height') !== readNumber(video, 'height')
      || Number(readString(stream, 'nb_read_frames')) !== readNumber(video, 'outputFrames')
      || (readNumber(video, 'outputFrames') ?? 0) <= 0
      || !Number.isFinite(Number(readString(format, 'duration')))
      || Math.abs(Number(readString(format, 'duration')) * 1e6 - (readNumber(video, 'durationUs') ?? -1)) > 100000) {
      evidenceProblems.push('Independent video facts disagree with the recording record.')
    }
    const decoded = await runProgram(options.ffmpeg, ['-v', 'error', '-xerror', '-i', join(output, path), '-f', 'null', '-'], { cwd: target.cwd, timeoutMs: 15000 })
    await writeFile(join(target.folder, 'decode.stderr.txt'), decoded.stderr)
    if (decoded.code !== 0) evidenceProblems.push(`Independent whole decode failed, exit ${decoded.code ?? decoded.signal}.`)
  }
  return { outcome, wallMs: exit.wallMs, runner, runnerNative, media, encoder: processes.filter(value => basename(value.path) === basename(options.ffmpeg)),
    largestSampleGapMs: number(resources, 'largestGapMs'), artifactBytes: await bytes(join(output, 'artifacts')), runFolderBytes: await bytes(output),
    videos, evidenceProblems, resourcesFile: join(target.folder, 'resources.json'), command: [process.execPath, ...args], cwd: target.cwd,
    loadBefore, loadAfter: target.load() }
}
