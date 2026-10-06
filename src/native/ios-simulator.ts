import type { AppBuild, NativeRuntime, NativeRuntimeIdentity, ResetPolicy } from '../browser/contract.ts'
import type { Failure } from '../protocol/failures.ts'
import type { ExecutorBuild, NativePinSet } from './executors.ts'
import type { AppBundle, NativeExecutionIdentity, SimulatorDevice } from './identity.ts'
import type { CommandResult, NativeTools, RecordedProcess, StartedProcess } from './processes.ts'
import type { AppProcessReading, CaptureSource, DriverAnswer, LaunchSpec, NativeAppDriver, NativeSessionOptions } from './session.ts'
import type { ScopedSource } from './source-scope.ts'
import type { ExecutorAppState, ExecutorSession, RequestBounds } from './webdriver-client.ts'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { Deadline } from '../protocol/deadline.ts'
import { errorMessage } from '../protocol/failures.ts'
import { isPlainObject } from '../protocol/schema.ts'
import { freePort, holdPort, isListening, screenStreamRefused, startExecutor, watchExecutor } from './executor-process.ts'
import { checkXcode, nativePins } from './executors.ts'
import { appNames, nativeExecutionIdentity, readAppBundle, runtimeIdentity } from './identity.ts'
import { childEnvironment, commandOf, describeCommand, endProblem, endRecorded, killRecordedNow, listProcesses, OwnedProcess, processExists, recordedIdentity, runCommand } from './processes.ts'
import { iosSimulatorResetPolicy } from './reset-policy.ts'
import { NativeAppSession, NativeError, SerialLane } from './session.ts'
import { makeOwnedFolder } from './temporary-folders.ts'
import { ExecutorClient } from './webdriver-client.ts'

// The iOS simulator lifecycle through simctl, and WebDriverAgent inside it. Each runtime creates a simulator of its
// own from the target's device type and runtime, boots it, starts WebDriverAgent in it with xcodebuild, and at the
// end stops WebDriverAgent, shuts the simulator down and deletes it. It acts on no simulator it did not create, and
// every process it starts leads a process group of its own.

/** An installed simulator runtime, as simctl lists it. */
export type SimulatorRuntime = { readonly identifier: string; readonly name: string; readonly version: string; readonly build: string }

/** A device type, as simctl lists it. */
export type DeviceType = { readonly identifier: string; readonly name: string }

/** A simulator, as simctl lists it. */
export type ListedSimulator = { readonly udid: string; readonly name: string; readonly state: string; readonly runtime: string }

/** The iOS target a runtime starts for: the app's simulator build, by absolute path, and the simulator's device type and iOS version. */
export type IosSimulatorTargetSpec = { readonly appPath: string; readonly device: string; readonly runtime: string }

/** What starting an iOS simulator runtime needs. */
export type IosRuntimeOptions = {
  readonly target: IosSimulatorTargetSpec
  /** A WebDriverAgent build for the tested set, from `ensureExecutorBuild`. */
  readonly build: ExecutorBuild
  readonly pins?: NativePinSet | undefined
  readonly tools: NativeTools
  /** Where xcodebuild's output goes. */
  readonly logFolder: string
  readonly redact?: ((text: string) => string) | undefined
  readonly hiddenVariables?: readonly string[] | undefined
  /** The whole start, from the first simctl call to WebDriverAgent answering. */
  readonly timeoutMs: number
  readonly signal?: AbortSignal | undefined
  /** WebDriverAgent's port on 127.0.0.1; a free one by default. */
  readonly port?: number | undefined
}

// Retest's simulators are named for the process that made them, so a later run can tell one whose maker is gone.
const simulatorName = /^retest-native-(\d+)-[0-9a-f]{8}$/

/**
 * The iOS runtimes simctl can run, or the failure that says why they cannot be read.
 *
 * @example (await listSimulatorRuntimes(systemTools, { timeoutMs: 30_000 }))
 */
export async function listSimulatorRuntimes(tools: NativeTools, bounds: RequestBounds): Promise<SimulatorRuntime[] | Failure> {
  const listed = await simctlJson(tools, ['list', 'runtimes'], bounds)
  if (!listed.ok) return listed.failure
  const runtimes = isPlainObject(listed.value) ? listed.value['runtimes'] : undefined
  if (!Array.isArray(runtimes)) return []
  return runtimes.filter(isPlainObject).filter((runtime) => runtime['platform'] === 'iOS' && runtime['isAvailable'] === true).map((runtime) => ({
    identifier: text(runtime['identifier']),
    name: text(runtime['name']),
    version: text(runtime['version']),
    build: text(runtime['buildversion']),
  }))
}

/**
 * The device types simctl knows.
 *
 * @example (await listDeviceTypes(systemTools, { timeoutMs: 30_000 }))
 */
export async function listDeviceTypes(tools: NativeTools, bounds: RequestBounds): Promise<DeviceType[] | Failure> {
  const listed = await simctlJson(tools, ['list', 'devicetypes'], bounds)
  if (!listed.ok) return listed.failure
  const types = isPlainObject(listed.value) ? listed.value['devicetypes'] : undefined
  if (!Array.isArray(types)) return []
  return types.filter(isPlainObject).map((type) => ({ identifier: text(type['identifier']), name: text(type['name']) }))
}

/**
 * Every simulator simctl lists, with its state.
 *
 * @example (await listSimulators(systemTools, { timeoutMs: 30_000 }))
 */
