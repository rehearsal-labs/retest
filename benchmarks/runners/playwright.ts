import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isRecord, parseFirstObject, readArray, readNumber, readRecord, readString, type JsonRecord } from '../json.ts'
import { factsOf, judge, timedOutReason, type Marks, type RunFacts, type RunOutcome } from '../phases.ts'
import { runProgram } from '../programs.ts'
import type { Project } from '../workspace.ts'

/**
 * Runs the Playwright project once with `playwright test` and its JSON reporter on stdout, and reads the phases
 * from that report. `workers` undefined leaves Playwright's default, half the cores.
 */
export async function runPlaywright(
  project: Project,
  runFolder: string,
  workers: number | undefined,
  timeoutMs: number,
  expectedTests: number,
): Promise<RunOutcome> {
  await mkdir(runFolder, { recursive: true })
  const args = [project.entry, 'test', '--reporter=json', '--output', join(runFolder, 'artifacts')]
  if (workers !== undefined) args.push(`--workers=${workers}`)
  const run = await runProgram(process.execPath, args, { cwd: project.folder, timeoutMs })
  await writeFile(join(runFolder, 'report.json'), run.stdout)
  await writeFile(join(runFolder, 'stderr.txt'), run.stderr)
  return outcomeFromReport(run.stdout, run.stderr, factsOf(run, timeoutMs), expectedTests)
}

/**
 * Judges a Playwright run from its JSON report: `stats` gives the counts, and every result's start and duration
 * bound the tests phase.
 */
export function outcomeFromReport(stdout: string, stderr: string, run: RunFacts, expectedTests: number): RunOutcome {
  const timedOut = timedOutReason(run)
  if (timedOut !== undefined) return judge(undefined, { passed: 0, failed: 0, exitCode: run.code }, expectedTests, timedOut)
  const report = parseFirstObject(stdout)
  if (report === undefined) {
    const last = stderr.trim().split('\n').at(-1)
    return judge(undefined, { passed: 0, failed: 0, exitCode: run.code }, expectedTests, `no JSON report: ${last === undefined || last === '' ? 'no output' : last}`)
  }
  const stats = readRecord(report, 'stats')
  const passed = stats === undefined ? 0 : (readNumber(stats, 'expected') ?? 0)
  const failed = stats === undefined ? 0 : (readNumber(stats, 'unexpected') ?? 0) + (readNumber(stats, 'flaky') ?? 0)
  const counts = { passed, failed, exitCode: run.code }
  const results = collectResults(readArray(report, 'suites'))
  if (results.length === 0) return judge(undefined, counts, expectedTests, 'no test ran')
  const marks: Marks = {
    spawnedAt: run.startedAt,
    exitedAt: run.endedAt,
    firstTestStart: Math.min(...results.map((result) => result.startedAt)),
    lastTestEnd: Math.max(...results.map((result) => result.startedAt + result.duration)),
    testDurations: results.map((result) => result.duration),
  }
  return judge(marks, counts, expectedTests)
}

type Result = { readonly startedAt: number; readonly duration: number }

// Suites nest: a file holds describe blocks, each holding specs, each holding one test per project with its results.
function collectResults(suites: readonly unknown[]): Result[] {
  const found: Result[] = []
  for (const suite of suites) {
    if (!isRecord(suite)) continue
    found.push(...collectResults(readArray(suite, 'suites')))
    for (const spec of readArray(suite, 'specs')) {
      if (!isRecord(spec)) continue
      for (const test of readArray(spec, 'tests')) {
        if (!isRecord(test)) continue
        for (const result of readArray(test, 'results')) {
          if (!isRecord(result)) continue
          const read = readResult(result)
          if (read !== undefined) found.push(read)
        }
      }
    }
  }
  return found
}

function readResult(result: JsonRecord): Result | undefined {
  const startedAt = Date.parse(readString(result, 'startTime') ?? '')
  const duration = readNumber(result, 'duration')
  if (Number.isNaN(startedAt) || duration === undefined) return undefined
  return { startedAt, duration }
}
