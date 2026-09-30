import type { ChildProcess } from 'node:child_process'
import type { TestContext } from 'node:test'
import type { RetestEvent } from '../../src/protocol/events.ts'
import type { RunResult, TestResult } from '../../src/protocol/result.ts'
import type { Timeouts } from '../../src/protocol/timeouts.ts'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { signalGroup } from '../../src/browser/chromium-process.ts'
import { agentVariables } from '../../src/cli/agent-detection.ts'
import { retestEventSchema } from '../../src/protocol/events.ts'
import { runResultSchema } from '../../src/protocol/result.ts'
import { childLogFile, eventsFile, resultFile } from '../../src/protocol/run-folder.ts'
import { parse, type Schema } from '../../src/protocol/schema.ts'
import { errorCode } from '../../src/shared/error-code.ts'
import { browserPath, processesUsing, waitForGroupEnd } from './browser-harness.ts'

export const repositoryRoot: string = fileURLToPath(new URL('../../', import.meta.url))

/** Retest run from its source, the way `npm test` runs it. */
export const sourceCommand: readonly string[] = [
  process.execPath,
  '--conditions=retest-source',
  join(repositoryRoot, 'src/cli/main.ts'),
]

/** The example from the brief, run by most checks. */
export const exampleFile = 'examples/task.retest.ts'

/** A scenario file in `fixtures/tests`, relative to the repository root. */
export function scenario(name: string): string {
  return `fixtures/tests/${name}.retest.ts`
}

const shortBudgets: Timeouts = {
  collection: 5000,
  setup: 15_000,
  action: 2000,
  navigation: 5000,
  assertion: 2000,
  test: 15_000,
  cleanup: 5000,
}

/** Short explicit budgets for `--timeouts`, with some replaced. */
export function budgets(overrides: Partial<Timeouts> = {}): string {
  return Object.entries({ ...shortBudgets, ...overrides })
    .map(([name, milliseconds]) => `${name}=${milliseconds}`)
    .join(',')
}

/** Waits for a fixture's state, looking every few milliseconds, and fails after `timeoutMs`. */
export async function waitFor(what: string, condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const end = performance.now() + timeoutMs
  while (!condition()) {
    if (performance.now() > end) assert.fail(`${what} did not happen within ${timeoutMs} ms`)
    await delay(10)
  }
}

export type Exit = { code: number | null; signal: NodeJS.Signals | null }

export type EventType = RetestEvent['type']
export type EventOf<Type extends EventType> = Extract<RetestEvent, { type: Type }>

const profilePrefix = 'retest-profile-'
const releaseWaitMs = 5000

/** A temporary folder removed after the test, even when it fails. */
export async function scratchFolder(t: TestContext, prefix = 'retest-cli-'): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), prefix))
  t.after(() => rm(folder, { recursive: true, force: true }))
  return folder
}

export type StartOptions = {
  args: readonly string[]
  /** Default: the repository root. */
  cwd?: string
  /** What runs before the arguments. Default: Retest from source. */
  command?: readonly string[]
  /** The folder Retest gets as TMPDIR, where its browser profiles go. Default: a new one. */
  tmp?: string
  env?: Readonly<Record<string, string>>
}

/**
 * One `retest` command, started as the leader of its own process group with a temporary folder of its
 * own, so that every process and profile it leaves can be found afterwards. Only processes this handle
 * started are ever signalled.
 */
export class RetestProcess {
  readonly pid: number
  readonly tmp: string
  readonly exited: Promise<Exit>
  readonly #child: ChildProcess
  readonly #startedAt = performance.now()
  readonly #browsers = new Set<number>()
  readonly #waiters = new Set<() => void>()
  readonly #printed: RetestEvent[] = []
  #stdout = ''
  #partialLine = ''
  #stderr = ''
  #durationMs: number | undefined

