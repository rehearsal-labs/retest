import { median } from './phases.ts'
import type { FixtureName } from './options.ts'
import type { Machine, Source } from './machine.ts'
import type { MeasuredRun } from './recording-program.ts'
import type { Engine, RecordingOptions } from './recording-options.ts'

export type RecordingCell = {
  readonly fixture: FixtureName
  readonly engine: Engine
  readonly tool: 'retest' | 'playwright'
  readonly diagnostics: boolean
  readonly recording: boolean
  readonly cache: 'cold' | 'warm'
  readonly runs: MeasuredRun[]
  readonly priming: MeasuredRun[]
}
export type RecordingResults = {
  readonly schemaVersion: 1
  readonly at: string
  readonly machine: Machine
  readonly source: Source
  readonly options: RecordingOptions
  readonly versions: Readonly<Record<string, string>>
  readonly cells: readonly RecordingCell[]
}
export type Spread = { readonly median: number; readonly min: number; readonly max: number; readonly q1: number; readonly q3: number; readonly p95: number }

export function spread(values: readonly number[]): Spread | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const quantile = (q: number): number => {
    const at = (sorted.length - 1) * q
    const low = sorted[Math.floor(at)], high = sorted[Math.ceil(at)]
    if (low === undefined || high === undefined) throw new Error('Missing sorted sample.')
    return low + (high - low) * (at - Math.floor(at))
  }
  const center = median(sorted), min = sorted[0], max = sorted.at(-1), p95 = sorted[Math.ceil(sorted.length * 0.95) - 1]
  if (center === null || min === undefined || max === undefined || p95 === undefined) throw new Error('Missing spread sample.')
  return { median: center, min, max, q1: quantile(0.25), q3: quantile(0.75), p95 }
}

export function validMeasurement(run: MeasuredRun): boolean {
  return run.outcome.valid && run.runner !== null && run.evidenceProblems.length === 0
}

export function renderRecordingResults(results: RecordingResults): string {
  const lines = ['# Recording measurements', '',
    `${results.at}. ${results.machine.cpu}, ${results.machine.cores} cores, ${results.machine.memoryGb} GiB, ${results.machine.platform} ${results.machine.release} ${results.machine.arch}, Node ${results.machine.node}.`, '',
    `Source ${results.source.commit}, dirty ${results.source.dirty}, built ${results.source.built}. Versions: ${JSON.stringify(results.versions)}.`, '',
    `Five or more samples per cell, ${results.options.runs} requested. Every run starts a fresh CLI and browser. Cold means an empty dedicated Node compile cache; warm means the measured run follows its own uncounted priming run with the same cache and settings. Neither means an OS cold boot or a kept browser. Fixture servers are already running.`, '',
    'Tables show median [min, max]. Full quartiles and nearest-rank p95 are in results.json summaries. With five samples p95 equals the maximum; it does not establish a population tail.', '',
    'Wall covers CLI spawn through CLI close, including media readiness, video finalization and runner cleanup. Artifact bytes sum regular files under run/artifacts; run-folder bytes also include events, result and logs. Harness logs, resource readings and prime runs are excluded.', '',
    'Runner exit-hook CPU and peak RSS come from process.resourceUsage at the CLI exit hook; later exit hooks may still do work. Native runner and media CPU are their own cumulative CPU at the last native sample, excluding children, and are lower bounds. Both runner CPU readings are shown. Media peak physical footprint is the kernel lifetime high-water mark at the last sample; RSS is a sampled maximum. A peak or CPU after that sample may be missed. The observer requests 5 ms sampling and records actual largest gaps. These are different memory measures and are not summed.', '',
    'Both fixtures are published. Retest recording cells retain default diagnostic capture. Matched Chrome comparison cells disable diagnostics, video, trace and screenshots on both tools; use one worker, one active browser, fresh context per test, the same Chrome binary, viewport 1280x720 at scale 1, same fixture/address and test body, no retries, 30 s test and 5 s action/assertion budgets. Each file has one test. Imports, runner bookkeeping, browser launch flags, locator implementations and cleanup are tool-specific. Navigation waits retain each tool\'s implementation.', '',
    'These measurements make no speed claim. They do not establish suite throughput, native-platform performance, full-machine CPU or peak memory, clean-host installation, another machine or OS, failure/cancellation cost, or equivalence of browser engines.', '',
    '| Fixture | Engine | Tool | Diagnostics | Recording | Cache | Valid | Wall ms | Runner exit-hook CPU ms | Runner native CPU ms lower bound | Runner peak RSS MiB | Media CPU ms lower bound | Media peak footprint MiB | Media sampled RSS MiB | Artifact KiB | Run folder KiB |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |']
  for (const cell of results.cells) {
    const runs = cell.runs.filter(validMeasurement)
    const display = (values: number[], divisor = 1): string => {
      const stats = spread(values.map(value => value / divisor))
      return stats === null ? 'unavailable' : `${stats.median.toFixed(2)} [${stats.min.toFixed(2)}, ${stats.max.toFixed(2)}]`
    }
    const of = (read: (run: MeasuredRun) => number): string => display(runs.map(read))
    const media = (read: (run: MeasuredRun) => number, divisor = 1): string => cell.recording ? display(runs.map(read), divisor) : 'not started'
    lines.push(`| ${cell.fixture} | ${cell.engine} | ${cell.tool} | ${cell.diagnostics ? 'on' : 'off'} | ${cell.recording ? 'on' : 'off'} | ${cell.cache} | ${runs.length}/${cell.runs.length} | ${of(run => run.wallMs)} | ${of(run => (run.runner?.userCpuMs ?? 0) + (run.runner?.systemCpuMs ?? 0))} | ${of(run => (run.runnerNative?.userCpuMs ?? 0) + (run.runnerNative?.systemCpuMs ?? 0))} | ${display(runs.map(run => run.runner?.peakRssBytes ?? 0), 2 ** 20)} | ${media(run => run.media.reduce((sum, value) => sum + value.userCpuMs + value.systemCpuMs, 0))} | ${media(run => Math.max(...run.media.map(value => value.peakFootprintBytes)), 2 ** 20)} | ${media(run => Math.max(...run.media.map(value => value.sampledPeakRssBytes)), 2 ** 20)} | ${display(runs.map(run => run.artifactBytes), 1024)} | ${display(runs.map(run => run.runFolderBytes), 1024)} |`)
    for (const [index, run] of cell.runs.entries()) if (!validMeasurement(run)) lines.push('', `Invalid ${cell.fixture}/${cell.engine}/${cell.tool}/${cell.cache}/${cell.recording ? 'on' : 'off'}/${index + 1}: ${run.outcome.reason ?? ''}; ${run.evidenceProblems.join('; ')}. Raw readings retained at ${run.resourcesFile}.`, '')
  }
  lines.push('', 'Actual command, cwd, load before/after, individual resource samples, recording mode and capture counts are retained per run. Priming results are retained and must also pass; they do not enter measured medians.', '')
  return lines.join('\n')
}

