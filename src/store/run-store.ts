import type { RetestEvent } from '../protocol/events.ts'
import type { Failure } from '../protocol/failures.ts'
import type { RunResult } from '../protocol/result.ts'
import type { StorageState } from '../protocol/storage-state.ts'
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { redactArtifactText } from '../diagnostics/artifact.ts'
import { monotonicClock } from '../protocol/deadline.ts'
import { errorMessage } from '../protocol/failures.ts'
import { diagnosticsFolder, eventsFile, logsFolder, resultFile, statesFolder } from '../protocol/run-folder.ts'
import { parse } from '../protocol/schema.ts'
import { storageStateSchema } from '../protocol/storage-state.ts'
import { learnedSoFar } from '../runner/redactor.ts'
import { errorCode } from '../shared/error-code.ts'
import { keepFolderToUser, PrivateFolderError } from '../shared/private-file.ts'

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
 * A file or folder as a pass found it. Its contents are the same while all of these are, as every change of them moves
 * its change time, and one put in its place has another inode.
 */
type FileState = { readonly inode: bigint; readonly size: bigint; readonly modifiedNs: bigint; readonly changedNs: bigint }

/** A file as the last pass that read it left it, with `learnedSoFar()` as it stood then. */
type PassedFile = { readonly learned: number; readonly state: FileState }

/**
 * The folder one run writes: events as whole lines, logs, artifacts, and `result.json` last. It never
 * writes over another run.
 */
export class RunStore {
  readonly directory: string
  readonly #events: number
  readonly #logs = new Map<string, number>()
  // Each artifact this store wrote, by its absolute path, with `learnedSoFar()` as it stood when it was written or last
  // redacted again. An artifact whose mark still equals the count holds no value any redactor knows.
  readonly #redactedAt = new Map<string, number>()
  // Each file another writer may add to, by its absolute path, as the last pass that read it left it.
  readonly #passed = new Map<string, PassedFile>()
  // The diagnostics folder as the last pass over it found it, while every file in it was an artifact of this store's.
  #diagnosticsPass: { readonly learned: number; readonly written: number; readonly folder: FileState } | undefined
  #diagnosticsWritten = 0
  #resultWritten = false
  #closed = false
  #removeStatesOnExit: (() => void) | undefined
  #statesReady: Promise<void> | undefined
  // Where the run's clock stands at zero on the host's monotonic clock, as the events written so far place it.
  #clockZero: number | undefined
  #clock: (() => number) | undefined

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

