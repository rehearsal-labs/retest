import type { Readable } from 'node:stream'
import type { ConsoleCapture, ConsoleCounts, ConsoleRecord, DiagnosticIdentity } from '../protocol/diagnostics.ts'
import type { AttemptBudget, TextRedactor } from '../diagnostics/session-capture.ts'
import type { NativeTools, RecordedProcess } from './processes.ts'
import type { AppProcessReading, LaunchSpec } from './session.ts'
import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { setTimeout as sleep } from 'node:timers/promises'
import { boundText, sanitizeText } from '../diagnostics/sanitize.ts'
import { errorMessage } from '../protocol/failures.ts'
import { childEnvironment, commandOf, endProblem, endRecorded, killRecordedNow } from './processes.ts'
import { simulatorAppProcesses } from './ios-simulator.ts'

export type NativeLogSourceName = 'simctl-stdout' | 'macos-stdout'
export type NativeLogOptions = { identity: DiagnosticIdentity; budget: AttemptBudget; redactor: TextRedactor; enabled?: boolean; clock?: () => number }
export type NativeLogResult = { records: ConsoleRecord[]; capture: ConsoleCapture }

/** Owned app output only. No raw line is written to a file, even while a line is being assembled. */
export class NativeLogSource {
  readonly #options: NativeLogOptions
  readonly #records: ConsoleRecord[] = []
  readonly #counts: ConsoleCounts = { entries: 0, errors: 0, warnings: 0, runtimeErrors: 0, handledLater: 0, dropped: 0, truncated: 0, bytes: 0 }
  readonly #decoder = new StringDecoder('utf8')
  readonly #reasons = new Set<string>()
  readonly #detach: (() => void)[] = []
  #owned: { process: RecordedProcess; source: NativeLogSourceName } | undefined
  #line = ''
  #cut = false
  #rawLength = 0
  #unavailable: string | undefined
  #finished: NativeLogResult | undefined