  private constructor(child: ChildProcess, tmp: string) {
    const { pid } = child
    assert.ok(pid !== undefined, 'retest did not start')
    this.pid = pid
    this.tmp = tmp
    this.#child = child
    child.stdout?.setEncoding('utf8').on('data', (text: string) => this.#read(text))
    child.stderr?.setEncoding('utf8').on('data', (text: string) => {
      this.#stderr += text
    })
    this.exited = new Promise((resolve) => {
      child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
        this.#durationMs = performance.now() - this.#startedAt
        this.#notify()
        resolve({ code, signal })
      })
    })
  }

  static async start(t: TestContext, options: StartOptions): Promise<RetestProcess> {
    const tmp = options.tmp ?? join(await scratchFolder(t), 'tmp')
    await mkdir(tmp, { recursive: true })
    const [executable = process.execPath, ...leading] = options.command ?? sourceCommand
    const child = spawn(executable, [...leading, ...options.args], {
      cwd: options.cwd ?? repositoryRoot,
      env: environment(tmp, options.env ?? {}),
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const retest = new RetestProcess(child, tmp)
    t.after(() => retest.#release())
    return retest
  }

  get stdout(): string {
    return this.#stdout
  }

  get stderr(): string {
    return this.#stderr
  }

  /** Milliseconds from start to exit. */
  get durationMs(): number {
    assert.ok(this.#durationMs !== undefined, 'retest is still running')
    return this.#durationMs
  }

  /** Sends a signal to the retest process alone, not to its children. */
  signal(signal: NodeJS.Signals): void {
    this.#child.kill(signal)
  }

  /** Stops reading stdout, as a reader that went away would. */
  closeStdout(): void {
    this.#child.stdout?.destroy()
  }

  /** Stops reading stderr, as a reader that went away would. */
  closeStderr(): void {
    this.#child.stderr?.destroy()
  }

  /** The browser process groups this command reported, so the harness can check and release them. */
  ownBrowser(pid: number): void {
    this.#browsers.add(pid)
  }

  /** Resolves with the first event of this type on stdout, as the JSONL reporter prints it. */
  waitForEvent<Type extends EventType>(type: Type, matches: (event: EventOf<Type>) => boolean = () => true): Promise<EventOf<Type>> {
    const { promise, resolve, reject } = Promise.withResolvers<EventOf<Type>>()
    const check = (): void => {
      const found = eventsOf(this.#printed, type).find(matches)
      if (found !== undefined) {
        this.#waiters.delete(check)
        resolve(found)
      } else if (this.#durationMs !== undefined) {
        this.#waiters.delete(check)
        reject(new Error(`retest exited without printing ${type}. stderr:\n${this.#stderr}`))
      }
    }
    this.#waiters.add(check)
    check()
    return promise
  }

  // Keeps each whole stdout line that is an event, and the browsers they report.
  #read(text: string): void {
    this.#stdout += text
    const lines = `${this.#partialLine}${text}`.split('\n')
    this.#partialLine = lines.pop() ?? ''
    for (const line of lines) {
      const parsed = parse(retestEventSchema, parseJson(line))
      if (!parsed.ok) continue
      this.#printed.push(parsed.value)
      if (parsed.value.type === 'browser.started') this.ownBrowser(parsed.value.pid)
    }
    this.#notify()
  }

  #notify(): void {
    for (const check of [...this.#waiters]) check()
  }

  // The last resort after a failed assertion: end what this command started, and nothing else.
  #release(): void {
    if (this.#durationMs === undefined) signalGroup(this.pid, 'SIGKILL')
    for (const pid of this.#browsers) signalGroup(pid, 'SIGKILL')
  }
}

function environment(tmp: string, extra: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: tmp }
  for (const name of agentVariables) delete env[name]
  return { ...env, ...extra }
}

export type RunRequest = {
  files: readonly string[]
  baseUrl?: string
  /** Such as `action=500,test=3000`. Default: `budgets()`. */
  timeouts?: string
  /** Default: the test browser. */
  browser?: string
  /** Default: jsonl, so stdout can be read as events. */
  reporter?: 'jsonl' | 'human' | 'agent'
  args?: readonly string[]
} & Omit<StartOptions, 'args'>

export type StartedRun = { retest: RetestProcess; output: string }

/** Starts `retest run` with a new output folder. */
export async function startRun(t: TestContext, request: RunRequest): Promise<StartedRun> {
  const folder = await scratchFolder(t)
  const output = join(folder, 'run')
  const args = [
    'run',
    ...request.files,
    '--browser',
    request.browser ?? browserPath(),
    '--reporter',
    request.reporter ?? 'jsonl',
    '--output',
    output,
    '--timeouts',
    request.timeouts ?? budgets(),
    ...(request.baseUrl === undefined ? [] : ['--base-url', request.baseUrl]),
    ...(request.args ?? []),
  ]
  const retest = await RetestProcess.start(t, { ...request, args, tmp: request.tmp ?? join(folder, 'tmp') })
  return { retest, output }
}

export type FinishedRun = {
  exit: Exit
  stdout: string
  stderr: string
  durationMs: number
  output: string
  /** `events.jsonl`, every line validated. Empty when the run never created its folder. */
  events: RetestEvent[]
  /** `result.json`, validated, when the run wrote it. */
  result: RunResult | undefined
}

/** Waits for the run to end, reads its folder, and checks that it left no process or profile behind. */
export async function finishRun(started: StartedRun): Promise<FinishedRun> {
  const run = await readFinishedRun(started)
  await assertReleased(started.retest, run.events)
  return run
}

/** Starts a run and finishes it. */
export async function runRetest(t: TestContext, request: RunRequest): Promise<FinishedRun> {
  return finishRun(await startRun(t, request))
}

/** Waits for the run to end and reads its folder, without checking what it left behind. */
export async function readFinishedRun({ retest, output }: StartedRun): Promise<FinishedRun> {
  const exit = await retest.exited
  const events = existsSync(join(output, eventsFile)) ? readEvents(readFileSync(join(output, eventsFile), 'utf8')) : []
  for (const event of events) if (event.type === 'browser.started') retest.ownBrowser(event.pid)
  const result = existsSync(join(output, resultFile)) ? readResult(readFileSync(join(output, resultFile), 'utf8')) : undefined
  const { stdout, stderr, durationMs } = retest
  return { exit, stdout, stderr, durationMs, output, events, result }
}

/**
 * Checks that nothing the command started is left: no browser process group it reported, no process in
 * its own group (the test file processes), no browser profile and no process using its temporary folder.
 */
export async function assertReleased(retest: RetestProcess, events: readonly RetestEvent[]): Promise<void> {
  await waitForGroupEnd(retest.pid, releaseWaitMs)
  assert.deepEqual(profilesIn(retest.tmp), [], 'no browser profile is left')
  assert.deepEqual(await processesUsing(retest.tmp), [], 'no process uses the run temporary folder')
  for (const browser of eventsOf(events, 'browser.started')) await waitForGroupEnd(browser.pid, releaseWaitMs)
}

/** The Retest browser profiles in a folder. */
export function profilesIn(folder: string): string[] {
  return readdirSync(folder).filter((name) => name.startsWith(profilePrefix))
}

/** Every line of an events file, validated against the version 1 schema, in sequence order. */
export function readEvents(text: string): RetestEvent[] {
  const lines = text.split('\n')
  assert.equal(lines.pop(), '', 'the events end with a whole line')
  const events = lines.map((line, index) => parseLine(retestEventSchema, line, `event line ${index + 1}`))
  assert.deepEqual(
    events.map((event) => event.sequence),
    events.map((_event, index) => index),
    'events are numbered in order from 0',
  )
  assert.equal(new Set(events.map((event) => event.runId)).size <= 1, true, 'events come from one run')
  return events
}

/** A run result, validated against the version 1 schema. */
export function readResult(text: string): RunResult {
  return parseLine(runResultSchema, text, 'the run result')
}

/** The complete lines of a stream, without the one still being written. */
export function completeLines(text: string): string[] {
  const lines = text.split('\n')
  lines.pop()
  return lines
}

export function parseLine<T>(schema: Schema<T>, text: string, what: string): T {
  const json = parseJson(text)
  assert.notEqual(json, undefined, `${what} is JSON: ${text.slice(0, 200)}`)
  const parsed = parse(schema, json)
  assert.ok(parsed.ok, `${what} matches its schema: ${parsed.ok ? '' : JSON.stringify(parsed.issues)}`)
  return parsed.value
}

function parseJson(text: string): unknown {
  try {
    const value: unknown = JSON.parse(text)
    return value
  } catch {
    return undefined
  }
}

export function eventsOf<Type extends EventType>(events: readonly RetestEvent[], type: Type): EventOf<Type>[] {
  return events.filter((event): event is EventOf<Type> => event.type === type)
}

/** The one event of a type. */
export function onlyEvent<Type extends EventType>(events: readonly RetestEvent[], type: Type): EventOf<Type> {
  const found = eventsOf(events, type)
  assert.equal(found.length, 1, `one ${type} event`)
  const [event] = found
  assert.ok(event !== undefined)
  return event
}

/** The run result, which every run that reached its end writes. */
export function resultOf(run: FinishedRun): RunResult {
  assert.ok(run.result !== undefined, `the run wrote ${resultFile}. stderr:\n${run.stderr}`)
  return run.result
}

/** The result of the test with this name. */
export function testNamed(run: FinishedRun, name: string): TestResult {
  const found = resultOf(run)
  const test = found.files.flatMap((file) => file.tests).find((candidate) => candidate.name === name)
  assert.ok(test !== undefined, `a test named ${JSON.stringify(name)} is in the result`)
  return test
}

/** The only test in the run. */
export function onlyTest(run: FinishedRun): TestResult {
  const tests = resultOf(run).files.flatMap((file) => file.tests)
  assert.equal(tests.length, 1, 'the run has one test')
  const [test] = tests
  assert.ok(test !== undefined)
  return test
}

/** What a test file's process printed, from the run folder. */
export function childLog(run: FinishedRun, file: string): string {
  return readFileSync(join(run.output, childLogFile(file)), 'utf8')
}

/** The process ids a test file printed as `pid <n>`. */
export function printedPids(text: string): number[] {
  return [...text.matchAll(/pid (\d+)/g)].map((match) => Number(match[1]))
}

/** Whether a process this suite started is still there. */
export function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (errorCode(error) === 'ESRCH') return false
    throw error
  }
}

/** Starts `retest inspect` and returns the run result it prints with `--json`. */
export async function inspectJson(t: TestContext, output: string): Promise<{ exit: Exit; result: RunResult; stderr: string }> {
  const retest = await RetestProcess.start(t, { args: ['inspect', output, '--json'] })
  const exit = await retest.exited
  await assertReleased(retest, [])
  return { exit, result: readResult(retest.stdout), stderr: retest.stderr }
}