  /**
   * Writes one event as one line, synchronously, so a killed process leaves whole lines behind. On Linux, SIGKILL
   * can end the last write early at a page boundary and cut that one line off; `inspect` leaves such a line out.
   */
  appendEvent(event: RetestEvent): void {
    // Each event is stamped a moment before it is written, so the earliest zero any event places is the closest to the
    // event log's own.
    const zero = monotonicClock() - event.elapsedMs
    if (this.#clockZero === undefined || zero < this.#clockZero) this.#clockZero = zero
    writeAll(this.#events, `${JSON.stringify(event)}\n`)
  }

  /** Supplies the run's clock to capture writers. Older callers retain the clock inferred from events. */
  setClock(clock: () => number): void { this.#clock = clock }

  /** Whole milliseconds on the supplied clock, or the event clock fallback before a caller supplies one. */
  elapsedMs(): number | undefined {
    if (this.#clock !== undefined) return this.#clock()
    return this.#clockZero === undefined ? undefined : Math.max(0, Math.round(monotonicClock() - this.#clockZero))
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
   * fill read it, is only hidden by this pass. A run passes over its logs more than once as it ends, so a log an
   * earlier pass left as it still is, with no value learned since, is not read again.
   */
  redactLogs(redact: (text: string) => string): void {
    const learned = learnedSoFar()
    const visit = (folder: string): void => {
      for (const entry of readdirSync(folder, { withFileTypes: true })) {
        const path = join(folder, entry.name)
        if (entry.isDirectory()) { visit(path); continue }
        // A link in a run folder never authorizes rewriting its target outside that folder.
        if (!entry.isFile()) continue
        this.#redactFile(path, redact, learned)
      }
    }
    visit(this.#path(logsFolder))
  }

  /**
   * Rewrites every diagnostics artifact with each page text passed through `redact`, as `redactLogs` rewrites the logs.
   * Its records were redacted as it was written, so an artifact this store wrote with no value learned since holds none
   * and is not read again; one written before a value was learned is. A pass that follows another with no value learned
   * and nothing added to the folder since reads nothing. A run with no artifact has nothing to rewrite.
   */
  redactDiagnostics(redact: (text: string) => string): void {
    const folder = this.#path(diagnosticsFolder)
    if (!existsSync(folder)) return
    const learned = learnedSoFar()
    const listed = stateOf(folder)
    const last = this.#diagnosticsPass
    if (last !== undefined && last.learned === learned && last.written === this.#diagnosticsWritten && sameState(last.folder, listed)) return
    let others = false
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      if (!entry.isFile()) continue
      const path = join(folder, entry.name)
      const mark = this.#redactedAt.get(path)
      if (mark === undefined) {
        others = true
        this.#redactFile(path, (text) => redactArtifactText(text, redact), learned)
        continue
      }
      if (mark === learned) continue
      const text = readFileSync(path, 'utf8')
      const redacted = redactArtifactText(text, redact)
      if (redacted !== text) writeFileSync(path, redacted)
      this.#redactedAt.set(path, learned)
    }
    // A file this store did not write may change without the store hearing of it, so a folder holding one is listed again.
    this.#diagnosticsPass = others ? undefined : { learned, written: this.#diagnosticsWritten, folder: listed }
  }

  // A file another writer may add to, as a log is, is read unless the last pass left it as it is now with no value
  // learned since. Its state is taken before it is read, so text added while it is read makes the next pass read it
  // again. A writer adding to a file while this pass rewrites it races that rewrite, as it always has.
  #redactFile(path: string, rewrite: (text: string) => string, learned: number): void {
    const before = stateOf(path)
    const passed = this.#passed.get(path)
    if (passed !== undefined && passed.learned === learned && sameState(passed.state, before)) return
    const text = readFileSync(path, 'utf8')
    const redacted = rewrite(text)
    if (redacted === text) {
      this.#passed.set(path, { learned, state: before })
      return
    }
    writeFileSync(path, redacted)
    this.#passed.set(path, { learned, state: stateOf(path) })
  }

  /**
   * Writes a new artifact. An existing file is never replaced. Its writer redacts any text in it with what the run knows
   * as it writes, as a diagnostics artifact's records are.
   */
  writeArtifact(path: string, bytes: Uint8Array): void {
    const target = this.#path(path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, bytes, { flag: 'wx' })
    this.#redactedAt.set(target, learnedSoFar())
    if (dirname(target) === this.#path(diagnosticsFolder)) this.#diagnosticsWritten += 1
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
   * they are removed when the run ends, and when the process exits before it could. Their folder is made, by this
   * process alone, and kept to this user before any state is in it (on Windows, whose files take their folder's access
   * list, that is when its list is replaced); each state is then made exclusively and written through the descriptor
   * that made it, so nothing written ever follows a link or lands in a file someone else made.
   */
  async writeState(path: string, state: StorageState): Promise<void> {
    const target = this.#path(path)
    await this.#statesFolder(dirname(target))
    if (this.#removeStatesOnExit === undefined) {
      this.#removeStatesOnExit = () => this.removeStates()
      process.once('exit', this.#removeStatesOnExit)
    }
    const descriptor = openSync(target, 'wx', 0o600)
    try {
      writeAll(descriptor, JSON.stringify(state))
    } catch (error) {
      closeSync(descriptor)
      throw withLeftover(error, target, () => rmSync(target, { force: true }))
    }
    closeSync(descriptor)
  }

  // The states folder, made once per run by this process: a folder already there is refused, so no one else's folder
  // ever holds a state. It is kept to this user before anything is made in it; a folder that cannot be is removed.
  #statesFolder(folder: string): Promise<void> {
    this.#statesReady ??= (async () => {
      mkdirSync(folder, { mode: 0o700 })
      try {
        await keepFolderToUser(folder)
      } catch (error) {
        throw withLeftover(error, folder, () => rmSync(folder, { recursive: true, force: true }))
      }
    })().catch((error: unknown) => {
      this.#statesReady = undefined
      throw error
    })
    return this.#statesReady
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
    this.#statesReady = undefined
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

// The failure as it was, with what its cleanup could not remove added to it, so a cleanup that fails never replaces it.
function withLeftover(error: unknown, path: string, remove: () => void): unknown {
  try {
    remove()
    return error
  } catch (removal) {
    const leftover = `${path} is still there: ${errorMessage(removal)}`
    if (error instanceof PrivateFolderError) return new PrivateFolderError(error.message, `${error.detail}; ${leftover}`)
    return new Error(`${errorMessage(error)} ${leftover}`, { cause: error })
  }
}

function stateOf(path: string): FileState {
  const { ino, size, mtimeNs, ctimeNs } = statSync(path, { bigint: true })
  return { inode: ino, size, modifiedNs: mtimeNs, changedNs: ctimeNs }
}

function sameState(first: FileState, second: FileState): boolean {
  return first.inode === second.inode && first.size === second.size && first.modifiedNs === second.modifiedNs && first.changedNs === second.changedNs
}

function writeAll(descriptor: number, text: string): void {
  const bytes = Buffer.from(text, 'utf8')
  let offset = 0
  while (offset < bytes.length) offset += writeSync(descriptor, bytes, offset)
}

function occupied(directory: string): string {
  return `The run folder ${directory} already holds files. Retest never writes over a run; choose a new folder.`
}
