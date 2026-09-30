import type { TestRun } from './test-run.ts'
import { failure } from '../protocol/failures.ts'
import { currentScope } from './context.ts'
import { RetestError } from './failure.ts'
import { collectionRoot } from './registry.ts'
import { callerLocation } from './source-location.ts'

/**
 * A usage failure for a call made the wrong way, located at the caller. Inside a test it is recorded against
 * that test, the running one unless another is named; either way it comes back to be thrown.
 *
 * @example throw misuse('getByText() takes the text to find, received 3.')
 */
export function misuse(message: string, run: TestRun | undefined = currentScope()?.run): RetestError {
  if (run !== undefined) return run.fail(failure('usage', message, run.location()))
  const root = collectionRoot()
  return new RetestError(failure('usage', message, root === undefined ? undefined : callerLocation(root)))
}
