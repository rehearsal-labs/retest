import type { SourceLocation } from '../protocol/failures.ts'
import type { AppPage } from './app-page.ts'

/** The pages a test's function receives when it runs, each under the name its context gives it. */
export type RuntimeContext = Readonly<Record<string, AppPage>>

/** A test's or hook's function as the registry keeps it. */
export type RuntimeBody = (context: RuntimeContext) => unknown

/** A `beforeEach` or `afterEach` function and where it was declared. */
export type Hook = { readonly body: RuntimeBody; readonly location: SourceLocation }

/** A test's hooks in the order they run: outermost `beforeEach` first, innermost `afterEach` first. */
export type TestHooks = { readonly beforeEach: readonly Hook[]; readonly afterEach: readonly Hook[] }

/** What a test run executes: its function, the apps it declared, if any, and its hooks. */
export type RunnableTest = {
  readonly body: RuntimeBody
  readonly apps?: readonly string[] | undefined
  readonly hooks: TestHooks
}
