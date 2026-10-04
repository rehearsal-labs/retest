import type { FrameSource } from '../media/capture.ts'
import type { RecordIdentity } from '../protocol/identity.ts'
import type { SessionIdentity } from './contract.ts'
import type { CdpSession } from './cdp/session.ts'
import type { PipeStreams, Transport } from './cdp/transport.ts'
import type {
  BrowserCommand,
  DispatchedCommand,
  NewPageOptions,
  OwnedBrowser,
  OutputRedactor,
  PageNavigation,
  PageReading,
  SessionRuntime,
  TextQuery,
  WebRuntimeIdentity,
  WebSession,
} from './contract.ts'
import type { DiagnosticCollection, DiagnosticSink } from '../diagnostics/observations.ts'
import type { DiagnosticScope } from '../protocol/diagnostics.ts'
import type { CommandResult } from '../protocol/commands.ts'
import type { Failure } from '../protocol/failures.ts'
import type { StorageState } from '../protocol/storage-state.ts'
import type { ProcessExit } from '../shared/process-exit.ts'
import { constants } from 'node:fs'
import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { chromiumScope } from '../diagnostics/chromium-collector.ts'
import { Deadline, elapsedMs, monotonicClock } from '../protocol/deadline.ts'
import { errorMessage } from '../protocol/failures.ts'
import { s } from '../protocol/schema.ts'
import { errorCode } from '../shared/error-code.ts'
import { describeExit } from '../shared/process-exit.ts'
import { BrowserError } from './browser-error.ts'
import { CdpConnection } from './cdp/connection.ts'
import { CdpClosedError, CdpDisconnectedError, CdpProtocolError, CdpTimeoutError } from './cdp/errors.ts'
import { PipeTransport } from './cdp/transport.ts'
import { readProtocol, request, sendOptions } from './cdp-results.ts'
import { ChromiumProcess } from './chromium-process.ts'
import { closeGraceMs, LaunchError } from './contract.ts'
import { worldName } from './isolated-world.ts'
import { describeDiagnostic, handshake, launchOutput, logLength, logWriter } from './launch.ts'
import { Listeners } from './listeners.ts'
import { ChromiumPage } from './page.ts'
import { changeScript } from './page-scripts.ts'
import { createTemporaryProfile, removeStaleProfiles } from './profiles.ts'
import { explainStartFailure } from './start-failure.ts'

// An Electron app driven by the Chromium driver over the debugging pipe of the app's own binary. Electron refuses
// `Target.createBrowserContext` and `Target.createTarget`, so Retest opens no page of its own: each window the app
// opens is a page target in the app's one browser context, and the first of them is the test's page. The main
// process, native menus and native dialogs are reached only through what that window shows.

/** How to launch an Electron app. Every path is absolute. */
export type ElectronLaunchOptions = {
  /** The Electron binary, inside Electron.app on macOS. */
  readonly executablePath: string
  /** The app's folder, which holds its package.json, or its entry file. */
  readonly appPath: string
  /** What the app receives after its path. */
  readonly args: readonly string[]
  /**
   * The data folder the config named, which the app keeps from one launch to the next. Retest never removes it, and
   * leaves it to Electron to make. Without it, the app gets a new folder of Retest's in the temporary folder, removed
   * when the app quits, as a browser's profile is.
   */
  readonly userDataDir?: string
  /** Where the launch writes, once the app has quit, the windows the app opened. */
  readonly windowsFile: string
  /** Receives the app's stdout and stderr, and Retest's notes on its windows. */
  readonly logFile: string
  /** Environment variables the app must not see, as a browser must not. */
  readonly hiddenVariables?: readonly string[]
  /**
   * Rewrites each line written to `logFile`, the app's own output and Retest's notes alike, as the run's redactor does,
   * since an app's main process can print what a test typed into it. Without it the lines are written as they are.
   */
  readonly redact?: (text: string) => string
  readonly redactStream?: () => OutputRedactor
  /** The app and target as the config names them, which refusals and the windows record name. */
  readonly app: string
  readonly target: string
  /** Which launch of the target this is, from 1. */
  readonly launch: number
}

/** The Electron release an app runs on, read from its binary, and the Chromium it embeds, as the app reported it. */
export type ElectronVersions = { readonly version: string; readonly chromium: string }

/**
 * An Electron app this run launched, as the runner holds it: its one page is the first window the app opened, given
 * once, and closing that page quits the app. `product` is `Electron` and `version` Electron's own.
 */
export interface ElectronRuntime extends OwnedBrowser, SessionRuntime {
  readonly identity: WebRuntimeIdentity
  readonly electron: ElectronVersions
  /** True once Retest asked the app to quit, so the disconnect that follows is no loss. */
  readonly closeRequested: boolean
  /**
   * Settles once the app's main process has exited and none of its processes is left, which can be a second after its
   * pipe closed: only then is its data folder free for another launch.
   */
  readonly gone: Promise<void>
}

