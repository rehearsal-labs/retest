import type { ChildProcess } from 'node:child_process'
import type { Failure } from '../protocol/failures.ts'
import type { NativeTools, RecordedProcess } from './processes.ts'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { Socket } from 'node:net'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { errorMessage } from '../protocol/failures.ts'
import { parse, s } from '../protocol/schema.ts'
import { childEnvironment, commandOf, endProblem, endRecorded, groupPresence } from './processes.ts'
import { NativeError } from './session.ts'

// One interactive desktop, one macOS runner, across every process on the Mac. The desktop is held by a kernel lock:
// `lockf` holds the lock file for as long as a child of it, `cat`, reads a pipe from this process. When this process
// ends in any way, SIGKILL included, the pipe closes, `cat` and `lockf` exit, and the kernel lets the lock go; so no
// process ever has to judge whether a holder is still there, and two takers can never both hold it. The holder does
// not keep this process alive: the lock lasts as long as the process does, and no longer.
//
// Beside the lock, a record names the holder and the processes its runner runs as, each with its exact command line.
// Only the holder writes it, beside it and renamed into place. A record found by a new holder was left by one that is
// gone: the processes it names are ended, each only while its command line is still the recorded one, and the record
// is replaced only once nothing it names is left. A runner app that appeared during that holder's start and was never
// tied to it is named, never ended: the record stays, and starts are refused, until it is gone.

/**
 * What the record holds: the holder, when it took the desktop and how it was started (its program and entry script),
 * and the runner's processes.
 */
export type DesktopLockRecord = {
  pid: number
  startedAt: string
  holderCommand: string
  xcodebuild?: RecordedProcess
  runnerApps: RecordedProcess[]
  /** Runner apps that appeared during the start and are not tied to it yet. */
  untied?: RecordedProcess[]
}

const processSchema = s.object({ pid: s.number({ integer: true, min: 1 }), command: s.string() })
const recordSchema = s.object({ pid: s.number({ integer: true, min: 1 }), startedAt: s.string(), holderCommand: s.string(), xcodebuild: s.optional(processSchema), runnerApps: s.array(processSchema), untied: s.optional(s.array(processSchema)) })

// The record paths whose lock this process holds now, so a refusal can say the holder is this very process.
const heldHere = new Map<string, ChildProcess>()

/** Where the desktop lock lives unless told otherwise; its record sits beside it, ending in `.json`. */
export function defaultDesktopLock(): string {
  return join(homedir(), 'Library', 'Caches', 'retest', 'macos-desktop.lock')
}

/** The desktop, held by this process until `release` or until the process ends. */
export class DesktopLock {
  readonly path: string
  readonly recordPath: string
  readonly #holder: ChildProcess
  #record: DesktopLockRecord
  #released = false
  #releasing?: Promise<void>
  #holderGone = false

  constructor(path: string, holder: ChildProcess, record: DesktopLockRecord) {
    this.path = path
    this.recordPath = recordPathOf(path)
    this.#holder = holder
    this.#record = record
    holder.once('exit', () => {
      this.#holderGone = true
    })
  }

  /** The record as this holder last wrote it. */
  get record(): DesktopLockRecord {
    return this.#record
  }

