import type { ChildProcess } from 'node:child_process'
import type { RetestEvent } from '../../src/protocol/events.ts'
import type { RunResult } from '../../src/protocol/result.ts'
import type { EventOf, EventType, Exit } from '../integration/cli-harness.ts'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { agentVariables } from '../../src/cli/agent-detection.ts'
import { retestEventSchema } from '../../src/protocol/events.ts'
import { eventsFile, resultFile } from '../../src/protocol/run-folder.ts'
import { parse } from '../../src/protocol/schema.ts'
import { OwnedProcessGroup } from '../../src/shared/process-ownership.ts'
import { processesUsing, waitForGroupEnd } from '../integration/browser-harness.ts'
import { assertJudged, eventsOf, readEvents, readResult, retestEntriesIn, statesLeftIn } from '../integration/cli-harness.ts'
import { killBrowserFromOutside } from '../integration/outside-kill.ts'
import { tempFolder } from '../support/temp-folder.ts'

// One conformance run as a process of its own: `retest run`, or a host program that calls `runFiles`, started as the
// leader of its own process group with a temporary folder of its own, as the CLI harness starts one. Each process the
// run launches is recorded beneath it through the ownership layer while the run lives, as the CLI harness records
// them, and only a recorded process is ever signalled, after a fresh reading shows it is still the one recorded.

const releaseWaitMs = 5000

export type StartRequest = {
  /** The program and its leading arguments, such as Retest from source. */
  readonly command: readonly string[]
  readonly args: readonly string[]
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
}

/** A run process this module started, and what it printed. */
export class RunProcess {
  readonly pid: number
  readonly tmp: string
  readonly exited: Promise<Exit>
  readonly #child: ChildProcess
  readonly #startedAt = performance.now()
  readonly #printed: RetestEvent[] = []
  readonly #waiters = new Set<() => void>()
  /** The run and every process recorded beneath it while it ran, as the runner records the browsers it launches. */
  #ownership: OwnedProcessGroup | undefined
  /** Each reported browser no reading could find beneath the run, by pid, with its start and command when reported. */
  readonly #launchedElsewhere = new Map<number, ProcessReading>()
  #stdout = ''
  #stderr = ''
  #partialLine = ''
  #exit: Exit | undefined
  #durationMs = 0