/**
 * A window the app opened: its number, in the order Retest learned of the windows from 1, whether a test can reach it,
 * and when it opened and closed, in milliseconds after the launch began. Only the first window is the test's page.
 * `existing` marks a window already open when Retest began to watch the app's windows: the browser lists those in an
 * order of its own, and `openedMs` is when Retest learned of it. A window still open when the app quit has no
 * `closedMs`.
 */
export type WindowRecord = { window: number; reachable: boolean; openedMs: number; existing?: true; closedMs?: number }

/**
 * What `windowsFile` holds: the launch, the app's process, every window it opened, and `notes` on anything Retest could
 * not set up in the app's first window.
 */
export type WindowsRecord = { app: string; target: string; launch: number; pid: number; windows: WindowRecord[]; notes?: string[] }

const launchTimeoutMs = 30_000
// With it set, the Electron binary runs as plain Node and never opens the app. It reaches Retest from any parent that
// is itself an Electron app, as it did in the session that built this driver.
const runAsNode = 'ELECTRON_RUN_AS_NODE'
// Electron's own logging, which would print the windows' console lines and more into the app's output unredacted.
const loggingVariables = ['ELECTRON_ENABLE_LOGGING', 'ELECTRON_LOG_FILE', 'ELECTRON_DEBUG_NOTIFICATIONS', 'ELECTRON_LOG_ASAR_READS', 'ELECTRON_ENABLE_STACK_DUMPING']
const giveBinary = 'Give the Electron binary, inside Electron.app on macOS: Electron.app/Contents/MacOS/Electron.'

const targetInfoSchema = s.object({ targetId: s.string(), type: s.string(), browserContextId: s.optional(s.string()) })
const targetsSchema = s.object({ targetInfos: s.array(targetInfoSchema) })
const targetCreatedSchema = s.object({ targetInfo: targetInfoSchema })
const targetDestroyedSchema = s.object({ targetId: s.string() })
const frameTreeSchema = s.object({ frameTree: s.object({ frame: s.object({ id: s.string(), url: s.string() }) }) })
const worldSchema = s.object({ executionContextId: s.number({ integer: true }) })
const userAgentVersion = /\bElectron\/(\d+\.\d+\.\d+(?:-[\w.]+)?)/
const lateCaptureReason = "the app's window was already showing its page when capture began, so what the page logged or loaded before then was not captured"
const unknownStartReason = "Retest could not read whether the app's window was already showing its page when capture began, so what came before then may not have been captured"
const bundleVersion = /<key>CFBundleVersion<\/key>\s*<string>([^<]+)<\/string>/

type FirstWindow = { targetId: string; browserContextId: string }

/** A rejected launch may still own processes. Its data folder stays held until `gone` settles. */
export class ElectronLaunchError extends LaunchError {
  readonly gone: Promise<void>
  readonly outputSettled: Promise<void>

  constructor(message: string, gone: Promise<void>, cleanupProblems: readonly string[], options?: ErrorOptions, outputSettled: Promise<void> = gone) {
    super(message, { ...options, failureClass: cleanupProblems.length === 0 ? 'setup_failed' : 'cleanup_failed' })
    this.gone = gone
    this.outputSettled = outputSettled
  }
}

/**
 * Launches an Electron app this run owns, in a process group of its own, with a private debugging pipe and the data
 * folder the config named, or else a new one of Retest's, which goes when the app quits. Folders left by earlier
 * launches are retained. Waits for the first window the app opens, which becomes
 * the test's page. The app never sees `ELECTRON_RUN_AS_NODE` or `hiddenVariables`. Every failure is a `LaunchError`
 * that names the problem, and a binary that is not Electron is refused, never run as a browser. `transport` makes the
 * connection's transport from the pipe; a test passes one that watches or holds messages.
 *
 * @example const app = await launchElectron({ executablePath, appPath, args: [], windowsFile, logFile, app: 'desktop', target: 'electron', launch: 1 })
 */
