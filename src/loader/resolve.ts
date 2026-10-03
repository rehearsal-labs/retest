import type { ResolveFnOutput, ResolveHookContext, ResolveHookSync } from 'node:module'
import type { PathAlias, ProjectPaths, TsconfigRead } from './tsconfig.ts'
import { existsSync } from 'node:fs'
import { dirname, extname, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { errorCode } from '../shared/error-code.ts'
import { relativePosixPath } from '../shared/posix-path.ts'

/** What the parent passes the test process to say the run is of Playwright test files. */
export const playwrightArgument: string = '--playwright'

/** The specifiers a Playwright test file imports its `test` and `expect` from. */
export const playwrightSpecifiers: ReadonlySet<string> = new Set(['@playwright/test', 'playwright/test'])

// Tried in order after a relative import that names no file, as TypeScript and Playwright's own loader resolve it.
const suffixes = ['.ts', '.js', '.mts', '.mjs', '/index.ts', '/index.js']
const indexes = ['/index.ts', '/index.js']
// tsc reads an import of a .js file as the .ts source beside it, when there is one, as `module: nodenext` writes them.
const sourceExtensions: readonly (readonly [string, string])[] = [
  ['.js', '.ts'],
  ['.mjs', '.mts'],
]
const jsxExtensions = ['.tsx', '.jsx']
const notFound = new Set(['ERR_MODULE_NOT_FOUND', 'ERR_UNSUPPORTED_DIR_IMPORT'])

type NextResolve = Parameters<ResolveHookSync>[2]

export type ResolverOptions = {
  /** A module of this copy of Retest. Playwright's specifiers resolve as it would import them. */
  ownUrl: string
  /** The folder of Retest's own modules, `src` or `dist`. What they import resolves as Node resolves it. */
  ownFolderUrl: string
  /** The folder tests run from. A file in it is named by its path from there. */
  rootFolder?: string
  /** The subpath Playwright's specifiers resolve to, in a run of Playwright test files. */
  playwright?: string
  /** The tsconfig.json that governs the files of a folder, the nearest one at or above it, or undefined for none. */
  tsconfigFor?: (folder: string) => TsconfigRead | undefined
}

/**
 * The resolve hook for a project's files. A relative import written without its extension, or a folder, resolves to the
 * file or the folder's index; one written with `.js` resolves to the `.ts` source beside it when there is one, as `tsc`
 * reads it. A bare import that a `paths` pattern of the importing file's tsconfig matches resolves to the first of its
 * targets that is a file, and otherwise as Node resolves it. An import that cannot be found says which tsconfig governed
 * it. In a run of Playwright test files, `@playwright/test` resolves to Retest's own subpath. Imports from node_modules
 * and from Retest's own modules resolve as Node resolves them.
 *
 * @example registerHooks({ resolve: projectResolver({ ownUrl: import.meta.url, ownFolderUrl, tsconfigFor }) })
 */
export function projectResolver(options: ResolverOptions): ResolveHookSync {
  return (specifier, context, nextResolve) => {
    if (options.playwright !== undefined && playwrightSpecifiers.has(specifier)) {
      return nextResolve(options.playwright, { ...context, parentURL: options.ownUrl })
    }
    const importer = projectImporter(context.parentURL, options.ownFolderUrl)
    if (importer === undefined) return nextResolve(specifier, context)
    const tsconfig = options.tsconfigFor?.(dirname(importer))
    if (tsconfig !== undefined && !tsconfig.ok) throw new Error(tsconfig.failure.message)
    const paths = tsconfig?.paths
    try {
      return resolveImport({ specifier, importer, paths, rootFolder: options.rootFolder }, context, nextResolve)
    } catch (error) {
      throw paths === undefined ? error : namingTsconfig(error, paths.file)
    }
  }
}

/**
 * The alias whose pattern matches a bare import, as TypeScript picks it: a pattern with no `*` equal to the import,
 * and otherwise the matching pattern with the longest part before its `*`. Each target has the matched part in place
 * of its `*`.
 *
 * @example matchAlias([{ pattern: '@helpers/*', targets: ['/work/helpers/*'] }], '@helpers/model') // { pattern: '@helpers/*', paths: ['/work/helpers/model'] }
 */
export function matchAlias(aliases: readonly PathAlias[], specifier: string): { pattern: string; paths: string[] } | undefined {
  const exact = aliases.find((alias) => !alias.pattern.includes('*') && alias.pattern === specifier)
  if (exact !== undefined) return { pattern: exact.pattern, paths: exact.targets }
  let best: { alias: PathAlias; matched: string; prefixLength: number } | undefined
  for (const alias of aliases) {
    const star = alias.pattern.indexOf('*')
    if (star === -1) continue
    const prefix = alias.pattern.slice(0, star)
    const suffix = alias.pattern.slice(star + 1)
    const fits = specifier.length >= prefix.length + suffix.length && specifier.startsWith(prefix) && specifier.endsWith(suffix)
    if (!fits || (best !== undefined && best.prefixLength >= prefix.length)) continue
    best = { alias, matched: specifier.slice(prefix.length, specifier.length - suffix.length), prefixLength: prefix.length }
  }
  if (best === undefined) return undefined
  const { matched } = best
  return { pattern: best.alias.pattern, paths: best.alias.targets.map((target) => target.replace('*', matched)) }
}

/**
 * Whether a specifier is relative, as Node reads one: `.`, `..`, or a path starting with either.
 *
 * @example isRelative('..') // true
 */
export function isRelative(specifier: string): boolean {
  return specifier === '.' || specifier === '..' || specifier.startsWith('./') || specifier.startsWith('../')
}

type ProjectImport = { specifier: string; importer: string; paths: ProjectPaths | undefined; rootFolder: string | undefined }

function resolveImport({ specifier, importer, paths, rootFolder }: ProjectImport, context: ResolveHookContext, nextResolve: NextResolve): ResolveFnOutput {
  if (isRelative(specifier)) return resolveRelative(specifier, context, nextResolve, rootFolder)
  const match = paths !== undefined && isBare(specifier) ? matchAlias(paths.aliases, specifier) : undefined
  if (match === undefined || paths === undefined) return nextResolve(specifier, context)
  return resolveAlias({ specifier, match, tsconfig: paths.file, importer }, context, nextResolve)
}

// The path of the importing file when it is the project's: a file outside node_modules and outside Retest's own modules.
function projectImporter(parentUrl: string | undefined, ownFolderUrl: string): string | undefined {
  if (parentUrl === undefined || !parentUrl.startsWith('file:') || parentUrl.startsWith(ownFolderUrl)) return undefined
  const path = fileURLToPath(parentUrl)
  return path.split(sep).includes('node_modules') ? undefined : path
}

function resolveRelative(specifier: string, context: ResolveHookContext, nextResolve: NextResolve, rootFolder: string | undefined): ResolveFnOutput {
  try {
    return resolveFile(specifier, context, nextResolve)
  } catch (error) {
    const jsx = isNotFound(error) ? jsxFileFor(specifier, context.parentURL) : undefined
    if (jsx === undefined) throw error
    const shown = rootFolder !== undefined && isInside(jsx, rootFolder) ? relativePosixPath(rootFolder, jsx) : jsx
    throw Object.assign(new Error(`${specifier} names ${shown}, a ${extname(jsx)} file. Retest does not load JSX.`), { code: 'ERR_MODULE_NOT_FOUND' })
  }
}

// The .ts source a .js names, when there is one; then the specifier as written; then, for an import that names no
// file, each suffix, or for a folder, its index. A failure other than a missing file is the import's own, thrown at once.
function resolveFile(specifier: string, context: ResolveHookContext, nextResolve: NextResolve): ResolveFnOutput {
  for (const [written, source] of sourceExtensions) {
    if (!specifier.endsWith(written)) continue
    try {
      return nextResolve(`${specifier.slice(0, -written.length)}${source}`, context)
    } catch (error) {
      if (!isNotFound(error)) throw error
    }
  }
  try {
    return nextResolve(specifier, context)
  } catch (error) {
    if (!isNotFound(error)) throw error
    for (const candidate of candidates(specifier)) {
      try {
        return nextResolve(candidate, context)
      } catch {
        // The next candidate may name the file.
      }
    }
    throw error
  }
}

function candidates(specifier: string): string[] {
  if (specifier === '.' || specifier === '..' || specifier.endsWith('/')) {
    const folder = specifier.replace(/\/+$/, '')
    return indexes.map((index) => `${folder}${index}`)
  }
  return suffixes.map((suffix) => `${specifier}${suffix}`)
}

type AliasImport = { specifier: string; match: { pattern: string; paths: string[] }; tsconfig: string; importer: string }

// Each target in order, then the import as Node resolves it, such as a package that has the alias's name.
function resolveAlias({ specifier, match, tsconfig, importer }: AliasImport, context: ResolveHookContext, nextResolve: NextResolve): ResolveFnOutput {
  for (const path of match.paths) {
    try {
      return resolveFile(pathToFileURL(path).href, context, nextResolve)
    } catch (error) {
      if (!isNotFound(error)) throw error
    }
  }
  try {
    return nextResolve(specifier, context)
  } catch (error) {
    if (!isNotFound(error)) throw error
    const tried = match.paths.join(', ')
    const message = `Cannot find ${specifier} imported from ${importer}. ${match.pattern} in the paths of ${tsconfig} maps it to ${tried}, and none of them is a file.`
    throw Object.assign(new Error(message), { code: 'ERR_MODULE_NOT_FOUND' })
  }
}

// A missing module from a file a tsconfig governs says which one, unless the message already does.
function namingTsconfig(error: unknown, tsconfig: string): unknown {
  if (!(error instanceof Error) || !isNotFound(error) || error.message.includes(tsconfig)) return error
  const message = `${error.message.replace(/\.$/, '')}. Imports from that file follow ${tsconfig}.`
  return Object.assign(new Error(message), { code: errorCode(error) })
}

// The JSX file beside the importer that an import without its extension names, which Retest does not load.
function jsxFileFor(specifier: string, parentUrl: string | undefined): string | undefined {
  if (parentUrl === undefined) return undefined
  const base = new URL(specifier, parentUrl)
  for (const extension of jsxExtensions) {
    const file = fileURLToPath(`${base.href}${extension}`)
    if (existsSync(file)) return file
  }
  return undefined
}

function isNotFound(error: unknown): boolean {
  const code = errorCode(error)
  return code !== undefined && notFound.has(code)
}

// A package name or an alias, not a path and not a URL such as node:fs.
function isBare(specifier: string): boolean {
  return !specifier.startsWith('/') && !/^[a-z][a-z\d+.-]*:/i.test(specifier)
}

function isInside(path: string, folder: string): boolean {
  return path === folder || path.startsWith(folder.endsWith(sep) ? folder : `${folder}${sep}`)
}
