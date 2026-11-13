import type { AppBuild, DispatchedRequest, InputDispatch, NativeRuntimeIdentity } from '../../browser/contract.ts'
import type { LoadedAgentDeviceTarget } from '../../config/loaded.ts'
import type { Failure } from '../../protocol/failures.ts'
import type { AndroidDevice, AppBundle, NativeExecutionIdentity, PackageExecutor } from '../identity.ts'
import type { NativeTools } from '../processes.ts'
import type { NativeSessionOptions, ProcessReading } from '../session.ts'
import type { RequestBounds } from '../webdriver-client.ts'
import type { AgentDeviceTarget, ScreenCapture } from './interaction.ts'
import type { AgentDeviceAnswer, AgentDeviceHost, AgentDeviceStarter } from './package.ts'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { describeAndroidDevice } from '../../config/native-targets.ts'
import { Deadline } from '../../protocol/deadline.ts'
import { errorMessage } from '../../protocol/failures.ts'
import { maxTimeout } from '../../protocol/timeouts.ts'
import { sha256Hex } from '../../shared/sha256.ts'
import { nativePins } from '../executors.ts'
import { readAppBundle, runtimeIdentity } from '../identity.ts'
import { bootSimulator, createSimulator, deleteSimulator, installOnSimulator, resolveSimulatorTarget, shutdownSimulator, simulatorAppProcesses, simulatorScreenshot, sweepOrphanedSimulators } from '../ios-simulator.ts'
import { childEnvironment, describeCommand, listProcesses, runCommand } from '../processes.ts'
import { NativeError } from '../session.ts'
import { makeOwnedFolder, sweepOwnedFolders } from '../temporary-folders.ts'
import { AgentDeviceInteraction } from './interaction.ts'
import { agentDeviceVersion, loadAgentDevice } from './package.ts'

// The runtime of a target agent-device drives. Retest owns the device's lifecycle where it can: for an iOS target it
// creates a simulator of its own from the target's device type and runtime, named for this process as its own driver
// names its simulators, boots it, installs the app with simctl and, at the end, shuts it down and deletes it, then
// checks that no process of that simulator is left. An Android emulator or device is not Retest's: agent-device finds
// it by its name or serial, boots an emulator that is not running, which Retest then shuts down at the end, and installs
// the APK afresh. Either way agent-device's daemon runs inside this process, in a state folder of the runtime's own that
// is deleted at the end, with the environment Retest's tools get, so it never sees a secret's variable. The Android
// path is built and covered by unit tests against a stand-in; it has not run on a real emulator or device.


type AgentDeviceTargetConfig = LoadedAgentDeviceTarget

/** What starting an agent-device runtime needs. `starter` is agent-device's, loaded from where Retest is installed, unless a test gives a stand-in. */
export type AgentDeviceRuntimeOptions = {
  readonly target: AgentDeviceTargetConfig
  readonly tools: NativeTools
  readonly timeoutMs: number
  readonly signal?: AbortSignal | undefined
  readonly redact: (text: string) => string
  readonly starter?: AgentDeviceStarter
  /** Reads a file's bytes, for the APK's checksum; Node's own unless a test gives a stand-in. */
  readonly readBytes?: (path: string) => Promise<Uint8Array>
}

type StartFailure = { readonly ok: false; readonly failure: Failure; readonly idle?: true; readonly cleaned?: true }

type Platform =
  | { readonly kind: 'ios'; readonly udid: string; readonly folder: string; readonly exitHook: () => void }
  | { readonly kind: 'android'; readonly serial: string; readonly folder: string; readonly bootedHere: boolean }

/** The runtime of one agent-device target: its device, agent-device's daemon in this process, and the app it runs. */
export class AgentDeviceRuntime {
  /** agent-device's runtime has no port of Retest's. */
  readonly port = 0
  readonly #options: AgentDeviceRuntimeOptions
  readonly #host: AgentDeviceHost
  readonly #platform: Platform
  readonly #session: string
  readonly #bundle: AppBundle
  readonly #execution: NativeExecutionIdentity
  readonly #listeners = new Set<(reason: string) => void>()
  #lost: string | undefined
  #closing: Promise<void> | undefined
  #screens = 0

