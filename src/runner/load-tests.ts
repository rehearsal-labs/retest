import type { Failure } from '../protocol/failures.ts'
import type { RegisteredTest } from '../protocol/messages.ts'
import type { TestFileProcess } from './test-file-process.ts'
import { failure } from '../protocol/failures.ts'
import { describeExit } from '../shared/process-exit.ts'

/** `modules` names every project module the process loaded with the file, by its path from the root, when it said. */
export type Loaded = { ok: true; tests: RegisteredTest[]; modules?: string[] } | { ok: false; failure: Failure }

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
export function loadTests(child: TestFileProcess, options: LoadOptions): Promise<Loaded> {
  const { file, timeoutMs } = options
  const { promise, resolve } = Promise.withResolvers<Loaded>()
  const failed = (message: string): void => resolve({ ok: false, failure: failure('collection_failed', message) })
  const seeLog = options.logFile === undefined ? '' : ` Its output is in ${options.logFile}.`
  const timer = setTimeout(() => {
    failed(`Loading ${file} took longer than ${timeoutMs} ms, so Retest stopped its process.${seeLog}`)
    void child.kill()
  }, timeoutMs)
  child.listen((event) => {
    if (event.kind === 'exit') return failed(`The process for ${file} ended while loading it (${describeExit(event.exit)}).${seeLog}`)
    if (event.kind === 'invalid') {
      void child.kill()
      return failed(`The process for ${file} sent a message Retest could not read: ${event.problem}`)
    }
    const { message } = event
    if (message.type === 'collected') return resolve({ ok: true, tests: message.tests, ...(message.modules === undefined ? {} : { modules: message.modules }) })
    if (message.type === 'collection-failed') return resolve({ ok: false, failure: message.failure })
    void child.kill()
    failed(`The process for ${file} sent ${message.type} while loading its file.`)
  })
  child.send({ type: 'collect', file, rootDir: options.rootDir })
  return promise.finally(() => {
    clearTimeout(timer)
    child.listen(undefined)
  })
}

export function missingFileFailure(file: string): Failure {
  return failure('collection_failed', `There is no file at ${file}.`)
}
