import type { TestRun } from './test-run.ts'
import { AsyncLocalStorage } from 'node:async_hooks'
import { failure } from '../protocol/failures.ts'
import { RetestError } from './failure.ts'

/**
 * Which test, and which step inside it, the running code belongs to. `reading` marks the function `expect.poll`
 * calls on every look, which may not act on a page.
 */
export type Scope = { readonly run: TestRun; readonly stepId?: string; readonly reading?: true }

const storage = new AsyncLocalStorage<Scope>()

/** Calls test code in a scope and settles with what it returns or throws, whether it is async or not. */
export function callInScope<T>(scope: Scope, body: () => T | Promise<T>): Promise<T> {
  return storage.run(scope, async () => body())
}

export function currentScope(): Scope | undefined {
  return storage.getStore()
}

/** The running test's scope, or a usage error naming the call that needs one. */
export function requireScope(call: string): Scope {
  const scope = storage.getStore()
  if (scope !== undefined) return scope
  throw new RetestError(failure('usage', `${call} can only run inside a test.`))
}
