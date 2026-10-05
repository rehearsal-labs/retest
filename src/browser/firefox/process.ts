import type { ChildProcess } from 'node:child_process'
import type { OwnedProcessIdentity } from '../../shared/process-ownership.ts'
import type { ProcessExit } from '../../shared/process-exit.ts'
import type { OutputRedactor } from '../contract.ts'
import type { FirefoxRoute } from './route.ts'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { rmSync } from 'node:fs'
import { appendFile, mkdir, open, readFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { setTimeout as sleep } from 'node:timers/promises'
import { waitBeforeRead } from '../../assertions/wait-before-read.ts'
import { promisify } from 'node:util'
import { Deadline } from '../../protocol/deadline.ts'
import { errorMessage } from '../../protocol/failures.ts'
import { s, parse } from '../../protocol/schema.ts'
import { describeExit } from '../../shared/process-exit.ts'
import { OwnedProcessGroup } from '../../shared/process-ownership.ts'
import { closeGraceMs, LaunchError } from '../contract.ts'
import { writeRedactedLog } from '../redacted-log.ts'
import { ownerIdentityAsync, writeOwnerRecord } from './profile.ts'
import { isRunning, readProcessTable, readProcessIdentityAsync, readProcessIdentity, readProcessLivenessAsync, readProcessTableAsync } from './process-table.ts'

export type FirefoxStart = {
  /** The absolute path of the Firefox executable, such as `/Applications/Firefox.app/Contents/MacOS/firefox`. */
  executable: string
  route: FirefoxRoute
  headless: boolean
  /** The launch's own folder, which holds the profile; removed when the process stops. */
  folder: string
  profile: string
  /** Receives Firefox's stdout and stderr: as Firefox writes them on the spawn route, after the process ends on the other. */
  logFile: string
  hiddenVariables?: readonly string[]
  redact?: (text: string) => string
  redactStream?: () => OutputRedactor
  deadline: Deadline
}

const pollMs = 20
// How often the Launch Services route reads the process table for a Firefox whose connection still stands. The
// connection's end is the usual sign that the browser went; this rare look, taken without holding the thread, is for a
// Firefox that went without closing it, and a look every `pollMs * 5` follows once the connection ended.
const mainPollMs = 1000
// Where the Launch Services route sends Firefox's output: inside the launch's own folder, since Firefox opens the file
// under its own privacy grants, which may refuse a run folder in a protected place such as Documents.
const rawOutputFile = 'firefox-output.log'
// Kept out of the environment so a crash never opens Mozilla's crash reporter window on the person's screen.
const crashReporterOff = { MOZ_CRASHREPORTER_DISABLE: '1' }
const serverFileSchema = s.object({ ws_host: s.string(), ws_port: s.number({ integer: true, min: 1 }) })

/**
 * A Firefox this launch started: the leader of its own process group, with the launch's folder, which holds its
 * profile. Ownership is recorded as the shared process ownership records a Chromium browser: the launched process,
 * claimed through its parent (this process on the spawn route, launchd on the other), and every descendant seen beneath
 * it; nothing is ever signalled without a fresh check of its identity, and nothing merely sharing its group is claimed.
 * The launch writes an owner record into the folder, so a later launch can end this Firefox if this process dies
 * without closing it.
 */
export class FirefoxProcess {
  readonly pid: number
  readonly route: FirefoxRoute
  readonly folder: string
  readonly profile: string
  /** Settles once the main process has exited; with its exit status on the spawn route, where it is this process's child. */
  readonly exited: Promise<ProcessExit | undefined>
  /** Settles once every line of Firefox's output reached the log, or could not. */
  readonly outputSettled: Promise<void>
  readonly #ownership: OwnedProcessGroup
  readonly #ownershipProblems: string[] = []
  readonly #lastResort: () => void
  readonly #outputClosed: Promise<string[]>
  readonly #cancelOutput: (() => void) | undefined
  readonly #copyOutput: (() => Promise<string[]>) | undefined
  readonly #table: ProcessTable
  readonly #startedAt: string | undefined
  #exit: ProcessExit | undefined
  #mainGone = false
  #exitExpected = false
  #wakeLook: (() => void) | undefined
  #stopping: Promise<string[]> | undefined
  #gone: Promise<void> | undefined

  /** Made by `start` once a route has claimed the process; never by a caller. */
  constructor(fields: ClaimedFirefox) {
    this.pid = fields.pid
    this.route = fields.route
    this.folder = fields.folder
    this.profile = fields.profile
    this.#ownership = fields.ownership
    this.#outputClosed = fields.output
    this.#copyOutput = fields.copyOutput
    this.#cancelOutput = fields.cancelOutput
    this.#table = fields.table ?? { readAsync: readProcessTableAsync }
    this.#startedAt = fields.startedAt
    const { child } = fields
    this.exited = child === undefined ? this.#pollMainExit() : new Promise((resolve) => {
      const exited = (code: number | null, signal: NodeJS.Signals | null): void => {
        this.#exit = { code, signal }
        this.#mainGone = true
        resolve(this.#exit)
      }
      if (child.exitCode !== null || child.signalCode !== null) exited(child.exitCode, child.signalCode)
      else child.once('exit', exited)
    })
    const copied = Promise.withResolvers<void>()
    this.#settleCopied = copied.resolve
    this.outputSettled = this.#copyOutput === undefined ? this.#outputClosed.then(() => undefined) : copied.promise
    this.#lastResort = () => killAtExit(this.#ownership, this.folder)
    process.on('exit', this.#lastResort)
  }

  readonly #settleCopied: () => void

  /**
   * Starts Firefox by the route asked for, claims its process and writes the folder's owner record. A start that fails
   * ends what it started, with a `LaunchError` that says why.
   *
   * @example const firefox = await FirefoxProcess.start({ executable, route: 'spawn', headless: true, folder, profile, logFile, deadline })
   */
  static async start(options: FirefoxStart): Promise<FirefoxProcess> {
    const owner = await ownerIdentityAsync()
    const started = options.route === 'spawn' ? await spawnFirefox(options) : await openFirefox(options)
    const record = started.identity
    try {
      await writeOwnerRecord(options.folder, { version: 1, startTimeVersion: 1, owner, firefox: { pid: record.pid, startedAt: record.startedAt, command: record.command, route: options.route }, profile: options.profile })
    } catch (error) {
      const problems = await started.stop(0)
      throw new LaunchError(`Could not record the launched Firefox in ${options.folder}: ${errorMessage(error)}.${problems.length === 0 ? '' : ` Cleaning up also failed: ${problems.join(' ')}`}`, { cause: error, failureClass: problems.length === 0 ? 'setup_failed' : 'cleanup_failed' })
    }
    return started.process
  }

  /** How the main process ended, when it is this process's child and has exited. */
  get exit(): ProcessExit | undefined {
    return this.#exit
  }

  /** True once the main process has exited. */
  get mainGone(): boolean {
    return this.#mainGone
  }

  /**
   * Records the processes Firefox started since the last look, while it is still there to be their parent, from a
   * reading that does not hold the thread.
   */
  async recordDescendants(deadline?: Deadline): Promise<void> {
    for (const problem of await this.#ownership.captureAsync(deadline)) if (!this.#ownershipProblems.includes(problem)) this.#ownershipProblems.push(problem)
  }

  /**
   * Tells the process that its browser's connection ended, or that Retest asked it to close, so the Launch Services
   * route looks for its exit often from now on rather than rarely.
   */
  expectExit(): void {
    this.#exitExpected = true
    this.#wakeLook?.()
  }

  /** Ends only freshly verified recorded processes, for tests that deliberately lose this browser. */
  crash(): void {
    this.expectExit()
    // End the browser first. Ending its content processes first lets the still-live Remote Agent answer an input
    // with a protocol error before the browser connection is lost. Every signal still needs a fresh owned identity.
    const problems: string[] = []
    const browser = this.#ownership.verifiedIdentity()
    if (browser !== undefined) {
      try { process.kill(browser.pid, 'SIGKILL') }
      catch (error) { problems.push(`Could not end the recorded Firefox process ${browser.pid}: ${errorMessage(error)}`) }
    }
    problems.push(...this.#ownership.signalNow('SIGKILL'))
    if (problems.length > 0) throw new Error(problems.join(' '))
  }

  /**
   * Waits for the WebDriver BiDi address Firefox writes into its profile once its Remote Agent listens, and returns
   * it, such as `ws://127.0.0.1:50928`. Fails when the process ends first or the deadline passes.
   */
  async waitForAddress(deadline: Deadline): Promise<string> {
    const file = join(this.profile, 'WebDriverBiDiServer.json')
    for (;;) {
      const finalRead = deadline.reached
      const text = await readFile(file, 'utf8').catch((error: unknown) => {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
        throw error
      })
      const value = text === undefined ? undefined : parseJson(text)
      const parsed = value === undefined ? undefined : parse(serverFileSchema, value)
      if (parsed?.ok === true) return `ws://${parsed.value.ws_host}:${parsed.value.ws_port}`
      if (this.#mainGone) throw new LaunchError(`Firefox started by the ${this.route} route ${this.#exit === undefined ? 'exited' : `exited with ${describeExit(this.#exit)}`} before its Remote Agent listened.`)
      if (finalRead) throw new LaunchError(`Firefox started by the ${this.route} route did not start its Remote Agent within ${deadline.budgetMs} ms.`)
      await waitBeforeRead(deadline, pollMs)
    }
  }

  /** Settles once the main process has exited, no recorded process is left and its output is in the log. */
  gone(): Promise<void> {
    this.#gone ??= this.#awaitGone()
    return this.#gone
  }

  async #awaitGone(): Promise<void> {
    await this.exited
    await this.recordDescendants()
    while (!(await this.#helpersGone())) await sleep(pollMs * 5, undefined, { ref: false })
    await this.outputSettled
  }

  /**
   * Waits up to `graceMs` for the main process and every recorded one to end, kills the recorded ones still there after
   * a fresh check of each identity, waits up to `closeGraceMs` more, copies the output of the Launch Services route into
   * the log, and removes the folder once nothing of it is left. Resolves with what could not be cleaned up. A second
   * call waits for the first.
   */
  stop(graceMs: number, deadline: Deadline = new Deadline(graceMs + 2 * closeGraceMs)): Promise<string[]> {
    this.#stopping ??= this.#stop(graceMs, deadline)
    return this.#stopping
  }

  async #stop(graceMs: number, deadline: Deadline): Promise<string[]> {
    this.expectExit()
    await this.recordDescendants(deadline)
    const problems: string[] = [...this.#ownershipProblems]
    try {
      if (!(await this.#ended(new Deadline(graceMs), deadline))) {
        if (!this.#mainGone) await this.recordDescendants(deadline)
        const report = await this.#ownership.signalReportAsync('SIGKILL', deadline)
        problems.push(...report.problems, ...report.identityRefusals)
        if (!(await this.#ended(new Deadline(closeGraceMs), deadline))) problems.push(`Firefox's process group ${this.pid} could not be confirmed ended ${closeGraceMs} ms after SIGKILL.`)
      }
    } catch (error) {
      problems.push(`Could not end Firefox's process group ${this.pid}: ${errorMessage(error)}`)
    }
    if (!(await settlesWithin(this.#outputClosed, new Deadline(closeGraceMs)))) {
      problems.push("Firefox's output did not close within the cleanup bound.")
      this.#cancelOutput?.()
    }
    problems.push(...(await this.#outputClosed))
    if (this.#copyOutput !== undefined) problems.push(...(await this.#copyOutput()))
    this.#settleCopied()
    if (!(await this.#ownership.remainsAsync(deadline))) {
      await rm(this.folder, { recursive: true, force: true, maxRetries: 3 }).catch((error: unknown) => {
        problems.push(`Could not remove the Firefox folder ${this.folder}: ${errorMessage(error)}`)
      })
    } else problems.push(`The Firefox folder ${this.folder} was kept, since the launch could not be confirmed ended.`)
    const remains = await this.#ownership.remainsAsync(deadline)
    if (!remains) process.off('exit', this.#lastResort)
    return [...new Set([...problems, ...this.#ownership.readProblems])]
  }

  // The main process's exit is awaited, not polled; then the helpers it leaves are looked for without holding the
  // thread, and the ownership's own reading, which does, is asked only once no process of the group is seen.
  async #ended(wait: Deadline, deadline: Deadline): Promise<boolean> {
    if (!this.#mainGone && !(await settlesWithin(this.exited, new Deadline(Math.min(wait.remainingMs, deadline.remainingMs))))) return false
    for (;;) {
      if (await this.#helpersGone(deadline)) return true
      if (wait.reached || deadline.reached) return false
      await sleep(Math.min(pollMs * 5, wait.remainingMs, deadline.remainingMs))
    }
  }

  async #helpersGone(deadline?: Deadline): Promise<boolean> {
    return !(await this.#ownership.remainsAsync(deadline))
  }

  // On the Launch Services route Firefox is not this process's child, so nothing tells of its exit: it is looked for in
  // the process table, rarely while its connection stands and often once it ended, from readings that never hold the
  // thread the BiDi connection and every deadline run on.
  async #pollMainExit(): Promise<undefined> {
    for (;;) {
      let present: boolean
      try {
        // A pid is the launched Firefox only while it keeps the start time recorded at launch: one the system gave
        // to another process after Firefox exited is not Firefox still running.
        const startedAt = this.#startedAt
        present = (await (this.#table.watchAsync?.() ?? this.#table.readAsync())).some((entry) => entry.pid === this.pid && isRunning(entry) && (startedAt === undefined || entry.startedAt === startedAt))
      } catch {
        // A table that cannot be read says nothing; the next look decides.
        present = true
      }
      if (!present) {
        this.#mainGone = true
        return undefined
      }
      await this.#nextLook()
    }
  }

  #nextLook(): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>()
    const timer = setTimeout(resolve, this.#exitExpected ? pollMs * 5 : mainPollMs)
    timer.unref()
    this.#wakeLook = () => {
      clearTimeout(timer)
      resolve()
    }
    return promise.finally(() => {
      this.#wakeLook = undefined
    })
  }
}

/** How the process looks for a Firefox that is not its child: the process table, read without holding the thread. */
export type ProcessTable = {
  readAsync(): Promise<readonly OwnedProcessIdentity[]>
  /** Kernel liveness facts only, never used to claim ancestry or authorize a signal. */
  watchAsync?(): Promise<readonly OwnedProcessIdentity[]>
  /** Checks every recorded pid's birth and every group member without changing recorded commands. */
  endedAsync?(): Promise<boolean>
}

// Whether `promise` settles before the deadline passes.
async function settlesWithin(promise: Promise<unknown>, deadline: Deadline): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), deadline.remainingMs)
  })
  try {
    return await Promise.race([promise.then(() => true), late])
  } finally {
    clearTimeout(timer)
  }
}

/** A process a route claimed: its id, folder and profile, its ownership, its child handle on the spawn route, and its output. */
type ClaimedFirefox = {
  pid: number
  route: FirefoxRoute
  folder: string
  profile: string
  ownership: OwnedProcessGroup
  child: ChildProcess | undefined
  /** Settles once the output that goes through Retest, or straight to the log, is done, with what went wrong. */
  output: Promise<string[]>
  /** Copies output the route left in a file of its own into the log, once the process is gone. */
  copyOutput?: () => Promise<string[]>
  cancelOutput?: () => void
  /** The process table the Launch Services route watches; the host's own unless a test gives one. */
  table?: ProcessTable
  /** When the claimed process started, as the launch recorded it, which tells it from a later process with its pid. */
  startedAt?: string
}

type Started = { process: FirefoxProcess; identity: OwnedProcessIdentity; stop(graceMs: number): Promise<string[]> }

/** The arguments both routes start Firefox with: a fresh profile, and the BiDi server on a port the system picks. */
export function firefoxArguments(profile: string, headless: boolean): string[] {
  return [...(headless ? ['--headless'] : []), '--no-remote', '--profile', profile, '--remote-debugging-port=0', 'about:blank']
}

async function spawnFirefox(options: FirefoxStart): Promise<Started> {
  const { executable, profile, folder, logFile, redact, redactStream } = options
  const log = await openLog(logFile)
  let logHandedOn = false
  try {
    const hidden = new Set(options.hiddenVariables)
    const environment = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !hidden.has(name))), ...crashReporterOff }
    // Output to redact comes through Retest; any other goes straight to the log.
    const redacting = redact !== undefined || redactStream !== undefined
    const child = spawn(executable, firefoxArguments(profile, options.headless), { env: environment, detached: true, stdio: ['ignore', redacting ? 'pipe' : log.fd, redacting ? 'pipe' : log.fd] })
    await once(child, 'spawn').catch((error: unknown) => {
      throw new LaunchError(`Cannot start ${executable}: ${errorMessage(error)}`, { cause: error })
    })
    const { ownership, table } = await claimOwnership(child.pid ?? 0, process.pid)
    const ownershipProblems = ownership.capture()
    // Without redaction Firefox writes to the log itself, until it exits.
    let output: Promise<string[]> = child.exitCode !== null || child.signalCode !== null ? Promise.resolve([]) : new Promise((resolve) => child.once('exit', () => resolve([])))
    let cancelOutput: (() => void) | undefined
    if (redacting) {
      const streams = [child.stdout, child.stderr].flatMap((stream) => (stream instanceof Readable ? [stream] : []))
      const writer = writeRedactedLog(streams, log, redact ?? ((text) => text), redactStream)
      output = writer.closed
      cancelOutput = writer.cancel
      logHandedOn = true
    }
    const firefox = new FirefoxProcess({ pid: child.pid ?? 0, route: 'spawn', folder, profile, ownership, table, child, output, ...(cancelOutput === undefined ? {} : { cancelOutput }) })
    if (!redacting) {
      logHandedOn = true
      await log.close().catch(() => undefined)
    }
    const identity = ownership.verifiedIdentity()
    if (ownershipProblems.length > 0 || identity === undefined) {
      const problems = await firefox.stop(0)
      throw new LaunchError(`Could not record the launched Firefox's ownership: ${[...ownershipProblems, ...problems].join(' ') || 'it was gone before Retest could read it.'}`, { failureClass: problems.length > 0 ? 'cleanup_failed' : 'setup_failed' })
    }
    return { process: firefox, identity, stop: (graceMs) => firefox.stop(graceMs) }
  } finally {
    if (!logHandedOn) await log.close().catch(() => undefined)
  }
}

/**
 * Starts the app bundle the executable belongs to through Launch Services, always as a new instance, in the background
 * and hidden. `open` returns once the app is launched without naming it, so the process is found by the profile in its
 * command line, which only this launch uses, and claimed through launchd, its parent, only when it leads a process group
 * of its own.
 */
async function openFirefox(options: FirefoxStart): Promise<Started> {
  const { executable, profile, folder, deadline } = options
  const bundle = /^(.+?\.app)\/Contents\/MacOS\/[^/]+$/.exec(executable)?.[1]
  if (bundle === undefined) throw new LaunchError(`${executable} is not inside a macOS app bundle, so Launch Services cannot start it. Use the spawn route.`)
  const raw = join(folder, rawOutputFile)
  const environment = Object.entries(crashReporterOff).flatMap(([name, value]) => ['--env', `${name}=${value}`])
  const openArgs = ['-n', '-g', '-j', '-a', bundle, '--stdout', raw, '--stderr', raw, ...environment, '--args', ...firefoxArguments(profile, options.headless)]
  try {
    await promisify(execFile)('/usr/bin/open', openArgs, { timeout: deadline.commandTimeoutMs, env: { PATH: '/usr/bin:/bin', HOME: process.env['HOME'] ?? '' } })
  } catch (error) {
    // `open` may have started the app before it gave up; whatever uses the profile is this launch's.
    await endByProfile(profile)
    throw new LaunchError(`/usr/bin/open did not finish starting ${bundle}: ${errorMessage(error)}`, { cause: error })
  }
  const found = await findByProfile(profile, deadline)
  if (found === undefined) {
    await endByProfile(profile)
    throw new LaunchError(`${bundle} was opened, but no process using the profile ${profile} appeared within the launch budget.`)
  }
  const { ownership, table } = await claimOwnership(found.pid, found.parentPid)
  const ownershipProblems = ownership.capture()
  const copyOutput = (): Promise<string[]> => copyRawOutput(raw, options)
  const identity = ownership.verifiedIdentity()
  const firefox = new FirefoxProcess({ pid: found.pid, route: 'launch-services', folder, profile, ownership, table, child: undefined, output: Promise.resolve([]), copyOutput, ...(identity === undefined ? {} : { startedAt: identity.startedAt }) })
  if (found.groupId !== found.pid || ownershipProblems.length > 0 || identity === undefined) {
    const reason = found.groupId !== found.pid ? `it started in process group ${found.groupId}, not a group of its own` : [...ownershipProblems].join(' ') || 'it was gone before Retest could read it'
    const problems = await firefox.stop(0)
    throw new LaunchError(`Could not claim the Firefox Launch Services started, ${found.pid}: ${reason}.${problems.length === 0 ? '' : ` ${problems.join(' ')}`}`, { failureClass: problems.length > 0 ? 'cleanup_failed' : 'setup_failed' })
  }
  return { process: firefox, identity, stop: (graceMs) => firefox.stop(graceMs) }
}

// The main process names the profile with two dashes; its child processes name it with one, so they never match.
function usesProfile(command: string, profile: string): boolean {
  return command.includes(` --profile ${profile} `) || command.endsWith(` --profile ${profile}`)
}

async function findByProfile(profile: string, deadline: Deadline): Promise<OwnedProcessIdentity | undefined> {
  for (;;) {
    let found: OwnedProcessIdentity | undefined
    try {
      found = (await readProcessTableAsync(deadline)).find((entry) => isRunning(entry) && usesProfile(entry.command, profile) && !entry.command.startsWith('/usr/bin/open '))
    } catch {
      found = undefined
    }
    if (found !== undefined) return found
    if (deadline.expired) return undefined
    await sleep(Math.min(pollMs, deadline.remainingMs))
  }
}

// A failed Launch Services start may still bring Firefox up a moment later. Its profile is unique to this launch, so a
// process naming it is this launch's; it is claimed through its own parent and ended with the identity check.
async function endByProfile(profile: string): Promise<void> {
  const deadline = new Deadline(closeGraceMs)
  const found = await findByProfile(profile, new Deadline(Math.min(500, deadline.remainingMs)))
  if (found === undefined) return
  const { ownership } = await claimOwnership(found.pid, found.parentPid)
  ownership.capture(deadline)
  await ownership.signalReportAsync('SIGKILL', deadline)
  while (!deadline.expired) {
    if (!(await ownership.remainsAsync(deadline))) break
    await sleep(pollMs)
  }
}

// Whole-table readings are awaited. The shared owner consumes that snapshot to record ancestry and liveness;
// immediately before each signal it still reads the one recorded pid fresh, within the same cleanup budget.
async function claimOwnership(pid: number, parentPid: number): Promise<{ ownership: OwnedProcessGroup; table: ProcessTable }> {
  const table: ProcessTable = { readAsync: readProcessTableAsync, watchAsync: readProcessLivenessAsync }
  const ownership = new OwnedProcessGroup(pid, parentPid, {
    read: readProcessTable,
    readAsync: readProcessTableAsync,
    readProcess: readProcessIdentity,
    readProcessAsync: readProcessIdentityAsync,
    signal: (recordedPid, signal) => { process.kill(recordedPid, signal) },
  })
  return { ownership, table }
}

async function copyRawOutput(raw: string, { logFile, redact, redactStream }: FirefoxStart): Promise<string[]> {
  let text: string
  try {
    text = await readFile(raw, 'utf8')
  } catch {
    return []
  }
  if (text === '') return []
  try {
    const redactor = redactStream?.()
    const lines = text.endsWith('\n') ? text : `${text}\n`
    const written = redactor !== undefined ? redactor.write(lines) + redactor.end() : lines.split('\n').map((line) => (redact === undefined ? line : redact(line))).join('\n')
    await mkdir(dirname(logFile), { recursive: true })
    await appendFile(logFile, written)
    return []
  } catch (error) {
    return [`Could not copy Firefox's output into ${logFile}: ${errorMessage(error)}`]
  }
}

async function openLog(logFile: string) {
  try {
    await mkdir(dirname(logFile), { recursive: true })
    return await open(logFile, 'a')
  } catch (error) {
    throw new LaunchError(`Cannot open the browser log ${logFile}: ${errorMessage(error)}`, { cause: error })
  }
}

function parseJson(text: string): unknown {
  try {
    const value: unknown = JSON.parse(text)
    return value
  } catch {
    return undefined
  }
}

// Runs while this process exits normally, when a failure can neither be awaited nor reported. SIGKILL skips it, which
// is why every launch first ends the Firefoxes of launchers that are gone.
function killAtExit(ownership: OwnedProcessGroup, folder: string): void {
  try {
    ownership.signalNow('SIGKILL')
    if (!ownership.remains()) rmSync(folder, { recursive: true, force: true, maxRetries: 3 })
  } catch {
    // Throwing here would replace the exit code Retest chose.
  }
}
