import type { RetestEvent } from '../protocol/events.ts'
import type { Failure } from '../protocol/failures.ts'
import type { RunResult } from '../protocol/result.ts'
import type { StorageState } from '../protocol/storage-state.ts'
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { errorMessage } from '../protocol/failures.ts'
import { eventsFile, logsFolder, resultFile, statesFolder } from '../protocol/run-folder.ts'
import { parse } from '../protocol/schema.ts'
import { storageStateSchema } from '../protocol/storage-state.ts'
import { errorCode } from '../shared/error-code.ts'

/** Thrown when the run folder cannot be created or already holds another run. */
export class RunFolderError extends Error {
  override readonly name = 'RunFolderError'
  readonly failure: Failure

  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.failure = { class: 'usage', message }
  }
}

/**
 * The folder one run writes: events as whole lines, logs, artifacts, and `result.json` last. It never
 * writes over another run.
 */
export class RunStore {
  readonly directory: string
  readonly #events: number
  readonly #logs = new Map<string, number>()
  #resultWritten = false
  #closed = false
  #removeStatesOnExit: (() => void) | undefined

  private constructor(directory: string, events: number) {
    this.directory = directory
    this.#events = events
  }

  /**
   * Creates the folder, or takes an empty one. Creating `events.jsonl` exclusively claims the folder, so
   * two runs started at once cannot share it.
   *
   * @example const store = RunStore.create('.retest/runs/2026-09-30T09-15-00.000Z')
   */
  static create(folder: string): RunStore {
    const directory = resolve(folder)
    const events = claim(directory)
    try {
      mkdirSync(join(directory, logsFolder))
    } catch (error) {
      closeSync(events)
      throw new RunFolderError(`Retest could not create ${join(directory, logsFolder)}: ${errorMessage(error)}`, { cause: error })
    }
    return new RunStore(directory, events)
  }

  /** Writes one event as one line, synchronously, so a killed process leaves only whole lines behind. */
  appendEvent(event: RetestEvent): void {
    writeAll(this.#events, `${JSON.stringify(event)}\n`)
  }

  /** Appends text to a log file named by a path relative to the run folder. */
  appendLog(path: string, text: string): void {
    let descriptor = this.#logs.get(path)
    if (descriptor === undefined) {
      descriptor = openSync(this.#path(path), 'a')
      this.#logs.set(path, descriptor)
    }
    writeAll(descriptor, text)
  }

  /**
   * Rewrites every log with `redact`, for once nothing writes to them any more. A log was redacted as it was
   * written with what was known then; a value learned later, such as a one-time code a server printed before a
   * fill read it, is only hidden by this pass.
   */
  redactLogs(redact: (text: string) => string): void {
    const folder = this.#path(logsFolder)
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      if (!entry.isFile()) continue
      const path = join(folder, entry.name)
      const text = readFileSync(path, 'utf8')
      const redacted = redact(text)
      if (redacted !== text) writeFileSync(path, redacted)
    }
  }

  /** Writes a new artifact. An existing file is never replaced. */
  writeArtifact(path: string, bytes: Uint8Array): void {
    const target = this.#path(path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, bytes, { flag: 'wx' })
  }

  /** Writes `result.json` once, through a temporary file renamed into place, so it is never half written. */
  writeResult(result: RunResult): void {
    if (this.#resultWritten) throw new Error('result.json is written once per run.')
    const temporary = this.#path(`${resultFile}.partial`)
    writeFileSync(temporary, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' })
    renameSync(temporary, this.#path(resultFile))
    this.#resultWritten = true
  }

  /**
   * Saves a sign-in state where only this user can read it, never over another. States hold session cookies, so
   * they are removed when the run ends, and when the process exits before it could.
   */
  writeState(path: string, state: StorageState): void {
    const target = this.#path(path)
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
    if (this.#removeStatesOnExit === undefined) {
      this.#removeStatesOnExit = () => this.removeStates()
      process.once('exit', this.#removeStatesOnExit)
    }
    writeFileSync(target, JSON.stringify(state), { flag: 'wx', mode: 0o600 })
  }

  /** Reads a state `writeState` saved, checked against its schema. */
  readState(path: string): StorageState {
    const parsed = parse(storageStateSchema, JSON.parse(readFileSync(this.#path(path), 'utf8')))
    if (parsed.ok) return parsed.value
    throw new Error(`${path} is not a saved state: ${parsed.issues.map((issue) => `${issue.path} ${issue.message}`).join('; ')}`)
  }

  /** Removes every saved state. */
  removeStates(): void {
    if (this.#removeStatesOnExit !== undefined) process.removeListener('exit', this.#removeStatesOnExit)
    this.#removeStatesOnExit = undefined
    rmSync(this.#path(statesFolder), { recursive: true, force: true })
  }

  /** The absolute path of a file inside the run folder. */
  pathOf(path: string): string {
    return this.#path(path)
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    closeSync(this.#events)
    for (const descriptor of this.#logs.values()) closeSync(descriptor)
    this.#logs.clear()
  }

  #path(path: string): string {
    return join(this.directory, path)
  }
}

function claim(directory: string): number {
  try {
    mkdirSync(directory, { recursive: true })
  } catch (error) {
    const problem = errorCode(error) === 'EEXIST' ? 'a file is already there' : errorMessage(error)
    throw new RunFolderError(`Retest could not create the run folder ${directory}: ${problem}.`, { cause: error })
  }
  if (readdirSync(directory).length > 0) throw new RunFolderError(occupied(directory))
  try {
    return openSync(join(directory, eventsFile), 'wx')
  } catch (error) {
    if (errorCode(error) === 'EEXIST') throw new RunFolderError(occupied(directory), { cause: error })
    throw new RunFolderError(`Retest could not write to the run folder ${directory}: ${errorMessage(error)}`, { cause: error })
  }
}

function writeAll(descriptor: number, text: string): void {
  const bytes = Buffer.from(text, 'utf8')
  let offset = 0
  while (offset < bytes.length) offset += writeSync(descriptor, bytes, offset)
}

function occupied(directory: string): string {
  return `The run folder ${directory} already holds files. Retest never writes over a run; choose a new folder.`
}
