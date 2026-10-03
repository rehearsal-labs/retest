import type { CollectedTest } from '../protocol/events.ts'
import type { Failure } from '../protocol/failures.ts'
import type { RunResult } from '../protocol/result.ts'
import type { Reporter } from '../reporters/reporter.ts'
import type { FindExecutable, LaunchBrowser } from './browser-pool.ts'
import type { CollectedFile, CollectOptions, CollectResult, RunOptions, Selection } from './contract.ts'
import type { CollectedTests, Plan, PlannedTest } from './plan.ts'
import type { RunConfig } from './run-config.ts'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { launchBrowser } from '../browser/launch.ts'
import { judgeVariables } from '../evaluation/judges.ts'
import { withAlso } from '../protocol/failures.ts'
import { variantKey } from '../protocol/variant.ts'
import { relativePosixPath } from '../shared/posix-path.ts'
import { RunStore } from '../store/run-store.ts'
import { loadTests, missingFileFailure } from './load-tests.ts'
import { collectedTest, planTests } from './plan.ts'
import { fileProcessFailure, reportedErrors } from './process-failures.ts'
import { collectConfig } from './run-config.ts'
import { RunSession } from './run-session.ts'
import { abortGraceMs } from './running-test.ts'
import { scheduleRun } from './schedule.ts'
import { secretVariables } from './secrets.ts'
import { searchSetups } from './setup-search.ts'
import { findTargetExecutable } from './target-executable.ts'
import { TestFileProcess } from './test-file-process.ts'

export type { FindExecutable, LaunchBrowser } from './browser-pool.ts'
export { RunFolderError } from '../store/run-store.ts'

/**
 * Runs the tests in each file, up to `workers` files at once, and writes the run folder and `.retest/last-run.json`.
 * Throws `RunFolderError` when the output folder cannot be used; every other problem is part of the result. A
 * service that launches its own browsers passes `launch`, and `findExecutable` when the executables it launches
 * are not on this machine.
 *
 * @example const result = await runFiles(options, [reporter])
 */
export async function runFiles(
  options: RunOptions,
  reporters: readonly Reporter[],
  launch: LaunchBrowser = launchBrowser,
  findExecutable: FindExecutable = findTargetExecutable,
): Promise<RunResult> {
  const store = RunStore.create(options.outputDir)
  try {
    return await new RunSession({ options, reporters, launch, findExecutable, store }).run()
  } finally {
    store.close()
  }
}

/**
 * Loads each file in its own process and lists the tests it declares, checked as a run would check them: with a
 * config, each test's apps and variants, its tags and states, and the setups a run would take from the project's
 * other test files, which follow the files given. A file whose process fails after its tests were collected, as
 * on an error it throws then, keeps its tests and fails, as in a run. With a selection, only the tests and
 * variants a run would start are listed, setups they need included. Never launches a browser.
 *
 * @example const { files } = await collectFiles({ files: ['tests/tasks.retest.ts'], rootDir: '/work', timeouts })
 */
export async function collectFiles(options: CollectOptions): Promise<CollectResult> {
  const rootDir = resolve(options.rootDir)
  const config = collectConfig(options.config)
  const processFailures = new Map<string, Failure>()
  // A file's process never sees the variables the secrets and the judges' credentials are read from, as in a run.
  const hiddenVariables = [...secretVariables(options.config?.secrets ?? new Map()), ...judgeVariables(options.config?.evaluation)]
  const collect = async (file: string): Promise<CollectedTests> => {
    const { collected, processFailure } = await collectFile({ file, rootDir, timeoutMs: options.timeouts.collection, hiddenVariables })
    if (processFailure !== undefined) processFailures.set(file, processFailure)
    return collected
  }
  const collected: CollectedTests[] = []
  for (const file of options.files) collected.push(await collect(relativePosixPath(rootDir, resolve(rootDir, file))))
  const search = options.config === undefined ? undefined : await searchSetups({ rootDir, collected, collect })
  const plan = planTests(collected, config, search)
  const kept = options.selection === undefined ? undefined : scheduledVariants(plan, options.selection, config.variants)
  return {
    files: plan.files.map((file): CollectedFile => {
      if (!file.ok) return { file: file.file, collection: 'failed', failure: file.failure, tests: [] }
      const tests = file.tests.flatMap((test) => listed(test, config, kept))
      const problem = processFailures.get(file.file)
      return problem === undefined ? { file: file.file, collection: 'ok', tests } : { file: file.file, collection: 'ok', failure: problem, tests }
    }),
  }
}

type Loaded = { collected: CollectedTests; processFailure?: Failure }

type CollectFile = { file: string; rootDir: string; timeoutMs: number; hiddenVariables: readonly string[] }

async function collectFile({ file, rootDir, timeoutMs, hiddenVariables }: CollectFile): Promise<Loaded> {
  if (!existsSync(resolve(rootDir, file))) return { collected: { file, ok: false, failure: missingFileFailure(file) } }
  const child = TestFileProcess.spawn(hiddenVariables.length === 0 ? {} : { hiddenVariables })
  try {
    const loaded = await loadTests(child, { file, rootDir, timeoutMs })
    const closed = await child.close(abortGraceMs)
    if (!loaded.ok) return { collected: { file, ok: false, failure: withAlso(loaded.failure, reportedErrors(file, child.errors)) } }
    const problem = fileProcessFailure({ file, closed, errors: child.errors, killed: child.killed, exitRecorded: false })
    const collected: CollectedTests = { file, ok: true, tests: loaded.tests }
    return problem === undefined ? { collected } : { collected, processFailure: problem }
  } finally {
    await child.kill()
  }
}

// The variants of each test a run with this selection would choose, by test id, skipped tests included.
function scheduledVariants(plan: Plan, selection: Selection, variants: boolean): Map<string, Set<string>> {
  const kept = new Map<string, Set<string>>()
  const schedule = scheduleRun(plan, selection, variants)
  for (const attempt of [...schedule.visits.flatMap((visit) => visit.attempts), ...schedule.skipped]) {
    const keys = kept.get(attempt.test.testId) ?? new Set()
    kept.set(attempt.test.testId, keys.add(variantKey(attempt.targets)))
  }
  return kept
}

function listed(test: PlannedTest, config: RunConfig, kept: ReadonlyMap<string, ReadonlySet<string>> | undefined): CollectedTest[] {
  if (kept === undefined) return [collectedTest(test, config)]
  const keys = kept.get(test.testId)
  if (keys === undefined) return []
  return [collectedTest({ ...test, variants: test.variants.filter((variant) => keys.has(variantKey(variant))) }, config)]
}