  private constructor(child: ChildProcess, tmp: string) {
    const { pid } = child
    assert.ok(pid !== undefined, 'the run did not start')
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
        this.#exit = { code, signal }
        this.#notify()
        resolve(this.#exit)
      })
    })
  }

  /** Starts the run in its own process group, with a temporary folder of its own as TMPDIR. */
  static async start(request: StartRequest): Promise<RunProcess> {
    const tmp = join(tempFolder('retest-conformance-'), 'tmp')
    await mkdir(tmp, { recursive: true })
    const [executable = process.execPath, ...leading] = request.command
    const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: tmp }
    for (const name of agentVariables) delete env[name]
    const child = spawn(executable, [...leading, ...request.args], {
      cwd: request.cwd,
      env: { ...env, ...request.env },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return new RunProcess(child, tmp)
  }

  get stdout(): string {
    return this.#stdout
  }

  get stderr(): string {
    return this.#stderr
  }

  /** Milliseconds from start to exit, once the run has exited. */
  get durationMs(): number {
    return this.#durationMs
  }

  /** Sends a signal to the run's own process alone, as a person's Ctrl+C reaches it. */
  signal(signal: NodeJS.Signals): void {
    this.#child.kill(signal)
  }

  /**
   * Ends the run's whole process group, the test file processes in it included, while the run's own process has not
   * been reaped: until then its pid, which leads the group, cannot belong to anything else.
   */
  endGroup(): void {
    if (this.#exit !== undefined || this.#child.exitCode !== null || this.#child.signalCode !== null) return
    process.kill(-this.pid, 'SIGKILL')
  }

  /** Whether the run exits within `limitMs`. */
  async exitsWithin(limitMs: number): Promise<boolean> {
    const timer = Promise.withResolvers<false>()
    const handle = setTimeout(() => timer.resolve(false), limitMs)
    try {
      return await Promise.race([this.exited.then(() => true), timer.promise])
    } finally {
      clearTimeout(handle)
    }
  }

  /**
   * Ends a browser the run reported, as something outside Retest would, and says why when it cannot. Its main process
   * is ended alone, so its pipe closes at once and the run loses the whole browser in one moment; its helpers are left
   * to the browser's own cleanup and to the run, which records them. A browser beneath the run is ended only when a
   * fresh reading beneath the run's own process shows it is still the process recorded there. A browser the run started
   * through macOS Launch Services is no descendant of the run, so no reading can record it by ancestry: it is ended only
   * when a fresh reading shows the start and the command it had when the run reported it, a command that names the
   * run's own temporary folder, which holds its profile.
   */
  endBrowser(pid: number): string[] {
    if (this.#ownership?.verifiedIdentity(pid) !== undefined) {
      try {
        killBrowserFromOutside(this.pid, pid)
        return []
      } catch (error) {
        return [error instanceof Error ? error.message : String(error)]
      }
    }
    const recorded = this.#launchedElsewhere.get(pid)
    if (recorded === undefined) return [`process ${pid} is not recorded beneath the run, so it was not signalled`]
    const current = readProcess(pid)
    if (current === undefined) return [`process ${pid} had already ended`]
    if (current.startedAt !== recorded.startedAt || current.command !== recorded.command) {
      return [`process ${pid} is no longer the browser the run reported (start ${recorded.startedAt} to ${current.startedAt}), so it was not signalled`]
    }
    process.kill(pid, 'SIGKILL')
    return []
  }

  /**
   * Ends what the run left behind that is recorded beneath it, each process after a fresh reading shows it is still
   * the one recorded, and says what could not be ended. Nothing merely reported is signalled.
   */
  endLeftovers(): string[] {
    const ownership = this.#ownership
    if (ownership === undefined || !ownership.remains()) return []
    const report = ownership.signalReport('SIGKILL')
    return [...report.problems, ...report.identityRefusals]
  }

  // Records the run and what it has launched since the last record, only while Node has not reaped it, so its pid
  // cannot yet belong to anything else. A reported browser that is no descendant is read once, as it is now.
  #record(event: RetestEvent): void {
    if (event.type !== 'browser.started' && event.type !== 'app.started') return
    if (this.#child.exitCode !== null || this.#child.signalCode !== null) return
    this.#ownership ??= new OwnedProcessGroup(this.pid)
    this.#ownership.capture()
    if (event.type !== 'browser.started' || this.#ownership.verifiedIdentity(event.pid) !== undefined) return
    const reading = readProcess(event.pid)
    if (reading !== undefined && reading.command.includes(this.tmp) && reading.command.includes(event.executablePath)) this.#launchedElsewhere.set(event.pid, reading)
  }

  /** Resolves with the first event of this type on stdout that `matches`, and rejects once the run has exited without one. */
  waitForEvent<Type extends EventType>(type: Type, matches: (event: EventOf<Type>) => boolean = () => true): Promise<EventOf<Type>> {
    const { promise, resolve, reject } = Promise.withResolvers<EventOf<Type>>()
    const check = (): void => {
      const found = eventsOf(this.#printed, type).find(matches)
      if (found !== undefined) {
        this.#waiters.delete(check)
        resolve(found)
      } else if (this.#exit !== undefined) {
        this.#waiters.delete(check)
        reject(new Error(`the run exited without printing ${type}`))
      }
    }
    this.#waiters.add(check)
    check()
    return promise
  }

  #read(text: string): void {
    this.#stdout += text
    const lines = `${this.#partialLine}${text}`.split('\n')
    this.#partialLine = lines.pop() ?? ''
    for (const line of lines) {
      const parsed = parse(retestEventSchema, parseJson(line))
      if (!parsed.ok) continue
      this.#printed.push(parsed.value)
      this.#record(parsed.value)
    }
    this.#notify()
  }

  #notify(): void {
    for (const check of [...this.#waiters]) check()
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

/** A run that ended: how it exited, what it printed, and its folder, read and validated. */
export type EndedRun = {
  readonly exit: Exit
  readonly stdout: string
  readonly stderr: string
  readonly durationMs: number
  readonly output: string
  readonly events: RetestEvent[]
  readonly result: RunResult | undefined
}

/**
 * Waits for the run to end and reads its folder: every event line validated and numbered in order, every passed
 * assertion judged by whom it must be, and the result validated, as the CLI harness reads a run.
 */
export async function endRun(run: RunProcess, output: string): Promise<EndedRun> {
  const exit = await run.exited
  const events = existsSync(join(output, eventsFile)) ? readEvents(readFileSync(join(output, eventsFile), 'utf8')) : []
  assertJudged(events)
  const result = existsSync(join(output, resultFile)) ? readResult(readFileSync(join(output, resultFile), 'utf8')) : undefined
  return { exit, stdout: run.stdout, stderr: run.stderr, durationMs: run.durationMs, output, events, result }
}

/** The browser and app server process groups a run reported. */
export function reportedGroups(events: readonly RetestEvent[]): number[] {
  return events.flatMap((event) => (event.type === 'browser.started' || event.type === 'app.started' ? [event.pid] : []))
}

/**
 * Checks that the run left nothing behind, as the CLI harness checks: no process in its own group, no browser or app
 * server group it reported, nothing of Retest's in its temporary folder, no process using that folder, and no saved
 * sign-in state in its run folder.
 */
export async function assertNothingLeft(run: RunProcess, ended: EndedRun): Promise<void> {
  await waitForGroupEnd(run.pid, releaseWaitMs)
  assert.deepEqual(retestEntriesIn(run.tmp), [], 'no browser profile or other Retest folder is left in the temporary folder')
  assert.deepEqual(await processesUsing(run.tmp), [], 'no process uses the run temporary folder')
  for (const group of reportedGroups(ended.events)) await waitForGroupEnd(group, releaseWaitMs)
  assert.deepEqual(statesLeftIn(ended.output), [], 'no saved sign-in state is left in the run folder')
}

/** A process as `ps` shows it at one moment: when it started, to the second, and its whole command line. */
type ProcessReading = { readonly startedAt: string; readonly command: string }

/**
 * A process as `ps` shows it now, or undefined when it is gone or cannot be read.
 *
 * @example readProcess(4242) // { startedAt: 'Mon Oct  5 12:00:01 2026', command: '/Applications/Firefox.app/… -profile /var/…' }
 */
function readProcess(pid: number): ProcessReading | undefined {
  try {
    const printed = execFileSync('ps', ['-ww', '-o', 'lstart=,command=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, LC_ALL: 'C', TZ: 'UTC0' } })
    // `lstart` is five words wide, such as "Mon Oct  5 12:00:01 2026", and the command follows it.
    const match = /^\s*(\S+\s+\S+\s+\d+\s+[\d:]+\s+\d+)\s+(.*)$/.exec(printed.trim())
    return match?.[1] === undefined || match[2] === undefined ? undefined : { startedAt: match[1].replace(/\s+/g, ' '), command: match[2] }
  } catch {
    return undefined
  }
}
