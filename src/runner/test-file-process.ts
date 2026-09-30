import type { ChildProcess } from 'node:child_process'
import type { Failure } from '../protocol/failures.ts'
import type { ChildMessage, ParentMessage } from '../protocol/messages.ts'
import type { ProcessExit } from '../shared/process-exit.ts'
import { fork } from 'node:child_process'
import { extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { childMessageSchema } from '../protocol/messages.ts'
import { parse } from '../protocol/schema.ts'

/** A message about the file or the test running in it. Errors outside any test are kept by the process. */
export type TestFileMessage = Exclude<ChildMessage, { type: 'process-error' }>

/** Everything a test file's process can tell the parent. Messages are validated before they arrive here. */
export type ProcessEvent =
  | { kind: 'message'; message: TestFileMessage }
  | { kind: 'invalid'; problem: string }
  | { kind: 'exit'; exit: ProcessExit }

/**
 * How a process ended once it was asked to close. `forced` means it had not ended within the grace
 * period and Retest killed it.
 */
export type ClosedProcess = { exit: ProcessExit; forced: boolean }

export type SpawnOptions = {
  /** Receives the process's stdout and stderr. Without it, both are discarded. */
  onOutput?: (stream: 'stdout' | 'stderr', text: string) => void
}

// The entry beside this module: child.ts when running from source, child.js once built.
const childEntry = fileURLToPath(new URL(`./child${extname(fileURLToPath(import.meta.url))}`, import.meta.url))

const liveChildren = new Set<ChildProcess>()
let exitHookInstalled = false

/**
 * The process one test file runs in. The parent owns it: it is killed when the run gives up on it, and,
 * as a last resort, when the parent process exits.
 */
export class TestFileProcess {
  readonly #child: ChildProcess
  readonly #closed: Promise<ProcessExit>
  readonly #errors: Failure[] = []
  #listener: ((event: ProcessEvent) => void) | undefined
  #exit: ProcessExit | undefined
  #killed = false

  private constructor(child: ChildProcess) {
    this.#child = child
    const closed = Promise.withResolvers<ProcessExit>()
    this.#closed = closed.promise
    child.on('message', (raw: unknown) => this.#receive(raw))
    child.on('exit', (code, signal) => this.#ended({ code, signal }))
    // A process that never started emits only `error`.
    child.on('error', () => {
      if (child.pid === undefined) this.#ended({ code: null, signal: null })
    })
    // `close` comes after the last message and the last output.
    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      this.#ended({ code, signal })
      closed.resolve(this.#exit ?? { code, signal })
    })
  }

  /** Starts a process for one test file, with the same export conditions as this one. */
  static spawn(options: SpawnOptions = {}): TestFileProcess {
    const output = options.onOutput
    const child = fork(childEntry, [], {
      execArgv: conditionArguments(process.execArgv),
      serialization: 'json',
      stdio: output === undefined ? ['ignore', 'ignore', 'ignore', 'ipc'] : ['ignore', 'pipe', 'pipe', 'ipc'],
    })
    own(child)
    if (output !== undefined) {
      child.stdout?.setEncoding('utf8').on('data', (text: string) => output('stdout', text))
      child.stderr?.setEncoding('utf8').on('data', (text: string) => output('stderr', text))
    }
    return new TestFileProcess(child)
  }

  get pid(): number | undefined {
    return this.#child.pid
  }

  get alive(): boolean {
    return this.#exit === undefined
  }

  /** How the process ended, once it has. */
  get exit(): ProcessExit | undefined {
    return this.#exit
  }

  /** Whether Retest killed the process. */
  get killed(): boolean {
    return this.#killed
  }

  /** Errors the process reported while no test was running, in order. All have arrived once it has closed. */
  get errors(): readonly Failure[] {
    return this.#errors
  }

  /** Resolves once the process has exited and its messages and output have all arrived. */
  get closed(): Promise<ProcessExit> {
    return this.#closed
  }

  /** Routes every later event to one listener, replacing the last. */
  listen(listener: ((event: ProcessEvent) => void) | undefined): void {
    this.#listener = listener
  }

  /** Sends a message if the process can still receive one. A process that is gone reports its exit instead. */
  send(message: ParentMessage): void {
    if (!this.#child.connected) return
    this.#child.send(message, (error: Error | null) => {
      if (error !== null && this.alive) this.#child.kill('SIGKILL')
    })
  }

  /** Kills the process at once and waits until it is gone. */
  kill(): Promise<ProcessExit> {
    if (this.alive) {
      this.#killed = true
      this.#child.kill('SIGKILL')
    }
    return this.#closed
  }

  /** Asks the process to finish, and kills it if it has not within `graceMs`. */
  async close(graceMs: number): Promise<ClosedProcess> {
    if (!this.alive) return { exit: await this.#closed, forced: false }
    this.send({ type: 'close' })
    let forced = false
    const timer = setTimeout(() => {
      forced = true
      void this.kill()
    }, graceMs)
    try {
      const exit = await this.#closed
      return { exit, forced }
    } finally {
      clearTimeout(timer)
    }
  }

  #receive(raw: unknown): void {
    const parsed = parse(childMessageSchema, raw)
    if (!parsed.ok) {
      this.#listener?.({ kind: 'invalid', problem: parsed.issues.map((issue) => `${issue.path} ${issue.message}`).join('; ') })
      return
    }
    const message = parsed.value
    if (message.type === 'process-error') this.#errors.push(message.failure)
    else this.#listener?.({ kind: 'message', message })
  }

  #ended(exit: ProcessExit): void {
    if (this.#exit !== undefined) return
    this.#exit = exit
    liveChildren.delete(this.#child)
    this.#listener?.({ kind: 'exit', exit })
  }
}

/** Whether a process ended by itself with nothing wrong. */
export function endedCleanly(exit: ProcessExit): boolean {
  return exit.code === 0 && exit.signal === null
}

/**
 * The `--conditions` arguments among Node's own, so the child resolves the same Retest (source or built)
 * as the parent. Other arguments, such as `--test`, stay behind.
 *
 * @example conditionArguments(['--test', '--conditions=retest-source']) // ['--conditions=retest-source']
 */
export function conditionArguments(execArgv: readonly string[]): string[] {
  const kept: string[] = []
  for (const [index, argument] of execArgv.entries()) {
    if (argument.startsWith('--conditions=') || argument.startsWith('-C=')) kept.push(argument)
    const next = execArgv[index + 1]
    if ((argument === '--conditions' || argument === '-C') && next !== undefined) kept.push(argument, next)
  }
  return kept
}

function own(child: ChildProcess): void {
  liveChildren.add(child)
  if (exitHookInstalled) return
  exitHookInstalled = true
  // Runs synchronously as the parent exits, whatever ended it short of SIGKILL.
  process.on('exit', () => {
    for (const live of liveChildren) live.kill('SIGKILL')
  })
}