export function recordingSummaries(cells: readonly RecordingCell[]): object[] {
  return cells.map(cell => {
    const runs = cell.runs.filter(validMeasurement)
    const metric = (read: (run: MeasuredRun) => number): Spread | null => spread(runs.map(read))
    return { fixture: cell.fixture, engine: cell.engine, tool: cell.tool, recording: cell.recording, diagnostics: cell.diagnostics, cache: cell.cache,
      valid: runs.length, attempted: cell.runs.length, wallMs: metric(run => run.wallMs),
      runnerCpuMs: metric(run => (run.runner?.userCpuMs ?? 0) + (run.runner?.systemCpuMs ?? 0)), runnerPeakRssBytes: metric(run => run.runner?.peakRssBytes ?? 0),
      runnerNativeCpuMsLowerBound: metric(run => (run.runnerNative?.userCpuMs ?? 0) + (run.runnerNative?.systemCpuMs ?? 0)),
      mediaCpuMsLowerBound: cell.recording ? metric(run => run.media.reduce((sum, value) => sum + value.userCpuMs + value.systemCpuMs, 0)) : null,
      mediaPeakFootprintBytes: cell.recording ? metric(run => Math.max(...run.media.map(value => value.peakFootprintBytes))) : null,
      mediaSampledPeakRssBytes: cell.recording ? metric(run => Math.max(...run.media.map(value => value.sampledPeakRssBytes))) : null,
      runnerNativePeakFootprintBytes: metric(run => run.runnerNative?.peakFootprintBytes ?? 0),
      observedFfmpegCpuMsLowerBound: cell.recording ? metric(run => run.encoder.reduce((sum, value) => sum + value.userCpuMs + value.systemCpuMs, 0)) : null,
      observedFfmpegMaxSingleProcessFootprintBytes: cell.recording ? metric(run => Math.max(0, ...run.encoder.map(value => value.peakFootprintBytes))) : null,
      artifactBytes: metric(run => run.artifactBytes), runFolderBytes: metric(run => run.runFolderBytes), largestSampleGapMs: metric(run => run.largestSampleGapMs) }
  })
}
