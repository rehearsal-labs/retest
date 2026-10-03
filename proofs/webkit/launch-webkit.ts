import type { ChildProcess } from 'node:child_process'
import type { PipeStreams } from '../../src/browser/cdp/transport.ts'
import type { ProcessExit } from '../../src/shared/process-exit.ts'
import { execFile, execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { constants, rmSync } from 'node:fs'
import { access, mkdir, mkdtemp, open, readFile, realpath, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { setTimeout as sleep } from 'node:timers/promises'
import { promisify } from 'node:util'
import { signalGroup } from '../../src/browser/chromium-process.ts'
import { Deadline } from '../../src/protocol/deadline.ts'
import { errorMessage } from '../../src/protocol/failures.ts'
import { errorCode } from '../../src/shared/error-code.ts'

/** The Playwright WebKit build this proof was written and run against. */
export type PinnedBuild = {
  readonly revision: string
  readonly browserVersion: string
  readonly playwrightVersion: string
  readonly hostPlatform: string
  readonly url: string
  /** The sha256 of the build's `protocol.json`, the protocol the client was written against. */
  readonly protocolSha256: string
}

export const PINNED_BUILD: PinnedBuild = {
  revision: '2359',
  browserVersion: '26.6',
  playwrightVersion: '1.63.0',
  hostPlatform: 'mac26-arm64',
  url: 'https://cdn.playwright.dev/dbazure/download/playwright/builds/webkit/2359/webkit-mac-26-arm64.zip',
  protocolSha256: '5962bc790bde7750ce127029962a6c1bd93aed884cbcf832da8393c2a12c106c',
}

/** An unpacked macOS WebKit build: the `Playwright.app` shell and the frameworks beside it. */
export type WebKitBuild = {
  /** Absolute, with symbolic links resolved and no trailing separator, so it compares with paths `ps` prints. */
  readonly directory: string
  readonly executable: string
  /** The protocol the build speaks, shipped inside it. */
  readonly protocolFile: string
  readonly protocolSha256: string
  /** From the folder name `webkit-<revision>` that Playwright's installer gives it, or undefined for another name. */
  readonly revision: string | undefined
}

/**
 * A process from the build that the browser started: web content, networking or GPU. launchd starts them outside
 * the browser's process group. `launchd` means `launchctl print` listed it under the browser; `path` means `ps`
 * found it running from the build folder after the browser started, which is how it is found once the browser is
 * gone and launchd no longer answers for it.
 */
export type HelperProcess = { readonly pid: number; readonly label: string; readonly command: string; readonly foundBy: 'launchd' | 'path' }

export type StopReport = {
  /** How the main process ended, or undefined if it was still running when the stop gave up. */
  readonly exit: ProcessExit | undefined
  /** True once no process of the browser's own process group was left. */
  readonly groupEnded: boolean
  /** Processes from the build, started after the browser, that needed SIGKILL after the browser had gone. */
  readonly helpersKilled: readonly HelperProcess[]
  /** Processes from the build, started after the browser, still running at the end. Empty means none was found. */
  readonly buildProcessesLeft: readonly HelperProcess[]
  /** Processes from the build that were running before this browser started. They are never signalled. */
  readonly othersUnderBuild: readonly HelperProcess[]
  /** System services launchd started for the browser, which this proof watches but never signals. */
  readonly systemServices: readonly { helper: HelperProcess; ended: boolean }[]
  readonly problems: readonly string[]
}

export type StartOptions = {
  build: WebKitBuild
  /** Receives the browser's stdout and stderr. */
  logFile: string
  headless: boolean
}

const execFileAsync = promisify(execFile)
const pollMs = 25
const commandTimeoutMs = 5000
const killGraceMs = 2000
const helperGraceMs = 5000
// What a stop may take beyond the caller's grace period: helpers ending, kills and the commands that check them.
const stopReserveMs = killGraceMs + helperGraceMs + killGraceMs + 3 * commandTimeoutMs

/**
 * Where the pinned build is: `RETEST_WEBKIT_BUILD`, or where `npx playwright install webkit` puts it on macOS.
 *
 * @example defaultBuildDirectory({}) // '/Users/me/Library/Caches/ms-playwright/webkit-2359'
 */
export function defaultBuildDirectory(environment: NodeJS.ProcessEnv = process.env): string {
  const configured = environment['RETEST_WEBKIT_BUILD']
  if (configured !== undefined && configured !== '') return configured
  return join(homedir(), 'Library', 'Caches', 'ms-playwright', `webkit-${PINNED_BUILD.revision}`)
}

/**
 * Checks that a macOS WebKit build is unpacked at `directory` and returns its parts. The path is made absolute and
 * its symbolic links resolved once, here, so a trailing slash or a relative path names the same build.
 *
 * @example const build = await findWebKitBuild()
 */
export async function findWebKitBuild(directory: string = defaultBuildDirectory()): Promise<WebKitBuild> {
  if (process.platform !== 'darwin') {
    throw new Error(`This proof launches the macOS WebKit build, and this host is ${process.platform}. The Linux route is described in docs/plans/public-beta/proofs/webkit.md and has not been run.`)
  }
  const install = `Install it outside the repository with \`npx playwright@${PINNED_BUILD.playwrightVersion} install webkit\`, or set RETEST_WEBKIT_BUILD to an unpacked build.`
  const absolute = await realpath(resolve(directory)).catch(() => {
    throw new Error(`No WebKit build at ${directory}: the folder does not exist. ${install}`)
  })
  const executable = join(absolute, 'Playwright.app', 'Contents', 'MacOS', 'Playwright')
  const protocolFile = join(absolute, 'protocol.json')
  await access(executable, constants.X_OK).catch(() => {
    throw new Error(`No WebKit build at ${absolute}: ${executable} is missing or not executable. ${install}`)
  })
  const protocol = await readFile(protocolFile).catch(() => {
    throw new Error(`The WebKit build at ${absolute} has no readable protocol.json. ${install}`)
  })
  return {
    directory: absolute,
    executable,
    protocolFile,
    protocolSha256: createHash('sha256').update(protocol).digest('hex'),
    revision: readRevision(absolute),
  }
}

/**
 * The revision in a folder named `webkit-<revision>`, as Playwright's installer names it.
 *
 * @example readRevision('/cache/ms-playwright/webkit-2359') // '2359'
 */
export function readRevision(directory: string): string | undefined {
  return /^webkit-(\d+)$/.exec(basename(directory))?.[1]
}

/** Whether a build is the pinned one: its folder names the pinned revision and its protocol is the pinned file. */
export function matchesPin(build: WebKitBuild): boolean {
  return build.revision === PINNED_BUILD.revision && build.protocolSha256 === PINNED_BUILD.protocolSha256
}

/**
 * The build's WebKit version, from its `WebKit.framework` bundle, such as `626.1.6+`. The user agent does not say.
 *
 * @example await readWebKitVersion(build) // '626.1.6+'
 */
export async function readWebKitVersion(build: WebKitBuild): Promise<string> {
  const plist = join(build.directory, 'WebKit.framework', 'Resources', 'Info.plist')
  return (await run('plutil', ['-extract', 'CFBundleVersion', 'raw', '-o', '-', plist])).trim()
}

/**
 * The flags Playwright's launcher passes for a browser with no persistent profile: commands over fds 3 and 4, and
 * no window until a page is created. Contexts made with `Playwright.createContext` keep their data in memory.
 *
 * @example webKitArguments({ headless: true }) // ['--inspector-pipe', '--headless', '--no-startup-window']
 */
export function webKitArguments(options: { headless: boolean }): string[] {
  return ['--inspector-pipe', ...(options.headless ? ['--headless'] : []), '--no-startup-window']
}

/**
 * The whole environment the browser gets. Nothing of Retest's own environment passes through, so no secret can.
 * The frameworks load from the build, as its `pw_run.sh` arranges, and the home folder is a temporary one: the
 * build writes caches and website data under `~/Library` even for in-memory contexts.
 *
 * @example webKitEnvironment(build, '/tmp/retest-webkit-1a2b')
 */
export function webKitEnvironment(build: WebKitBuild, home: string): Record<string, string> {
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
 * Reads the services launchd lists under one process's domain, from `launchctl print pid/<pid>`, keeping those
 * with a running pid. The format is launchd's own text, not a stable interface, so text without a services block
 * is an error rather than an empty list.
 *
 * @example parseLaunchdServices('\tservices = {\n\t\t   812      - \tcom.apple.WebKit.WebContent.1A2B\n\t}') // [{ pid: 812, label: 'com.apple.WebKit.WebContent.1A2B' }]
 */
export function parseLaunchdServices(text: string): { pid: number; label: string }[] {
  const lines = text.split('\n')
  const start = lines.findIndex((line) => /^\s*services = \{\s*$/.test(line))
  if (start === -1) throw new Error('launchctl print listed no services block, so its format is not the one this proof reads')
  const services: { pid: number; label: string }[] = []
  for (const line of lines.slice(start + 1)) {
    if (/^\s*\}\s*$/.test(line)) break
    const match = /^\s*(\d+)\s+\S+\s+(\S+)\s*$/.exec(line)
    const pid = Number(match?.[1])
    if (match?.[2] !== undefined && Number.isSafeInteger(pid) && pid > 0) services.push({ pid, label: match[2] })
  }
  return services
}

/**
 * Reads `ps -A -o pid=,comm=` and keeps the processes whose executable lies inside `directory`.
 *
 * @example parseProcessListing('  812 /cache/webkit-2359/com.apple.WebKit.GPU.xpc/Contents/MacOS/com.apple.WebKit.GPU.Development', '/cache/webkit-2359') // [{ pid: 812, command: '/cache/…' }]
 */
export function parseProcessListing(text: string, directory: string): { pid: number; command: string }[] {
  const inside = `${directory}${sep}`
  const processes: { pid: number; command: string }[] = []
  for (const line of text.split('\n')) {
    const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(line)
    if (match?.[1] === undefined || match[2] === undefined || !match[2].startsWith(inside)) continue
    processes.push({ pid: Number(match[1]), command: match[2] })
  }
  return processes
}

/**
 * Every running process whose executable lies inside the build folder.
 * @example await listBuildProcesses(build)
 */
export async function listBuildProcesses(build: WebKitBuild, timeoutMs: number = commandTimeoutMs): Promise<{ pid: number; command: string }[]> {
  return parseProcessListing(await run('ps', ['-A', '-o', 'pid=,comm='], timeoutMs), build.directory)
}

/** Whether a helper is still running: its pid exists and still runs the same command, so a reused pid does not count. */
export async function stillRunning(helper: HelperProcess): Promise<boolean> {
  return isRunning(helper.pid) && (await commandOf(helper.pid)) === helper.command
}

/** Whether a process with this id exists. */
export function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return errorCode(error) === 'EPERM'
  }
}

/**
 * The WebKit build's main process in a process group of its own, with the temporary home it owns. Its web content,
 * networking and GPU helpers are XPC services that launchd starts outside that group. They are found two ways:
 * launchd lists them under the browser while it runs, and `ps` finds every process running from the build folder
 * that was not there before the browser started. Only the second still works after the browser has died. It cannot
 * tell two browsers started from the same build apart, so the proof starts one at a time.
 */
export class WebKitProcess {
  readonly pid: number
  readonly build: WebKitBuild
  readonly home: string
  /** The browser reads commands from fd 3 and writes replies to fd 4. */
  readonly pipe: PipeStreams
  /** Settles when the main process exits. */
  readonly exited: Promise<ProcessExit>
  readonly #before: ReadonlySet<number>
  readonly #helpers = new Map<number, HelperProcess>()
  readonly #lastResort: () => void
  #exit: ProcessExit | undefined
  #stopping: Promise<StopReport> | undefined

  /**
   * Starts the build's executable as the leader of a new process group, with a temporary home. The processes
   * already running from the build are noted first, so they are never taken for this browser's.
   *
   * @example const webkit = await WebKitProcess.start({ build, logFile: 'out/browser.log', headless: true })
   */
  static async start(options: StartOptions): Promise<WebKitProcess> {
    const before = new Set((await listBuildProcesses(options.build)).map((entry) => entry.pid))
    const home = await mkdtemp(join(tmpdir(), 'retest-webkit-'))
    try {
      await mkdir(join(home, 'tmp'))
      return await spawnInGroup(options, home, before)
    } catch (error) {
      await rm(home, { recursive: true, force: true, maxRetries: 3 })
      throw error
    }
  }

  constructor(child: ChildProcess, build: WebKitBuild, home: string, pipe: PipeStreams, before: ReadonlySet<number>) {
    if (child.pid === undefined) throw new TypeError('The WebKit process has no pid')
    const pid = child.pid
    this.pid = pid
    this.build = build
    this.home = home
    this.pipe = pipe
    this.#before = before
    this.exited = new Promise((resolve) => {
      child.once('exit', (code, signal) => {
        this.#exit = { code, signal }
        resolve(this.#exit)
      })
    })
    this.#lastResort = () => this.#killAtExit()
    process.on('exit', this.#lastResort)
  }

  /** Everything recorded so far: build helpers and system services. */
  get helpers(): readonly HelperProcess[] {
    return [...this.#helpers.values()]
  }

  /** The recorded helpers that run from the build folder. */
  get buildHelpers(): readonly HelperProcess[] {
    return this.helpers.filter((helper) => this.#fromBuild(helper.command))
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
   * Records the browser's helpers: those launchd lists under the browser while it runs, and every process running
   * from the build folder that was not there before the browser started. A helper that started and ended between
   * two calls is never seen. Resolves with every helper recorded so far.
   */
  async recordHelpers(timeoutMs: number = commandTimeoutMs): Promise<readonly HelperProcess[]> {
    if (this.#exit === undefined) {
      for (const { pid, label } of parseLaunchdServices(await run('launchctl', ['print', `pid/${this.pid}`], timeoutMs))) {
        if (this.#helpers.has(pid)) continue
        const command = await commandOf(pid, timeoutMs)
        if (command !== undefined) this.#helpers.set(pid, { pid, label, command, foundBy: 'launchd' })
      }
    }
    for (const helper of await this.#startedSince(timeoutMs)) if (!this.#helpers.has(helper.pid)) this.#helpers.set(helper.pid, helper)
    return this.helpers
  }

  /**
   * Waits up to `graceMs` for the browser's process group to end and kills the group if any of it is left. Then
   * waits for every process from the build started since the browser to end, kills any left whose command is
   * unchanged, checks again by path, and removes the home. The whole stop has a deadline; past it the report says so.
   */
  stop(graceMs: number): Promise<StopReport> {
    this.#stopping ??= this.#stopWithin(graceMs)
    return this.#stopping
  }

  async #stopWithin(graceMs: number): Promise<StopReport> {
    const budgetMs = graceMs + stopReserveMs
    let timer: NodeJS.Timeout | undefined
    const late = new Promise<StopReport>((resolve) => {
      timer = setTimeout(() => {
        const problem = `Stopping the browser did not finish within ${budgetMs} ms; its processes and home ${this.home} may remain.`
        resolve({ exit: this.#exit, groupEnded: false, helpersKilled: [], buildProcessesLeft: [], othersUnderBuild: [], systemServices: [], problems: [problem] })
      }, budgetMs)
    })
    try {
      return await Promise.race([this.#stop(new Deadline(budgetMs), graceMs), late])
    } finally {
      clearTimeout(timer)
    }
  }

  async #stop(deadline: Deadline, graceMs: number): Promise<StopReport> {
    const problems: string[] = []
    const limit = () => Math.max(1, Math.min(commandTimeoutMs, deadline.remainingMs))
    await this.recordHelpers(limit()).catch((error: unknown) => {
      // launchd forgets a process the moment it exits; only a running browser that cannot be asked is a problem.
      if (this.#exit === undefined && isRunning(this.pid)) problems.push(`The browser's helpers could not be listed: ${errorMessage(error)}`)
    })
    let groupEnded = await this.#ended(new Deadline(Math.min(graceMs, deadline.remainingMs)))
    if (!groupEnded) {
      try {
        signalGroup(this.pid, 'SIGKILL')
      } catch (error) {
        problems.push(`Could not signal the browser's process group ${this.pid}: ${errorMessage(error)}`)
      }
      groupEnded = await this.#ended(new Deadline(Math.min(killGraceMs, deadline.remainingMs)))
      if (!groupEnded) problems.push(`The browser's process group ${this.pid} was still there ${killGraceMs} ms after SIGKILL.`)
    }
    const helpersKilled: HelperProcess[] = []
    try {
      await this.#waitForBuildProcesses(new Deadline(Math.min(helperGraceMs, deadline.remainingMs)), limit)
      for (const helper of await this.#startedSince(limit())) {
        // The command is read again so that a pid the system has given to another process is never signalled.
        if ((await commandOf(helper.pid, limit())) !== helper.command) continue
        if (killProcess(helper.pid)) helpersKilled.push(helper)
      }
      await waitForAll(helpersKilled, new Deadline(Math.min(killGraceMs, deadline.remainingMs)))
    } catch (error) {
      problems.push(`The browser's leftover processes could not be checked: ${errorMessage(error)}`)
    }
    const { left, others } = await this.#finalCheck(limit()).catch((error: unknown) => {
      problems.push(`The final check for processes from the build failed: ${errorMessage(error)}`)
      return { left: [], others: [] }
    })
    for (const helper of left) problems.push(`${helper.label} (pid ${helper.pid}) from the build is still running.`)
    const systemServices = await Promise.all(
      this.helpers.filter((helper) => !this.#fromBuild(helper.command)).map(async (helper) => ({ helper, ended: !(await stillRunning(helper)) })),
    )
    process.off('exit', this.#lastResort)
    await rm(this.home, { recursive: true, force: true, maxRetries: 3 }).catch((error: unknown) => {
      problems.push(`Could not remove the browser's home ${this.home}: ${errorMessage(error)}`)
    })
    return { exit: this.#exit, groupEnded, helpersKilled, buildProcessesLeft: left, othersUnderBuild: others, systemServices, problems }
  }

  // Processes running from the build that were not there before the browser started.
  async #startedSince(timeoutMs: number): Promise<HelperProcess[]> {
    return (await listBuildProcesses(this.build, timeoutMs))
      .filter((entry) => entry.pid !== this.pid && !this.#before.has(entry.pid))
      .map((entry) => ({ ...entry, label: basename(entry.command), foundBy: 'path' as const }))
  }

  async #waitForBuildProcesses(deadline: Deadline, limit: () => number): Promise<void> {
    while ((await this.#startedSince(limit())).length > 0 && !deadline.expired) await sleep(Math.min(pollMs * 4, deadline.remainingMs))
  }

  async #finalCheck(timeoutMs: number): Promise<{ left: HelperProcess[]; others: HelperProcess[] }> {
    const running = await listBuildProcesses(this.build, timeoutMs)
    const describe = (entry: { pid: number; command: string }): HelperProcess => ({ ...entry, label: basename(entry.command), foundBy: 'path' as const })
    return {
      left: running.filter((entry) => entry.pid !== this.pid && !this.#before.has(entry.pid)).map(describe),
      others: running.filter((entry) => this.#before.has(entry.pid)).map(describe),
    }
  }

  #fromBuild(command: string): boolean {
    return command.startsWith(`${this.build.directory}${sep}`)
  }

  // The main process has exited and no process of its group is left.
  async #ended(deadline: Deadline): Promise<boolean> {
    if ((await this.waitForExit(deadline.remainingMs)) === undefined) return false
    while (signalGroup(this.pid, 0)) {
      if (deadline.expired) return false
      await sleep(Math.min(pollMs, deadline.remainingMs))
    }
    return true
  }

  // Runs while the proof's process exits, when a failure can neither be awaited nor reported. A SIGKILL of the
  // proof itself never reaches here, so then the home stays behind.
  #killAtExit(): void {
    try {
      signalGroup(this.pid, 'SIGKILL')
      for (const helper of this.#helpers.values()) {
        if (this.#fromBuild(helper.command) && isRunning(helper.pid) && commandOfSync(helper.pid) === helper.command) killProcess(helper.pid)
      }
      rmSync(this.home, { recursive: true, force: true, maxRetries: 3 })
    } catch {
      // Throwing here would replace the exit code the proof chose.
    }
  }
}

async function spawnInGroup(options: StartOptions, home: string, before: ReadonlySet<number>): Promise<WebKitProcess> {
  await mkdir(dirname(options.logFile), { recursive: true })
  const log = await open(options.logFile, 'a')
  try {
    const child = spawn(options.build.executable, webKitArguments({ headless: options.headless }), {
      detached: true,
      env: webKitEnvironment(options.build, home),
      stdio: ['ignore', log.fd, log.fd, 'pipe', 'pipe'],
    })
    await once(child, 'spawn').catch((error: unknown) => {
      throw new Error(`Cannot start ${options.build.executable}: ${errorMessage(error)}`, { cause: error })
    })
    const [, , , writable, readable] = child.stdio
    if (!(writable instanceof Writable) || !(readable instanceof Readable)) {
      if (child.pid !== undefined) signalGroup(child.pid, 'SIGKILL')
      throw new Error(`Cannot open the inspector pipe to ${options.build.executable}.`)
    }
    return new WebKitProcess(child, options.build, home, { readable, writable }, before)
  } finally {
    await log.close()
  }
}

// Every external command has a time limit, so a stalled one cannot hold the proof.
async function run(command: string, args: string[], timeoutMs: number = commandTimeoutMs): Promise<string> {
  try {
    const { stdout } = await execFileAsync(command, args, { encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL' })
    return stdout
  } catch (error) {
    const killed = error instanceof Error && 'killed' in error && error.killed === true
    throw new Error(killed ? `${command} did not finish within ${timeoutMs} ms` : `${command} failed: ${errorMessage(error)}`, { cause: error })
  }
}

// False when the process was already gone.
function killProcess(pid: number): boolean {
  try {
    process.kill(pid, 'SIGKILL')
    return true
  } catch (error) {
    if (errorCode(error) === 'ESRCH') return false
    throw error
  }
}

async function commandOf(pid: number, timeoutMs: number = commandTimeoutMs): Promise<string | undefined> {
  try {
    const command = (await run('ps', ['-o', 'comm=', '-p', String(pid)], timeoutMs)).trim()
    return command === '' ? undefined : command
  } catch {
    // ps exits 1 for a process that is gone, and a check that timed out cannot vouch for the process either.
    return undefined
  }
}

function commandOfSync(pid: number): string | undefined {
  try {
    return execFileSync('ps', ['-o', 'comm=', '-p', String(pid)], { encoding: 'utf8', timeout: 1000, killSignal: 'SIGKILL' }).trim()
  } catch {
    return undefined
  }
}

async function waitForAll(helpers: readonly HelperProcess[], deadline: Deadline): Promise<void> {
  while (helpers.some((helper) => isRunning(helper.pid)) && !deadline.expired) await sleep(Math.min(pollMs, deadline.remainingMs))
}
