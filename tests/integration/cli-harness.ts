import type { ChildProcess, ExecFileException } from 'node:child_process'
import type { TestContext } from 'node:test'
import type { RetestEvent } from '../../src/protocol/events.ts'
import type { RunResult, TestResult } from '../../src/protocol/result.ts'
import type { Timeouts } from '../../src/protocol/timeouts.ts'
import assert from 'node:assert/strict'
import { execFile, execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { agentVariables } from '../../src/cli/agent-detection.ts'
import { retestEventSchema } from '../../src/protocol/events.ts'
import { runResultSchema } from '../../src/protocol/result.ts'
import { childLogFile, eventsFile, resultFile, statesFolder } from '../../src/protocol/run-folder.ts'
import { parse, type Schema } from '../../src/protocol/schema.ts'
import { errorCode } from '../../src/shared/error-code.ts'
import { OwnedProcessGroup } from '../../src/shared/process-ownership.ts'
import { tempFolder } from '../support/temp-folder.ts'
import { browserPath, groupExists, processesUsing, waitForGroupEnd } from './browser-harness.ts'
import { engineUnderTest, type TestEngine } from './engines.ts'

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
const retestPrefix = 'retest-'
const releaseWaitMs = 5000

/** A temporary folder removed after the test, even when it fails, under the test process's own root. */
export async function scratchFolder(t: TestContext, prefix = 'retest-cli-'): Promise<string> {
  const folder = tempFolder(prefix)
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
 * own, so that every process and profile it leaves can be found afterwards. Only the command itself and the
 * processes the process table shows it launched are ever signalled, each checked against its record first.
 */
export class RetestProcess {
  readonly pid: number
  readonly tmp: string
  readonly exited: Promise<Exit>
  readonly #child: ChildProcess
  /** The command and every process recorded beneath it while it ran, as the runner records the browsers it launches. */
  #ownership: OwnedProcessGroup | undefined
  readonly #startedAt = performance.now()
  /** Each browser and app server process group the command reported, with what it is, for a failure that names it. */
  readonly #groups = new Map<number, string>()
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
    t.after(() => retest.#release(t))
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

  /**
   * A browser or app server process group this command reported, so the harness can check that it ended, and end it
   * if it is still there after the test. The reported pid alone is never signalled: while the command runs, a process
   * it launched is its child in the process table, which is what records it as the command's own.
   */
  ownGroup(pid: number, what: string = this.#groups.get(pid) ?? 'a process group the run reported'): void {
    this.#groups.set(pid, what)
    this.#recordLaunched()
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

  // Keeps each whole stdout line that is an event, and the process groups they report.
  #read(text: string): void {
    this.#stdout += text
    const lines = `${this.#partialLine}${text}`.split('\n')
    this.#partialLine = lines.pop() ?? ''
    for (const line of lines) {
      const parsed = parse(retestEventSchema, parseJson(line))
      if (!parsed.ok) continue
      this.#printed.push(parsed.value)
      for (const { pid, what } of reportedProcesses([parsed.value])) this.ownGroup(pid, what)
    }
    this.#notify()
  }

  #notify(): void {
    for (const check of [...this.#waiters]) check()
  }

  // Records the command and what it has launched since the last record, only while Node has not reaped it, so its pid
  // cannot yet belong to anything else. The command is first recorded once it reports something, by when a launcher
  // such as `/usr/bin/env` has long been replaced by the program the record must hold.
  #recordLaunched(): void {
    if (this.#child.exitCode !== null || this.#child.signalCode !== null) return
    this.#ownership ??= new OwnedProcessGroup(this.pid)
    this.#ownership.capture()
  }

  // The last resort after a failed assertion. A command still running is ended through its own handle, which never
  // names a reaped pid, once what it launched is recorded; then each recorded process still there is ended after its
  // identity is checked again. Anything of the run left after that was not this harness's to end, and fails the test.
  // node:test keeps only the test's own failure when its body failed too, so what is left is also written as a
  // diagnostic of the test and to stderr first, where it survives.
  async #release(t: TestContext): Promise<void> {
    if (this.#durationMs === undefined) {
      this.#recordLaunched()
      this.#child.kill('SIGKILL')
    }
    const ownership = this.#ownership
    const report = ownership?.remains() === true ? ownership.signalReport('SIGKILL') : { problems: [], identityRefusals: [] }
    const left = await groupsLeft(new Map([[this.pid, 'the command with its test file processes'], ...this.#groups]), releaseWaitMs)
    if (left.length === 0) return
    const message = [...left, 'The harness ends only what it recorded beneath the command, each process checked against its record.', ...report.problems, ...report.identityRefusals].join('\n')
    t.diagnostic(message)
    process.stderr.write(`${message}\n`)
    assert.fail(message)
  }
}

type ReportedProcess = { pid: number; what: string }

// A browser and a server the run started each lead a process group of their own.
function reportedProcesses(events: readonly RetestEvent[]): ReportedProcess[] {
  return events.flatMap((event): ReportedProcess[] => {
    if (event.type === 'browser.started') return [{ pid: event.pid, what: `the ${event.product} browser${event.app === undefined ? '' : ` of ${event.app}`} the run reported` }]
    if (event.type === 'app.started') return [{ pid: event.pid, what: `the server of ${event.app} the run reported` }]
    return []
  })
}

function reportedGroups(events: readonly RetestEvent[]): number[] {
  return reportedProcesses(events).map((reported) => reported.pid)
}

// Each group still there after `timeoutMs`, named with the pid and executable name of every process in it. Command
// lines are left out, since an app server's may carry what its config passed it.
async function groupsLeft(groups: ReadonlyMap<number, string>, timeoutMs: number): Promise<string[]> {
  const end = performance.now() + timeoutMs
  const left: string[] = []
  for (const [group, what] of groups) {
    while (groupExists(group) && performance.now() < end) await delay(20)
    if (!groupExists(group)) continue
    const listed = await runProgram('/bin/ps', ['-ax', '-o', 'pid=,pgid=,comm='], repositoryRoot)
    const members = listed.stdout.split('\n').map((line) => line.trim().split(/\s+/)).filter(([, pgid]) => pgid === String(group))
    const named = members.map(([pid, , ...name]) => `${pid} ${name.join(' ')}`).join(', ')
    left.push(`Process group ${group}, ${what}, is still there after the test: ${named}.`)
  }
  return left
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
  /** Default: the test browser. `false` runs from the config in `cwd`, without `--browser`. */
  browser?: string | false
  /** Default: jsonl, so stdout can be read as events. */
  reporter?: 'jsonl' | 'human' | 'agent'
  args?: readonly string[]
} & Omit<StartOptions, 'args'>

export type StartedRun = { retest: RetestProcess; output: string }

/** Starts `retest run` with a new output folder. */
export async function startRun(t: TestContext, request: RunRequest): Promise<StartedRun> {
  const folder = await scratchFolder(t)
  const output = join(folder, 'run')
  // A run on the test browser runs, on another engine, from a config whose one app is that engine's target.
  const engine = engineUnderTest()
  const engineConfig = request.browser === undefined && engine.name !== 'chromium' ? await writeEngineConfig(join(folder, 'engine'), engine) : undefined
  const browser = engineConfig === undefined ? (request.browser ?? browserPath()) : false
  const args = [
    'run',
    ...request.files,
    ...(browser === false ? [] : ['--browser', browser]),
    ...(engineConfig === undefined ? [] : ['--config', engineConfig]),
    '--reporter',
    request.reporter ?? 'jsonl',
    '--output',
    output,
    '--timeouts',
    request.timeouts ?? budgets(),
    ...(request.baseUrl === undefined ? [] : ['--base-url', request.baseUrl]),
    ...(request.args ?? []),
  ]
  const env = { ...engine.environment, ...(request.env ?? {}) }
  const retest = await RetestProcess.start(t, { ...request, args, env, tmp: request.tmp ?? join(folder, 'tmp') })
  return { retest, output }
}

/** A config whose one app, `web`, is the engine's target, in a folder that resolves Retest by its package name. */
async function writeEngineConfig(folder: string, engine: TestEngine): Promise<string> {
  const file = join(folder, 'retest.config.ts')
  await writeFiles(folder, { 'retest.config.ts': `import { defineConfig } from '@rehearsal-labs/retest'\n\nexport default defineConfig({ apps: { web: ${engine.target()} } })\n` })
  await linkPackage(folder, '@rehearsal-labs/retest', repositoryRoot)
  return file
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

/** Waits for the run to end, reads its folder, and checks that it left no process, profile, server or state behind. */
export async function finishRun(started: StartedRun): Promise<FinishedRun> {
  const run = await readFinishedRun(started)
  await assertReleased(started.retest, run.events, started.output)
  return run
}

/** Starts a run and finishes it. */
export async function runRetest(t: TestContext, request: RunRequest): Promise<FinishedRun> {
  return finishRun(await startRun(t, request))
}

/**
 * Waits for the run to end and reads its folder, without checking what it left behind. Every passed assertion must
 * say who judged it (`assertJudged`).
 */
export async function readFinishedRun({ retest, output }: StartedRun): Promise<FinishedRun> {
  const exit = await retest.exited
  const events = existsSync(join(output, eventsFile)) ? readEvents(readFileSync(join(output, eventsFile), 'utf8')) : []
  for (const { pid, what } of reportedProcesses(events)) retest.ownGroup(pid, what)
  assertJudged(events)
  const result = existsSync(join(output, resultFile)) ? readResult(readFileSync(join(output, resultFile), 'utf8')) : undefined
  const { stdout, stderr, durationMs } = retest
  return { exit, stdout, stderr, durationMs, output, events, result }
}

/**
 * Checks who judged each passed assertion. A locator assertion is judged by the parent, on the look it names: an
 * `observation` the parent wrote earlier in the same attempt, for the same app and locator. A page assertion is judged
 * by the parent on a look at the page, which has no event of its own, so it names a look and records the page. A value
 * assertion's pass is the test process's claim, and names no look.
 */
export function assertJudged(events: readonly RetestEvent[]): void {
  for (const [index, event] of events.entries()) {
    if (event.type !== 'assertion.passed') continue
    const passed = `assertion.passed ${event.matcher} at sequence ${event.sequence}`
    if (event.locator === undefined && /^(not\.)?toHave(URL|Title)$/.test(event.matcher)) {
      assert.equal(event.judgedBy, 'parent', `${passed} was judged by the parent`)
      assert.match(event.observationId ?? '', /^o\d+$/, `${passed} names the look it rested on`)
      assert.ok(event.pageUrl !== undefined, `${passed} records the page it read`)
      continue
    }
    if (event.locator === undefined) {
      assert.deepEqual([event.judgedBy, event.observationId], ['child', undefined], `${passed} is the test process's claim`)
      continue
    }
    assert.equal(event.judgedBy, 'parent', `${passed} was judged by the parent`)
    const look = eventsOf(events.slice(0, index), 'observation').find(
      (earlier) => earlier.attemptId === event.attemptId && earlier.observationId === event.observationId,
    )
    assert.ok(look !== undefined, `${passed} names ${event.observationId}, a look the parent wrote earlier in its attempt`)
    assert.deepEqual([look.origin, look.session, look.locator], ['parent', event.session, event.locator], `${passed} rests on a look at its own locator`)
  }
}

/**
 * Checks that nothing the command started is left: no process in its own group (the test file processes), no
 * browser or app server process group it reported, nothing of Retest's in its temporary folder, such as a
 * browser profile, no process using that folder and, given the run folder, no saved sign-in state.
 */
export async function assertReleased(retest: RetestProcess, events: readonly RetestEvent[], output?: string): Promise<void> {
  await waitForGroupEnd(retest.pid, releaseWaitMs)
  assert.deepEqual(retestEntriesIn(retest.tmp), [], 'no browser profile or other Retest folder is left in the temporary folder')
  assert.deepEqual(await processesUsing(retest.tmp), [], 'no process uses the run temporary folder')
  for (const group of reportedGroups(events)) await waitForGroupEnd(group, releaseWaitMs)
  if (output !== undefined) assert.deepEqual(statesLeftIn(output), [], 'no saved sign-in state is left in the run folder')
}

/** The Retest browser profiles in a folder. */
export function profilesIn(folder: string): string[] {
  return readdirSync(folder).filter((name) => name.startsWith(profilePrefix))
}

/** Everything in a folder that Retest names as its own: browser profiles, and any other `retest-` folder or file. */
export function retestEntriesIn(folder: string): string[] {
  return readdirSync(folder).filter((name) => name.startsWith(retestPrefix))
}

/** The saved sign-in states a run folder still holds. A run deletes them when it ends. */
export function statesLeftIn(output: string): string[] {
  const folder = join(output, statesFolder)
  return existsSync(folder) ? readdirSync(folder, { recursive: true, encoding: 'utf8' }) : []
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

export type CommandRun = { exit: Exit; stdout: string; stderr: string }

/** Runs a `retest` command other than `run` to its end, and checks that it left nothing behind. */
export async function runCli(t: TestContext, args: readonly string[], options: Omit<StartOptions, 'args'> = {}): Promise<CommandRun> {
  const retest = await RetestProcess.start(t, { ...options, args })
  const exit = await retest.exited
  await assertReleased(retest, [])
  return { exit, stdout: retest.stdout, stderr: retest.stderr }
}

/** A host's run: what `finishRun` reads, and the result `runFiles` returned to the host, which it printed. */
export type HostRun = FinishedRun & { returned: RunResult }

export type HostRequest = {
  cwd: string
  /** The program and the arguments before the run folder, which comes last. */
  command: readonly string[]
  env?: Readonly<Record<string, string>>
}

/**
 * Starts a host's own program, one that calls `runFiles` itself, with a new run folder as its last argument, in its
 * own process group with its own temporary folder. Its stdout is the events its reporter received, as JSON lines, so
 * `waitForEvent` reads them as they arrive.
 */
export async function startHost(t: TestContext, request: HostRequest): Promise<StartedRun> {
  const output = join(await scratchFolder(t), 'run')
  const [executable = process.execPath, ...leading] = request.command
  const retest = await RetestProcess.start(t, { cwd: request.cwd, command: [executable], args: [...leading, output], env: request.env ?? {} })
  return { retest, output }
}

/** Runs a host's own program to its end, as `startHost` starts it and `finishHost` checks it. */
export async function runHost(t: TestContext, request: HostRequest): Promise<HostRun> {
  return finishHost(await startHost(t, request))
}

/**
 * Waits for a host's program to end. Besides what `finishRun` checks, stdout must be exactly the events its reporter
 * received, as JSON lines, and the result it printed on stderr as `result <json>` must be `result.json`.
 */
export async function finishHost(started: StartedRun): Promise<HostRun> {
  const run = await finishRun(started)
  assertStdoutIsEvents(run)
  const printed = /^result (.+)$/m.exec(run.stderr)?.[1]
  assert.ok(printed !== undefined, `the host printed the result runFiles returned. stderr:\n${run.stderr}`)
  const returned = parseLine(runResultSchema, printed, 'the result runFiles returned')
  assert.deepEqual(returned, resultOf(run), 'the result runFiles returned is result.json')
  assert.equal(run.exit.code, returned.exitCode, 'the host exits with the run exit code')
  return { ...run, returned }
}

export type HostScript = {
  /** The object `defineConfig` receives, as TypeScript source. */
  config: string
  files: readonly string[]
  /** More `RunOptions`, as TypeScript source, such as `hostChecks: { ... }`. */
  options?: string
}

/**
 * The source of a host's script, which imports Retest by its package name: it builds `config` in memory, validates
 * it under a label with no file behind it, resolves its secrets, and runs `files` from the project folder with short
 * budgets and `options`. Its reporter prints each event as a JSON line as it arrives, and at the end it prints the
 * result `runFiles` returned, as `runHost` reads them, and exits with the run's exit code.
 */
export function hostScript(script: HostScript): string {
  return `import type { Reporter } from '@rehearsal-labs/retest/runner'
import { chrome, defineConfig } from '@rehearsal-labs/retest'
import { resolveSecrets, runFiles, validateConfig } from '@rehearsal-labs/retest/runner'

const outputDir = process.argv.at(-1) ?? ''
const loaded = validateConfig(defineConfig(${script.config}), \`\${process.cwd()}/host.config.ts\`)
if (!loaded.ok) throw new Error(loaded.failure.message)
const secrets = resolveSecrets(loaded.config, {})
if (!secrets.ok) throw new Error(secrets.failure.message)
const reporter: Reporter = {
  name: 'host',
  onEvent: (event) => void process.stdout.write(\`\${JSON.stringify(event)}\\n\`),
  onRunEnd: () => undefined,
}
const result = await runFiles(
  {
    files: ${JSON.stringify(script.files)},
    rootDir: process.cwd(),
    apps: { kind: 'config', config: loaded.config, secrets: secrets.secrets },
    timeouts: ${JSON.stringify(shortBudgets)},
    outputDir,
    headless: true,
    signal: new AbortController().signal,
    ${script.options ?? ''}
  },
  [reporter],
)
process.stderr.write(\`result \${JSON.stringify(result)}\\n\`)
process.exitCode = result.exitCode
`
}

const defaultSecondBrowser = join(
  homedir(),
  'Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
)

/**
 * The second browser the milestone 2 checks run on, a plain Chromium build: `RETEST_TEST_SECOND_BROWSER`, or
 * Chrome for Testing where it was unpacked on the machine the checks were written on. Never skipped.
 */
export function secondBrowserPath(): string {
  const configured = process.env['RETEST_TEST_SECOND_BROWSER']
  if (configured) return configured
  if (existsSync(defaultSecondBrowser)) return defaultSecondBrowser
  throw new Error(`No second browser to test with: set RETEST_TEST_SECOND_BROWSER, or unpack Chrome for Testing at ${defaultSecondBrowser}`)
}

const versions = new Map<string, string>()

/**
 * The version a browser gives for itself with `--version`, such as `154.0.8037.92`. It is read without Retest,
 * so a check can hold what Retest reports against it, whichever builds the machine has.
 */
export function browserVersion(executablePath: string): string {
  const known = versions.get(executablePath)
  if (known !== undefined) return known
  const printed = execFileSync(executablePath, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 })
  const version = /\b\d+\.\d+\.\d+\.\d+\b/.exec(printed)?.[0]
  assert.ok(version !== undefined, `${executablePath} --version printed no version: ${printed}`)
  versions.set(executablePath, version)
  return version
}

export type ProjectFiles = Readonly<Record<string, string>>

/**
 * A project outside the repository, removed after the test, whose files import Retest by its package name. The
 * name leads to this checkout, so a run from source loads its source.
 */
export async function writeProject(t: TestContext, files: ProjectFiles): Promise<string> {
  const root = await scratchFolder(t, 'retest-project-')
  await writeFiles(root, files)
  await linkPackage(root, '@rehearsal-labs/retest', repositoryRoot)
  return root
}

/** Writes each file under `root`, making its folders. */
export async function writeFiles(root: string, files: ProjectFiles): Promise<void> {
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), text)
  }
}

/** Makes a package installed elsewhere visible in a project's `node_modules`, without installing anything. */
export async function linkPackage(root: string, name: string, target: string): Promise<void> {
  const link = join(root, 'node_modules', name)
  await mkdir(dirname(link), { recursive: true })
  await symlink(target, link, 'dir')
}

/** A `retest.config.ts` whose default export is `defineConfig(body)`, with every constructor imported. */
export function configSource(body: string): string {
  return `import { app, chrome, chromium, defineConfig, env } from '@rehearsal-labs/retest'\n\nexport default defineConfig(${body})\n`
}

export type ProjectRunRequest = Omit<RunRequest, 'cwd' | 'browser' | 'files'> & { files?: readonly string[] }

/**
 * Runs a project from the config in its root, every test file under it unless `files` names some, and checks
 * that JSONL output is exactly the run's events, besides what `finishRun` checks.
 */
export async function runProject(t: TestContext, root: string, request: ProjectRunRequest = {}): Promise<FinishedRun> {
  const run = await runRetest(t, { ...request, files: request.files ?? [], cwd: root, browser: false })
  if ((request.reporter ?? 'jsonl') === 'jsonl') assertStdoutIsEvents(run)
  return run
}

/** Checks that stdout, as the JSONL reporter printed it, is every event of `events.jsonl`, each line valid. */
export function assertStdoutIsEvents(run: FinishedRun): void {
  assert.ok(run.stdout === '' || run.stdout.endsWith('\n'), 'stdout ends with a whole line')
  const printed = completeLines(run.stdout).map((line, index) => parseLine(retestEventSchema, line, `stdout line ${index + 1}`))
  assert.deepEqual(printed, run.events, 'stdout carries exactly the events in events.jsonl')
}

/** The results of the tests with this name, one for each variant that ran, in the order they ran. */
export function resultsNamed(run: FinishedRun, name: string): TestResult[] {
  const found = resultOf(run).files.flatMap((file) => file.tests).filter((test) => test.name === name)
  assert.ok(found.length > 0, `a test named ${JSON.stringify(name)} is in the result`)
  return found
}

/** The forms a secret could be written in: as it is, and as a URL or a form encodes it. */
function writtenForms(value: string): Buffer[] {
  return [...new Set([value, encodeURIComponent(value), value.replaceAll(' ', '+')])].map((form) => Buffer.from(form))
}

/** Every file under `folder` that holds `value` in any form it could be written in, as paths relative to it. */
export function filesHolding(folder: string, value: string): string[] {
  const forms = writtenForms(value)
  return readdirSync(folder, { recursive: true, encoding: 'utf8' }).filter((path) => {
    const file = join(folder, path)
    if (!statSync(file).isFile()) return false
    const bytes = readFileSync(file)
    return forms.some((form) => bytes.includes(form))
  })
}

/** Whether `text` holds `value` in any form it could be written in. */
export function textHolds(text: string, value: string): boolean {
  const bytes = Buffer.from(text)
  return writtenForms(value).some((form) => bytes.includes(form))
}

/** A loopback port nothing listens on at the moment it is returned. */
export async function freePort(): Promise<number> {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address !== null && typeof address === 'object')
  await new Promise<void>((resolve, reject) => server.close((error) => (error === undefined ? resolve() : reject(error))))
  return address.port
}

/** Whether an HTTP server answers at `url` within a second. */
export async function answersAt(url: string): Promise<boolean> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(1000) })
    return true
  } catch {
    return false
  }
}