export async function launchElectron(
  options: ElectronLaunchOptions,
  timeoutMs: number = launchTimeoutMs,
  transport: (pipe: PipeStreams) => Transport = (pipe) => new PipeTransport(pipe),
): Promise<ElectronRuntime> {
  const startedAt = monotonicClock()
  const deadline = new Deadline(timeoutMs, { startedAt })
  const executable = await checkElectronBinary(options.executablePath)
  await checkApp(options.appPath)
  const staleProfileProblems = await removeStaleProfiles(tmpdir())
  const dataFolder = await dataFolderFor(options.userDataDir)
  const outputStart = await logLength(options.logFile)
  const hiddenVariables = [...(options.hiddenVariables ?? []), runAsNode, ...loggingVariables]
  const args = electronArguments({ appPath: options.appPath, args: options.args, userDataDir: dataFolder.path })
  // A folder of Retest's belongs to the process from now on, so it goes when the app stops, or at once if it never starts.
  const owned = dataFolder.owner === 'retest' ? { profile: dataFolder.path } : {}
  const { redact } = options
  const redacting = redact === undefined ? {} : { redact }
  const streaming = options.redactStream === undefined ? {} : { redactStream: options.redactStream }
  const child = await ChromiumProcess.start({ executable, args, logFile: options.logFile, hiddenVariables, ...owned, ...redacting, ...streaming })
  let connection: CdpConnection | undefined
  try {
    const write = logWriter(options.logFile)
    const log = redact === undefined ? write : (line: string) => write(redact(line))
    for (const problem of staleProfileProblems) log(problem)
    // Every command Retest sends names its own timeout; the launch budget bounds any that would not.
    connection = new CdpConnection(transport(child.pipe), { timeoutMs, onDiagnostic: (diagnostic) => log(describeDiagnostic(diagnostic)) })
    const windows = new AppWindows(connection, startedAt, log)
    const version = await handshake(connection, deadline)
    // Checked before any window is reached, so a browser given in place of Electron is refused at once.
    const electron = await readElectronVersion(executable, version.userAgent)
    if (electron === undefined) throw new NotElectronError(executable)
    // The windows open before discovery begins are told in the browser's own order, so they are marked as such.
    const { targetInfos } = await request(connection, 'Target.getTargets', undefined, targetsSchema, sendOptions(deadline))
    windows.alreadyOpen(targetInfos.map((target) => target.targetId))
    await request(connection, 'Target.setDiscoverTargets', { discover: true }, s.object({}), sendOptions(deadline))
    const first = await windows.first(deadline)
    const session = await connection.attach(first.targetId, sendOptions(deadline))
    const onListenerError = (error: unknown) => log(`a listener failed: ${errorMessage(error)}`)
    const pageOptions = { connection, session, browserContextId: first.browserContextId, onListenerError }
    const page = await ChromiumPage.open({ ...pageOptions, baseUrl: undefined, emulation: undefined, restoredOrigins: [], proxyServer: undefined }, deadline)
    await observeChanges(session, deadline, (note) => {
      windows.note(note)
      log(note)
    })
    const versions = { version: electron, chromium: version.version }
    const named = { app: options.app, target: options.target, launch: options.launch, windowsFile: options.windowsFile }
    const showing = (timeoutMs: number) => showsPage(session, timeoutMs)
    return new ElectronApp({ process: child, connection, page, showsPage: showing, windows, executablePath: executable, userAgent: version.userAgent, versions, named, onListenerError })
  } catch (error) {
    const ended = error instanceof CdpDisconnectedError || error instanceof CdpClosedError
    // A program that closed its pipe is usually exiting; how it exits is the best explanation there is.
    const exit = ended ? await child.waitForExit(Math.min(deadline.remainingMs, closeGraceMs)) : undefined
    const problems: string[] = []
    try { connection?.close() } catch (closeError) { problems.push(`Could not close the Electron app's debugging pipe: ${errorMessage(closeError)}`) }
    problems.push(...await child.stop(0))
    const output = await launchOutput(options.logFile, outputStart)
    const message = launchFailure(error, { executable, appPath: options.appPath, exit, logFile: options.logFile, timeoutMs, output })
    const cleanup = problems.length === 0 ? '' : ` Cleaning up also failed: ${problems.join(' ')}`
    throw new ElectronLaunchError(`${message}${cleanup}`, child.gone(), problems, { cause: error }, child.outputSettled)
  }
}

/**
 * The arguments an Electron binary is started with: Retest's debugging pipe and the app's data folder, the app's
 * path, then the app's own arguments.
 *
 * @example electronArguments({ appPath: '/work/desktop', args: ['--tasks=3'], userDataDir: '/run/electron/1/user-data' }, 'darwin')
 */
export function electronArguments(options: Pick<ElectronLaunchOptions, 'appPath' | 'args' | 'userDataDir'>, platform: NodeJS.Platform = process.platform): string[] {
  return [
    '--remote-debugging-pipe',
    `--user-data-dir=${options.userDataDir}`,
    // Chromium's fake keychain, so the app's safe storage never reaches the login keychain the person's own apps use.
    ...(platform === 'darwin' ? ['--use-mock-keychain'] : []),
    options.appPath,
    ...options.args,
  ]
}

/**
 * The Electron release a binary runs, from what the binary states: the Electron framework's bundle on macOS, the
 * `version` file beside the binary in Electron's own builds, or else the user agent the app reported. Undefined when
 * none of them names one, as for a binary that is not Electron.
 *
 * @example await readElectronVersion('/opt/Electron.app/Contents/MacOS/Electron', userAgent) // '44.5.1'
 */
