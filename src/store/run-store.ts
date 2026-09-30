import type { RetestEvent } from '../protocol/events.ts'
import type { Failure } from '../protocol/failures.ts'
import type { RunResult } from '../protocol/result.ts'
import { closeSync, mkdirSync, openSync, readdirSync, renameSync, writeFileSync, writeSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { errorMessage } from '../protocol/failures.ts'
import { eventsFile, resultFile } from '../protocol/run-folder.ts'
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
      mkdirSync(join(directory, 'logs'))
    } catch (error) {
      closeSync(events)
      throw new RunFolderError(`Retest could not create ${join(directory, 'logs')}: ${errorMessage(error)}`, { cause: error })
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