  /**
   * Writes the runner's processes into the record as they appear, whole, so a later holder can recognise and end them.
   * Throws when the record cannot be written; a record that is not this holder's is never touched.
   */
  note(processes: { readonly xcodebuild?: RecordedProcess; readonly runnerApps: readonly RecordedProcess[]; readonly untied?: readonly RecordedProcess[] }): void {
    if (this.#released) throw new Error('The desktop lock was already let go.')
    if (this.#holderGone) throw new Error(`The process holding the desktop lock ${this.path} ended, so this process no longer holds the desktop.`)
    const known = new Map(this.#record.runnerApps.map((entry) => [entry.pid, entry]))
    for (const entry of processes.runnerApps) known.set(entry.pid, entry)
    const untied = processes.untied ?? this.#record.untied ?? []
    const next: DesktopLockRecord = { ...this.#record, ...(processes.xcodebuild === undefined ? {} : { xcodebuild: processes.xcodebuild }), runnerApps: [...known.values()], untied: [...untied] }
    if (!isMine(this.recordPath, this.#record)) throw new Error(`The desktop record ${this.recordPath} is not this process's.`)
    writeWhole(this.recordPath, next)
    this.#record = next
  }

  /** Lets the desktop go after its holder exits. The next kernel holder recovers its record; failed cleanup stays failed. */
  release(): Promise<void> {
    if (this.#releasing !== undefined) return this.#releasing
    this.#released = true
    this.#releasing = this.#release()
    return this.#releasing
  }

  async #release(): Promise<void> {
    try {
      await endHolder(this.#holder)
      // After EOF, a new holder may already have replaced this path. Only a kernel holder may change its record.
      if (heldHere.get(this.recordPath) === this.#holder) heldHere.delete(this.recordPath)
    } catch (error) {
      throw new NativeError({ class: 'cleanup_failed', message: `${errorMessage(error)} The desktop record ${this.recordPath} is kept.` })
    }
  }

  /**
   * Closes the holder's pipe for an exit hook, where nothing can wait. Its record stays for the next kernel holder
   * to recover; an unconfirmed exit also keeps this process's holder marker.
   */
  releaseNow(): void {
    if (this.#released) return
    this.#released = true
    try {
      this.#holder.stdin?.destroy()
      if (!this.#holderGone && this.#holder.exitCode === null && this.#holder.signalCode === null) return
      if (heldHere.get(this.recordPath) === this.#holder) heldHere.delete(this.recordPath)
    } catch {
      // Throwing here would replace the exit code Retest chose.
    }
  }
}

/**
 * Takes the desktop for this process. A desktop another process holds refuses, naming that process as its record does,
 * and one this process already holds says so. A record a gone holder left is cleared first: the processes it names are
 * ended while their command lines are the recorded ones, xcodebuild by its recorded pid only, and a runner app it never tied to
 * its start is named, never ended; until nothing it names is left, or when `ps` cannot be read, the record is kept, the
 * lock let go, and the start refused by name. A record that cannot be read is never overwritten. Resolves with the
 * pids ended.
 *
 * @example await takeDesktopLock({ path: defaultDesktopLock(), tools: systemTools })
 */
export async function takeDesktopLock(options: { readonly path: string; readonly tools: NativeTools }): Promise<{ readonly ok: true; readonly lock: DesktopLock; readonly recovered: readonly number[] } | { readonly ok: false; readonly failure: Failure }> {
  await mkdir(dirname(options.path), { recursive: true })
  const recordPath = recordPathOf(options.path)
  const held = await holdKernelLock(options)
  if (!held.ok) {
    if (held.reason !== 'held') return refused(held.reason)
    const other = readRecord(await readFile(recordPath, 'utf8').catch(() => ''))
    if (heldHere.has(recordPath) && other?.pid === process.pid) return refused(`This process already holds the desktop lock ${options.path}, since ${other.startedAt}: a runner this process started is still open, or its close could not end what it started, and the lock is kept until this process ends.`)
    if (other !== undefined) return { ok: false, failure: { class: 'setup_failed', message: `Another Retest process (pid ${other.pid}, started as ${JSON.stringify(other.holderCommand.slice(0, 300))} at ${other.startedAt}) drives this Mac's desktop; native work on one desktop runs one runner at a time.`, details: { lock: options.path, holder: other.pid } } }
    return refused(`Another process holds the desktop lock ${options.path}; native work on one desktop runs one runner at a time.`)
  }
  const recovered: number[] = []
  const text = await readFile(recordPath, 'utf8').catch((error: unknown) => (error instanceof Error && 'code' in error && error.code === 'ENOENT' ? undefined : error))
  if (text !== undefined && typeof text !== 'string') {
    return refuseAfterRelease(held.holder, `Retest could not read the desktop record ${recordPath} (${text instanceof Error ? text.message : String(text)}), so it cannot tell what the process that held the desktop before left running.`)
  }
  const left = text === undefined ? undefined : readRecord(text)
  if (text !== undefined && left === undefined) {
    return refuseAfterRelease(held.holder, `The desktop record ${recordPath} is not one Retest can read, so it cannot tell what the process that held the desktop before left running. Remove the file once no runner it names is running.`)
  }
  if (left !== undefined) {
    const cleared = await endLeftRunner(left, options.tools)
    if (!cleared.ok) {
      return refuseAfterRelease(held.holder, `${cleared.problem} The record ${recordPath} of the Retest process that held the desktop before is kept, so a later start can try again.`)
    }
    recovered.push(...cleared.pids)
  }
  const record: DesktopLockRecord = { pid: process.pid, startedAt: new Date().toISOString(), holderCommand: holderCommand(), runnerApps: [] }
  try {
    writeWhole(recordPath, record)
  } catch (error) {
    return refuseAfterRelease(held.holder, `Retest could not write the desktop record ${recordPath}: ${error instanceof Error ? error.message : String(error)}`)
  }
  heldHere.set(recordPath, held.holder)
  return { ok: true, lock: new DesktopLock(options.path, held.holder, record), recovered }
}

// Starts `lockf` on the lock file with a child that reads this process's pipe, and waits until it says it holds the
// lock, or exits: with 75 when another process holds it.
function holdKernelLock(options: { readonly path: string; readonly tools: NativeTools }): Promise<{ readonly ok: true; readonly holder: ChildProcess } | { readonly ok: false; readonly reason: string }> {
  return new Promise((resolve) => {
    const holder = spawn(options.tools.lockf, ['-k', '-s', '-t', '0', options.path, '/bin/sh', '-c', 'echo locked; exec /bin/cat > /dev/null'], { stdio: ['pipe', 'pipe', 'ignore'], detached: true, env: childEnvironment(undefined, options.tools.hiddenVariables) })
    let settled = false
    holder.stdout.once('data', () => {
      if (settled) return
      settled = true
      holder.stdout.destroy()
      holder.unref()
      if (holder.stdin instanceof Socket) holder.stdin.unref()
      resolve({ ok: true, holder })
    })
    holder.once('exit', (code) => {
      if (settled) return
      settled = true
      resolve({ ok: false, reason: code === 75 ? 'held' : `lockf could not take the desktop lock ${options.path} (exit code ${code ?? 'unknown'}).` })
    })
    holder.once('error', (error) => {
      if (settled) return
      settled = true
      resolve({ ok: false, reason: `lockf could not run: ${error.message}` })
    })
  })
}

// The holder is cooperative: closing its input ends cat and lockf. No process is signaled without a launch record.
async function endHolder(holder: ChildProcess): Promise<void> {
  if (holder.exitCode !== null || holder.signalCode !== null) return
  await new Promise<void>((resolve, reject) => {
    const finish = (failure?: NativeError): void => {
      clearTimeout(timer)
      holder.off('exit', onExit)
      holder.off('error', onError)
      if (failure === undefined) resolve()
      else reject(failure)
    }
    const onExit = (): void => finish()
    const onError = (error: unknown): void => finish(new NativeError({ class: 'cleanup_failed', message: `Could not close the desktop lock holder's input: ${errorMessage(error)}` }))
    const timer = setTimeout(() => finish(new NativeError({ class: 'cleanup_failed', message: `The desktop lock holder (pid ${holder.pid ?? 'unknown'}) did not confirm its exit after its input pipe was closed, so Retest left it alone.` })), 5000)
    holder.once('exit', onExit)
    holder.once('error', onError)
    try {
      holder.stdin?.destroy()
    } catch (error) {
      onError(error)
    }
  })
}

async function refuseAfterRelease(holder: ChildProcess, message: string): Promise<{ readonly ok: false; readonly failure: Failure }> {
  try {
    await endHolder(holder)
  } catch (error) {
    return { ok: false, failure: { class: 'cleanup_failed', message: `${message} ${errorMessage(error)}` } }
  }
  return refused(message)
}

// Ends what a gone holder's runner left: each process the record names whose command line is still exactly the
// recorded one. Unrecorded members of xcodebuild's group prevent recovery and are never signaled.
async function endLeftRunner(left: DesktopLockRecord, tools: NativeTools): Promise<{ readonly ok: true; readonly pids: number[] } | { readonly ok: false; readonly problem: string }> {
  const ended: number[] = []
  const problems: string[] = []
  for (const entry of left.runnerApps) {
    const outcome = await endRecorded(tools, entry, 5000)
    const problem = endProblem(entry, outcome)
    if (problem !== undefined) problems.push(problem)
    else if (outcome === 'ended') ended.push(entry.pid)
  }
  const xcodebuild = left.xcodebuild
  if (xcodebuild !== undefined) {
    // A persisted leader record grants no ownership of descendants that this process never observed launching.
    const outcome = await endRecorded(tools, xcodebuild, 5000)
    const problem = endProblem(xcodebuild, outcome)
    if (problem !== undefined) problems.push(problem)
    else if (outcome === 'ended') ended.push(xcodebuild.pid)
    const presence = groupPresence(xcodebuild.pid)
    if (presence === 'present') problems.push(`Process group ${xcodebuild.pid} still has members whose launch ownership was not recorded; Retest left them alone.`)
    else if (presence !== 'absent') problems.push(`Retest could not read whether process group ${xcodebuild.pid} is free: ${presence.unreadable}`)
  }
  for (const entry of left.untied ?? []) {
    const presence = await commandOf(tools, entry.pid)
    if (presence.state === 'unreadable') problems.push(`Retest could not read whether pid ${entry.pid} is still running: ${presence.problem}`)
    else if (presence.state === 'present' && presence.command === entry.command) problems.push(`A runner app (pid ${entry.pid}) appeared during that process's start, which ended before tying it to the start, so Retest did not end it; quit it and start again.`)
  }
  if (problems.length > 0) return { ok: false, problem: `Retest could not end what the Retest process that held the desktop before left running: ${problems.join(' ')}` }
  return { ok: true, pids: ended }
}

// How this process was started: its program and its entry script, never the arguments after them, which can carry a
// value that must not reach a file.
function holderCommand(): string {
  return [process.execPath, process.argv[1]].filter((part) => part !== undefined && part.length > 0).join(' ')
}

function writeWhole(path: string, record: DesktopLockRecord): void {
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  writeFileSync(temporary, JSON.stringify(record))
  renameSync(temporary, path)
}

function recordPathOf(path: string): string {
  return path.endsWith('.lock') ? `${path.slice(0, -'.lock'.length)}.json` : `${path}.json`
}

function readRecord(text: string): DesktopLockRecord | undefined {
  try {
    const parsed = parse(recordSchema, JSON.parse(text))
    return parsed.ok ? parsed.value : undefined
  } catch {
    return undefined
  }
}

function isMine(path: string, record: DesktopLockRecord): boolean {
  try {
    const current = readRecord(readFileSync(path, 'utf8'))
    return current?.pid === record.pid && current.startedAt === record.startedAt
  } catch {
    return false
  }
}

function refused(message: string): { readonly ok: false; readonly failure: Failure } {
  return { ok: false, failure: { class: 'setup_failed', message } }
}