  /**
   * Starts a runtime: loads agent-device and checks its version, then makes the device ready. A refusal before anything
   * was made says it is `idle`; a failed start whose device and folder were proved removed says it is `cleaned`.
   */
  static async start(options: AgentDeviceRuntimeOptions): Promise<{ readonly ok: true; readonly runtime: AgentDeviceRuntime } | StartFailure> {
    const deadline = new Deadline(Math.max(1, Math.min(maxTimeout, Math.floor(options.timeoutMs))))
    let starter = options.starter
    if (starter === undefined) {
      const loaded = await loadAgentDevice()
      if (!loaded.ok) return { ...loaded, idle: true }
      starter = loaded.start
    }
    return options.target.platform === 'android' ? startAndroid(options, options.target, starter, deadline) : startIos(options, options.target, starter, deadline)
  }

  /** @internal Made by `start` alone. */
  constructor(parts: { readonly options: AgentDeviceRuntimeOptions; readonly host: AgentDeviceHost; readonly platform: Platform; readonly session: string; readonly bundle: AppBundle; readonly execution: NativeExecutionIdentity }) {
    this.#options = parts.options
    this.#host = parts.host
    this.#platform = parts.platform
    this.#session = parts.session
    this.#bundle = parts.bundle
    this.#execution = parts.execution
  }

  get bundle(): AppBundle {
    return this.#bundle
  }

  get execution(): NativeExecutionIdentity {
    return this.#execution
  }

