import type { ResolveHookSync } from 'node:module'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { isPlainObject } from '../protocol/schema.ts'

/**
 * Every specifier a package's `exports` let another package import: its name for `.`, and its name with each
 * exported subpath. An exports map whose keys are conditions is the `.` export alone. Nothing else is named, so a
 * path the package does not export resolves as it would anyway.
 *
 * @example exportedSpecifiers({ name: '@rehearsal-labs/retest', exports: { '.': './dist/index.js', './runner': './dist/runner/index.js' } })
 * // Set { '@rehearsal-labs/retest', '@rehearsal-labs/retest/runner' }
 */
export function exportedSpecifiers(manifest: unknown): Set<string> {
  const name = isPlainObject(manifest) ? manifest['name'] : undefined
  const exports = isPlainObject(manifest) ? manifest['exports'] : undefined
  if (typeof name !== 'string' || !isPlainObject(exports)) throw new Error('The Retest package.json has no name or no exports map.')
  const subpaths = Object.keys(exports).filter((key) => key.startsWith('.'))
  if (subpaths.length === 0) return new Set([name])
  return new Set(subpaths.map((subpath) => (subpath === '.' ? name : `${name}${subpath.slice(1)}`)))
}

/**
 * A resolve hook that resolves each of `specifiers` as a module of this copy at `ownUrl` would, by the package's
 * own name, and leaves every other specifier alone. So a test file loads the copy of Retest that runs it, wherever
 * the file is: in a folder with no `node_modules`, or beside another copy.
 *
 * @example registerHooks({ resolve: ownPackageResolver(new Set(['@rehearsal-labs/retest']), import.meta.url) })
 */
export function ownPackageResolver(specifiers: ReadonlySet<string>, ownUrl: string): ResolveHookSync {
  return (specifier, context, nextResolve) => (specifiers.has(specifier) ? nextResolve(specifier, { ...context, parentURL: ownUrl }) : nextResolve(specifier, context))
}

/** Makes every module this process loads from now on resolve Retest's own specifiers to this copy, and returns the package's name. */
export function resolveOwnPackage(): string {
  const manifest: unknown = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
  const specifiers = exportedSpecifiers(manifest)
  registerHooks({ resolve: ownPackageResolver(specifiers, import.meta.url) })
  const name = isPlainObject(manifest) ? manifest['name'] : undefined
  if (typeof name !== 'string') throw new Error('The Retest package.json has no name.')
  return name
}
