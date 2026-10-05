import type { ChildProcess } from 'node:child_process'
import type { OwnedProcessIdentity, ProcessOwnershipSystem } from '../../shared/process-ownership.ts'
import type { ProcessExit } from '../../shared/process-exit.ts'
import type { PipeStreams } from '../cdp/transport.ts'
import type { BrowserOutput } from '../chromium-process.ts'
import type { OutputRedactor } from '../contract.ts'
import type { WebKitBuild } from './build.ts'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { rmSync } from 'node:fs'
import { mkdir, mkdtemp, open, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { setTimeout as sleep } from 'node:timers/promises'
import { Deadline } from '../../protocol/deadline.ts'
import { errorMessage } from '../../protocol/failures.ts'
import { readMetadataProcess } from '../../shared/metadata-process.ts'
import { OwnedProcessGroup } from '../../shared/process-ownership.ts'
import { ProcessLaunchError } from '../chromium-process.ts'
import { closeGraceMs, LaunchError } from '../contract.ts'
import { writeRedactedLog } from '../redacted-log.ts'
import { WebKitProcessTable } from './process-table.ts'

// The WebKit build's main process leads a process group of its own, but its web content, networking and GPU helpers
// are XPC services that launchd starts with parent pid 1, each outside that group. Ending the group does not end
// them. They are attributed to the browser by launchd, which lists the services it started for the browser's pid while
// the browser runs, and each is recorded by its pid, start time and command; only a recorded process whose identity
// still matches is ever signalled. The record is also written into the browser's temporary home, so a later launch can
// end what a Retest process killed outright left behind, and nothing else.

export type WebKitStartOptions = {
  build: WebKitBuild
  /** Receives the browser's stdout and stderr. */
  logFile: string
  headless: boolean
  /** Rewrites each line of the browser's output before it reaches the log, as the run's redactor does. */
  redact?: (text: string) => string
  redactStream?: () => OutputRedactor
  /** Where the temporary home is made: the system's temporary folder unless given. */
  homeParent?: string
  /** Reads and signals processes: the host's own unless a test gives one. */
  system?: ProcessOwnershipSystem
  /** Lists the services launchd started for a pid: `launchctl print pid/<pid>` unless a test gives one. */
  listServices?: (pid: number) => string
}

/** A process from the build that launchd started for the browser, as recorded when it was first seen. */
export type WebKitHelper = { readonly pid: number; readonly label: string; readonly identity: OwnedProcessIdentity }

/**
 * Start version 1 is C-locale UTC0; an absent or unknown version cannot confirm ownership.
 * What a temporary home's owner record holds: the Retest process that made it, by pid and start time, and every process
 * of the browser it recorded, the main process first.
 */
export type WebKitHomeRecord = {
  readonly version: 1
  readonly startTimeVersion?: number
  readonly path: string
  readonly launcher: { readonly pid: number; readonly startedAt: string }
  readonly processes: readonly OwnedProcessIdentity[]
}

/** The name of the owner record inside each temporary home. */
export const homeRecordFile: string = '.retest-webkit-owner.json'

const pollMs = 25
const helperGraceMs = 3000
const commandTimeoutMs = 5000
// Once nothing can write to the browser's output any more, what is left is Retest's own queued log writes and the close.
const ownWritingLimitMs = 10 * closeGraceMs

/**
 * How the temporary homes of a Retest process begin, so a later launch can tell whose each one was.
 *
 * @example homePrefix(4242) // 'retest-webkit-4242-'
 */
export function homePrefix(pid: number): string {
  return `retest-webkit-${pid}-`
}

/**
 * The flags Playwright's launcher passes a browser with no persistent profile: commands over fds 3 and 4, and no
 * window until a page is created. Every context Retest makes keeps its data in memory.
 *
 * @example webKitArguments(true) // ['--inspector-pipe', '--headless', '--no-startup-window']
 */
export function webKitArguments(headless: boolean): string[] {
  return ['--inspector-pipe', ...(headless ? ['--headless'] : []), '--no-startup-window']
}

/**
 * The whole environment the browser gets. Nothing of Retest's own environment passes through, so no secret and no
 * judge's key can. The frameworks load from the build, as its `pw_run.sh` arranges, and the home is a temporary one,
 * since the build writes caches and website data under `~/Library` even for in-memory contexts.
 *
 * @example webKitEnvironment(build, '/tmp/retest-webkit-4242-ab12')
 */
export function webKitEnvironment(build: Pick<WebKitBuild, 'directory'>, home: string): Record<string, string> {
  return {
    PATH: '/usr/bin:/bin',
    HOME: home,
    CFFIXED_USER_HOME: home,
    TMPDIR: `${join(home, 'tmp')}${sep}`,
    DYLD_FRAMEWORK_PATH: build.directory,
    DYLD_LIBRARY_PATH: build.directory,
  }
}

/**
 * Reads the services launchd lists under one process, from `launchctl print pid/<pid>`, keeping those with a running
 * pid. The text is launchd's own and no stable interface, so text without a services block is an error rather than an
 * empty list.
 *
 * @example parseLaunchdServices('\tservices = {\n\t\t   812      - \tcom.apple.WebKit.WebContent.1A2B\n\t}') // [{ pid: 812, label: 'com.apple.WebKit.WebContent.1A2B' }]
 */
export function parseLaunchdServices(text: string): { pid: number; label: string }[] {
  const lines = text.split('\n')
  const start = lines.findIndex((line) => /^\s*services = \{\s*$/.test(line))
  if (start === -1) throw new Error('launchctl print listed no services block, so its format is not the one Retest reads')
  const services: { pid: number; label: string }[] = []
  for (const line of lines.slice(start + 1)) {
    if (/^\s*\}\s*$/.test(line)) break
    const match = /^\s*(\d+)\s+\S+\s+(\S+)\s*$/.exec(line)
    const pid = Number(match?.[1])
    if (match?.[2] !== undefined && Number.isSafeInteger(pid) && pid > 1) services.push({ pid, label: match[2] })
  }
  return services
}

/** What an owner record holds for the start of the Retest process that made the home when that could not be read. */
export const unknownStartedAt: string = 'unknown'

/**
 * The start time `ps` gives a process, which with its pid names it however often the pid is reused, or undefined
 * when a reading shows no such process. A reading that fails throws, since it shows nothing either way.
 *
 * @example processStartedAt(process.pid) // 'Mon Oct  5 01:23:45 2026'
 */
export function processStartedAt(pid: number): string | undefined {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new RangeError('A start time reading needs a valid pid.')
  // `ps -p` exits 1 with no output when no listed pid exists, which a failed reading cannot be told apart from. Listing
  // this process too keeps a successful reading for an absent pid.
  const text = readMetadataProcess({ command: '/bin/ps', args: ['-o', 'pid=,lstart=', '-p', `${pid},${process.pid}`], environment: { PATH: '/usr/bin:/bin', LC_ALL: 'C', TZ: 'UTC0' } })
  return parseProcessStart(text, pid, process.pid)
}

/**
 * The start of `pid` in `ps -o pid=,lstart=` output that lists it beside `ownPid`, the process that read it, or
 * undefined when the output shows no such process. Output without the reading process's own line shows nothing, and
 * neither does a line that is not a pid and a start time, so both are errors.
 *
 * @example parseProcessStart('  812 Mon Oct  5 01:23:45 2026\n  700 Mon Oct  5 01:00:00 2026\n', 812, 700) // 'Mon Oct  5 01:23:45 2026'
 */
export function parseProcessStart(text: string, pid: number, ownPid: number): string | undefined {
  const starts = new Map<number, string>()
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    const fields = /^\s*(\d+)\s+([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s*$/.exec(line)
    if (fields?.[1] === undefined || fields[2] === undefined) throw new Error('ps returned a line that is not a pid and a start time.')
    starts.set(Number(fields[1]), fields[2])
  }
  if (!starts.has(ownPid)) throw new Error(`ps did not list the process reading it, so its reading shows nothing of process ${pid}.`)
  return starts.get(pid)
}

// The owner record keeps an unread start, and a later sweep then holds the home for as long as any process has this pid.
function ownStartedAt(): string {
  try {
    return processStartedAt(process.pid) ?? unknownStartedAt
  } catch {
    return unknownStartedAt
  }
}

/**
 * The WebKit build's main process in a process group of its own, with the temporary home it owns and the helpers launchd
 * started for it, each recorded by identity.
 */
export class WebKitProcess {
  readonly pid: number
  readonly build: WebKitBuild
  readonly home: string
  /** The browser reads commands from fd 3 and writes replies to fd 4. */
  readonly pipe: PipeStreams
  /** Settles when the main process exits. */
  readonly exited: Promise<ProcessExit>
  readonly outputSettled: Promise<void>
  readonly #ownership: OwnedProcessGroup
  readonly #helpers = new Map<number, { helper: WebKitHelper; ownership: OwnedProcessGroup }>()
  readonly #endedHelpers = new Set<number>()
  readonly #services = new Map<number, string>()
  readonly #launcher: { pid: number; startedAt: string }
  readonly #system: WebKitProcessTable
  readonly #listServices: (pid: number) => string
  readonly #output: BrowserOutput
  readonly #lastResort: () => void
  readonly #problems: string[] = []
  #exit: ProcessExit | undefined
  #stopping: Promise<string[]> | undefined
  #gone: Promise<void> | undefined

  /**
   * Starts the build's executable as the leader of a new process group, with a temporary home whose owner record names
   * this Retest process. A home it never used is removed again when the start fails.
   *
   * @example const webkit = await WebKitProcess.start({ build, logFile: 'logs/browser.log', headless: true })
   */
  static async start(options: WebKitStartOptions): Promise<WebKitProcess> {
    const parent = await realpath(options.homeParent ?? tmpdir())
    const home = await mkdtemp(join(parent, homePrefix(process.pid))).catch((error: unknown) => {
      throw new LaunchError(`Cannot create a temporary home for WebKit in ${parent}: ${errorMessage(error)}`, { cause: error })
    })
    const launcher = { pid: process.pid, startedAt: ownStartedAt() }
    try {
      await mkdir(join(home, 'tmp'))
      await writeRecord(home, { version: 1, startTimeVersion: 1, path: home, launcher, processes: [] }, 'wx')
      return await spawnInGroup(options, home, launcher)
    } catch (error) {
      if (error instanceof ProcessLaunchError) throw error
      await rm(home, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined)
      throw error instanceof LaunchError ? error : new LaunchError(`Cannot start WebKit: ${errorMessage(error)}`, { cause: error })
    }
  }

  constructor(child: ChildProcess, parts: { build: WebKitBuild; home: string; pipe: PipeStreams; ownership: OwnedProcessGroup; launcher: { pid: number; startedAt: string }; output: BrowserOutput; system?: ProcessOwnershipSystem; listServices?: (pid: number) => string }) {
    const { pid } = child
    if (pid === undefined) throw new TypeError('The WebKit process has no pid')
    this.pid = pid
    this.build = parts.build
    this.home = parts.home
    this.pipe = parts.pipe
    this.#ownership = parts.ownership
    this.#launcher = parts.launcher
    this.#system = parts.system instanceof WebKitProcessTable ? parts.system : new WebKitProcessTable(parts.system)
    this.#listServices = parts.listServices ?? launchdServices
    this.#output = parts.output
    this.outputSettled = parts.output.closed.then(() => undefined)
    this.exited = new Promise((resolve) => {
      child.once('exit', (code, signal) => {
        this.#exit = { code, signal }
        resolve(this.#exit)
      })
    })
    this.#lastResort = () => this.#killAtExit()
    process.on('exit', this.#lastResort)
  }

  /** The processes recorded so far, the main process first, then each build helper launchd started for it. */
  get processIds(): number[] {
    return [this.pid, ...this.#helpers.keys()]
  }

  /** The build helpers recorded so far. */
  get helpers(): readonly WebKitHelper[] {
    return [...this.#helpers.values()].map(({ helper }) => helper)
  }

  /** System services launchd started for the browser, by pid and label. Retest never signals them. */
  get services(): ReadonlyMap<number, string> {
    return this.#services
  }

  /** Resolves with how the process ended, or with undefined if it is still running after `timeoutMs`. */
  async waitForExit(timeoutMs: number): Promise<ProcessExit | undefined> {
    if (this.#exit !== undefined) return this.#exit
    const timer = new AbortController()
    const expired = sleep(timeoutMs, undefined, { signal: timer.signal }).catch(() => undefined)
    const exit = await Promise.race([this.exited, expired])
    timer.abort()
    return exit
  }

  /**
   * Records the build helpers launchd lists under the browser now, each by its identity, and writes them into the
   * home's owner record. A helper that started and ended between two calls is never seen. Only a running browser can be
   * asked; once it has gone this records nothing. Returns what could not be read or written.
   */
  async recordHelpers(): Promise<string[]> {
    if (this.#exit !== undefined) return []
    const problems: string[] = []
    let services: { pid: number; label: string }[]
    try {
      services = parseLaunchdServices(this.#listServices(this.pid))
    } catch (error) {
      if (this.#exit !== undefined) return []
      return [`The browser's helpers could not be listed: ${errorMessage(error)}`]
    }
    let added = false
    for (const { pid, label } of services) {
      if (this.#helpers.has(pid) || this.#services.has(pid)) continue
      // A service that ended before it was read, or that launchd did not start, is not recorded, so it is never
      // signalled; only a reading that failed is a problem.
      const ownership = new OwnedProcessGroup(pid, 1, this.#system)
      ownership.capture()
      const identity = ownership.verifiedIdentity(pid)
      if (identity === undefined) {
        problems.push(...ownership.readProblems)
        continue
      }
      if (!identity.command.startsWith(`${this.build.directory}${sep}`)) {
        this.#services.set(pid, label)
        continue
      }
      this.#helpers.set(pid, { helper: { pid, label, identity }, ownership })
      added = true
    }
    if (added) {
      await writeRecord(this.home, this.#record(), 'w').catch((error: unknown) => {
        problems.push(`Could not write the WebKit home's owner record: ${errorMessage(error)}`)
      })
    }
    return problems
  }

  /**
   * Settles once the main process has exited, nothing of its group or its recorded helpers is left, and its output is
   * written. Its polling holds no Retest process open.
   */
  gone(): Promise<void> {
    this.#gone ??= this.#awaitGone()
    return this.#gone
  }

  /**
   * Waits up to `graceMs` for the browser to end, kills what is left of its group, waits for the recorded helpers to end
   * and kills any whose identity still matches, then removes the home once nothing recorded remains. Resolves with what
   * could not be cleaned up. A second call waits for the first.
   */
  stop(graceMs: number): Promise<string[]> {
    this.#stopping ??= this.#stop(graceMs)
    return this.#stopping
  }

  async #stop(graceMs: number): Promise<string[]> {
    const deadline = new Deadline(graceMs + helperGraceMs + 3 * closeGraceMs)
    const problems = [...this.#problems, ...(await this.recordHelpers())]
    try {
      if (!(await this.#groupEnded(new Deadline(graceMs), deadline))) {
        const report = await this.#ownership.signalReportAsync('SIGKILL', deadline)
        problems.push(...report.problems, ...report.identityRefusals)
        if (!(await this.#groupEnded(new Deadline(closeGraceMs), deadline))) problems.push(`The browser's process group ${this.pid} could not be confirmed ended ${closeGraceMs} ms after SIGKILL.`)
      }
      await waitUntil(async () => (await this.#remainingHelpers(deadline)).length === 0, new Deadline(Math.min(helperGraceMs, deadline.remainingMs)))
      for (const { helper, ownership } of await this.#remainingHelpers(deadline)) {
        const report = await ownership.signalReportAsync('SIGKILL', deadline)
        problems.push(...[...report.problems, ...report.identityRefusals].map((problem) => `${helper.label}: ${problem}`))
      }
      await waitUntil(async () => (await this.#remainingHelpers(deadline)).length === 0, new Deadline(Math.min(closeGraceMs, deadline.remainingMs)))
      for (const { helper } of await this.#remainingHelpers(deadline)) problems.push(`${helper.label} (pid ${helper.pid}) from the build could not be confirmed ended after SIGKILL.`)
    } catch (error) {
      problems.push(`Could not end the browser's processes: ${errorMessage(error)}`)
    }
    problems.push(...(await outputWithin(this.#output, closeGraceMs)))
    const remains = (await this.#ownership.remainsAsync(deadline)) || (await this.#remainingHelpers(deadline)).length > 0
    if (!remains) {
      await rm(this.home, { recursive: true, force: true, maxRetries: 3 }).catch((error: unknown) => {
        problems.push(`Could not remove the browser's home ${this.home}: ${errorMessage(error)}`)
      })
    }
    if (!remains) process.off('exit', this.#lastResort)
    return [...new Set([...problems, ...this.#ownership.readProblems, ...[...this.#helpers.values()].flatMap(({ helper, ownership }) => ownership.readProblems.map((problem) => `${helper.label}: ${problem}`))])]
  }

  async #awaitGone(): Promise<void> {
    await this.exited
    while ((await this.#ownership.remainsAsync()) || (await this.#remainingHelpers()).length > 0) await sleep(pollMs, undefined, { ref: false })
    await this.#output.closed
  }

  async #remainingHelpers(deadline?: Deadline): Promise<{ helper: WebKitHelper; ownership: OwnedProcessGroup }[]> {
    const candidates = [...this.#helpers.values()].filter(({ helper }) => !this.#endedHelpers.has(helper.pid))
    if (candidates.length === 0) return []
    return this.#system.during(() => candidates.filter(({ helper, ownership }) => {
      if (ownership.remains(deadline)) return true
      this.#endedHelpers.add(helper.pid)
      return false
    }), deadline)
  }

  // The main process has exited and no process of its group is left.
  async #groupEnded(wait: Deadline, deadline: Deadline): Promise<boolean> {
    if ((await this.waitForExit(Math.min(wait.remainingMs, deadline.remainingMs))) === undefined) return false
    return waitUntil(async () => !(await this.#ownership.remainsAsync(deadline)), new Deadline(Math.min(wait.remainingMs, deadline.remainingMs)))
  }

  #record(): WebKitHomeRecord {
    const main = this.#ownership.verifiedIdentity(this.pid)
    return { version: 1, startTimeVersion: 1, path: this.home, launcher: this.#launcher, processes: [...(main === undefined ? [] : [main]), ...this.helpers.map((helper) => helper.identity)] }
  }

  // Runs while the Retest process exits, when a failure can neither be awaited nor reported. A SIGKILL of Retest
  // itself never reaches here: the browser then ends when its pipe closes, and a later launch removes the home.
  #killAtExit(): void {
    try {
      this.#system.duringNow(() => {
        this.#ownership.signalNow('SIGKILL')
        for (const { ownership } of this.#helpers.values()) ownership.signalNow('SIGKILL')
      }, new Deadline(closeGraceMs))
      const remains = this.#system.duringNow(() => this.#ownership.remains() || [...this.#helpers.values()].some(({ ownership }) => ownership.remains()), new Deadline(closeGraceMs))
      if (!remains) rmSync(this.home, { recursive: true, force: true, maxRetries: 3 })
    } catch {
      // Throwing here would replace the exit code Retest chose.
    }
  }

  /** Records the main process once more after it started, so the owner record names it. */
  async recordMain(): Promise<void> {
    await writeRecord(this.home, this.#record(), 'w')
  }

  /** Problems met while the process was started, reported with the next stop. */
  noteProblems(problems: readonly string[]): void {
    this.#problems.push(...problems)
  }
}

async function spawnInGroup(options: WebKitStartOptions, home: string, launcher: { pid: number; startedAt: string }): Promise<WebKitProcess> {
  const { build, redact, redactStream } = options
  await mkdir(dirname(options.logFile), { recursive: true })
  const log = await open(options.logFile, 'a').catch((error: unknown) => {
    throw new LaunchError(`Cannot open the browser log ${options.logFile}: ${errorMessage(error)}`, { cause: error })
  })
  let logHandedOn = false
  try {
    // Output to redact comes through Retest; any other goes straight to the log.
    const outputMode = redact === undefined && redactStream === undefined ? log.fd : 'pipe'
    const child = spawn(build.executable, webKitArguments(options.headless), {
      detached: true,
      env: webKitEnvironment(build, home),
      stdio: ['ignore', outputMode, outputMode, 'pipe', 'pipe'],
    })
    await once(child, 'spawn').catch((error: unknown) => {
      throw new LaunchError(`Cannot start ${build.executable}: ${errorMessage(error)}`, { cause: error })
    })
    const system = new WebKitProcessTable(options.system)
    const ownership = new OwnedProcessGroup(child.pid ?? 0, process.pid, system)
    const ownershipProblems = ownership.capture()
    const [, , , writable, readable] = child.stdio
    if (!(writable instanceof Writable) || !(readable instanceof Readable)) {
      const problems = [...ownershipProblems, ...ownership.signal('SIGKILL')]
      logHandedOn = true
      await log.close().catch(() => undefined)
      const gone = waitForGroup(child, ownership).then(() => rm(home, { recursive: true, force: true, maxRetries: 3 }))
      void gone.catch(() => undefined)
      throw new ProcessLaunchError(`Cannot open the inspector pipe to ${build.executable}. ${problems.join(' ')}`, gone, { failureClass: problems.length > 0 ? 'cleanup_failed' : 'setup_failed' })
    }
    let output: BrowserOutput
    if (redact !== undefined || redactStream !== undefined) {
      const streams = [child.stdout, child.stderr].flatMap((stream) => (stream === null ? [] : [stream]))
      output = {
        ...writeRedactedLog(streams, log, redact ?? ((text) => text), redactStream),
        // A pipe reaches its end only once every process holding its write end, inside the group or not, has let go.
        writersRemain: () => streams.some((stream) => !stream.readableEnded && !stream.destroyed),
      }
    } else {
      // The output goes straight to the log file, so only the group's own processes write it.
      output = { closed: waitForGroup(child, ownership).then(() => []), cancel: () => undefined, writersRemain: () => ownership.remains() }
    }
    logHandedOn = true
    const parts = { build, home, pipe: { readable, writable }, ownership, launcher, output, system, ...(options.listServices === undefined ? {} : { listServices: options.listServices }) }
    const started = new WebKitProcess(child, parts)
    if (redact === undefined && redactStream === undefined) {
      await log.close().catch((error: unknown) => started.noteProblems([`Could not close the browser log: ${errorMessage(error)}`]))
    }
    if (ownershipProblems.length > 0) {
      const problems = await started.stop(0)
      throw new ProcessLaunchError(`Could not record the launched browser's ownership: ${[...ownershipProblems, ...problems].join(' ')}`, started.gone(), { failureClass: problems.length > 0 ? 'cleanup_failed' : 'setup_failed' }, started.outputSettled)
    }
    await started.recordMain().catch((error: unknown) => started.noteProblems([`Could not write the WebKit home's owner record: ${errorMessage(error)}`]))
    return started
  } finally {
    if (!logHandedOn) await log.close().catch(() => undefined)
  }
}

function launchdServices(pid: number): string {
  return readMetadataProcess({ command: '/bin/launchctl', args: ['print', `pid/${pid}`], environment: { PATH: '/usr/bin:/bin', LC_ALL: 'C' }, timeoutMs: commandTimeoutMs })
}

async function writeRecord(home: string, record: WebKitHomeRecord, flag: 'w' | 'wx'): Promise<void> {
  await writeFile(join(home, homeRecordFile), `${JSON.stringify(record)}\n`, { flag, mode: 0o600 })
}

async function waitForGroup(child: ChildProcess, ownership: OwnedProcessGroup): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) await once(child, 'exit')
  await ownership.captureAsync()
  while (await ownership.remainsAsync()) await sleep(pollMs, undefined, { ref: false })
}

async function waitUntil(done: () => boolean | Promise<boolean>, deadline: Deadline): Promise<boolean> {
  while (!(await done())) {
    if (deadline.expired) return false
    await sleep(Math.min(pollMs, deadline.remainingMs))
  }
  return true
}

/**
 * Waits for the browser's output to close. A timer can fire before output that is already waiting has been read, when
 * the main thread was busy with other work such as synchronous process readings, so the clock alone is no proof the
 * output is still open. When the bound passes, waiting output is read first, then the output is judged by whether
 * anything can still write to it; once nothing can, Retest's own writing gets its own bound. The same judgement as the
 * Chromium process's (`chromium-process.ts`), where a busy host first showed every healthy close reported as failed.
 */
async function outputWithin(output: BrowserOutput, timeoutMs: number): Promise<string[]> {
  const first = await settledWithin(output.closed, timeoutMs)
  if (first !== undefined) return first
  await ioTurns(2)
  const late = await settledWithin(output.closed, 0)
  if (late !== undefined) return late
  if (output.writersRemain?.() === false) {
    const written = await settledWithin(output.closed, ownWritingLimitMs)
    if (written !== undefined) return written
    output.cancel()
    return [`Retest did not finish writing and closing the browser's log within ${ownWritingLimitMs} ms after its output ended.`]
  }
  output.cancel()
  return [`The browser's output did not finish writing and closing within ${timeoutMs} ms.`]
}

// What `promise` settled with within `timeoutMs`, or undefined. One that settled meanwhile wins over the timer.
async function settledWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  let settled: { value: T } | undefined
  void promise.then((value) => { settled = { value } }, () => undefined)
  const timer = new AbortController()
  const expired = sleep(timeoutMs, undefined, { signal: timer.signal }).then(() => undefined, () => undefined)
  const result = await Promise.race([promise.then((value) => ({ value })), expired])
  timer.abort()
  return (result ?? settled)?.value
}

// Lets the event loop read output that was already waiting, as a `setImmediate` runs only after that read.
async function ioTurns(count: number): Promise<void> {
  for (let turn = 0; turn < count; turn += 1) await new Promise<void>((resolve) => setImmediate(resolve))
}
