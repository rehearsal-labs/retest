import type { Failure, SourceLocation } from '../protocol/failures.ts'
import type { TestHostCheck } from './host-checks.ts'
import { failure } from '../protocol/failures.ts'

/** A skipped test as the host's checks name it: its id and where it is declared, and the checks the host keyed to it. */
export type SkippedTest = {
  readonly testId: string
  readonly location: SourceLocation
  readonly hostChecks: readonly TestHostCheck[]
  /** The ids of the AI checks the host requires of it. */
  readonly hostEvaluations: readonly string[]
}

/**
 * One failure for each check the host required of a test that test code skipped. The check was never made, and a
 * skip in test code cannot waive a check the host asked for, so each of these keeps the run from passing.
 *
 * @example skippedCheckFailures({ testId, location, hostChecks: [{ check: { kind: 'text', text: 'Saved' }, app: 'web' }], hostEvaluations: [] })[0]?.class // 'host_check_failed'
 */
export function skippedCheckFailures(test: SkippedTest): Failure[] {
  const checks = [...test.hostChecks.map(describeCheck), ...test.hostEvaluations.map((id) => `AI check ${JSON.stringify(id)}`)]
  return checks.map((check) => {
    const message = `${JSON.stringify(test.testId)} is skipped, so the host's ${check} was not made. Test code cannot skip a check the host requires, so the run cannot pass.`
    return failure('host_check_failed', message, test.location)
  })
}

// A check by its kind, the name the host gave it and the app it reads; never by the text it looks for.
function describeCheck({ check, app }: TestHostCheck): string {
  const named = check.name === undefined ? '' : ` ${JSON.stringify(check.name)}`
  return `${check.kind} check${named} on ${app}`
}
