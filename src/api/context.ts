import type { TestRun } from './test-run.ts'
import { AsyncLocalStorage } from 'node:async_hooks'
import { failure } from '../protocol/failures.ts'
import { RetestError } from './failure.ts'

/** Which test, and which step inside it, the running code belongs to. */
export type Scope = { readonly run: TestRun; readonly stepId?: string }

const storage = new AsyncLocalStorage<Scope>()

export function runInScope<T>(scope: Scope, body: () => T): T {
  return storage.run(scope, body)
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
