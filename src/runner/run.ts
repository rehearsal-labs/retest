import type { RunResult } from '../protocol/result.ts'
import type { Reporter } from '../reporters/reporter.ts'
import type { CollectedFile, CollectOptions, CollectResult, RunOptions } from './contract.ts'
import type { LaunchBrowser } from './run-session.ts'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { launchBrowser } from '../browser/launch.ts'
import { withAlso } from '../protocol/failures.ts'
import { relativePosixPath } from '../shared/posix-path.ts'
import { RunStore } from '../store/run-store.ts'
import { collectedTests, loadTests, missingFileFailure } from './load-tests.ts'
import { fileProcessFailure, reportedErrors } from './process-failures.ts'
import { RunSession } from './run-session.ts'
import { abortGraceMs } from './running-test.ts'
import { TestFileProcess } from './test-file-process.ts'

export type { LaunchBrowser } from './run-session.ts'
export { RunFolderError } from '../store/run-store.ts'

/**
 * Runs the tests in each file, one file after another, and writes the run folder. Throws
 * `RunFolderError` when the output folder cannot be used; every other problem is part of the result.
 *
 * @example const result = await runFiles(options, [reporter])
 */
export async function runFiles(
  options: RunOptions,
  reporters: readonly Reporter[],
  launch: LaunchBrowser = launchBrowser,
): Promise<RunResult> {
  const store = RunStore.create(options.outputDir)
  try {
    return await new RunSession({ options, reporters, launch, store }).run()
  } finally {
    store.close()
  }
}

/**
 * Loads each file in its own process and lists the tests it declares. A file whose process fails after its
 * tests were collected, as on an error it throws then, keeps its tests and fails, as in a run. Never
 * launches a browser.
 *
 * @example const { files } = await collectFiles({ files: ['tests/tasks.retest.ts'], rootDir: '/work', timeouts })
 */
export async function collectFiles(options: CollectOptions): Promise<CollectResult> {
  const rootDir = resolve(options.rootDir)
  const files: CollectedFile[] = []
  for (const file of options.files) {
    files.push(await collectFile(relativePosixPath(rootDir, resolve(rootDir, file)), rootDir, options.timeouts.collection))
  }
  return { files }
}

async function collectFile(file: string, rootDir: string, timeoutMs: number): Promise<CollectedFile> {
  if (!existsSync(resolve(rootDir, file))) return { file, collection: 'failed', failure: missingFileFailure(file), tests: [] }
  const child = TestFileProcess.spawn()
  try {
    const loaded = await loadTests(child, { file, rootDir, timeoutMs })
    const closed = await child.close(abortGraceMs)
    if (!loaded.ok) return { file, collection: 'failed', failure: withAlso(loaded.failure, reportedErrors(file, child.errors)), tests: [] }
    const problem = fileProcessFailure({ file, closed, errors: child.errors, killed: child.killed, exitRecorded: false })
    const tests = collectedTests(file, loaded.tests)
    return problem === undefined ? { file, collection: 'ok', tests } : { file, collection: 'ok', failure: problem, tests }
  } finally {
    await child.kill()
  }
}
