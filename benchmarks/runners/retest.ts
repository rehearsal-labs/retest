import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isRecord, readNumber, readString } from '../json.ts'
import { factsOf, judge, timedOutReason, type Marks, type RunFacts, type RunOutcome } from '../phases.ts'
import { runProgram } from '../programs.ts'
import type { Project } from '../workspace.ts'

/**
 * Runs every test file in the Retest project once, as `retest run` with its config, and reads the phases from the
 * run folder's `events.jsonl`. The run folder must not exist yet: Retest never writes over a run.
 */
export async function runRetest(project: Project, runFolder: string, timeoutMs: number, expectedTests: number): Promise<RunOutcome> {
  const run = await runProgram(process.execPath, [project.entry, 'run', '--no-agent', '--output', runFolder], { cwd: project.folder, timeoutMs })
  await writeFile(`${runFolder}.stdout.txt`, run.stdout)
  await writeFile(`${runFolder}.stderr.txt`, run.stderr)
  let events: string | undefined
  try {
    events = await readFile(join(runFolder, 'events.jsonl'), 'utf8')
  } catch {
    events = undefined
  }
  const missing = `no events.jsonl: ${lastLine(run.stderr) ?? lastLine(run.stdout) ?? 'no output'}`
  return outcomeFromEvents(events, factsOf(run, timeoutMs), expectedTests, missing)
}

/**
 * Runs the Playwright project's own spec files with Retest, unchanged: `retest run --playwright` from that
 * project's folder, with the browser and the address its Playwright config names. Retest is not installed there;
 * its command comes from the Retest project, and `@playwright/test` resolves to Retest's own subpath.
 */
export async function runRetestOnPlaywrightFiles(
  retest: Project,
  playwrightFolder: string,
  target: { browser: string; baseUrl: string },
  runFolder: string,
  timeoutMs: number,
  expectedTests: number,
): Promise<RunOutcome> {
  const args = [retest.entry, 'run', '--playwright', '--browser', target.browser, '--base-url', target.baseUrl, '--no-agent', '--output', runFolder]
  const run = await runProgram(process.execPath, args, { cwd: playwrightFolder, timeoutMs })
  await writeFile(`${runFolder}.stdout.txt`, run.stdout)
  await writeFile(`${runFolder}.stderr.txt`, run.stderr)
  let events: string | undefined
  try {
    events = await readFile(join(runFolder, 'events.jsonl'), 'utf8')
  } catch {
    events = undefined
  }
  const missing = `no events.jsonl: ${lastLine(run.stderr) ?? lastLine(run.stdout) ?? 'no output'}`
  return outcomeFromEvents(events, factsOf(run, timeoutMs), expectedTests, missing)
}

/**
 * Judges a Retest run from its `events.jsonl`: the first `test.started` and the last `test.finished` bound the
 * tests phase, and every `test.finished` counts as passed or not. `missing` is the reason when there is no file.
 */
export function outcomeFromEvents(events: string | undefined, run: RunFacts, expectedTests: number, missing: string): RunOutcome {
  const timedOut = timedOutReason(run)
  if (timedOut !== undefined) return judge(undefined, { passed: 0, failed: 0, exitCode: run.code }, expectedTests, timedOut)
  if (events === undefined) return judge(undefined, { passed: 0, failed: 0, exitCode: run.code }, expectedTests, missing)
  const starts: number[] = []
  const ends: number[] = []
  const durations: number[] = []
  let passed = 0
  let failed = 0
  for (const line of events.split('\n')) {
    if (line === '') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    if (!isRecord(parsed)) continue
    const type = readString(parsed, 'type')
    const time = Date.parse(readString(parsed, 'time') ?? '')
    if (Number.isNaN(time)) continue
    if (type === 'test.started') starts.push(time)
    if (type === 'test.finished') {
      ends.push(time)
      durations.push(readNumber(parsed, 'durationMs') ?? 0)
      if (readString(parsed, 'status') === 'passed') passed += 1
      else failed += 1
    }
  }
  const counts = { passed, failed, exitCode: run.code }
  if (starts.length === 0 || ends.length === 0) return judge(undefined, counts, expectedTests, 'no test ran')
  const marks: Marks = {
    spawnedAt: run.startedAt,
    exitedAt: run.endedAt,
    firstTestStart: Math.min(...starts),
    lastTestEnd: Math.max(...ends),
    testDurations: durations,
  }
  return judge(marks, counts, expectedTests)
}

function lastLine(text: string): string | undefined {
  const last = text.trim().split('\n').at(-1)?.trim()
  return last === undefined || last === '' ? undefined : last
}
