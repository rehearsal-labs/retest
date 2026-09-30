import type { RetestEvent } from '../../src/protocol/events.ts'
import type { RunResult, TestResult } from '../../src/protocol/result.ts'
import type { Timeouts } from '../../src/protocol/timeouts.ts'
import type { Reporter } from '../../src/reporters/reporter.ts'
import type { ChildOutput } from '../../src/runner/contract.ts'
import type { FakeBrowser, FakeOptions } from './fake-browser.ts'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { retestEventSchema } from '../../src/protocol/events.ts'
import { runResultSchema } from '../../src/protocol/result.ts'
import { eventsFile, resultFile } from '../../src/protocol/run-folder.ts'
import { parse } from '../../src/protocol/schema.ts'
import { tempFolder } from './temp-folder.ts'
import { defaultTimeouts } from '../../src/protocol/timeouts.ts'
import { runFiles } from '../../src/runner/run.ts'
import { fakeLauncher } from './fake-browser.ts'

export const rootDir: string = fileURLToPath(new URL('../../', import.meta.url))

/** Short budgets so failures arrive quickly. */
export const quickTimeouts: Timeouts = {
  ...defaultTimeouts,
  collection: 5000,
  setup: 2000,
  action: 500,
  navigation: 1000,
  assertion: 300,
  test: 5000,
  cleanup: 1000,
}

export type HarnessOptions = {
  fake?: FakeOptions
  timeouts?: Partial<Timeouts>
  reporters?: Reporter[]
  signal?: AbortSignal
  baseUrl?: string
  /** Sees each chunk of the test files' output as it arrives. */
  onOutput?: (chunk: ChildOutput) => void
}

export type RunRecord = {
  result: RunResult
  events: RetestEvent[]
  /** The events file as written, line by line. */
  lines: string[]
  folder: string
  browsers: FakeBrowser[]
  output: ChildOutput[]
  written: RunResult | undefined
}

/** A support file's path relative to the repository root. */
export function supportFile(name: string): string {
  return `tests/support/files/${name}`
}

/** A new, empty folder for one run's output. */
export function newRunFolder(): string {
  return join(tempFolder('runner-'), 'run')
}

/** Runs support files with the fake browser and reads back everything the run wrote, validating it. */
export async function runSupportFiles(names: readonly string[], options: HarnessOptions = {}): Promise<RunRecord> {
  const folder = newRunFolder()
  const { launch, browsers } = fakeLauncher(options.fake)
  const output: ChildOutput[] = []
  const result = await runFiles(
    {
      files: names.map(supportFile),
      rootDir,
      apps: { kind: 'browser', browserPath: '/fake/chromium', baseUrl: options.baseUrl ?? 'http://127.0.0.1:4173' },
      timeouts: { ...quickTimeouts, ...options.timeouts },
      outputDir: folder,
      headless: true,
      signal: options.signal ?? new AbortController().signal,
      onOutput: (chunk) => {
        output.push(chunk)
        options.onOutput?.(chunk)
      },
    },
    options.reporters ?? [],
    launch,
  )
  const { events, lines } = readEvents(folder)
  const written = readResult(folder)
  return { result, events, lines, folder, browsers, output, written }
}

/** Every line of `events.jsonl`, each checked against the version 1 schema, in sequence order. */
export function readEvents(folder: string): { events: RetestEvent[]; lines: string[] } {
  const text = readFileSync(join(folder, eventsFile), 'utf8')
  assert.ok(text === '' || text.endsWith('\n'), 'events.jsonl ends with a whole line')
  const lines = text.split('\n').filter((line) => line !== '')
  const events = lines.map((line, index) => {
    const parsed = parse(retestEventSchema, JSON.parse(line))
    assert.ok(parsed.ok, `line ${index + 1} is a valid event: ${parsed.ok ? '' : JSON.stringify(parsed.issues)}`)
    return parsed.value
  })
  assert.deepEqual(
    events.map((event) => event.sequence),
    events.map((_event, index) => index),
  )
  return { events, lines }
}

/** `result.json`, checked against its schema, or undefined when the run did not write it. */
export function readResult(folder: string): RunResult | undefined {
  const path = join(folder, resultFile)
  if (!existsSync(path)) return undefined
  const parsed = parse(runResultSchema, JSON.parse(readFileSync(path, 'utf8')))
  assert.ok(parsed.ok, `result.json is valid: ${parsed.ok ? '' : JSON.stringify(parsed.issues)}`)
  return parsed.value
}

/** The result of the test with this name, from any file. */
export function testNamed(result: RunResult, name: string): TestResult {
  const found = result.files.flatMap((file) => file.tests).find((test) => test.name === name)
  assert.ok(found, `a test named ${JSON.stringify(name)} is in the result`)
  return found
}

/** The events of one type, typed. */
export function eventsOfType<Type extends RetestEvent['type']>(events: readonly RetestEvent[], type: Type): Extract<RetestEvent, { type: Type }>[] {
  return events.filter((event): event is Extract<RetestEvent, { type: Type }> => event.type === type)
}

/** Whether a process id is still running. Only ever called with ids this suite started. */
export function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Waits up to `timeoutMs` for a process this suite started to be gone, and says whether it is. */
export async function isGoneWithin(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = performance.now() + timeoutMs
  while (isRunning(pid)) {
    if (performance.now() > deadline) return false
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return true
}

/** Process ids a test file printed as `pid <n>`. */
export function printedPids(output: readonly ChildOutput[]): number[] {
  return [...output.map((chunk) => chunk.text).join('').matchAll(/pid (\d+)/g)].map((match) => Number(match[1]))
}