export async function listSimulators(tools: NativeTools, bounds: RequestBounds): Promise<ListedSimulator[] | Failure> {
  const listed = await simctlJson(tools, ['list', 'devices'], bounds)
  if (!listed.ok) return listed.failure
  const byRuntime = isPlainObject(listed.value) ? listed.value['devices'] : undefined
  if (!isPlainObject(byRuntime)) return []
  return Object.entries(byRuntime).flatMap(([runtime, devices]) =>
    (Array.isArray(devices) ? devices.filter(isPlainObject) : []).map((device) => ({ udid: text(device['udid']), name: text(device['name']), state: text(device['state']), runtime })),
  )
}

/**
 * The device type and runtime a target names, matched exactly by name and version. The runtime must be one of the
 * tested set; a target that names another fails setup, naming what is installed.
 *
 * @example await resolveSimulatorTarget({ device: 'iPhone 17', runtime: '26.5' }, nativePins, systemTools, { timeoutMs: 30_000 })
 */
export async function resolveSimulatorTarget(target: { readonly device: string; readonly runtime: string }, pins: NativePinSet, tools: NativeTools, bounds: RequestBounds): Promise<{ readonly ok: true; readonly deviceType: DeviceType; readonly runtime: SimulatorRuntime } | { readonly ok: false; readonly failure: Failure }> {
  const runtimes = await listSimulatorRuntimes(tools, bounds)
  if (!Array.isArray(runtimes)) return { ok: false, failure: runtimes }
  const runtime = runtimes.find((candidate) => candidate.version === target.runtime || candidate.identifier === target.runtime)
  if (runtime === undefined) {
    const installed = runtimes.length === 0 ? 'none is installed' : `installed: ${runtimes.map((candidate) => `${candidate.version} (${candidate.build})`).join(', ')}`
    return refused(`No iOS ${target.runtime} simulator runtime is available; ${installed}. Install one with xcodebuild -downloadPlatform iOS.`)
  }
  if (!pins.toolchain.iosRuntimes.some((pinned) => pinned.version === runtime.version && pinned.build === runtime.build)) {
    return refused(`The iOS ${runtime.version} (${runtime.build}) runtime is not in the tested set (${pins.toolchain.iosRuntimes.map((pinned) => `${pinned.version} (${pinned.build})`).join(', ')}).`)
  }
  const types = await listDeviceTypes(tools, bounds)
  if (!Array.isArray(types)) return { ok: false, failure: types }
  const deviceType = types.find((candidate) => candidate.name === target.device || candidate.identifier === target.device)
  if (deviceType === undefined) return refused(`simctl knows no device type named ${JSON.stringify(target.device)}.`)
  return { ok: true, deviceType, runtime }
}

/**
 * Creates a simulator and returns its id.
 *
 * @example await createSimulator(systemTools, { name, deviceType, runtime }, { timeoutMs: 60_000 })
 */
export async function createSimulator(tools: NativeTools, spec: { readonly name: string; readonly deviceType: string; readonly runtime: string }, bounds: RequestBounds): Promise<{ readonly ok: true; readonly udid: string } | { readonly ok: false; readonly failure: Failure; readonly started: boolean }> {
  const result = await simctl(tools, ['create', spec.name, spec.deviceType, spec.runtime], bounds)
  const udid = result.stdout.trim()
  if (result.code === 0 && /^[0-9A-F-]{36}$/i.test(udid)) return { ok: true, udid }
  return { ok: false, failure: simctlFailure('xcrun simctl create', result), started: result.started }
}

/** Boots a simulator and waits until it has finished booting. */
export async function bootSimulator(tools: NativeTools, udid: string, bounds: RequestBounds): Promise<Failure | undefined> {
  const deadline = new Deadline(bounds.timeoutMs)
  const booted = await simctl(tools, ['boot', udid], bounds)
  // A device that is already booted says so with a failing exit; the status wait below decides.
  if (booted.code !== 0 && !/current state: Booted/i.test(booted.stderr)) return simctlFailure('xcrun simctl boot', booted)
  const status = await simctl(tools, ['bootstatus', udid, '-b'], { timeoutMs: deadline.commandTimeoutMs, signal: bounds.signal })
  return status.code === 0 ? undefined : simctlFailure('xcrun simctl bootstatus', status)
}

/** Installs an app bundle on a booted simulator. */
export async function installOnSimulator(tools: NativeTools, udid: string, appPath: string, bounds: RequestBounds): Promise<CommandResult> {
  return simctl(tools, ['install', udid, appPath], bounds)
}

/** Launches an installed app with simctl, outside XCTest, with its arguments and its environment through simctl's prefix. */
export async function launchOnSimulator(tools: NativeTools, udid: string, bundleId: string, launch: LaunchSpec, bounds: RequestBounds): Promise<CommandResult> {
  const environment = Object.fromEntries(Object.entries(launch.environment).map(([name, value]) => [`SIMCTL_CHILD_${name}`, value]))
  return runCommand(tools.xcrun, ['simctl', 'launch', udid, bundleId, ...launch.arguments], { ...bounds, environment, hiddenVariables: tools.hiddenVariables })
}

/** Terminates an app on a simulator with simctl. */
export async function terminateOnSimulator(tools: NativeTools, udid: string, bundleId: string, bounds: RequestBounds): Promise<CommandResult> {
  return simctl(tools, ['terminate', udid, bundleId], bounds)
}