export async function readElectronVersion(executablePath: string, userAgent: string): Promise<string | undefined> {
  const folder = dirname(executablePath)
  const plist = await readFile(join(folder, '..', 'Frameworks', 'Electron Framework.framework', 'Resources', 'Info.plist'), 'utf8').catch(() => undefined)
  const bundled = plist === undefined ? undefined : bundleVersion.exec(plist)?.[1]?.trim()
  if (bundled !== undefined && bundled !== '') return bundled
  const file = (await readFile(join(folder, 'version'), 'utf8').catch(() => undefined))?.trim()
  if (file !== undefined && /^\d+\.\d+\.\d+/.test(file)) return file
  return userAgentVersion.exec(userAgent)?.[1]
}

/**
 * The windows an app opens, as target discovery tells of them: the first is the test's page, and every later one is
 * recorded and left alone. Notes say what Retest could not set up in the first window.
 *
 * @example const windows = new AppWindows(connection, monotonicClock(), log)
 */
export class AppWindows {
  readonly #startedAt: number
  readonly #log: (line: string) => void
  readonly #windows: (WindowRecord & { targetId: string })[] = []
  readonly #existing = new Set<string>()
  readonly #notes: string[] = []
  readonly #first = Promise.withResolvers<FirstWindow>()
  readonly #ended = Promise.withResolvers<string>()

  constructor(connection: CdpConnection, startedAt: number, log: (line: string) => void) {
    this.#startedAt = startedAt
    this.#log = log
    connection.on('Target.targetCreated', (params) => this.#created(params))
    connection.on('Target.targetDestroyed', (params) => this.#destroyed(params))
    connection.onDisconnect((reason) => this.#ended.resolve(reason))
    if (connection.closeReason !== undefined) this.#ended.resolve(connection.closeReason)
  }

  get records(): WindowRecord[] {
    return this.#windows.map(({ window, reachable, openedMs, existing, closedMs }) => ({
      window,
      reachable,
      openedMs,
      ...(existing === undefined ? {} : { existing }),
      ...(closedMs === undefined ? {} : { closedMs }),
    }))
  }

