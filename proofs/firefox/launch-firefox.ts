import type { Dirent, Stats } from 'node:fs'
import type { BidiDiagnostic } from './bidi-client.ts'
import type { SessionFacts } from './firefox-session.ts'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { constants, rmSync } from 'node:fs'
import { access, appendFile, mkdir, mkdtemp, open, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { promisify } from 'node:util'
import { signalGroup } from '../../src/browser/chromium-process.ts'
import { Deadline } from '../../src/protocol/deadline.ts'
import { errorMessage } from '../../src/protocol/failures.ts'
import { errorCode } from '../../src/shared/error-code.ts'
import { BidiClient } from './bidi-client.ts'
import { startSession } from './firefox-session.ts'
import { processTable } from './process-table.ts'

/**
 * How Firefox is started. `spawn`, the default, makes it a child of this process in a new process group, as Retest
 * starts Chromium. `launch-services` asks macOS to start the app bundle with `open`. It exists for one kind of host:
 * a macOS app that may not let its children read Firefox's data folder, so a spawned Firefox never starts. It costs
 * the child relationship and the inherited environment, and makes macOS judge every file Firefox opens by Firefox's
 * own privacy grants; `docs/plans/public-beta/proofs/firefox.md` has the evidence and what was not tested.
 */
export type LaunchRoute = 'spawn' | 'launch-services'

export type FirefoxLaunchOptions = {
  /** The Firefox executable, such as `/Applications/Firefox.app/Contents/MacOS/firefox`. */
  executablePath: string
  /** Receives Firefox's stdout and stderr, and a line for each orphan the launch ended. The BiDi address is read from here. */
  logFile: string
  headless: boolean
  route: LaunchRoute
  /** Bounds the launch, from the first check until the session has named its process. */
  timeoutMs: number
  /** The client's timeout for each later command that sets none. */
  commandTimeoutMs: number
  onDiagnostic: (diagnostic: BidiDiagnostic) => void
}

/**
 * The preferences written to the profile's `user.js`. The Remote Agent also applies its own recommended preferences,
 * since `remote.prefs.recommended` is on by default, and they turn off updates, telemetry and first-run pages; these
 * name what the proof relies on instead of leaving it to that list.
 */
export const firefoxPreferences: Readonly<Record<string, string | number | boolean>> = {
  // WebDriver BiDi only. Firefox 133 still offers its deprecated CDP endpoint under other values.
  'remote.active-protocols': 1,
  // No update is downloaded or applied, and no restart is asked for, while a test runs.
  'app.update.disabledForTesting': true,
  'browser.shell.checkDefaultBrowser': false,
  // No "what's new" page opens in place of the first page, and no data policy notice is shown.
  'browser.startup.homepage_override.mstone': 'ignore',
  'datareporting.policy.dataSubmissionEnabled': false,
  // No background requests to Mozilla's servers to probe the network.
  'network.captive-portal-service.enabled': false,
  'network.connectivity-service.enabled': false,
}

/** How long ending a process waits for it to go after SIGKILL. */
export const killGraceMs = 2000

const pollMs = 20
const listeningLine = /^WebDriver BiDi listening on (ws:\/\/\S+)$/m
const folderPrefix = 'retest-firefox-'
const ownedFolder = /^retest-firefox-(\d+)-[A-Za-z0-9]+$/
// Kept out of the environment so a crash never opens Mozilla's crash reporter window on the person's screen.
const crashReporterOff = 'MOZ_CRASHREPORTER_DISABLE=1'

/** Thrown when Firefox cannot be launched. The message names the problem and what cleaning up could not do. */
export class FirefoxLaunchError extends Error {
  override readonly name = 'FirefoxLaunchError'
}

/**
 * A Firefox this launch started: the leader of its own process group, with a temporary folder that holds its profile.
 * The folder is named after this process, so a later launch can tell whose it was. Neither route keeps Firefox's exit
 * status: `spawn` does not record it, and `launch-services` cannot, since Firefox is not this process's child. The end
 * of the group is what is watched.
 */
export class FirefoxProcess {
  /** The main process, which is also its process group, and the process `session.new` named. */
  readonly pid: number
  readonly route: LaunchRoute
  /** The temporary folder the process owns. Removed when it stops. */
  readonly folder: string
  readonly profile: string
  /** Where the Remote Agent listens, such as `ws://127.0.0.1:50928`. A WebDriver BiDi session starts at its `/session`. */
  readonly webSocketUrl: string
  /** Milliseconds from the start of the launch until the address was printed. */
  readonly startupMs: number
  readonly #lastResort: () => void
  #stopping: Promise<string[]> | undefined

  constructor(fields: { pid: number; route: LaunchRoute; folder: string; webSocketUrl: string; startupMs: number }) {
    this.pid = fields.pid
    this.route = fields.route
    this.folder = fields.folder
    this.profile = profileIn(fields.folder)
    this.webSocketUrl = fields.webSocketUrl
    this.startupMs = fields.startupMs
    // Runs on a normal exit only. SIGKILL skips it, which is why every launch first ends the Firefoxes of runs that are gone.
    this.#lastResort = () => killAtExit(fields.pid, fields.folder)
    process.on('exit', this.#lastResort)
  }

  /** True while any process of the group is still there. */
  get running(): boolean {
    return groupRemains(this.pid)
  }

  /** Kills every process of the group at once, as a crash would end it. `stop` still cleans up afterwards. */
  kill(): void {
    signalGroup(this.pid, 'SIGKILL')
  }

  /** Resolves with true once no process of the group is left, or false if one still is after `timeoutMs`. */
  waitForGroupEnd(timeoutMs: number): Promise<boolean> {
    return groupEnds(this.pid, new Deadline(timeoutMs))
  }

  /**
   * Waits up to `graceMs` for the group to end, as it does after `browser.close`, kills it if any process is left,
   * waits up to `killGraceMs` more, then removes the folder. Resolves with what could not be cleaned up. A second
   * call waits for the first.
   */
  stop(graceMs: number): Promise<string[]> {
    this.#stopping ??= this.#stop(graceMs)
    return this.#stopping
  }

  async #stop(graceMs: number): Promise<string[]> {
    const problems: string[] = []
    try {
      if (!(await this.waitForGroupEnd(graceMs))) {
        signalGroup(this.pid, 'SIGKILL')
        if (!(await this.waitForGroupEnd(killGraceMs))) problems.push(`Firefox's process group ${this.pid} was still there ${killGraceMs} ms after SIGKILL.`)
      }
    } catch (error) {
      problems.push(`Could not end process group ${this.pid}: ${errorMessage(error)}`)
    } finally {
      if (!groupRemains(this.pid)) process.off('exit', this.#lastResort)
    }
    await rm(this.folder, { recursive: true, force: true, maxRetries: 3 }).catch((error: unknown) => {
      problems.push(`Could not remove the Firefox profile folder ${this.folder}: ${errorMessage(error)}`)
    })
    return problems
  }
}

/**
 * What a launch's sweep did: the Firefoxes of runs that are gone it ended, by process id, the folders of such runs
 * it removed, and what it could not do.
 */
export type SweepReport = { ended: number[]; removed: string[]; problems: string[] }

/** A launched Firefox, its one WebDriver BiDi session, what the session says of it, and what the launch swept first. */
export type LaunchedFirefox = { firefox: FirefoxProcess; client: BidiClient; session: SessionFacts; sweep: SweepReport }

/**
 * Starts Firefox with a fresh temporary profile and the WebDriver BiDi server on a port the system picks, connects,
 * starts the session and checks that `session.new` names the process and profile this launch made, so the process
 * it will later kill is the browser it drives. First it ends the Firefoxes and removes the folders of runs that are
 * no longer running. Every failure is a `FirefoxLaunchError`, and leaves no process and no profile of this launch.
 *
 * @example const { firefox, client } = await launchFirefox({ executablePath, logFile, headless: true, route: 'spawn', timeoutMs: 20_000, commandTimeoutMs: 10_000, onDiagnostic })
 */
export async function launchFirefox(options: FirefoxLaunchOptions): Promise<LaunchedFirefox> {
  const deadline = new Deadline(options.timeoutMs)
  const executable = await checkFirefox(options.executablePath)
  await mkdir(dirname(options.logFile), { recursive: true }).catch((error: unknown) => {
    throw new FirefoxLaunchError(`Cannot make the folder for the Firefox log ${options.logFile}: ${errorMessage(error)}`, { cause: error })
  })
  const sweep = await removeOrphanedFirefoxes(tmpdir())
  await logSweep(options.logFile, sweep)
  const folder = await mkdtemp(join(tmpdir(), `${folderPrefix}${process.pid}-`)).catch((error: unknown) => {
    throw new FirefoxLaunchError(`Cannot create a temporary Firefox profile: ${errorMessage(error)}`, { cause: error })
  })
  const profile = profileIn(folder)
  let pid: number | undefined
  let client: BidiClient | undefined
  try {
    await writeProfile(profile)
    const logStart = await fileSize(options.logFile)
    const args = firefoxArguments(profile, options.headless)
    pid =
      options.route === 'spawn'
        ? await spawnInGroup(executable, args, options.logFile)
        : await openWithLaunchServices({ executable, args, profile, logFile: options.logFile, deadline })
    const webSocketUrl = await waitForAddress({ pid, route: options.route, logFile: options.logFile, logStart, deadline, timeoutMs: options.timeoutMs })
    const startupMs = options.timeoutMs - deadline.remainingMs
    client = await BidiClient.connect(`${webSocketUrl}/session`, {
      timeoutMs: options.commandTimeoutMs,
      connectTimeoutMs: deadline.commandTimeoutMs,
      onDiagnostic: options.onDiagnostic,
    })
    const session = await startSession(client, deadline.commandTimeoutMs)
    if (session.processId !== pid) {
      throw new FirefoxLaunchError(`The Firefox at ${webSocketUrl} names process ${session.processId}, not the launched ${pid}, so stopping ${pid} would not stop the browser it drives.`)
    }
    if (session.profile !== profile) throw new FirefoxLaunchError(`The Firefox at ${webSocketUrl} uses the profile ${session.profile}, not ${profile}.`)
    return { firefox: new FirefoxProcess({ pid, route: options.route, folder, webSocketUrl, startupMs }), client, session, sweep }
  } catch (error) {
    client?.close()
    const problems = await cleanUp(pid, profile, folder)
    const message = error instanceof FirefoxLaunchError ? error.message : `Cannot launch Firefox: ${errorMessage(error)}`
    throw new FirefoxLaunchError(problems.length === 0 ? message : `${message} Cleaning up also failed: ${problems.join(' ')}`, { cause: error })
  }
}

/**
 * Ends the Firefoxes, and removes the profile folders, that runs no longer running left in `folder`. Chromium exits
 * when the pipe from the process that started it closes. Firefox's BiDi server is a WebSocket instead, so a runner
 * killed outright leaves its Firefox running, its profile in place and its one session taken for good. A Firefox or
 * folder whose owner is alive, or may be, is kept, and so is the folder of a Firefox that could not be ended.
 *
 * @example const { ended, removed, problems } = await removeOrphanedFirefoxes(tmpdir())
 */
export async function removeOrphanedFirefoxes(folder: string): Promise<SweepReport> {
  const report: SweepReport = { ended: [], removed: [], problems: [] }
  const stillRunning = new Set<string>()
  const marker = ` --profile ${join(folder, folderPrefix)}`
  try {
    for (const line of await processTable()) {
      const owned = ownedProfile(line.command, marker, folder)
      if (owned === undefined || isOpenCommand(line.command) || !processIsGone(owned.owner)) continue
      const problem = await endProcess(line.pid)
      if (problem === undefined) report.ended.push(line.pid)
      else {
        report.problems.push(problem)
        stillRunning.add(owned.folder)
      }
    }
  } catch (error) {
    report.problems.push(`Could not look for Firefoxes that runs no longer running left: ${errorMessage(error)}`)
  }
  let entries: Dirent[]
  try {
    entries = await readdir(folder, { withFileTypes: true })
  } catch (error) {
    report.problems.push(`Could not look for stale Firefox profiles in ${folder}: ${errorMessage(error)}`)
    return report
  }
  for (const entry of entries) {
    const owner = Number(ownedFolder.exec(entry.name)?.[1])
    const path = join(folder, entry.name)
    if (!entry.isDirectory() || !Number.isSafeInteger(owner) || owner < 1 || stillRunning.has(path) || !processIsGone(owner)) continue
    try {
      await rm(path, { recursive: true, force: true, maxRetries: 3 })
      report.removed.push(path)
    } catch (error) {
      report.problems.push(`Could not remove the stale Firefox profile ${path}: ${errorMessage(error)}`)
    }
  }
  return report
}

function profileIn(folder: string): string {
  return join(folder, 'profile')
}

function firefoxArguments(profile: string, headless: boolean): string[] {
  return [...(headless ? ['--headless'] : []), '--no-remote', '--profile', profile, '--remote-debugging-port=0', 'about:blank']
}

async function writeProfile(profile: string): Promise<void> {
  await mkdir(profile)
  const lines = Object.entries(firefoxPreferences).map(([name, value]) => `user_pref(${JSON.stringify(name)}, ${JSON.stringify(value)});`)
  await writeFile(join(profile, 'user.js'), `${lines.join('\n')}\n`)
}

async function checkFirefox(path: string): Promise<string> {
  const absolute = resolve(path)
  let stats: Stats
  try {
    stats = await stat(absolute)
  } catch (error) {
    throw new FirefoxLaunchError(`No Firefox at ${absolute}: ${errorMessage(error)}`, { cause: error })
  }
  if (!stats.isFile()) throw new FirefoxLaunchError(`${absolute} is not a file. Pass the firefox executable, such as /Applications/Firefox.app/Contents/MacOS/firefox.`)
  await access(absolute, constants.X_OK).catch((error: unknown) => {
    throw new FirefoxLaunchError(`${absolute} is not executable.`, { cause: error })
  })
  return absolute
}

async function spawnInGroup(executable: string, args: string[], logFile: string): Promise<number> {
  const log = await open(logFile, 'a')
  try {
    const child = spawn(executable, args, {
      detached: true,
      stdio: ['ignore', log.fd, log.fd],
      env: { ...process.env, MOZ_CRASHREPORTER_DISABLE: '1' },
    })
    await once(child, 'spawn').catch((error: unknown) => {
      throw new FirefoxLaunchError(`Cannot start ${executable}: ${errorMessage(error)}`, { cause: error })
    })
    if (child.pid === undefined) throw new FirefoxLaunchError(`${executable} started without a process id.`)
    return child.pid
  } finally {
    await log.close()
  }
}

type LaunchServicesStart = { executable: string; args: string[]; profile: string; logFile: string; deadline: Deadline }

/**
 * Starts the app bundle the executable belongs to through LaunchServices, always as a new instance, in the
 * background and hidden. `open` returns once the app is launched without naming it, so the process is found by the
 * profile folder in its command line, which only this launch uses, whatever path the bundle runs from.
 */
async function openWithLaunchServices({ executable, args, profile, logFile, deadline }: LaunchServicesStart): Promise<number> {
  if (process.platform !== 'darwin') throw new FirefoxLaunchError('The launch-services route needs macOS. Use the spawn route.')
  const bundle = /^(.+?\.app)\/Contents\/MacOS\/[^/]+$/.exec(executable)?.[1]
  if (bundle === undefined) throw new FirefoxLaunchError(`${executable} is not inside a macOS app bundle, so LaunchServices cannot start it.`)
  const openArgs = ['-n', '-g', '-j', '-a', bundle, '--stdout', logFile, '--stderr', logFile, '--env', crashReporterOff, '--args', ...args]
  try {
    await promisify(execFile)('/usr/bin/open', openArgs, { timeout: deadline.commandTimeoutMs })
  } catch (error) {
    throw new FirefoxLaunchError(`/usr/bin/open did not finish starting ${bundle}: ${errorMessage(error)}`, { cause: error })
  }
  const found = await findByProfile(profile, deadline)
  if (found === undefined) throw new FirefoxLaunchError(`${bundle} was opened, but no process using ${profile} appeared within the launch budget.`)
  if (found.group !== found.pid) {
    const problem = await endProcess(found.pid)
    const outcome = problem ?? 'It and the child processes naming it as their parent were killed by their process ids.'
    throw new FirefoxLaunchError(`Firefox ${found.pid} started in process group ${found.group}, not a group of its own, so this launch cannot own it. ${outcome}`)
  }
  return found.pid
}

async function findByProfile(profile: string, deadline: Deadline): Promise<{ pid: number; group: number } | undefined> {
  for (;;) {
    const found = (await processTable()).find(({ command }) => usesProfile(command, profile) && !isOpenCommand(command))
    if (found !== undefined) return found
    if (deadline.expired) return undefined
    await sleep(Math.min(pollMs, deadline.remainingMs))
  }
}

type AddressWait = { pid: number; route: LaunchRoute; logFile: string; logStart: number; deadline: Deadline; timeoutMs: number }

// Firefox prints the address on stderr once the Remote Agent listens, which is after the profile is in use.
async function waitForAddress({ pid, route, logFile, logStart, deadline, timeoutMs }: AddressWait): Promise<string> {
  for (;;) {
    const output = await readFrom(logFile, logStart)
    const address = listeningLine.exec(output)?.[1]
    if (address !== undefined) return address
    if (!groupRemains(pid)) throw new FirefoxLaunchError(`Firefox started by the ${route} route exited before it printed its WebDriver BiDi address. Its output is in ${logFile}.`)
    if (deadline.expired) throw new FirefoxLaunchError(`${await silenceExplanation(route, timeoutMs)} Its output is in ${logFile}.`)
    await sleep(Math.min(pollMs, deadline.remainingMs))
  }
}

/**
 * Why Firefox may have stayed silent. On macOS, Firefox reads its profile list in `~/Library/Application Support/Firefox`
 * even when it is given a profile, and the app a spawned Firefox runs under is the one macOS asks. A process that may
 * not read that folder is told so, with the likely cause; the dialog itself was never seen.
 */
async function silenceExplanation(route: LaunchRoute, timeoutMs: number): Promise<string> {
  const silent = `Firefox started by the ${route} route did not print its WebDriver BiDi address within ${timeoutMs} ms.`
  if (route !== 'spawn' || process.platform !== 'darwin') return silent
  const dataFolder = join(homedir(), 'Library', 'Application Support', 'Firefox')
  const refused = await readdir(dataFolder).then(
    () => false,
    (error: unknown) => errorCode(error) === 'EPERM',
  )
  if (!refused) return silent
  return `${silent} macOS does not let this process read ${dataFolder}, which Firefox reads before anything else; the likely cause is a profile dialog that headless mode never shows. Run from an app that may read that folder, such as a terminal allowed to access data from other apps, or choose the launch-services route.`
}

// A Firefox that leads its own process group is ended with all of it. One that does not, as when its group is gone or
// it never had one, is ended by its pid, with the child processes Firefox started naming it as their parent.
async function endProcess(pid: number): Promise<string | undefined> {
  const deadline = new Deadline(killGraceMs)
  if (groupRemains(pid)) {
    signalGroup(pid, 'SIGKILL')
    return (await groupEnds(pid, deadline)) ? undefined : `Firefox's process group ${pid} was still there ${killGraceMs} ms after SIGKILL.`
  }
  const children = (await processTable()).filter((line) => line.command.includes(` -parentPid ${pid} `)).map((line) => line.pid)
  const targets = [pid, ...children]
  for (const target of targets) killProcess(target)
  for (const target of targets) {
    if (!(await processEnds(target, deadline))) return `Firefox process ${target} was still there ${killGraceMs} ms after SIGKILL.`
  }
  return undefined
}

// Ends whatever this launch started: the process it knew of, and any process using its profile, such as one started
// before `open` gave up or one a failed search never matched. Then removes the folder.
async function cleanUp(pid: number | undefined, profile: string, folder: string): Promise<string[]> {
  const problems: string[] = []
  const targets = new Set<number>(pid === undefined ? [] : [pid])
  try {
    for (const line of await processTable()) if (usesProfile(line.command, profile) && !isOpenCommand(line.command)) targets.add(line.pid)
  } catch (error) {
    problems.push(`Could not look for a Firefox using ${profile}: ${errorMessage(error)}`)
  }
  for (const target of targets) {
    try {
      const problem = await endProcess(target)
      if (problem !== undefined) problems.push(problem)
    } catch (error) {
      problems.push(`Could not end Firefox ${target}: ${errorMessage(error)}`)
    }
  }
  await rm(folder, { recursive: true, force: true, maxRetries: 3 }).catch((error: unknown) => {
    problems.push(`Could not remove the Firefox profile folder ${folder}: ${errorMessage(error)}`)
  })
  return problems
}

async function logSweep(logFile: string, sweep: SweepReport): Promise<void> {
  const lines = [
    ...sweep.ended.map((pid) => `ended Firefox ${pid}, whose run is gone`),
    ...sweep.removed.map((path) => `removed ${path}, whose run is gone`),
    ...sweep.problems,
  ]
  if (lines.length === 0) return
  await appendFile(logFile, lines.map((line) => `[retest] ${line}\n`).join('')).catch(() => {
    // The log is evidence; failing to add a line to it must not stop the launch the sweep made room for.
  })
}

// The folder and the pid of the run that owns a Firefox, read from its `--profile` argument, when that names a folder
// a launch made in `folder`.
function ownedProfile(command: string, marker: string, folder: string): { owner: number; folder: string } | undefined {
  const start = command.indexOf(marker)
  if (start === -1) return undefined
  const match = /^(\d+)-([A-Za-z0-9]+)\/profile(?: |$)/.exec(command.slice(start + marker.length))
  const [, owner, suffix] = match ?? []
  if (owner === undefined || suffix === undefined) return undefined
  return { owner: Number(owner), folder: join(folder, `${folderPrefix}${owner}-${suffix}`) }
}

function usesProfile(command: string, profile: string): boolean {
  return command.includes(` --profile ${profile} `) || command.endsWith(` --profile ${profile}`)
}

// `open` carries Firefox's arguments while it starts the app; it is not the browser.
function isOpenCommand(command: string): boolean {
  return command.startsWith('/usr/bin/open ')
}

// Signal 0 only asks whether a process exists. EPERM means it does, and belongs to someone else.
function processIsGone(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    return errorCode(error) === 'ESRCH'
  }
}

function killProcess(pid: number): void {
  try {
    process.kill(pid, 'SIGKILL')
  } catch (error) {
    if (errorCode(error) !== 'ESRCH') throw error
  }
}

async function processEnds(pid: number, deadline: Deadline): Promise<boolean> {
  while (!processIsGone(pid)) {
    if (deadline.expired) return false
    await sleep(Math.min(pollMs, deadline.remainingMs))
  }
  return true
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return 0
    throw error
  }
}

// What a log holds from `start` on. A log that became shorter than `start` was replaced, and is read from its beginning.
async function readFrom(path: string, start: number): Promise<string> {
  let handle
  try {
    handle = await open(path, 'r')
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return ''
    throw error
  }
  try {
    const { size } = await handle.stat()
    const from = size < start ? 0 : start
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(size - from), 0, size - from, from)
    return buffer.toString('utf8', 0, bytesRead)
  } finally {
    await handle.close()
  }
}

// A group that cannot be asked about is counted as still there.
function groupRemains(pgid: number): boolean {
  try {
    return signalGroup(pgid, 0)
  } catch {
    return true
  }
}

async function groupEnds(pgid: number, deadline: Deadline): Promise<boolean> {
  while (groupRemains(pgid)) {
    if (deadline.expired) return false
    await sleep(Math.min(pollMs, deadline.remainingMs))
  }
  return true
}

// Runs while this process exits normally, when a failure can neither be awaited nor reported.
function killAtExit(pgid: number, folder: string): void {
  try {
    signalGroup(pgid, 'SIGKILL')
    rmSync(folder, { recursive: true, force: true, maxRetries: 3 })
  } catch {
    // Throwing here would replace the exit code this process chose.
  }
}