/**
 * Whether an app's process runs on a simulator, from the simulator's own launchd: a running app is listed as
 * `UIKitApplication:<bundle id>[…]` with its pid. A simulator's processes are the Mac's own, so each comes with its
 * command line and start as `ps` shows them; one that ended since the listing is left out.
 *
 * @example await simulatorAppProcesses(systemTools, udid, 'dev.retest.fixtures.taskphone', { timeoutMs: 10_000 }) // { ok: true, running: true, pids: [4242], processes: [{ pid: 4242, command: '/…/TaskPhone.app/TaskPhone', startedAt: 'Mon Oct 5 11:18:31 2026' }] }
 */
export async function simulatorAppProcesses(tools: NativeTools, udid: string, bundleId: string, bounds: RequestBounds): Promise<AppProcessReading> {
  const result = await simctl(tools, ['spawn', udid, 'launchctl', 'list'], bounds)
  if (result.code !== 0) return { ok: false, problem: describeCommand('xcrun simctl spawn launchctl list', result) }
  const processes: StartedProcess[] = []
  for (const line of result.stdout.split('\n')) {
    const [pid, , label] = line.split('\t')
    if (label?.startsWith(`UIKitApplication:${bundleId}[`) !== true || pid === undefined || !/^\d+$/.test(pid)) continue
    const presence = await commandOf(tools, Number(pid))
    if (presence.state === 'unreadable') return { ok: false, problem: presence.problem }
    if (presence.state === 'present') processes.push({ pid: Number(pid), command: presence.command, startedAt: presence.startedAt })
  }
  return { ok: true, running: processes.length > 0, pids: processes.map((entry) => entry.pid), processes }
}

/** Erases a shut-down simulator's contents and settings. */
export async function eraseSimulator(tools: NativeTools, udid: string, bounds: RequestBounds): Promise<CommandResult> {
  return simctl(tools, ['erase', udid], bounds)
}

/** Shuts a simulator down; one already shut down counts as done. */
export async function shutdownSimulator(tools: NativeTools, udid: string, bounds: RequestBounds): Promise<Failure | undefined> {
  const result = await simctl(tools, ['shutdown', udid], bounds)
  return result.cleanupProblems.length === 0 && (result.code === 0 || /current state: Shutdown/i.test(result.stderr)) ? undefined : simctlFailure('xcrun simctl shutdown', result)
}

/** Deletes a simulator. */
export async function deleteSimulator(tools: NativeTools, udid: string, bounds: RequestBounds): Promise<Failure | undefined> {
  const result = await simctl(tools, ['delete', udid], bounds)
  return result.code === 0 ? undefined : simctlFailure('xcrun simctl delete', result)
}

/**
 * A PNG of the simulator's display, read by simctl: a capture source of its own, apart from WebDriverAgent's.
 *
 * @example await simulatorScreenshot(systemTools, udid, { timeoutMs: 15_000 })
 */
