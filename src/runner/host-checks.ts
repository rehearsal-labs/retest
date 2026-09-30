import type { Failure } from '../protocol/failures.ts'
import type { HostCheck, HostCheckRecord, HostCheckResult } from '../protocol/host-check.ts'
import type { PlannedTest } from './plan.ts'
import { failure } from '../protocol/failures.ts'
import { hostCheckProblems, hostCheckRecord, hostChecksFor, unmatchedHostCheckKeys } from '../protocol/host-check.ts'
import { formatPath } from '../protocol/schema.ts'

/** Host checks by test id or by file, as `RunOptions.hostChecks` gives them. */
export type HostChecks = Readonly<Record<string, readonly HostCheck[]>>

/** One of a test's host checks, and the app whose page it reads: its own `app`, or the test's first. */
export type TestHostCheck = { check: HostCheck; app: string }

/**
 * Everything wrong with the shape of the checks, as one usage failure naming each key, or undefined when there
 * is nothing. The checks are not read further until this passes.
 *
 * @example hostChecksShapeProblem({ 'tests/a.retest.ts': [{ kind: 'text', text: '' }] })?.class // 'usage'
 */
export function hostChecksShapeProblem(hostChecks: unknown): Failure | undefined {
  return usage(hostCheckProblems(hostChecks))
}

/**
 * What the run must refuse before any test starts, now that it knows the tests it will run: a key that names
 * none of them and no file one comes from, and a check whose `app` a test it applies to does not use. A key
 * that names a file which could not be collected, or a test in one, is left to that file's own failure.
 *
 * @example hostChecksScopeProblem(hostChecks, scheduledTests, [])
 */
export function hostChecksScopeProblem(hostChecks: HostChecks, tests: readonly PlannedTest[], unloadedFiles: readonly string[]): Failure | undefined {
  const unloaded = (key: string): boolean => unloadedFiles.some((file) => key === file || key.startsWith(`${file} > `))
  const unmatched = unmatchedHostCheckKeys(hostChecks, tests).filter((key) => !unloaded(key))
  // The first unmatched key says what a key looks like, once.
  const example = tests[0] === undefined ? '' : ` Keys are test ids, such as ${JSON.stringify(tests[0].testId)}, or files as the run lists them.`
  const keys = unmatched.map((key, index) => `${checkPath([key])}: names no test this run will run, and no file one comes from.${index === 0 ? example : ''}`)
  return usage([...keys, ...appProblems(hostChecks, tests)])
}

/**
 * The checks as `run.started` records them.
 *
 * @example recordedHostChecks({ 'tests/a.retest.ts': [{ kind: 'text', text: 'Saved' }] }) // { 'tests/a.retest.ts': [{ kind: 'text', text: 'Saved' }] }
 */
export function recordedHostChecks(hostChecks: HostChecks): Record<string, HostCheckRecord[]> {
  return Object.fromEntries(Object.entries(hostChecks).map(([key, checks]) => [key, checks.map(hostCheckRecord)]))
}

/**
 * A test's checks in the order they run, the file's first, each with the app it reads.
 *
 * @example testHostChecks(hostChecks, plannedTest).map(({ app }) => app) // ['web']
 */
export function testHostChecks(hostChecks: HostChecks | undefined, test: PlannedTest): TestHostCheck[] {
  if (hostChecks === undefined) return []
  const [firstApp] = test.apps
  return hostChecksFor(hostChecks, test).flatMap((check) => {
    const app = check.app ?? firstApp
    return app === undefined ? [] : [{ check, app }]
  })
}

/** Every check of a test that did not get to run, as its result lists them. */
export function notRunHostChecks(checks: readonly TestHostCheck[]): HostCheckResult[] {
  return checks.map(({ check, app }) => ({ check: hostCheckRecord(check), app, status: 'not_run' }))
}

// A check names an app for every test its key applies to; the first test that lacks it is named.
function appProblems(hostChecks: HostChecks, tests: readonly PlannedTest[]): string[] {
  return Object.entries(hostChecks).flatMap(([key, checks]) => {
    const covered = tests.filter((test) => test.testId === key || test.file === key)
    return checks.flatMap((check, index) => {
      const app = check.app
      const lacking = app === undefined ? undefined : covered.find((test) => !test.apps.includes(app))
      if (app === undefined || lacking === undefined) return []
      const uses = lacking.apps.join(', ')
      return [`${checkPath([key, index, 'app'])}: ${JSON.stringify(app)} is not an app of ${JSON.stringify(lacking.testId)}, which uses ${uses}.`]
    })
  })
}

function checkPath(path: (string | number)[]): string {
  return formatPath(['hostChecks', ...path]).slice(2)
}

function usage(problems: readonly string[]): Failure | undefined {
  const [first] = problems
  if (first === undefined) return undefined
  if (problems.length === 1) return failure('usage', first)
  return failure('usage', `The host checks have ${problems.length} problems:\n${problems.map((problem) => `  ${problem}`).join('\n')}`)
}