const appServerScript = join(repositoryRoot, 'fixtures/app-server/cli.ts')

export type AppServerFlags = { delayMs?: number; neverListen?: boolean; ignoreTerm?: boolean; child?: boolean; printEnv?: string }

function appServerArgs(port: number, flags: AppServerFlags): string[] {
  return [
    appServerScript,
    '--port',
    String(port),
    ...(flags.delayMs === undefined ? [] : ['--delay-ms', String(flags.delayMs)]),
    ...(flags.neverListen === true ? ['--never-listen'] : []),
    ...(flags.ignoreTerm === true ? ['--ignore-term'] : []),
    ...(flags.child === true ? ['--child'] : []),
    ...(flags.printEnv === undefined ? [] : ['--print-env', flags.printEnv]),
  ]
}

/** The shell command that starts `fixtures/app-server` on `port`, for a config's `start.command`. */
export function appServerCommand(port: number, flags: AppServerFlags = {}): string {
  return [process.execPath, ...appServerArgs(port, flags)].map((word) => `'${word.replaceAll("'", `'\\''`)}'`).join(' ')
}

/** The lines of `ps` for `fixtures/app-server` on `port`, and for the child process it starts with `--child`. */
export async function appServersOn(port: number): Promise<string[]> {
  return (await processesUsing(`--port ${port}`)).filter((line) => line.includes('app-server'))
}

/**
 * Starts `fixtures/app-server` on `port` as a process group of this test's own, and waits until it listens.
 * It is killed after the test if it is still there, through the record this test made of its launch.
 */
export async function startAppServerFixture(t: TestContext, port: number): Promise<{ pid: number; url: string }> {
  const child = spawn(process.execPath, appServerArgs(port, {}), { detached: true, stdio: ['ignore', 'pipe', 'ignore'] })
  await once(child, 'spawn')
  const { pid } = child
  assert.ok(pid !== undefined, 'the app server did not start')
  const ownership = new OwnedProcessGroup(pid)
  ownership.capture()
  t.after(() => {
    if (ownership.remains()) assert.deepEqual(ownership.signalReport('SIGKILL').problems, [], 'the app server this test started was ended')
  })
  let printed = ''
  child.stdout.setEncoding('utf8').on('data', (text: string) => {
    printed += text
  })
  const url = `http://127.0.0.1:${port}`
  await waitFor(`the app server listening on ${url}`, () => printed.includes(`listening on ${url}`))
  return { pid, url }
}

export type ProgramRun = { code: number; stdout: string; stderr: string }

/** Runs a program to its end and keeps what it printed. A program that could not run has a code of 1. */
export function runProgram(file: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<ProgramRun> {
  return new Promise((resolve) => {
    execFile(file, args, { cwd, env, maxBuffer: 16 * 1024 * 1024 }, (error: ExecFileException | null, stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1
      resolve({ code, stdout, stderr })
    })
  })
}

export function assertSucceeded(result: ProgramRun, what: string): void {
  assert.equal(result.code, 0, `${what} failed:\n${result.stdout}\n${result.stderr}`)
}

/** The two TypeScript compilers every type check runs on. */
export const compilers: Readonly<Record<string, string>> = {
  'TypeScript 6': join(repositoryRoot, 'node_modules/typescript/bin/tsc'),
  'TypeScript 7': join(repositoryRoot, 'node_modules/typescript-7/bin/tsc'),
}

/** Type-checks a project with one compiler. */
export function typecheck(compiler: string, project: string, tsconfig = 'tsconfig.json'): Promise<ProgramRun> {
  return runProgram(process.execPath, [compiler, '-p', tsconfig, '--pretty', 'false'], project)
}

export type Packed = { tarball: string; npmEnv: NodeJS.ProcessEnv }

/**
 * Builds Retest and packs it into `folder`, with an npm cache of its own there, which keeps every install away
 * from the person's cache.
 */
export async function packRetest(folder: string): Promise<Packed> {
  const pack = join(folder, 'pack')
  await mkdir(pack, { recursive: true })
  const npmEnv = { ...process.env, npm_config_cache: join(folder, 'npm-cache'), npm_config_update_notifier: 'false' }
  assertSucceeded(await runProgram('npm', ['run', 'build'], repositoryRoot, npmEnv), 'npm run build')
  assertSucceeded(await runProgram('npm', ['pack', '--pack-destination', pack], repositoryRoot, npmEnv), 'npm pack')
  const [tarball, ...others] = readdirSync(pack)
  assert.ok(tarball !== undefined && others.length === 0, 'npm pack made one tarball')
  return { tarball: join(pack, tarball), npmEnv }
}

/** Installs the packed tarball into a project with no network. */
export async function installPacked(project: string, packed: Packed): Promise<void> {
  const install = ['install', '--offline', '--no-audit', '--no-fund', packed.tarball]
  assertSucceeded(await runProgram('npm', install, project, packed.npmEnv), 'npm install --offline')
}

/**
 * Makes this checkout's Node types visible to a project, as `npm i -D @types/node` would, since installing them
 * would need the network. TypeScript follows the link, so their own dependencies resolve here too.
 */
export function linkNodeTypes(project: string): Promise<void> {
  return linkPackage(project, '@types/node', join(repositoryRoot, 'node_modules/@types/node'))
}
