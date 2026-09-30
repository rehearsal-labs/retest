import type { Failure } from '../protocol/failures.ts'
import type { RuntimeContext } from './test-body.ts'
import type { TestRun } from './test-run.ts'
import { failure } from '../protocol/failures.ts'
import { listWords } from '../shared/list-words.ts'
import { AppPage } from './app-page.ts'
import { misuse } from './misuse.ts'

export type BuiltContext = { readonly context: RuntimeContext } | { readonly failure: Failure }

/**
 * What a test's function receives. A test that declares no apps gets `page`, the one app the parent opened for
 * it; a test that declares apps gets a page for each, under its name, and reading `page` from it fails with
 * a message that names its apps.
 *
 * @example testContext(run, ['owner', 'member'], ['owner', 'member']) // { context: { owner, member } }
 */
export function testContext(run: TestRun, declared: readonly string[] | undefined, opened: readonly string[]): BuiltContext {
  if (declared === undefined || declared.length === 0) {
    const [only, ...others] = opened
    if (only === undefined || others.length > 0) return mismatch(opened, 'uses one app')
    return { context: Object.freeze({ page: new AppPage(run, only) }) }
  }
  if (!sameNames(declared, opened)) return mismatch(opened, `declares ${listWords(declared, 'and')}`)
  const context: Record<string, AppPage> = Object.fromEntries(declared.map((app) => [app, new AppPage(run, app)]))
  if (!Object.hasOwn(context, 'page')) {
    const message = `This test declares the apps ${listWords(declared, 'and')}, so it has no page. Take its apps by name: ({ ${declared.join(', ')} }).`
    Object.defineProperty(context, 'page', {
      get: () => {
        throw misuse(message, run)
      },
    })
  }
  return { context: Object.freeze(context) }
}

function sameNames(declared: readonly string[], opened: readonly string[]): boolean {
  const names = new Set(opened)
  return names.size === opened.length && names.size === declared.length && declared.every((app) => names.has(app))
}

function mismatch(opened: readonly string[], declares: string): BuiltContext {
  const apps = opened.length === 0 ? 'no app' : `the apps ${listWords(opened, 'and')}`
  return { failure: failure('test_error', `Retest opened ${apps} for this test, which ${declares}.`) }
}