  get notes(): string[] {
    return [...this.#notes]
  }

  /** The targets open before discovery began, by id. */
  alreadyOpen(targetIds: readonly string[]): void {
    for (const id of targetIds) this.#existing.add(id)
  }

  note(text: string): void {
    this.#notes.push(text)
  }

  /** True once the first window, the test's page, has closed. */
  get firstClosed(): boolean {
    return this.#windows[0]?.closedMs !== undefined
  }

  /** Waits for the first window within the deadline; rejects when the app goes first, or opens none in time. */
  async first(deadline: Deadline): Promise<FirstWindow> {
    const timer = new AbortController()
    const waited = sleep(deadline.remainingMs, 'expired' as const, { signal: timer.signal }).catch(() => 'stopped' as const)
    try {
      const outcome = await Promise.race([this.#first.promise, this.#ended.promise.then((reason) => ({ ended: reason })), waited])
      if (outcome === 'expired' || outcome === 'stopped') throw new NoWindowError(deadline.budgetMs)
      if ('ended' in outcome) throw new CdpDisconnectedError({ method: 'Target.targetCreated', sessionId: undefined }, { reason: outcome.ended, written: false })
      return outcome
    } finally {
      timer.abort()
    }
  }

  #created(params: unknown): void {
    const { targetInfo } = readProtocol(targetCreatedSchema, params, { method: 'Target.targetCreated' })
    if (targetInfo.type !== 'page') return
    const number = this.#windows.length + 1
    const existing = this.#existing.has(targetInfo.targetId) ? { existing: true as const } : {}
    this.#windows.push({ window: number, reachable: number === 1, openedMs: elapsedMs(this.#startedAt), ...existing, targetId: targetInfo.targetId })
    if (number === 1) this.#first.resolve({ targetId: targetInfo.targetId, browserContextId: targetInfo.browserContextId ?? '' })
    else this.#log(`the app opened window ${number}; a test reaches only the app's first window`)
  }

  #destroyed(params: unknown): void {
    const { targetId } = readProtocol(targetDestroyedSchema, params, { method: 'Target.targetDestroyed' })
    const window = this.#windows.find((entry) => entry.targetId === targetId)
    if (window === undefined || window.closedMs !== undefined) return
    window.closedMs = elapsedMs(this.#startedAt)
    if (window.window === 1) this.#log('the app closed its first window, which was the test\'s page')
  }
}

type AppOptions = {
  process: ChromiumProcess
  connection: CdpConnection
  page: ChromiumPage
  showsPage: (timeoutMs: number) => Promise<boolean>
  windows: AppWindows
  executablePath: string
  userAgent: string
  versions: ElectronVersions
  named: { app: string; target: string; launch: number; windowsFile: string }
  onListenerError: (error: unknown) => void
}

/** An Electron app this run launched and owns. */
class ElectronApp implements ElectronRuntime {
  readonly product = 'Electron'
  readonly version: string
  readonly userAgent: string
  readonly pid: number
  readonly executablePath: string
  readonly electron: ElectronVersions
  readonly gone: Promise<void>
  readonly outputSettled: Promise<void>
  readonly #process: ChromiumProcess
  readonly #connection: CdpConnection
  readonly #page: ElectronWindowSession
  readonly #windows: AppWindows
  readonly #named: AppOptions['named']
  readonly #onListenerError: (error: unknown) => void
  readonly #disconnects: Listeners<string>
  readonly #cleanupProblems: string[] = []
  #disconnectReason: string | undefined
  #closeRequested = false
  #closing: Promise<void> | undefined
  #pageGiven = false

  constructor(options: AppOptions) {
    this.version = options.versions.version
    this.electron = options.versions
    this.userAgent = options.userAgent
    this.pid = options.process.pid
    this.executablePath = options.executablePath
    this.gone = options.process.gone()
    this.outputSettled = options.process.outputSettled
    this.#process = options.process
    this.#connection = options.connection
    this.#windows = options.windows
    this.#named = options.named
    this.#onListenerError = options.onListenerError
    this.#disconnects = new Listeners(options.onListenerError)
    const { app, target } = this.#named
    const parts = { window: options.page, app, target, showsPage: options.showsPage, firstClosed: () => this.#firstClosed(), quit: (timeoutMs: number) => this.close(timeoutMs) }
    this.#page = new ElectronWindowSession(parts)
    this.#connection.onDisconnect((reason) => this.#disconnected(reason))
    if (this.#connection.closeReason !== undefined) this.#disconnected(this.#connection.closeReason)
    void this.#process.exited.then((exit) => {
      try { this.#disconnected(`the Electron app ended with ${describeExit(exit)}`) }
      catch (error) { this.#cleanupProblems.push(`Could not report the Electron app's process exit: ${errorMessage(error)}`) }
      try { this.#connection.close() }
      catch (error) { this.#cleanupProblems.push(`Could not close the Electron app's debugging pipe: ${errorMessage(error)}`) }
    })
  }

  get connected(): boolean {
    return this.#disconnectReason === undefined
  }

  get closeRequested(): boolean {
    return this.#closeRequested
  }

  get identity(): WebRuntimeIdentity {
    return { kind: 'web', engine: 'chromium', product: this.product, version: this.version, executablePath: this.executablePath, processIds: [this.pid] }
  }

  /**
   * The app's first window, given once, as the test's page. The app has no address and keeps its own storage, so a
   * base URL, an emulated screen, a proxy or a saved state is refused by name, never dropped.
   */
  async newPage(options: NewPageOptions, _timeoutMs: number): Promise<WebSession> {
    const { app } = this.#named
    if (this.#disconnectReason !== undefined) {
      throw new BrowserError({ class: 'session_lost', message: `Could not reach the Electron app ${app}, because it is gone: ${this.#disconnectReason}.` })
    }
    const refused = electronPageRefusal(options)
    if (refused !== undefined) throw new BrowserError({ class: 'unsupported', message: `The Electron app ${app} ${refused}`, details: { app, target: this.#named.target } })
    if (this.#pageGiven) throw new BrowserError({ class: 'setup_failed', message: `The first window of the Electron app ${app} is already a test's page.` })
    this.#pageGiven = true
    return this.#page
  }

  onDisconnect(listener: (reason: string) => void): () => void {
    const reason = this.#disconnectReason
    if (reason === undefined) return this.#disconnects.add(listener)
    // A listener that arrives after the disconnect still hears about it, once.
    const late = new Listeners<string>(this.#onListenerError)
    const remove = late.add(listener)
    queueMicrotask(() => late.emit(reason))
    return remove
  }

  /**
   * Quits the app: closes its debugging pipe, which Electron quits on whether or not the app keeps running with no
   * windows, waits up to `closeGraceMs` within `timeoutMs` for its process group to go, kills what is left, removes the
   * data folder when it was Retest's, and then writes the windows it opened to `windowsFile`. A data folder the config
   * named stays as the app left it. A second call waits for the first.
   */
  close(timeoutMs: number): Promise<void> {
    this.#closing ??= this.#close(timeoutMs)
    return this.#closing
  }

  async #close(timeoutMs: number): Promise<void> {
    this.#closeRequested = true
    this.#process.recordDescendants()
    const problems: string[] = []
    try { this.#connection.close() }
    catch (error) { problems.push(`Could not close the Electron app's debugging pipe: ${errorMessage(error)}`) }
    const graceMs = Math.max(0, Math.min(closeGraceMs, timeoutMs - closeGraceMs))
    problems.push(...await this.#process.stop(graceMs), ...this.#cleanupProblems)
    const { app, target, launch, windowsFile } = this.#named
    const notes = this.#windows.notes
    const record: WindowsRecord = { app, target, launch, pid: this.pid, windows: this.#windows.records, ...(notes.length === 0 ? {} : { notes }) }
    await mkdir(dirname(windowsFile), { recursive: true })
      .then(() => writeFile(windowsFile, `${JSON.stringify(record, null, 2)}\n`))
      .catch((error: unknown) => problems.push(`Could not write the Electron app's windows to ${windowsFile}: ${errorMessage(error)}`))
    if (problems.length > 0) throw new BrowserError({ class: 'cleanup_failed', message: problems.join(' ') })
  }

  // Only while the app is still there: once it has gone, its loss is the failure that says so.
  #firstClosed(): boolean {
    return this.connected && this.#windows.firstClosed
  }

  #disconnected(reason: string): void {
    if (this.#disconnectReason !== undefined) return
    this.#disconnectReason = this.#closeRequested ? 'Retest quit the Electron app' : reason
    this.#disconnects.emit(this.#disconnectReason)
  }
}

/**
 * What an Electron app's window session is made of: the window, a Chromium page in the app's own browser context; the
 * app and target the config names; whether the window shows a page of the app's own, read from the window within a
 * budget; whether it has closed while the app runs on; and how to quit the app.
 */
export type ElectronWindowParts = {
  window: WebSession
  app: string
  target: string
  showsPage: (timeoutMs: number) => Promise<boolean>
  firstClosed: () => boolean
  quit: (timeoutMs: number) => Promise<void>
}

/**
 * The app's first window as a test's page, as the runner holds it. It has no address to go to and no state Retest can
 * save, its diagnostics say what came before capture began was missed, and closing it quits the app. Every other
 * command goes to the window as it goes to a browser's page.
 *
 * @example new ElectronWindowSession({ window, app: 'desktop', target: 'electron', firstClosed: () => false, quit: (timeoutMs) => app.close(timeoutMs) })
 */
export class ElectronWindowSession implements WebSession {
  readonly #window: WebSession
  readonly #app: string
  readonly #target: string
  readonly #showsPage: (timeoutMs: number) => Promise<boolean>
  readonly #firstClosed: () => boolean
  readonly #quit: (timeoutMs: number) => Promise<void>

  constructor(parts: ElectronWindowParts) {
    this.#window = parts.window
    this.#app = parts.app
    this.#target = parts.target
    this.#showsPage = parts.showsPage
    this.#firstClosed = parts.firstClosed
    this.#quit = parts.quit
  }

  get url(): string | undefined {
    return this.#window.url
  }

  async execute(command: BrowserCommand, timeoutMs: number, signal?: AbortSignal, commandToken?: number): Promise<CommandResult> {
    return (await this.dispatch(command, timeoutMs, signal, commandToken)).result
  }

  // `goto` is refused before anything reaches the window. reload, goBack and goForward go to it as they go to a
  // browser's page.
  identify(session: SessionIdentity): void { this.#window.identify?.(session) }

  frameSource(identity: RecordIdentity): FrameSource {
    if (this.#window.frameSource === undefined) throw new BrowserError({ class: 'unsupported', message: 'The window provides no frame source.' })
    return this.#window.frameSource(identity)
  }

  async dispatch(command: BrowserCommand, timeoutMs: number, signal?: AbortSignal, commandToken?: number): Promise<DispatchedCommand> {
    if (command.kind === 'goto') return { result: { ok: false, failure: this.#noAddress() }, input: 'not_sent' }
    const answer = await this.#window.dispatch(command, timeoutMs, signal, commandToken)
    if (answer.result.ok || !this.#firstClosed()) return answer
    const { failure } = answer.result
    if (failure.class !== 'session_lost' && failure.class !== 'outcome_unknown') return answer
    return { ...answer, result: { ok: false, failure: { ...failure, message: `${failure.message} The Electron app closed its first window, and a test reaches no other window of it.` } } }
  }

  capture(timeoutMs: number): ReturnType<NonNullable<WebSession['capture']>> {
    return this.#window.capture === undefined ? Promise.resolve({ ok: false, failure: { class: 'unsupported', message: 'The window provides no attributed capture.' } }) : this.#window.capture(timeoutMs)
  }

  screenshot(timeoutMs: number): Promise<Uint8Array> {
    return this.#window.screenshot(timeoutMs)
  }

  readPage(queries: readonly TextQuery[], timeoutMs: number): Promise<PageReading> {
    return this.#window.readPage(queries, timeoutMs)
  }

  onNavigation(listener: (navigation: PageNavigation) => void): () => void {
    return this.#window.onNavigation(listener)
  }

  // The app opens its window as it starts, before any test asks for it, while a browser's page is still blank by then. A
  // window already showing a page once capture runs has had time to log and load what nobody heard. The window itself
  // is asked, after capture started, since the page may have missed the commit of a document that came first.
  async collectDiagnostics(sink: DiagnosticSink, timeoutMs: number): Promise<DiagnosticCollection> {
    if (this.#window.collectDiagnostics === undefined) throw new BrowserError({ class: 'unsupported', message: 'This window collects no diagnostics.' })
    const deadline = new Deadline(timeoutMs)
    const collection = await this.#window.collectDiagnostics(sink, deadline.commandTimeoutMs)
    const shown = await this.#showsPage(deadline.commandTimeoutMs).catch(() => undefined)
    const late = shown === false ? {} : { startedLate: shown === true ? lateCaptureReason : unknownStartReason }
    return { scope: electronScope, ...late, stop: () => collection.stop() }
  }

  async captureState(_timeoutMs: number): Promise<StorageState> {
    const message = `Retest cannot save a sign-in state from the Electron app ${this.#app}: the app keeps its own storage. Set userDataDir to keep the app's data from one launch to the next.`
    throw new BrowserError({ class: 'unsupported', message, details: { app: this.#app, target: this.#target } })
  }

  /** Quits the app, which the window belongs to. */
  dispose(timeoutMs: number): Promise<void> {
    return this.#quit(timeoutMs)
  }

  #noAddress(): Failure {
    const message = `goto() is not available on the Electron app ${this.#app} (target ${this.#target}): the app has no address, and the test's page is the first window the app opened.`
    return { class: 'unsupported', message, details: { app: this.#app, target: this.#target, command: 'goto' } }
  }
}

/**
 * What an Electron app's page cannot take of the options it was opened with, as the end of a sentence that names the
 * app, or undefined when it takes them all. The app has no address and keeps its own storage, so each is refused by
 * name rather than dropped.
 *
 * @example electronPageRefusal({ baseUrl: 'http://127.0.0.1:4173' }) // "has no address, so it takes no base URL: …"
 */
export function electronPageRefusal(options: NewPageOptions): string | undefined {
  if (options.baseUrl !== undefined) return 'has no address, so it takes no base URL: the test\'s page is the first window the app opened.'
  if (options.emulation !== undefined) return 'shows its own windows, so Retest emulates no screen in them.'
  if (options.proxy !== undefined) return 'sends its requests its own way, so Retest gives it no proxy.'
  if (options.storageState !== undefined) {
    return 'keeps its own storage, so Retest cannot restore a saved sign-in state into it. Set userDataDir to keep the app\'s data from one launch to the next.'
  }
  return undefined
}

/**
 * What a capture on an Electron app's window covers: what a Chromium page covers, and never the app's main process,
 * whose own console and requests run outside every window, nor the app's other windows, which a test does not reach.
 */
export const electronScope: DiagnosticScope = {
  ...chromiumScope,
  console: { covered: [...chromiumScope.console.covered], notCovered: [...chromiumScope.console.notCovered, 'main_process', 'other_windows'] },
  network: { covered: [...chromiumScope.network.covered], notCovered: [...chromiumScope.network.notCovered, 'main_process', 'other_windows'] },
  reason: "An Electron app's main process runs outside its windows, and Retest reaches only the first window, so neither the main process's own console and requests nor the app's other windows are captured.",
}

/**
 * Starts Retest's change observer in the window's current document. The app's first document may have loaded before
 * Retest attached: Electron reads its pipe only once the app is ready, and by then the app may have opened its window.
 * Scripts Retest adds run in later documents, so the observer is started in this one too; the input guard is made by the
 * first action, as in any document that lacks it. When the window refuses, as when its document goes in between, `note`
 * hears why: until the next document, a check in this one waits out its timer instead of waking on a change.
 *
 * @example await observeChanges(session, deadline, (note) => log(note))
 */
export async function observeChanges(session: CdpSession, deadline: Deadline, note: (text: string) => void): Promise<void> {
  try {
    const { frameTree } = await request(session, 'Page.getFrameTree', undefined, frameTreeSchema, sendOptions(deadline))
    const params = { frameId: frameTree.frame.id, worldName }
    const { executionContextId } = await request(session, 'Page.createIsolatedWorld', params, worldSchema, sendOptions(deadline))
    await request(session, 'Runtime.evaluate', { expression: changeScript, contextId: executionContextId }, s.object({}), sendOptions(deadline))
  } catch (error) {
    if (!(error instanceof CdpProtocolError)) throw error
    note(`Retest could not start its change observer in the first window's document (${errorMessage(error)}), so checks there wait out their timers until the window opens another document`)
  }
}

/**
 * Checks, without starting anything, that an Electron target's binary can run and that its app is where it says.
 * Throws a `LaunchError` that names the problem.
 *
 * @example await checkElectronFiles('/opt/Electron.app/Contents/MacOS/Electron', '/work/desktop')
 */
export async function checkElectronFiles(executablePath: string, appPath: string): Promise<void> {
  await checkElectronBinary(executablePath)
  await checkApp(appPath)
}

// Whether a window holds a document of the app's own, rather than the empty one a new window starts with.
async function showsPage(session: CdpSession, timeoutMs: number): Promise<boolean> {
  const { frameTree } = await request(session, 'Page.getFrameTree', undefined, frameTreeSchema, { timeoutMs })
  const { url } = frameTree.frame
  return url !== '' && url !== 'about:blank'
}

async function checkElectronBinary(path: string): Promise<string> {
  const absolute = resolve(path)
  const stats = await stat(absolute).catch((error: unknown) => {
    const code = errorCode(error)
    const message = code === 'ENOENT' || code === 'ENOTDIR' ? `No Electron binary at ${absolute}. ${giveBinary}` : `Cannot read ${absolute}: ${errorMessage(error)}`
    throw new LaunchError(message, { cause: error })
  })
  if (stats.isDirectory()) {
    const inside = absolute.endsWith('.app') ? ` Give the executable inside it: ${join(absolute, 'Contents', 'MacOS', 'Electron')} for Electron's own build.` : ` ${giveBinary}`
    throw new LaunchError(`${absolute} is a folder.${inside}`)
  }
  if (!stats.isFile()) throw new LaunchError(`${absolute} is not a file. ${giveBinary}`)
  await access(absolute, constants.X_OK).catch((error: unknown) => {
    throw new LaunchError(`${absolute} is not executable. Allow it to run, or give another Electron binary.`, { cause: error })
  })
  return absolute
}

// Electron shows a dialog of its own for an app it cannot find, and that dialog waits for a person, so a path that
// cannot be an app is refused before anything starts.
async function checkApp(appPath: string): Promise<void> {
  const stats = await stat(appPath).catch((error: unknown) => {
    throw new LaunchError(`No Electron app at ${appPath}: give the app's folder, which holds its package.json, or its entry file.`, { cause: error })
  })
  if (!stats.isDirectory()) return
  const entries = await Promise.all(['package.json', 'index.js'].map((name) => stat(join(appPath, name)).then(() => true, () => false)))
  if (!entries.includes(true)) throw new LaunchError(`${appPath} holds no package.json or index.js, so Electron would not find an app in it.`)
}

// The folder the config named, or a new one of Retest's, named as a browser profile is so a later run can tell whose
// it was.
async function dataFolderFor(named: string | undefined): Promise<{ path: string; owner: 'config' | 'retest' }> {
  if (named !== undefined) return { path: named, owner: 'config' }
  const path = await createTemporaryProfile(tmpdir()).catch((error: unknown) => {
    throw new LaunchError(`Cannot create a temporary data folder for the Electron app: ${errorMessage(error)}`, { cause: error })
  })
  return { path, owner: 'retest' }
}

class NoWindowError extends Error {
  override readonly name = 'NoWindowError'

  constructor(timeoutMs: number) {
    super(`the app opened no window within ${timeoutMs} ms`)
  }
}

class NotElectronError extends Error {
  override readonly name = 'NotElectronError'

  constructor(executable: string) {
    super(`${executable} answered as Chromium, but it is not Electron: its binary names no Electron release, and neither does its user agent.`)
  }
}

type FailureContext = { executable: string; appPath: string; exit: ProcessExit | undefined; logFile: string; timeoutMs: number; output: string }

function launchFailure(error: unknown, { executable, appPath, exit, logFile, timeoutMs, output }: FailureContext): string {
  const explained = explainStartFailure(output)
  const advice = `${explained === undefined ? '' : `${explained} `}Its output is in ${logFile}.`
  if (error instanceof NotElectronError) return `${error.message} ${giveBinary}`
  if (error instanceof NoWindowError) return `The Electron app ${appPath} opened no window within ${timeoutMs} ms. ${advice}`
  if (error instanceof CdpTimeoutError) return `${executable} did not answer over its debugging pipe within ${timeoutMs} ms. ${advice}`
  if (exit !== undefined) return `${executable} exited with ${describeExit(exit)} before the app opened a window. ${advice}`
  if (error instanceof CdpDisconnectedError || error instanceof CdpClosedError) return `${executable} closed its debugging pipe before the app opened a window. ${advice}`
  return `${executable} started, but Retest could not reach the app's first window: ${errorMessage(error)}. ${advice}`
}
