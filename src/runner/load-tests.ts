import type { Failure } from '../protocol/failures.ts'
import type { RegisteredTest } from '../protocol/messages.ts'
import type { TestFileProcess } from './test-file-process.ts'
import { failure } from '../protocol/failures.ts'
import { describeExit } from '../shared/process-exit.ts'

/** `modules` names every project module the process loaded with the file, by its path from the root, when it said. */
export type Loaded = { ok: true; tests: RegisteredTest[]; modules?: string[] } | { ok: false; failure: Failure }

/** What a load came to, and the errors its process had reported while no test was running by the time it did. */
export type LoadOutcome = { loaded: Loaded; errors: readonly Failure[] }

export type LoadOptions = {
  file: string
  rootDir: string
  timeoutMs: number
  /** Where the process's output is kept, named in failures that it would explain. */
  logFile?: string
}

/**
 * Asks a test file's process to load its file and collect its tests. A process that takes longer than
 * the collection budget, for example on an endless loop at the top of the file, is killed.
 */
export async function loadTests(child: TestFileProcess, options: LoadOptions): Promise<Loaded> {
  const outcome = await FileLoad.begin(child, options).within(options.timeoutMs)
  return outcome.loaded
}

/**
 * One file's load in its process. It begins when the process is sent the file, which can be before the run waits for
 * it, and its budget counts from when the run does: a load begun ahead of its turn, slowed by the tests running
 * meanwhile, is never stopped sooner than one begun when its turn came. Nothing of a test runs until the run asks.
 */
export class FileLoad {
  readonly #child: TestFileProcess
  readonly #file: string
  readonly #seeLog: string
  readonly #outcome = Promise.withResolvers<LoadOutcome>()
  #ended: LoadOutcome | undefined
  #timer: NodeJS.Timeout | undefined

  private constructor(child: TestFileProcess, file: string, logFile: string | undefined) {
    this.#child = child
    this.#file = file
    this.#seeLog = logFile === undefined ? '' : ` Its output is in ${logFile}.`
  }

  /** Sends the file to its process, which starts loading it. */
  static begin(child: TestFileProcess, { file, rootDir, logFile }: Omit<LoadOptions, 'timeoutMs'>): FileLoad {
    const load = new FileLoad(child, file, logFile)
    // A process started ahead can have ended before its file was sent to it, and then no event will say so.
    if (child.exit !== undefined) {
      load.#failed(`The process for ${file} ended while loading it (${describeExit(child.exit)}).${load.#seeLog}`)
      return load
    }
    child.listen((event) => {
      if (event.kind === 'exit') return load.#failed(`The process for ${file} ended while loading it (${describeExit(event.exit)}).${load.#seeLog}`)
      if (event.kind === 'invalid') {
        void child.kill()
        return load.#failed(`The process for ${file} sent a message Retest could not read: ${event.problem}`)
      }
      const { message } = event
      if (message.type === 'collected') return load.#end({ ok: true, tests: message.tests, ...(message.modules === undefined ? {} : { modules: message.modules }) })
      if (message.type === 'collection-failed') return load.#end({ ok: false, failure: message.failure })
      void child.kill()
      load.#failed(`The process for ${file} sent ${message.type} while loading its file.`)
    })
    child.send({ type: 'collect', file, rootDir })
    return load
  }

  /** The load's outcome. One still going `timeoutMs` from now is stopped there, and its process killed. */
  within(timeoutMs: number): Promise<LoadOutcome> {
    if (this.#ended === undefined && this.#timer === undefined) {
      this.#timer = setTimeout(() => {
        this.#failed(`Loading ${this.#file} took longer than ${timeoutMs} ms, so Retest stopped its process.${this.#seeLog}`)
        void this.#child.kill()
      }, timeoutMs)
    }
    return this.#outcome.promise
  }

  #failed(message: string): void {
    this.#end({ ok: false, failure: failure('collection_failed', message) })
  }

  // The errors are those that had arrived as the load ended, as when it was waited for from the start.
  #end(loaded: Loaded): void {
    if (this.#ended !== undefined) return
    clearTimeout(this.#timer)
    this.#child.listen(undefined)
    this.#ended = { loaded, errors: [...this.#child.errors] }
    this.#outcome.resolve(this.#ended)
  }
}

export function missingFileFailure(file: string): Failure {
  return failure('collection_failed', `There is no file at ${file}.`)
}