export async function simulatorScreenshot(tools: NativeTools, udid: string, bounds: RequestBounds): Promise<{ readonly ok: true; readonly png: Uint8Array } | { readonly ok: false; readonly result: CommandResult }> {
  const folder = await mkdtemp(join(tmpdir(), 'retest-simctl-io-'))
  try {
    const path = join(folder, 'display.png')
    const result = await simctl(tools, ['io', udid, 'screenshot', '--type=png', path], bounds)
    if (result.code !== 0) return { ok: false, result }
    return { ok: true, png: new Uint8Array(await readFile(path)) }
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
}

/**
 * Reports simulators named for a Retest process that is gone, such as one a SIGKILLed run left. Only reports: a name
 * is no record that Retest made the device, so Retest never shuts one down or deletes it, and each report names the
 * command that removes it. A simulator whose maker's pid runs again, as another process, is not seen.
 *
 * @example await sweepOrphanedSimulators(systemTools, { timeoutMs: 60_000 }) // { problems: [] }
 */
export async function sweepOrphanedSimulators(tools: NativeTools, bounds: RequestBounds): Promise<{ readonly problems: readonly string[] }> {
  const listed = await listSimulators(tools, bounds)
  if (!Array.isArray(listed)) return { problems: [listed.message] }
  const problems: string[] = []
  for (const device of listed) {
    const maker = Number(simulatorName.exec(device.name)?.[1])
    if (!Number.isSafeInteger(maker) || maker === process.pid) continue
    try {
      if (processExists(maker)) continue
      problems.push(`Simulator ${device.udid} (${device.name}) is named for a Retest process that is gone and has no retained ownership record, so Retest did not shut it down or delete it. Once nothing uses it, remove it with \`xcrun simctl delete ${device.udid}\`.`)
    } catch (error) {
      problems.push(`Retest could not read whether simulator maker pid ${maker} remains: ${errorMessage(error)}`)
    }
  }
  return { problems }
}

/**
 * An iOS simulator runtime: one simulator created for it, WebDriverAgent running in it, and the app it was started
 * for. One session at a time opens in it; a second waits for the first to be disposed.
 */
export class IosSimulatorRuntime implements NativeRuntime {
  readonly udid: string
  readonly port: number
  readonly #options: IosRuntimeOptions
  readonly #processIds: readonly number[]
  readonly #executorProcesses: readonly StartedProcess[]
  // The app as it is installed on the simulator now: the one the runtime started with, until a session installs a
  // build, whose copy on the simulator every later session names.
  #bundle: AppBundle
  #execution: NativeExecutionIdentity
  readonly #runner: OwnedProcess
  readonly #client: ExecutorClient
  readonly #sessions = new SerialLane()
  readonly #open = new Set<NativeAppSession>()
  readonly #listeners = new Set<(reason: string) => void>()
  readonly #folder: string
  readonly #lastResort: () => void
  readonly #stopWatch: () => void
  #lost: string | undefined
  #closing: Promise<void> | undefined

  /**
   * Starts a runtime: checks Xcode and the target against the tested set, reads the app's bundle, refuses while a
   * simulator an earlier Retest process left is still there, creates and boots a simulator, and starts WebDriverAgent
   * in it. Whatever it created is removed again when a later step fails or the start is stopped. A refusal that comes
   * before any simulator could have been created says it is `idle`. A recorded runtime proved removed after a failed
   * start says it is `cleaned`, while keeping the startup failure.
   */
  static async start(options: IosRuntimeOptions): Promise<{ readonly ok: true; readonly runtime: IosSimulatorRuntime } | { readonly ok: false; readonly failure: Failure; readonly idle?: true; readonly cleaned?: true }> {
    options = { ...options, tools: { ...options.tools, hiddenVariables: options.hiddenVariables ?? options.tools.hiddenVariables, redact: options.redact ?? options.tools.redact } }
    const pins = options.pins ?? nativePins
    const deadline = new Deadline(options.timeoutMs)
    const bounds = (): RequestBounds => ({ timeoutMs: deadline.commandTimeoutMs, signal: options.signal })
    if (process.platform !== 'darwin') return idle(refused('iOS simulator apps need macOS with Xcode.'))
    if (options.build.executor !== 'webdriveragent') return idle(refused(`An iOS simulator runtime needs a WebDriverAgent build, not ${options.build.executor}.`))
    // Until a simulator is created, every step runs short tools that hold no device.
    const xcode = await checkXcode(options.tools, pins.toolchain, options.signal)
    if (xcode !== undefined) return idle({ ok: false, failure: xcode })
    const resolved = await resolveSimulatorTarget(options.target, pins, options.tools, bounds())
    if (!resolved.ok) return idle(resolved)
    const bundle = await readAppBundle(options.target.appPath, 'ios-simulator', options.tools, options.signal)
    if (!bundle.ok) return idle(bundle)
    const swept = await sweepOrphanedSimulators(options.tools, bounds())
    if (swept.problems.length > 0) return idle(refused(swept.problems.join(' ')))
    let folder: string
    try {
      folder = await makeOwnedFolder('retest-ios-', options.tools)
    } catch (error) {
      return idle(refused(`Retest could not make the runtime's temporary folder: ${errorMessage(error)}`))
    }
    const created: Created = { folder, tools: options.tools }
    try {
      const name = `retest-native-${process.pid}-${randomBytes(4).toString('hex')}`
      const simulator = await createSimulator(options.tools, { name, deviceType: resolved.deviceType.identifier, runtime: resolved.runtime.identifier }, bounds())
      // An unanswered create may have made a device. Its name permits a warning, never an ownership claim.
      if (!simulator.ok) {
        const failed = await failStart(simulator.failure, created, options, simulator.started ? name : undefined)
        // A create that never ran made no device; with nothing left to clean up, the start left nothing behind.
        return !simulator.started && failed.failure.details?.['also'] === undefined ? idle(failed) : failed
      }
      created.udid = simulator.udid
      created.exitHook = simulatorExitHook(simulator.udid, created)
      process.on('exit', created.exitHook)
      const booted = await bootSimulator(options.tools, simulator.udid, bounds())
      if (booted !== undefined) return await failStart(booted, created, options)
      const port = options.port ?? (await freePort())
      // WebDriverAgent's screen stream binds every interface, whatever USE_IP says. Its port is held on every interface
      // while the executor starts, so that listener fails and nothing serves the simulator's screen to the network.
      const streamPort = await freePort()
      const held = await holdPort(streamPort)
      const logFile = join(options.logFolder, `${name}-webdriveragent.log`)
      // The runner app runs inside the simulator, which makes it a process of the Mac under the device's folder.
      const isRunnerApp = (command: string): boolean => command.includes(`/Devices/${simulator.udid}/`) && command.includes('WebDriverAgentRunner-Runner')
      let runner: Awaited<ReturnType<typeof startExecutor>>
      try {
        runner = await startExecutor({
          executor: 'webdriveragent',
          build: options.build,
          destination: `platform=iOS Simulator,id=${simulator.udid}`,
          port,
          environment: { TEST_RUNNER_USE_IP: '127.0.0.1', TEST_RUNNER_MJPEG_SERVER_PORT: String(streamPort) },
          logFile,
          resultFolder: created.folder,
          tools: options.tools,
          bounds: bounds(),
          isRunnerApp,
          tie: 'command',
          onProcesses: (processes) => {
            created.runnerApps = processes.runnerApps
          },
        })
      } finally {
        await held.close()
      }
      if (!runner.ok) return await failStart(runner.failure, created, options)
      created.runner = runner.process
      if (!(await screenStreamRefused(logFile))) return await failStart({ class: 'setup_failed', message: `WebDriverAgent started its screen stream although its port ${streamPort} was held, so the simulator's screen may be served on every interface. The executor log is ${logFile}.` }, created, options)
      const runnerApps = runner.runnerApps
      const device: SimulatorDevice = { name, type: resolved.deviceType.name, udid: simulator.udid }
      const execution = nativeExecutionIdentity({ platform: 'ios-simulator', bundle: bundle.bundle, os: { name: 'iOS', version: resolved.runtime.version, build: resolved.runtime.build }, device, build: options.build })
      return { ok: true, runtime: new IosSimulatorRuntime({ options, udid: simulator.udid, port, bundle: bundle.bundle, execution, runner: runner.process, runnerApps, xcodebuild: runner.xcodebuild, folder: created.folder, lastResort: created.exitHook }) }
    } catch (error) {
      return await failStart({ class: 'setup_failed', message: `Starting the iOS simulator runtime failed: ${errorMessage(error)}` }, created, options)
    }
  }

  private constructor(parts: { readonly options: IosRuntimeOptions; readonly udid: string; readonly port: number; readonly bundle: AppBundle; readonly execution: NativeExecutionIdentity; readonly runner: OwnedProcess; readonly runnerApps: readonly StartedProcess[]; readonly xcodebuild: StartedProcess; readonly folder: string; readonly lastResort: () => void }) {
    this.#options = parts.options
    this.udid = parts.udid
    this.port = parts.port
    this.#bundle = parts.bundle
    this.#execution = parts.execution
    this.#executorProcesses = [parts.xcodebuild, ...parts.runnerApps]
    this.#processIds = this.#executorProcesses.map((entry) => entry.pid)
    this.#runner = parts.runner
    this.#folder = parts.folder
    this.#lastResort = parts.lastResort
    this.#client = new ExecutorClient({ executor: 'webdriveragent', host: '127.0.0.1', port: parts.port })
    this.#stopWatch = watchExecutor(parts.runnerApps.map((entry) => entry.pid), (pid, problem) => {
      if (this.#closing === undefined) this.#lose(problem ?? `WebDriverAgent's runner app (pid ${pid}) ended.`)
    })
    void parts.runner.exited.then((exit) => {
      if (this.#closing !== undefined) return
      this.#lose(`WebDriverAgent's xcodebuild ended (${exit.signal === null ? `exit code ${exit.code ?? 'unknown'}` : `signal ${exit.signal}`}).`)
    })
  }

  /** The executor processes this runtime recorded at startup, with their command lines and starts. */
  get executorProcesses(): readonly StartedProcess[] {
    return this.#executorProcesses
  }

  /** The app bundle on the simulator: the one the runtime started with, or the build a session installed last. */
  get bundle(): AppBundle {
    return this.#bundle
  }

  /** What results name, from the copy installed on the simulator. */
  get execution(): NativeExecutionIdentity {
    return this.#execution
  }

  get identity(): NativeRuntimeIdentity {
    return runtimeIdentity(this.#execution, this.#processIds)
  }

  /** The reset policy every session of this runtime starts under. */
  get resetPolicy(): ResetPolicy {
    return iosSimulatorResetPolicy.contract
  }

  /** Called by a session's driver after an install: the installed copy is what this runtime's sessions name from now. */
  noteInstalled(bundle: AppBundle, execution: NativeExecutionIdentity): void {
    this.#bundle = bundle
    this.#execution = execution
  }

  get connected(): boolean {
    return this.#lost === undefined && this.#closing === undefined
  }

  /** Tells `listener` once when WebDriverAgent or the simulator is lost, even when that happened before it was added. */
  onDisconnect(listener: (reason: string) => void): () => void {
    if (this.#lost !== undefined) {
      const reason = this.#lost
      queueMicrotask(() => listener(reason))
      return () => undefined
    }
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  /**
   * Opens a session for the runtime's app, once any open session is disposed: a WebDriverAgent session that launches
   * nothing, and the session that drives the app's lifecycle through it.
   */
  async openSession(options: NativeSessionOptions, timeoutMs: number, signal?: AbortSignal): Promise<{ readonly ok: true; readonly session: NativeAppSession; readonly client: ExecutorClient; readonly executor: ExecutorSession } | { readonly ok: false; readonly failure: Failure }> {
    if (!this.connected) return refused(`The iOS simulator runtime is ${this.#lost === undefined ? 'closing' : `lost: ${this.#lost}`}.`)
    const deadline = new Deadline(timeoutMs)
    const turn = await this.#sessions.acquire(signal, timeoutMs)
    if (!turn.ok) return refused(turn.reason === 'stopped' ? 'Opening the session was stopped while another session was open.' : `Another session of this simulator stayed open for ${timeoutMs} ms.`)
    const created = await this.#client.createSession({ timeoutMs: deadline.commandTimeoutMs, signal })
    if (created.status !== 'answered') {
      turn.release()
      return refused(`WebDriverAgent did not open a session: ${created.status === 'refused' ? `${created.error}: ${created.message}` : created.message}`)
    }
    const driver = new IosAppDriver({ runtime: this, tools: this.#options.tools, executor: created.value, release: () => turn.release() })
    const session = new NativeAppSession(driver, options)
    this.#open.add(session)
    driver.onRelease(() => this.#open.delete(session))
    return { ok: true, session, client: this.#client, executor: created.value }
  }

  /**
   * Ends everything the runtime started within `timeoutMs`: its sessions, WebDriverAgent, and the simulator, which is
   * shut down and deleted. Then it checks that no process of the simulator, no runner and no listening port is left.
   * Rejects with a `NativeError` naming what is left. A second call waits for the first.
   */
  close(timeoutMs: number): Promise<void> {
    this.#closing ??= this.#close(timeoutMs)
    return this.#closing
  }

  async #close(timeoutMs: number): Promise<void> {
    this.#stopWatch()
    const deadline = new Deadline(timeoutMs)
    const problems: string[] = []
    for (const session of this.#open) await session.dispose(Math.min(15_000, deadline.commandTimeoutMs)).catch((error: unknown) => problems.push(errorMessage(error)))
    problems.push(...(await stopExecutor(this.#client, this.#runner, deadline, this.#lost !== undefined)))
    problems.push(...(await removeSimulator(this.#options.tools, this.udid, this.port, deadline, this.#executorProcesses)))
    problems.push(...(await this.#runner.finishOutput(deadline.commandTimeoutMs)))
    process.off('exit', this.#lastResort)
    await rm(this.#folder, { recursive: true, force: true }).catch((error: unknown) => problems.push(`Could not remove ${this.#folder}: ${errorMessage(error)}`))
    if (problems.length > 0) throw new NativeError({ class: 'cleanup_failed', message: problems.join(' ') })
  }

  #lose(reason: string): void {
    if (this.#lost !== undefined) return
    this.#lost = reason
    for (const session of this.#open) session.markLost({ class: 'session_lost', message: reason })
    for (const listener of this.#listeners) listener(reason)
    this.#listeners.clear()
  }
}

type Created = { folder: string; tools: NativeTools; udid?: string; runner?: OwnedProcess; runnerApps?: readonly RecordedProcess[]; exitHook?: () => void }

// Undoes a start that did not finish, within its own time: a stopped start still removes what it made.
async function failStart(failure: Failure, created: Created, options: IosRuntimeOptions, orphanName?: string): Promise<{ readonly ok: false; readonly failure: Failure; readonly cleaned?: true }> {
  const deadline = new Deadline(120_000)
  const problems: string[] = []
  if (created.runner !== undefined) problems.push(...(await created.runner.stop(0)))
  for (const entry of created.runnerApps ?? []) {
    const problem = endProblem(entry, await endRecorded(options.tools, entry, 5000))
    if (problem !== undefined) problems.push(`The runner app: ${problem}`)
  }
  if (created.udid !== undefined) problems.push(...(await removeSimulator(options.tools, created.udid, undefined, deadline)))
  if (created.udid === undefined && orphanName !== undefined) {
    const listed = await listSimulators(options.tools, { timeoutMs: deadline.commandTimeoutMs })
    if (!Array.isArray(listed)) problems.push(`Retest could not read the result of the unanswered simulator creation: ${listed.message}`)
    else if (listed.some((device) => device.name === orphanName)) problems.push('The unanswered simulator creation left a device whose id was never recorded; Retest did not shut it down or delete it.')
  }
  if (created.exitHook !== undefined) process.off('exit', created.exitHook)
  await rm(created.folder, { recursive: true, force: true }).catch(() => undefined)
  // Only the recorded device's verified removal proves the runtime is free. An unanswered creation or a command
  // with unproved process cleanup still holds ownership, even if no simulator is listed by a later read.
  if (problems.length === 0) return { ok: false, failure, ...(created.udid !== undefined && failure.class !== 'cleanup_failed' ? { cleaned: true as const } : {}) }
  return { ok: false, failure: { ...failure, details: { ...failure.details, also: `cleanup_failed: ${problems.join(' ')}` } } }
}

// A runner asked to stop ends its test and xcodebuild exits; one that is already lost has nothing to stop, and its
// xcodebuild can take tens of seconds to notice, so it is ended at once.
async function stopExecutor(client: ExecutorClient, runner: OwnedProcess, deadline: Deadline, lost: boolean): Promise<string[]> {
  if (lost) return runner.stop(0, deadline)
  if (runner.exit === undefined) await client.shutdown({ timeoutMs: Math.min(5000, deadline.commandTimeoutMs) })
  return runner.stop(Math.min(30_000, deadline.remainingMs), deadline)
}

// Shuts the simulator down and deletes it, then checks nothing of it is left: no process running from its folder, no
// listing, no port.
async function removeSimulator(tools: NativeTools, udid: string, port: number | undefined, deadline: Deadline, recorded: readonly RecordedProcess[] = []): Promise<string[]> {
  const problems: string[] = []
  const shutdown = await shutdownSimulator(tools, udid, { timeoutMs: Math.min(120_000, deadline.commandTimeoutMs) })
  if (shutdown !== undefined) problems.push(shutdown.message)
  const deleted = await deleteSimulator(tools, udid, { timeoutMs: Math.min(120_000, deadline.commandTimeoutMs) })
  if (deleted !== undefined) problems.push(deleted.message)
  const listed = await listSimulators(tools, { timeoutMs: Math.min(30_000, deadline.commandTimeoutMs) })
  if (!Array.isArray(listed)) problems.push(`Retest could not check that the simulator ${udid} was removed: ${listed.message}`)
  else if (listed.some((device) => device.udid === udid)) problems.push(`The simulator ${udid} is still listed.`)
  const left = await leftProcesses(tools, udid, deadline, recorded).catch((error: unknown) => errorMessage(error))
  if (typeof left === 'string') problems.push(`Retest could not check that nothing of the simulator is left: ${left}.`)
  else if (left.length > 0) problems.push(`Processes of the simulator ${udid} are still running: ${left.join(' ')}`)
  if (port !== undefined && (await isListening('127.0.0.1', port))) problems.push(`Something still listens on 127.0.0.1:${port}.`)
  return problems
}

// A device path identifies possible leftovers, never who launched them. Only a retained launch record authorizes
// signalling; any other process still using the path is reported and left alone.
async function leftProcesses(tools: NativeTools, udid: string, deadline: Deadline, recorded: readonly RecordedProcess[]): Promise<string[]> {
  const marker = `/Devices/${udid}/`
  for (;;) {
    let listed
    try {
      listed = await listProcesses(tools, Math.min(10_000, deadline.commandTimeoutMs))
    } catch (error) {
      throw new Error(`the processes of the simulator ${udid} could not be read (${errorMessage(error)})`)
    }
    const left = listed.filter((entry) => entry.command.includes(marker))
    if (left.length === 0) return []
    if (deadline.remainingMs < 2000) {
      const problems: string[] = []
      for (const entry of left) {
        const own = recorded.find((record) => recordedIdentity(record, entry) === 'same')
        if (own === undefined) { problems.push(`pid ${entry.pid} uses the simulator path but was not recorded as this runtime's launch; Retest did not end it.`); continue }
        const problem = endProblem(own, await endRecorded(tools, own, 1000))
        if (problem !== undefined) problems.push(problem)
      }
      return problems
    }
    await sleep(250)
  }
}

// When the Retest process exits without closing the runtime, by its end or by process.exit, the runner app is killed
// and the simulator it made is shut down and deleted before the exit completes; only synchronous work runs there.
// A SIGKILL of the Retest process runs nothing: the simulator and its runner remain. A later start reports them but
// cannot adopt their name as proof of ownership.
function simulatorExitHook(udid: string, created: Created): () => void {
  return () => {
    killRecordedNow(created.runnerApps ?? [], created.tools)
    try {
      const env = childEnvironment(undefined, created.tools.hiddenVariables)
      spawnSync(created.tools.xcrun, ['simctl', 'shutdown', udid], { stdio: 'ignore', timeout: 30_000, env })
      spawnSync(created.tools.xcrun, ['simctl', 'delete', udid], { stdio: 'ignore', timeout: 30_000, env })
    } catch {
      // Throwing here would replace the exit code Retest chose.
    }
  }
}

/** The driver a session of an iOS simulator runtime runs on. */
class IosAppDriver implements NativeAppDriver {
  readonly platform = 'ios-simulator' as const
  readonly captureSources: readonly CaptureSource[] = ['executor-screen', 'simulator-display']
  readonly resetPolicy: ResetPolicy
  #bundle: AppBundle
  #identity: NativeExecutionIdentity
  readonly runtimeProcessIds: readonly number[]
  readonly #runtime: IosSimulatorRuntime
  readonly #tools: NativeTools
  readonly #executor: ExecutorSession
  readonly #release: () => void
  readonly #onRelease: (() => void)[] = []
  #released = false

  constructor(parts: { readonly runtime: IosSimulatorRuntime; readonly tools: NativeTools; readonly executor: ExecutorSession; readonly release: () => void }) {
    this.#runtime = parts.runtime
    this.#tools = parts.tools
    this.#executor = parts.executor
    this.#release = parts.release
    this.#bundle = parts.runtime.bundle
    this.#identity = parts.runtime.execution
    this.resetPolicy = parts.runtime.resetPolicy
    this.runtimeProcessIds = parts.runtime.identity.processIds
  }

  /** The app bundle on the simulator: the runtime's, or the one the session installed last. */
  get bundle(): AppBundle {
    return this.#bundle
  }

  /** What results name, from the bundle that is installed. */
  get identity(): NativeExecutionIdentity {
    return this.#identity
  }

  onRelease(listener: () => void): void {
    this.#onRelease.push(listener)
  }

  // The bundle installed is read before the install, so a result names the build that is on the simulator, not the
  // one the runtime started with.
  async install(build: AppBuild, bounds: RequestBounds): Promise<DriverAnswer<unknown>> {
    const read = await readAppBundle(build.appPath, 'ios-simulator', this.#tools, bounds.signal)
    if (!read.ok) return { status: 'failed', failure: read.failure, input: 'not_sent' }
    if (read.bundle.bundleId !== this.#bundle.bundleId) return { status: 'failed', failure: { class: 'not_actionable', message: `${build.appPath} is ${read.bundle.bundleId}, not this session's app ${this.#bundle.bundleId}.` }, input: 'not_sent' }
    const installed = commandAnswer('xcrun simctl install', await installOnSimulator(this.#tools, this.#runtime.udid, build.appPath, bounds))
    if (installed.status !== 'answered') return installed
    // What results name is the copy on the simulator, read from its app container after the install.
    const container = await simctl(this.#tools, ['get_app_container', this.#runtime.udid, read.bundle.bundleId, 'app'], bounds)
    const onDevice = container.code === 0 ? await readAppBundle(container.stdout.trim(), 'ios-simulator', this.#tools, bounds.signal) : undefined
    if (onDevice === undefined || !onDevice.ok) {
      const why = onDevice === undefined ? describeCommand('xcrun simctl get_app_container', container) : onDevice.failure.message
      return { status: 'failed', input: 'sent', failure: { class: 'setup_failed', message: `The app was installed, and Retest could not read the installed copy to name it: ${why}` } }
    }
    this.#bundle = { ...onDevice.bundle, appPath: build.appPath }
    const execution = this.#identity
    this.#identity = { ...execution, app: { bundleId: onDevice.bundle.bundleId, ...(onDevice.bundle.version === undefined ? {} : { version: onDevice.bundle.version }), ...(onDevice.bundle.build === undefined ? {} : { build: onDevice.bundle.build }), path: onDevice.bundle.appPath, sha256: onDevice.bundle.sha256 } }
    this.#runtime.noteInstalled(this.#bundle, this.#identity)
    return installed
  }

  async launchBlocker(): Promise<Failure | undefined> {
    return undefined
  }

  launch(launch: LaunchSpec, bounds: RequestBounds): Promise<DriverAnswer<unknown>> {
    return this.#executor.launchApp({ target: { bundleId: this.bundle.bundleId }, ...launch }, bounds)
  }

  activate(bounds: RequestBounds): Promise<DriverAnswer<unknown>> {
    return this.#executor.activateApp({ bundleId: this.bundle.bundleId }, bounds)
  }

  terminate(bounds: RequestBounds): Promise<DriverAnswer<boolean>> {
    return this.#executor.terminateApp({ bundleId: this.bundle.bundleId }, bounds)
  }

  state(bounds: RequestBounds): Promise<DriverAnswer<ExecutorAppState>> {
    return this.#executor.appState({ bundleId: this.bundle.bundleId }, bounds)
  }

  processState(bounds: RequestBounds): Promise<AppProcessReading> {
    return simulatorAppProcesses(this.#tools, this.#runtime.udid, this.bundle.bundleId, bounds)
  }

  async capture(source: CaptureSource, bounds: RequestBounds): Promise<DriverAnswer<Uint8Array>> {
    if (source === 'executor-screen') return this.#executor.screenshot(bounds)
    const taken = await simulatorScreenshot(this.#tools, this.#runtime.udid, bounds)
    if (taken.ok) return { status: 'answered', value: taken.png, durationMs: 0 }
    return { status: 'failed', failure: simctlFailure('xcrun simctl io screenshot', taken.result), input: 'not_sent' }
  }

  source(bounds: RequestBounds, redact?: (text: string) => string): Promise<DriverAnswer<ScopedSource>> {
    return this.#executor.ownedSource({ platform: 'ios-simulator', bundleId: this.bundle.bundleId, appNames: appNames(this.bundle), ...(redact === undefined ? {} : { redact }) }, bounds)
  }

  // A simulator's processes are the Mac's own, so the session's recorded processes are ended as on macOS: each only
  // while its command line is still the recorded one.
  async forceEnd(processes: readonly RecordedProcess[], bounds: RequestBounds): Promise<string[]> {
    const left: string[] = []
    for (const entry of processes) {
      const problem = endProblem(entry, await endRecorded(this.#tools, entry, Math.min(5000, bounds.timeoutMs)))
      if (problem !== undefined) left.push(`${this.bundle.bundleId} on ${this.#runtime.udid}: ${problem}`)
    }
    return left
  }

  async endExecutorSession(bounds: RequestBounds): Promise<string[]> {
    const ended = await this.#executor.end(bounds)
    return ended.status === 'answered' || ended.status === 'refused' ? [] : [`The WebDriverAgent session did not end: ${ended.message}`]
  }

  released(): void {
    if (this.#released) return
    this.#released = true
    this.#release()
    for (const listener of this.#onRelease) listener()
  }
}

function commandAnswer(name: string, result: CommandResult): DriverAnswer<unknown> {
  if (result.cleanupProblems.length > 0) return { status: 'unknown', reason: 'unreadable', message: describeCommand(name, result), durationMs: 0 }
  if (result.code === 0) return { status: 'answered', value: null, durationMs: 0 }
  if (!result.started) return { status: 'failed', failure: { class: result.stopped ? 'interrupted' : 'setup_failed', message: describeCommand(name, result) }, input: 'not_sent' }
  if (result.timedOut || result.stopped) return { status: 'unknown', reason: result.timedOut ? 'timeout' : 'stopped', message: describeCommand(name, result), durationMs: 0 }
  return { status: 'failed', failure: simctlFailure(name, result), input: 'unknown' }
}

async function simctl(tools: NativeTools, args: readonly string[], bounds: RequestBounds): Promise<CommandResult> {
  return runCommand(tools.xcrun, ['simctl', ...args], { ...bounds, hiddenVariables: tools.hiddenVariables })
}

async function simctlJson(tools: NativeTools, args: readonly string[], bounds: RequestBounds): Promise<{ readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly failure: Failure }> {
  const result = await simctl(tools, [...args, '-j'], bounds)
  if (result.code !== 0) return { ok: false, failure: simctlFailure(`xcrun simctl ${args.join(' ')}`, result) }
  try {
    return { ok: true, value: JSON.parse(result.stdout) }
  } catch (error) {
    return { ok: false, failure: { class: 'setup_failed', message: `xcrun simctl ${args.join(' ')} printed something that is not JSON: ${errorMessage(error)}` } }
  }
}

function simctlFailure(name: string, result: CommandResult): Failure {
  return { class: result.cleanupProblems.length > 0 ? 'cleanup_failed' : result.timedOut ? 'timeout' : 'setup_failed', message: describeCommand(name, result) }
}

function refused(message: string): { readonly ok: false; readonly failure: Failure } {
  return { ok: false, failure: { class: 'setup_failed', message } }
}

// Marks a refusal that came before any simulator could exist and left nothing running.
function idle(refusal: { readonly ok: false; readonly failure: Failure }): { readonly ok: false; readonly failure: Failure; readonly idle: true } {
  return { ...refusal, idle: true }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}