  constructor(options: NativeLogOptions) { this.#options = { ...options, identity: { ...options.identity } } }

  /** A parent can wait for an expected app line without reading or exposing its text. */
  get entries(): number { return this.#counts.entries }

  assertLaunchable(): void { if (this.#owned !== undefined || this.#finished !== undefined) throw new Error('The native log source is already bound or finished.') }

  /** Called by the launcher with the pid and command it recorded after its own launch. */
  bind(process: RecordedProcess, source: NativeLogSourceName): void {
    this.assertLaunchable()
    if (!Number.isSafeInteger(process.pid) || process.pid < 1 || process.command === '') throw new Error('A native log source needs the owned pid and command.')
    this.#owned = { process: { ...process }, source }
  }

  attach(stream: Readable): void {
    if (this.#owned === undefined) throw new Error('Bind the owned process before attaching its output.')
    const data = (chunk: Buffer): void => this.push(chunk)
    const error = (): void => this.partial('the app log stream could not be read')
    const end = (): void => { if (this.#line !== '' || this.#cut) this.partial('the app log ended inside a line') }
    stream.on('data', data).on('error', error).on('end', end)
    this.#detach.push(() => { stream.off('data', data).off('error', error).off('end', end) })
  }

  /** Chunks from a pipe, never from the machine's unscoped log. Memory per line is bounded before decoding more. */
  push(chunk: Uint8Array): void {
    if (this.#finished !== undefined || this.#options.enabled === false) return
    if (this.#owned === undefined) throw new Error('The log chunk names no owned process.')
    // Split large chunks so the decoder and the line buffer never keep an unbounded string.
    for (let offset = 0; offset < chunk.length; offset += 4096) this.#text(this.#decoder.write(Buffer.from(chunk.subarray(offset, offset + 4096))))
  }

  unavailable(reason: string): void { if (this.#finished === undefined) this.#unavailable = reason }
  partial(reason: string): void { if (this.#finished === undefined) this.#reasons.add(reason) }

  finish(): NativeLogResult {
    if (this.#finished !== undefined) return this.#finished
    for (const detach of this.#detach.splice(0)) detach()
    this.#text(this.#decoder.end())
    if (this.#line !== '' || this.#cut) { this.#reasons.add('the app log ended inside a line'); this.#keep() }
    // Secrets may have been learned since a line arrived. Rebound the final redacted representation, including bytes.
    const budget = this.#options.budget
    budget.consoleEntries -= this.#counts.entries; budget.consoleBytes -= this.#counts.bytes
    this.#counts.entries = 0; this.#counts.bytes = 0; this.#counts.truncated = 0
    const records: ConsoleRecord[] = []
    for (const record of this.#records) {
      const rewritten = boundText(sanitizeText(this.#options.redactor.redact(record.text.text)), budget.limits.textLength)
      const text = { ...rewritten, truncated: record.text.truncated || rewritten.truncated, length: Math.max(record.text.length, rewritten.length) }
      const final = { ...record, text }
      const bytes = Buffer.byteLength(JSON.stringify(final)) + 1
      if (budget.consoleEntries >= budget.limits.consoleEntries || budget.consoleBytes + bytes > budget.limits.consoleBytes) { this.#counts.dropped++; continue }
      budget.consoleEntries++; budget.consoleBytes += bytes
      this.#counts.entries++; this.#counts.bytes += bytes
      if (text.truncated) this.#counts.truncated++
      records.push(final)
    }
    const { dropped, truncated } = this.#counts
    if (dropped > 0) this.#reasons.add('app log lines over the diagnostics limits were dropped')
    if (truncated > 0) this.#reasons.add('app log lines over the text limit were cut')
    const capture: ConsoleCapture = this.#options.enabled === false ? { state: 'disabled' }
      : this.#unavailable !== undefined ? records.length === 0 ? { state: 'unavailable', reason: this.#unavailable } : { state: 'partial', ...this.#counts, reason: this.#unavailable }
      : this.#reasons.size > 0 ? { state: 'partial', ...this.#counts, reason: [...this.#reasons].join('; ') }
      : records.length === 0 ? { state: 'unavailable', reason: this.#owned === undefined ? 'the app provides no log source' : 'the app wrote no log lines' }
      : { state: 'complete', ...this.#counts }
    this.#finished = { records, capture }
    return this.#finished
  }

  #text(text: string): void {
    for (const part of text.split(/(?<=\n)/)) {
      const ended = part.endsWith('\n')
      const value = ended ? part.slice(0, -1) : part
      this.#rawLength += value.length
      const room = this.#options.budget.limits.textLength * 4 - this.#line.length
      if (!this.#cut) {
        this.#line += value.slice(0, Math.max(0, room))
        if (value.length > room) this.#cut = true
      }
      if (ended) this.#keep()
    }
  }

  #keep(): void {
    const owned = this.#owned
    if (owned === undefined) return
    const raw = this.#line.replace(/\r$/, '')
    if (raw.trim() === '' && !this.#cut) { this.#line = ''; this.#rawLength = 0; return }
    const clean = this.#cut ? this.#options.redactor.scan(raw, true).text : this.#options.redactor.redact(raw)
    const bounded = boundText(sanitizeText(clean), this.#options.budget.limits.textLength)
    const text = this.#cut ? { ...bounded, truncated: true, length: this.#rawLength } : bounded
    this.#line = ''; this.#cut = false; this.#rawLength = 0
    const record: ConsoleRecord = { ...this.#options.identity, type: 'console', id: `c${this.#records.length + 1}`, consoleType: 'stdout', level: 'info', origin: 'native', source: owned.source, processId: owned.process.pid, text, time: new Date((this.#options.clock ?? Date.now)()).toISOString() }
    const bytes = Buffer.byteLength(JSON.stringify(record)) + 1
    const budget = this.#options.budget
    if (budget.consoleEntries >= budget.limits.consoleEntries || budget.consoleBytes + bytes > budget.limits.consoleBytes) { this.#counts.dropped++; return }
    budget.consoleEntries++; budget.consoleBytes += bytes
    this.#counts.entries++; this.#counts.bytes += bytes
    if (text.truncated) this.#counts.truncated++
    this.#records.push(record)
  }
}

export type LoggedNativeLaunch = {
  readonly process: RecordedProcess
  readonly launcher?: RecordedProcess
  /** Ends only this launch's recorded pid after checking it is still the recorded process, and removes its pipe. */
  stop(): Promise<void>
}
export type LoggedNativeLaunchOptions = {
  source: NativeLogSource
  tools: NativeTools
  launch: LaunchSpec
  timeoutMs: number
  /** The driver's own app-scoped process observation; injectable for a driver wrapper or fake. */
  processes?: (timeoutMs: number) => Promise<AppProcessReading>
  target: { platform: 'macos'; executable: string } | { platform: 'ios-simulator'; udid: string; bundleId: string; executable: string }
}

/**
 * Launch hook for a NativeAppDriver wrapper. The session must check its launch blocker before calling it. A macOS app
 * runs in a process group of its own, so a stop meant for Retest's group never reaches it, and is killed by an exit
 * hook if Retest exits before stopping it; a SIGKILL of Retest runs no hook, and the next launch blocker names the copy.
 */
export async function launchLoggedNativeApp(options: LoggedNativeLaunchOptions): Promise<LoggedNativeLaunch> {
  const { source, tools, target, launch, timeoutMs } = options
  source.assertLaunchable()
  if (target.platform === 'macos') {
    // Give the app only the explicitly declared environment; no judge or host credential is inherited.
    const child = spawn(target.executable, [...launch.arguments], { env: { ...launch.environment }, stdio: ['ignore', 'pipe', 'ignore'], detached: true })
    const started = await new Promise<number>((resolve, reject) => { child.once('spawn', () => child.pid === undefined ? reject(new Error('The app launch names no pid.')) : resolve(child.pid)); child.once('error', () => { source.unavailable('the app log source could not be opened'); reject(new Error('The app log source could not be opened.')) }) })
    const presence = await commandOf(tools, started)
    if (presence.state !== 'present' || !(presence.command === target.executable || presence.command.startsWith(`${target.executable} `))) { source.unavailable('the app log source could not be opened'); throw new Error('The launched app command could not be reconciled.') }
    const app = { pid: started, command: presence.command, startedAt: presence.startedAt }
    const lastResort = (): void => killRecordedNow([app], tools)
    process.on('exit', lastResort)
    source.bind(app, 'macos-stdout'); source.attach(child.stdout)
    let stopping: Promise<void> | undefined
    return { process: app, stop: () => stopping ??= (async () => {
      const problem = endProblem(app, await endRecorded(tools, app, timeoutMs))
      child.stdout.destroy()
      // The hook stays while the app may still run.
      if (problem !== undefined) throw new Error(problem)
      process.off('exit', lastResort)
    })() }
  }
  // Console mode streams the owned app without a raw spool. It does not reliably print a launch pid.
  // Reconcile through the parent's app-scoped OS reading, never a pid chosen by app text.
  if (!/^[0-9a-f-]{36}$/i.test(target.udid) || target.executable === '' || target.executable.includes('/')) throw new Error('The log launch needs the owned simulator and app executable name.')
  const processes = options.processes ?? ((remainingMs: number) => simulatorAppProcesses(tools, target.udid, target.bundleId, { timeoutMs: remainingMs }))
  const before = await processes(timeoutMs)
  if (!before.ok || before.processes.length > 0) { source.unavailable('the app log source could not be opened'); throw new Error('The app process is unreadable or already running; the log launch did not start another copy.') }
  const environment = Object.fromEntries(Object.entries(launch.environment).map(([name, value]) => [`SIMCTL_CHILD_${name}`, value]))
  const child = spawn(tools.xcrun, ['simctl', 'launch', '--console', target.udid, target.bundleId, ...launch.arguments], { env: childEnvironment(environment, tools.hiddenVariables), stdio: ['ignore', 'pipe', 'ignore'] })
  let bootstrap = Buffer.alloc(0)
  let ready = false
  let overflow = false
  let unavailable = false
  const data = (chunk: Buffer): void => {
    if (ready) { source.push(chunk); return }
    const room = 64 * 1024 - bootstrap.length
    if (chunk.length > room) overflow = true
    bootstrap = Buffer.concat([bootstrap, chunk.subarray(0, Math.max(0, room))])
  }
  const readError = (): void => { unavailable = true; source.partial('the app log stream could not be read') }
  child.stdout.on('data', data).on('error', readError)
  child.once('error', () => { unavailable = true })
  child.once('exit', () => { unavailable = true })
  let launcher: RecordedProcess | undefined
  try {
    const launcherPid = child.pid
    if (launcherPid === undefined) throw new Error('The log launcher names no pid.')
    const launcherPresence = await commandOf(tools, launcherPid)
    if (launcherPresence.state !== 'present') throw new Error('The log launcher command could not be recorded.')
    launcher = { pid: launcherPid, command: launcherPresence.command, startedAt: launcherPresence.startedAt }
    const recordedLauncher = launcher
    const started = performance.now()
    let process: RecordedProcess | undefined
    while (!unavailable && performance.now() - started < timeoutMs) {
      const scoped = await processes(Math.max(1, Math.floor(timeoutMs - (performance.now() - started))))
      if (!scoped.ok || scoped.processes.length > 1) throw new Error('The dispatched launch could not be reconciled to one owned app process.')
      const candidate = scoped.processes[0]
      if (candidate !== undefined) {
        const presence = await commandOf(tools, candidate.pid)
        if (presence.state !== 'present' || presence.command !== candidate.command || (candidate.startedAt !== undefined && presence.startedAt !== candidate.startedAt) || !presence.command.includes(`/Devices/${target.udid}/`) || !(presence.command.endsWith(`/${target.executable}`) || presence.command.includes(`/${target.executable} `))) throw new Error('The launched app command could not be reconciled; the launch remains unreconciled.')
        process = { pid: candidate.pid, command: presence.command, startedAt: presence.startedAt }; break
      }
      await sleep(25)
    }
    if (process === undefined) throw new Error('The dispatched app launch could not be reconciled before the log source ended.')
    source.bind(process, 'simctl-stdout')
    if (overflow) source.partial('the app log exceeded the launch buffer limit')
    const bundle = target.bundleId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const marker = new RegExp(`^${bundle}: ${process.pid}\\r?\\n`, 'm')
    const initial = bootstrap.toString('latin1').replace(marker, '')
    ready = true; bootstrap = Buffer.alloc(0); source.push(Buffer.from(initial, 'latin1'))
    const app = process
    let stopping: Promise<void> | undefined
    return { process: app, launcher: recordedLauncher, stop: () => stopping ??= (async () => {
      const appProblem = endProblem(app, await endRecorded(tools, app, timeoutMs))
      if (appProblem !== undefined) { source.partial('the owned app shutdown could not be reconciled'); throw new Error(appProblem) }
      const launcherProblem = endProblem(recordedLauncher, await endRecorded(tools, recordedLauncher, timeoutMs))
      child.stdout.off('data', data).off('error', readError); child.stdout.destroy()
      if (launcherProblem !== undefined) { source.partial('the owned log launcher shutdown could not be reconciled'); throw new Error(launcherProblem) }
    })() }
  } catch (error) {
    source.unavailable('the app log source could not be opened')
    child.stdout.off('data', data).off('error', readError); child.stdout.resume()
    // No signal is sent to the app while its ownership is unresolved, and ending the launcher cannot undo the launch it
    // dispatched. The launcher is Retest's own child, recorded right after it started, so it is ended.
    const ended = launcher === undefined ? undefined : endProblem(launcher, await endRecorded(tools, launcher, Math.min(timeoutMs, 2000)))
    if (ended !== undefined) throw new Error(`${errorMessage(error)} The log launcher could not be ended: ${ended}`, { cause: error })
    throw error
  }
}
