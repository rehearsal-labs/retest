import type { ResolveHookSync } from 'node:module'
import { registerHooks } from 'node:module'
import { errorCode } from '../shared/error-code.ts'

/** What the parent passes the test process to say the run is of Playwright test files. */
export const playwrightArgument: string = '--playwright'

/** The specifiers a Playwright test file imports its `test` and `expect` from. */
export const playwrightSpecifiers: ReadonlySet<string> = new Set(['@playwright/test', 'playwright/test'])

// Tried in order after a relative import that names no file, as TypeScript and Playwright's own loader resolve it.
const suffixes = ['.ts', '.js', '.mts', '.mjs', '/index.ts', '/index.js']
const notFound = new Set(['ERR_MODULE_NOT_FOUND', 'ERR_UNSUPPORTED_DIR_IMPORT'])

/**
 * A resolve hook for Playwright test files. `@playwright/test` resolves to `compatibility`, Retest's own subpath,
 * as a module at `ownUrl` would import it, so the project needs no copy of either. A relative import written
 * without its extension, as Playwright suites write them, resolves to the file or the folder's index it names.
 *
 * @example registerHooks({ resolve: playwrightResolver('@rehearsal-labs/retest/playwright', import.meta.url) })
 */
export function playwrightResolver(compatibility: string, ownUrl: string): ResolveHookSync {
  return (specifier, context, nextResolve) => {
    if (playwrightSpecifiers.has(specifier)) return nextResolve(compatibility, { ...context, parentURL: ownUrl })
    if (!specifier.startsWith('./') && !specifier.startsWith('../')) return nextResolve(specifier, context)
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      const code = errorCode(error)
      if (code === undefined || !notFound.has(code)) throw error
      for (const suffix of suffixes) {
        try {
          return nextResolve(`${specifier}${suffix}`, context)
        } catch {
          // The next suffix may name the file.
        }
      }
      throw error
    }
  }
}

/** Makes every module this process loads from now on resolve as a Playwright test file's imports do. */
export function resolvePlaywright(packageName: string): void {
  registerHooks({ resolve: playwrightResolver(`${packageName}/playwright`, import.meta.url) })
}
