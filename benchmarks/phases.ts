import type { ProgramRun } from './programs.ts'

/** Milliseconds of one run, split where both tools can be read the same way. */
export type Phases = {
  /** Spawning the process to its exit. */
  readonly wall: number
  /** Spawning the process to the first test starting: boot, config, collection and the browser launch. */
  readonly startup: number
  /** The first test starting to the last test ending. */
  readonly tests: number
  /** The last test ending to the process exiting. */
  readonly teardown: number
  /** The median of the tool's own per-test durations. */
  readonly perTest: number
}

export type Marks = {
  readonly spawnedAt: number
  readonly exitedAt: number
  readonly firstTestStart: number
  readonly lastTestEnd: number
  readonly testDurations: readonly number[]
}

/** What the harness knows of a run before reading the tool's own report. */
export type RunFacts = {
  readonly startedAt: number
  readonly endedAt: number
  readonly code: number | null
  readonly timedOut: boolean
  readonly timeoutMs: number
}

export function factsOf(run: ProgramRun, timeoutMs: number): RunFacts {
  return { startedAt: run.startedAt, endedAt: run.endedAt, code: run.code, timedOut: run.timedOut, timeoutMs }
}

export type RunOutcome = {
  readonly phases: Phases | null
  readonly passed: number
  readonly failed: number
  readonly exitCode: number | null
  /** Every expected test passed and the process exited 0. Medians read only valid runs. */
  readonly valid: boolean
  readonly reason?: string
}

/** The middle value, or the mean of the two middle values. Null for no values. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  const upper = sorted[middle]
  const lower = sorted[middle - 1]
  if (upper === undefined) return null
  return sorted.length % 2 === 1 || lower === undefined ? upper : (lower + upper) / 2
}

export function phasesFrom(marks: Marks): Phases {
  return {
    wall: marks.exitedAt - marks.spawnedAt,
    startup: marks.firstTestStart - marks.spawnedAt,
    tests: marks.lastTestEnd - marks.firstTestStart,
    teardown: marks.exitedAt - marks.lastTestEnd,
    perTest: median(marks.testDurations) ?? 0,
  }
}

export type Counts = { readonly passed: number; readonly failed: number; readonly exitCode: number | null }

/** Judges one run: valid only when every expected test passed, nothing failed and the process exited 0. */
export function judge(marks: Marks | undefined, counts: Counts, expectedTests: number, problem?: string): RunOutcome {
  const base = { phases: marks === undefined ? null : phasesFrom(marks), ...counts }
  if (problem !== undefined) return { ...base, valid: false, reason: problem }
  if (counts.exitCode !== 0) return { ...base, valid: false, reason: `exit code ${counts.exitCode ?? 'unknown'}` }
  if (counts.failed > 0) return { ...base, valid: false, reason: `${counts.failed} failed` }
  if (counts.passed !== expectedTests) return { ...base, valid: false, reason: `${counts.passed} of ${expectedTests} passed` }
  if (marks === undefined) return { ...base, valid: false, reason: 'no timing read' }
  return { ...base, valid: true }
}

/** The reason a run the harness ended on time is invalid, before anything it printed is read. */
export function timedOutReason(run: RunFacts): string | undefined {
  return run.timedOut ? `timed out after ${run.timeoutMs} ms` : undefined
}

/** Medians of each phase over the valid runs, or null when none is valid. */
export function medianPhases(runs: readonly RunOutcome[]): Phases | null {
  const valid = runs.flatMap((run) => (run.valid && run.phases !== null ? [run.phases] : []))
  if (valid.length === 0) return null
  const of = (key: keyof Phases): number => median(valid.map((phases) => phases[key])) ?? 0
  return { wall: of('wall'), startup: of('startup'), tests: of('tests'), teardown: of('teardown'), perTest: of('perTest') }
}