  get identity(): NativeRuntimeIdentity {
    return runtimeIdentity(this.#execution, [])
  }

  get connected(): boolean {
    return this.#lost === undefined && this.#closing === undefined
  }

  onDisconnect(listener: (reason: string) => void): () => void {
    if (this.#lost !== undefined) {
      const reason = this.#lost
      queueMicrotask(() => listener(reason))
      return () => undefined
    }
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  /** An agent-device runtime drives its app itself; it opens no executor session. */
  openSession(): Promise<{ readonly ok: false; readonly failure: Failure }> {
    return Promise.resolve({ ok: false, failure: { class: 'setup_failed', message: 'An agent-device runtime opens no executor session; its interaction session drives the app.' } })
  }

  /** Opens the interaction session the runner drives the app through. */
  openInteraction(options: NativeSessionOptions, _timeoutMs: number, _signal: AbortSignal): Promise<{ readonly ok: true; readonly value: AgentDeviceInteraction } | { readonly ok: false; readonly failure: Failure }> {
    if (!this.connected) return Promise.resolve({ ok: false, failure: { class: 'setup_failed', message: `The agent-device runtime is ${this.#lost === undefined ? 'closing' : `lost: ${this.#lost}`}.` } })
    const device: AgentDeviceTarget = this.#platform.kind === 'ios' ? { platform: 'ios', udid: this.#platform.udid } : { platform: 'android', serial: this.#platform.serial }
    const interaction = new AgentDeviceInteraction({
      port: this.#host.port,
      session: this.#session,
      sessionId: `${options.owner.attemptId}:${options.owner.app}`,
      platform: this.#platform.kind === 'ios' ? 'ios-simulator' : 'android',
      device,
      bundleId: this.#bundle.bundleId,
      launch: options.launch,
      redact: options.redact,
      install: (build, bounds) => this.#install(build, bounds),
      processes: (bounds) => this.#processes(bounds),
      screen: this.#screen(),
      onLost: (reason) => this.#lose(reason),
    })
    return Promise.resolve({ ok: true, value: interaction })
  }

  /**
   * Ends everything the runtime started within `timeoutMs`: agent-device's session, shutting down a simulator or an
   * emulator it booted, its daemon, and on iOS the simulator, which is deleted, then checks that no process of that
   * simulator is left. Rejects with a `NativeError` naming what is left; the lease then stays held. A second call waits for
   * the first.
   */
  close(timeoutMs: number): Promise<void> {
    this.#closing ??= this.#close(timeoutMs)
    return this.#closing
  }

  async #close(timeoutMs: number): Promise<void> {
    const deadline = new Deadline(Math.max(1, Math.min(maxTimeout, Math.floor(timeoutMs))))
    const problems: string[] = []
    const shutdown = this.#platform.kind === 'ios' || this.#platform.bootedHere
    const selection = this.#platform.kind === 'ios' ? { platform: 'ios', udid: this.#platform.udid } : { platform: 'android', serial: this.#platform.serial }
    const closed = await this.#host.port.call('sessions.close', { session: this.#session, ...selection, ...(shutdown ? { shutdown: true } : {}) }, { timeoutMs: Math.min(deadline.commandTimeoutMs, 60_000) })
    // A session never opened, as when no test launched the app, is one agent-device does not know.
    if (closed.status !== 'answered' && !(closed.status === 'refused' || (closed.status === 'failed' && closed.code === 'SESSION_NOT_FOUND'))) problems.push(this.#options.redact(`agent-device did not close its session: ${describeAnswer(closed)}`))
    const host = await this.#host.close(deadline.commandTimeoutMs)
    if (!host.ok) problems.push(this.#options.redact(host.problem))
    else problems.push(...host.leftovers.map((line) => this.#options.redact(line)))
    if (this.#platform.kind === 'ios') problems.push(...(await this.#removeSimulator(this.#platform.udid, deadline)))
    await rm(this.#platform.folder, { recursive: true, force: true }).catch((error: unknown) => problems.push(`Retest could not remove agent-device's state folder ${this.#platform.folder}: ${errorMessage(error)}`))
    if (this.#platform.kind === 'ios') process.removeListener('exit', this.#platform.exitHook)
    if (problems.length > 0) throw new NativeError({ class: 'cleanup_failed', message: problems.join(' ') })
  }

  // Shuts the simulator down and deletes it, then waits for every process that names it, such as agent-device's
  // xcodebuild, to end. One that outlasts the simulator by the wait is ended; any still left is named.
  async #removeSimulator(udid: string, deadline: Deadline): Promise<string[]> {
    const { tools } = this.#options
    const problems: string[] = []
    const down = await shutdownSimulator(tools, udid, { timeoutMs: Math.min(deadline.commandTimeoutMs, 60_000) })
    if (down !== undefined) problems.push(`Shutting the simulator ${udid} down failed: ${down.message}`)
    const deleted = await deleteSimulator(tools, udid, { timeoutMs: Math.min(deadline.commandTimeoutMs, 60_000) })
    if (deleted !== undefined) problems.push(`Deleting the simulator ${udid} failed: ${deleted.message}`)
    const left = await processesNaming(udid, tools, deadline, Math.min(deadline.remainingMs, 30_000))
    if (typeof left === 'string') return [...problems, left]
    for (const entry of left) {
      try { process.kill(entry.pid, 'SIGTERM') } catch { /* gone already */ }
    }
    if (left.length === 0) return problems
    const still = await processesNaming(udid, tools, deadline, Math.min(deadline.remainingMs, 5000))
    if (typeof still === 'string') return [...problems, still]
    return [...problems, ...still.map((entry) => `A process of the simulator ${udid} was still running after it was deleted: pid ${entry.pid}.`)]
  }

  async #install(build: AppBuild, bounds: RequestBounds): Promise<DispatchedRequest> {
    if (this.#platform.kind === 'ios') {
      const installed = await installOnSimulator(this.#options.tools, this.#platform.udid, build.appPath, bounds)
      if (installed.code === 0) return { result: { ok: true }, input: 'sent' }
      const input = installed.started ? 'sent' : 'not_sent'
      return { result: { ok: false, failure: { class: 'setup_failed', message: this.#options.redact(`Installing the app on the simulator failed: ${describeCommand('xcrun simctl install', installed)}`), details: { inputSent: input } } }, input }
    }
    // Any copy of the app goes first, with its data, so the app starts with no data of an earlier run. agent-device's
    // uninstall reads the device's packages and removes the app only when it is there. Its reinstall runs adb's uninstall
    // whatever the device holds, and on Android 15 that fails for an app the device does not have.
    const deadline = new Deadline(Math.max(1, Math.min(maxTimeout, Math.floor(bounds.timeoutMs))))
    const within = (): RequestBounds => ({ timeoutMs: deadline.commandTimeoutMs, signal: bounds.signal })
    const device = { platform: 'android', serial: this.#platform.serial }
    const failed = (message: string, input: InputDispatch): DispatchedRequest => ({ result: { ok: false, failure: { class: 'setup_failed', message: this.#options.redact(message), details: { inputSent: input } } }, input })
    const removed = await this.#host.port.call('apps.uninstall', { ...device, app: this.#bundle.bundleId }, within())
    if (removed.status !== 'answered') return failed(`agent-device did not remove the app before installing the APK: ${describeAnswer(removed)}`, inputOf(removed))
    // An uninstall that says the app was not there changed nothing on the device.
    const removal: InputDispatch = typeof removed.value === 'object' && removed.value !== null && Reflect.get(removed.value, 'wasInstalled') === false ? 'not_sent' : 'sent'
    const answer = await this.#host.port.call('apps.install', { ...device, app: this.#bundle.bundleId, appPath: build.appPath }, within())
    if (answer.status !== 'answered') return failed(`agent-device did not install the APK: ${describeAnswer(answer)}`, worse(removal, inputOf(answer)))
    const installed = installedPackage(answer.value)
    if (installed !== this.#bundle.bundleId) return { result: { ok: false, failure: { class: 'setup_failed', message: this.#options.redact(`The APK installed ${installed === undefined ? 'a package agent-device did not name' : installed}, not ${this.#bundle.bundleId}, the package the target names, so Retest launches nothing.`) } }, input: 'sent' }
    return { result: { ok: true }, input: 'sent' }
  }

  async #processes(bounds: RequestBounds): Promise<ProcessReading> {
    if (this.#platform.kind === 'android') return { ok: false, problem: "Retest reads no Android process list yet, so it could not tell whether the app runs." }
    const read = await simulatorAppProcesses(this.#options.tools, this.#platform.udid, this.#bundle.bundleId, bounds)
    return read.ok ? { ok: true, running: read.running, pids: read.pids } : { ok: false, problem: this.#options.redact(read.problem) }
  }

  // On iOS the simulator's own display, read by simctl, as Retest's own driver reads it. On Android, agent-device's
  // screenshot, written to the runtime's state folder, read and removed.
  #screen(): ScreenCapture {
    return async (bounds) => {
      if (this.#platform.kind === 'ios') {
        const taken = await simulatorScreenshot(this.#options.tools, this.#platform.udid, bounds)
        return taken.ok ? { ok: true, png: taken.png, source: 'simulator-display' } : { ok: false, failure: { class: 'not_actionable', message: `simctl took no screenshot: ${describeCommand('xcrun simctl io screenshot', taken.result)}` } }
      }
      const path = join(this.#platform.folder, `screen-${++this.#screens}.png`)
      const answer = await this.#host.port.call('capture.screenshot', { session: this.#session, platform: 'android', serial: this.#platform.serial, path }, bounds)
      if (answer.status !== 'answered') return { ok: false, failure: { class: 'not_actionable', message: `agent-device took no screenshot: ${describeAnswer(answer)}` } }
      try {
        return { ok: true, png: new Uint8Array(await readFile(path)), source: 'executor-screen' }
      } catch (error) {
        return { ok: false, failure: { class: 'not_actionable', message: `Retest could not read agent-device's screenshot: ${errorMessage(error)}` } }
      } finally {
        await rm(path, { force: true }).catch(() => undefined)
      }
    }
  }

  #lose(reason: string): void {
    if (this.#lost !== undefined || this.#closing !== undefined) return
    this.#lost = reason
    for (const listener of this.#listeners) listener(reason)
    this.#listeners.clear()
  }
}

/** What an agent-device executor record names: the package and the version Retest checked. */
const executor: PackageExecutor = { name: 'agent-device', version: agentDeviceVersion, package: 'agent-device' }

async function startIos(options: AgentDeviceRuntimeOptions, target: Extract<AgentDeviceTargetConfig, { readonly platform: 'ios-simulator' }>, starter: AgentDeviceStarter, deadline: Deadline): Promise<{ readonly ok: true; readonly runtime: AgentDeviceRuntime } | StartFailure> {
  const { tools } = options
  const bounds = (): RequestBounds => ({ timeoutMs: deadline.commandTimeoutMs, signal: options.signal })
  if (process.platform !== 'darwin') return idle('An iOS simulator app needs macOS with Xcode.')
  // Until the simulator is created, every step reads and holds nothing.
  const xcode = await readXcode(tools, options.signal)
  if (typeof xcode === 'string') return idle(xcode)
  const resolved = await resolveSimulatorTarget(target, nativePins, tools, bounds())
  if (!resolved.ok) return { ...resolved, idle: true }
  const bundle = await readAppBundle(target.appPath, 'ios-simulator', tools, options.signal)
  if (!bundle.ok) return { ...bundle, idle: true }
  const swept = await sweepOrphanedSimulators(tools, bounds())
  if (swept.problems.length > 0) return idle(swept.problems.join(' '))
  const folders = await sweepOwnedFolders(tools).catch((error: unknown) => ({ removed: [], kept: 0, problems: [`Retest could not look through the temporary folder for what earlier runs left: ${errorMessage(error)}`] }))
  if (folders.problems.length > 0) return idle(folders.problems.join(' '))
  let folder: string
  try {
    folder = await makeOwnedFolder('retest-agent-device-', tools)
  } catch (error) {
    return idle(`Retest could not make agent-device's state folder: ${errorMessage(error)}`)
  }
  const name = `retest-native-${process.pid}-${randomBytes(4).toString('hex')}`
  const created = await createSimulator(tools, { name, deviceType: resolved.deviceType.identifier, runtime: resolved.runtime.identifier }, bounds())
  if (!created.ok) {
    await rm(folder, { recursive: true, force: true }).catch(() => undefined)
    // An unanswered create may have made a device; its name lets a later start report it.
    return created.started ? { ok: false, failure: created.failure } : { ok: false, failure: created.failure, idle: true }
  }
  const { udid } = created
  const exitHook = (): void => {
    try {
      const env = childEnvironment(undefined, tools.hiddenVariables)
      spawnSync(tools.xcrun, ['simctl', 'shutdown', udid], { stdio: 'ignore', timeout: 30_000, env })
      spawnSync(tools.xcrun, ['simctl', 'delete', udid], { stdio: 'ignore', timeout: 30_000, env })
    } catch {
      // Throwing here would replace the exit code Retest chose.
    }
  }
  process.on('exit', exitHook)
  const undo = async (failure: Failure, host?: AgentDeviceHost): Promise<StartFailure> => {
    const problems: string[] = []
    if (host !== undefined) {
      const closed = await host.close(60_000)
      if (!closed.ok) problems.push(closed.problem)
      else problems.push(...closed.leftovers)
    }
    const down = await shutdownSimulator(tools, udid, { timeoutMs: 60_000 })
    if (down !== undefined) problems.push(down.message)
    const gone = await deleteSimulator(tools, udid, { timeoutMs: 60_000 })
    if (gone !== undefined) problems.push(gone.message)
    await rm(folder, { recursive: true, force: true }).catch((error: unknown) => problems.push(errorMessage(error)))
    process.removeListener('exit', exitHook)
    if (problems.length > 0) return { ok: false, failure: { ...failure, details: { ...failure.details, also: options.redact(problems.join(' ')) } } }
    return { ok: false, failure, cleaned: true }
  }
  const booted = await bootSimulator(tools, udid, bounds())
  if (booted !== undefined) return undo(booted)
  let host: AgentDeviceHost
  try {
    host = await starter({ stateDir: folder, env: childEnvironment(undefined, tools.hiddenVariables), cwd: folder })
  } catch (error) {
    return undo({ class: 'setup_failed', message: options.redact(`agent-device's daemon did not start: ${errorMessage(error)}`) })
  }
  const execution: NativeExecutionIdentity = {
    platform: 'ios-simulator',
    app: { bundleId: bundle.bundle.bundleId, ...(bundle.bundle.version === undefined ? {} : { version: bundle.bundle.version }), ...(bundle.bundle.build === undefined ? {} : { build: bundle.bundle.build }), path: bundle.bundle.appPath, sha256: bundle.bundle.sha256 },
    os: { name: 'iOS', version: resolved.runtime.version, build: resolved.runtime.build },
    device: { name, type: resolved.deviceType.name, udid },
    executor,
    xcode,
  }
  const session = `retest-${process.pid}-${randomBytes(4).toString('hex')}`
  return { ok: true, runtime: new AgentDeviceRuntime({ options, host, platform: { kind: 'ios', udid, folder, exitHook }, session, bundle: bundle.bundle, execution }) }
}

async function startAndroid(options: AgentDeviceRuntimeOptions, target: Extract<AgentDeviceTargetConfig, { readonly platform: 'android' }>, starter: AgentDeviceStarter, deadline: Deadline): Promise<{ readonly ok: true; readonly runtime: AgentDeviceRuntime } | StartFailure> {
  const { tools } = options
  const bounds = (): RequestBounds => ({ timeoutMs: deadline.commandTimeoutMs, signal: options.signal })
  let apk: Uint8Array
  try {
    apk = await (options.readBytes ?? ((path) => readFile(path).then((bytes) => new Uint8Array(bytes))))(target.appPath)
  } catch (error) {
    return idle(`Retest cannot read the APK at ${target.appPath}: ${errorMessage(error)}`)
  }
  const folders = await sweepOwnedFolders(tools).catch((error: unknown) => ({ removed: [], kept: 0, problems: [`Retest could not look through the temporary folder for what earlier runs left: ${errorMessage(error)}`] }))
  if (folders.problems.length > 0) return idle(folders.problems.join(' '))
  let folder: string
  try {
    folder = await makeOwnedFolder('retest-agent-device-', tools)
  } catch (error) {
    return idle(`Retest could not make agent-device's state folder: ${errorMessage(error)}`)
  }
  let host: AgentDeviceHost
  try {
    host = await starter({ stateDir: folder, env: childEnvironment(undefined, tools.hiddenVariables), cwd: folder })
  } catch (error) {
    await rm(folder, { recursive: true, force: true }).catch(() => undefined)
    return idle(options.redact(`agent-device's daemon did not start: ${errorMessage(error)}`))
  }
  const giveUp = async (failure: Failure, bootedSerial?: string): Promise<StartFailure> => {
    const problems: string[] = []
    if (bootedSerial !== undefined) {
      const down = await host.port.call('devices.shutdown', { platform: 'android', serial: bootedSerial }, { timeoutMs: 60_000 })
      if (down.status !== 'answered') problems.push(`agent-device did not shut down the emulator it booted: ${describeAnswer(down)}`)
    }
    const closed = await host.close(60_000)
    if (!closed.ok) problems.push(closed.problem)
    else problems.push(...closed.leftovers)
    await rm(folder, { recursive: true, force: true }).catch((error: unknown) => problems.push(errorMessage(error)))
    if (problems.length > 0) return { ok: false, failure: { ...failure, details: { ...failure.details, also: options.redact(problems.join(' ')) } } }
    return { ok: false, failure, ...(bootedSerial === undefined ? { idle: true as const } : { cleaned: true as const }) }
  }
  const wanted = describeAndroidDevice(target.device)
  const found = await findAndroidDevice(host, target.device, bounds())
  if (!found.ok) return giveUp({ class: 'setup_failed', message: options.redact(found.problem) })
  let device = found.device
  let bootedHere = false
  if (!device.booted) {
    if (device.kind !== 'emulator') return giveUp({ class: 'setup_failed', message: options.redact(`The Android device ${wanted} is not running, and Retest boots only an emulator.`) })
    const boot = await host.port.call('devices.boot', { platform: 'android', ...('serial' in target.device ? { serial: target.device.serial } : { device: target.device.name }) }, bounds())
    if (boot.status !== 'answered') return giveUp({ class: 'setup_failed', message: options.redact(`agent-device did not boot the emulator ${wanted}: ${describeAnswer(boot)}`) })
    bootedHere = true
    const again = await findAndroidDevice(host, target.device, bounds())
    if (!again.ok || !again.device.booted) return giveUp({ class: 'setup_failed', message: options.redact(again.ok ? `The emulator ${wanted} did not come up after agent-device booted it.` : again.problem) }, again.ok ? again.device.serial : undefined)
    device = again.device
  }
  const android: AndroidDevice = { name: device.name, serial: device.serial, kind: device.kind, ...(device.model === undefined ? {} : { model: device.model }) }
  const bundle: AppBundle = { appPath: target.appPath, bundleId: target.package, name: target.package, executable: target.package, platforms: ['Android'], sha256: sha256Hex(apk) }
  const execution: NativeExecutionIdentity = {
    platform: 'android',
    app: { bundleId: target.package, path: target.appPath, sha256: bundle.sha256 },
    os: { name: 'Android', version: device.osVersion ?? 'unreported', build: 'unreported' },
    android,
    executor,
  }
  const session = `retest-${process.pid}-${randomBytes(4).toString('hex')}`
  return { ok: true, runtime: new AgentDeviceRuntime({ options, host, platform: { kind: 'android', serial: device.serial, folder, bootedHere }, session, bundle, execution }) }
}

type ListedAndroid = { readonly name: string; readonly serial: string; readonly kind: 'emulator' | 'device'; readonly booted: boolean; readonly model?: string; readonly osVersion?: string }

/**
 * The Android emulator or device a target names, among those agent-device lists: by its adb serial, or by its name.
 * None, or several by one name, fails by name, listing what agent-device found.
 *
 * @example await findAndroidDevice(host, { serial: 'emulator-5554' }, { timeoutMs: 30_000 })
 */
export async function findAndroidDevice(host: AgentDeviceHost, wanted: Extract<AgentDeviceTargetConfig, { readonly platform: 'android' }>['device'], bounds: RequestBounds): Promise<{ readonly ok: true; readonly device: ListedAndroid } | { readonly ok: false; readonly problem: string }> {
  const answer = await host.port.call('devices.list', { platform: 'android' }, bounds)
  if (answer.status !== 'answered') return { ok: false, problem: `agent-device did not list the Android devices: ${describeAnswer(answer)}` }
  const listed = Array.isArray(answer.value) ? answer.value.flatMap((entry) => readAndroidDevice(entry)) : []
  const matches = listed.filter((device) => ('serial' in wanted ? device.serial === wanted.serial : device.name === wanted.name))
  const [device, ...others] = matches
  const seen = listed.length === 0 ? 'it lists none' : `it lists ${listed.map((entry) => `${entry.name} (${entry.serial === '' ? 'not running' : entry.serial})`).join(', ')}`
  if (device === undefined) return { ok: false, problem: `agent-device finds no Android emulator or device with the ${describeAndroidDevice(wanted)}: ${seen}.` }
  if (others.length > 0) return { ok: false, problem: `agent-device lists ${matches.length} Android devices with the ${describeAndroidDevice(wanted)}. Name the one to use by its serial.` }
  return { ok: true, device }
}

function readAndroidDevice(entry: unknown): ListedAndroid[] {
  if (typeof entry !== 'object' || entry === null || Reflect.get(entry, 'platform') !== 'android') return []
  const get = (key: string): unknown => Reflect.get(entry, key)
  const android: unknown = get('android')
  const identifiers: unknown = get('identifiers')
  const serialValue: unknown = (typeof android === 'object' && android !== null ? Reflect.get(android, 'serial') : undefined) ?? (typeof identifiers === 'object' && identifiers !== null ? Reflect.get(identifiers, 'serial') : undefined)
  const name = get('name')
  const kind = get('kind')
  const model = get('model')
  const osVersion = get('osVersion')
  if (typeof name !== 'string') return []
  return [{
    name,
    serial: typeof serialValue === 'string' ? serialValue : '',
    kind: kind === 'emulator' ? 'emulator' : 'device',
    booted: get('booted') === true,
    ...(typeof model === 'string' ? { model } : {}),
    ...(typeof osVersion === 'string' ? { osVersion } : {}),
  }]
}

// Whether a request that did not succeed reached the device: only agent-device's refusal, or a stop before it went,
// proves it did not.
function inputOf(answer: Exclude<AgentDeviceAnswer, { readonly status: 'answered' }>): InputDispatch {
  return answer.status === 'refused' || (answer.status === 'stopped' && answer.dispatched === 'no') ? 'not_sent' : 'unknown'
}

// The less certain of two steps' inputs, as one request that took both reports it.
function worse(first: InputDispatch, second: InputDispatch): InputDispatch {
  if (first === 'unknown' || second === 'unknown') return 'unknown'
  return first === 'sent' || second === 'sent' ? 'sent' : 'not_sent'
}

// The package an install answer names: its package, or its app id.
function installedPackage(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const named: unknown = Reflect.get(value, 'package') ?? Reflect.get(value, 'appId')
  return typeof named === 'string' ? named : undefined
}

// The Xcode that agent-device builds its runner with, as `xcodebuild -version` names it, or why it cannot be read.
async function readXcode(tools: NativeTools, signal: AbortSignal | undefined): Promise<{ readonly version: string; readonly build: string } | string> {
  const result = await runCommand(tools.xcodebuild, ['-version'], { timeoutMs: 30_000, signal, hiddenVariables: tools.hiddenVariables })
  if (result.code !== 0) return `Xcode is needed for iOS simulator apps and ${describeCommand('xcodebuild -version', result)}. Install Xcode and select it with xcode-select.`
  const version = /^Xcode (\S+)/m.exec(result.stdout)?.[1]
  const build = /^Build version (\S+)/m.exec(result.stdout)?.[1]
  if (version === undefined || build === undefined) return 'Retest could not read which Xcode is installed from xcodebuild -version.'
  return { version, build }
}

// Every process whose command line names the simulator, once none is left or the wait ends: a simulator's id is
// unique, and Retest made this one, so a process that names it is one this runtime started through agent-device.
async function processesNaming(udid: string, tools: NativeTools, deadline: Deadline, waitMs: number): Promise<readonly { readonly pid: number }[] | string> {
  const until = performance.now() + waitMs
  for (;;) {
    let listed: Awaited<ReturnType<typeof listProcesses>>
    try {
      listed = await listProcesses(tools, Math.max(1, Math.min(10_000, deadline.commandTimeoutMs)))
    } catch (error) {
      return `Retest could not read whether a process of the simulator ${udid} is left: ${errorMessage(error)}`
    }
    const left = listed.filter((entry) => entry.pid !== process.pid && entry.command.includes(udid))
    if (left.length === 0 || performance.now() >= until || deadline.reached) return left
    await sleep(250)
  }
}

function describeAnswer(answer: Exclude<AgentDeviceAnswer, { readonly status: 'answered' }>): string {
  switch (answer.status) {
    case 'refused':
    case 'failed':
      return `${answer.code}${answer.reason === undefined ? '' : ` (${answer.reason})`}: ${answer.message}`
    case 'lost':
    case 'timeout':
      return answer.message
    case 'stopped':
      return 'the request was stopped'
  }
}

function idle(message: string): StartFailure {
  return { ok: false, failure: { class: 'setup_failed', message }, idle: true }
}
