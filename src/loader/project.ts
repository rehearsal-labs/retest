import type { LoadFnOutput, LoadHookContext, LoadHookSync, ModuleSource, ResolveHookSync } from 'node:module'
import type { ModuleRecord } from '../protocol/execution.ts'
import type { Failure } from '../protocol/failures.ts'
import type { TsconfigRead } from './tsconfig.ts'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { dirname, extname, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { errorCode } from '../shared/error-code.ts'
import { relativePosixPath } from '../shared/posix-path.ts'
import { sha256Hex } from '../shared/sha256.ts'
import { projectResolver } from './resolve.ts'
import { decoratorHint, transformTypeScript } from './transform.ts'
import { readTsconfig, tsconfigFileName } from './tsconfig.ts'

export type ProjectOptions = {
  /** The folder tests run from. Files in it are named by their path from there. */
  folder: string
  /** The file loaded first, a test file or the config, which must be an ES module whatever its extension. */
  entry: string
  /** The subpath Playwright's specifiers resolve to, in a run of Playwright test files. */
  playwright?: string
}

export type ProjectUse = { ok: true; tsconfig: string | undefined } | { ok: false; failure: Failure }

// The folder of Retest's own modules, `src` or `dist`: they load and resolve as Node loads them, never as the project's.
const ownFolderUrl = new URL('../', import.meta.url).href
const jsxExtensions = new Set(['.tsx', '.jsx'])
const typeScriptExtensions = new Set(['.ts', '.mts', '.cts'])
const commonJsFormats = new Set(['commonjs', 'commonjs-typescript'])
const commonJsName = /\brequire\s*\(|\bmodule\.exports\b|\bexports\.[A-Za-z_$][\w$]*|\b__dirname\b|\b__filename\b/
const moduleSyntax = /^[ \t]*(?:import|export)\b/m
const missingExport = /The requested module '([^']+)' does not provide an export named '([^']+)'/

type NextLoad = Parameters<LoadHookSync>[2]

let resolveImport: ResolveHookSync | undefined
let rootFolder = ''
let entryUrl = ''
// The project module last handed to Node. Node compiles each module as soon as it loads, so a compile error with no
// location of its own belongs to it.
let lastModule: string | undefined
// Each folder's nearest tsconfig.json, and each tsconfig as read, for the life of one project.
const tsconfigOfFolder = new Map<string, string | undefined>()
const tsconfigRead = new Map<string, TsconfigRead>()
// The project TypeScript files each specifier resolved to, which a missing export is checked against.
const resolvedFiles = new Map<string, Set<string>>()
// Every project module this process has loaded, by its real path, with the SHA-256 of its source as it was read.
const loadedSources = new Map<string, string>()

/**
 * Loads the project in `folder` from now on in this process: the `paths` of the tsconfig.json nearest each importing
 * file, relative imports without their extension, its TypeScript through Node's transformer, and a refusal that names
 * each JSX file and each CommonJS file that is the entry or TypeScript. The hooks are registered once per process; a
 * later call replaces the project they serve and forgets the tsconfigs read for the last. The tsconfig that governs the
 * entry is read first: one that cannot be read is a usage failure that names it, and the entry is not loaded.
 *
 * @example const project = useProject({ folder: '/work', entry: '/work/tests/tasks.retest.ts' })
 */
export function useProject(options: ProjectOptions): ProjectUse {
  const folder = realpathSync(options.folder)
  const entry = realPath(options.entry)
  const playwright = options.playwright === undefined ? {} : { playwright: options.playwright }
  const registered = resolveImport !== undefined
  tsconfigOfFolder.clear()
  tsconfigRead.clear()
  resolvedFiles.clear()
  loadedSources.clear()
  resolveImport = projectResolver({ ownUrl: import.meta.url, ownFolderUrl, rootFolder: folder, tsconfigFor, ...playwright })
  rootFolder = folder
  entryUrl = pathToFileURL(entry).href
  lastModule = undefined
  if (!registered) registerHooks({ resolve: resolveRecorded, load: loadModule })
  const governing = tsconfigFor(dirname(entry))
  if (governing !== undefined && !governing.ok) return governing
  return { ok: true, tsconfig: governing?.paths.file }
}

/**
 * More about a failure to load a file, when the project's own code shows the cause: a missing export that the module
 * imported from declares only as a type, or a decorator in the TypeScript module Node failed to compile. Undefined when
 * neither is found; nothing is said of JavaScript files or packages.
 *
 * @example explainLoadFailure("SyntaxError: The requested module './titles.ts' does not provide an export named 'Title'") // "tests/titles.ts declares Title only as a type: ..."
 */
export function explainLoadFailure(message: string): string | undefined {
  const missing = missingExport.exec(message)
  if (missing !== null) return typeOnlyHint(missing[1] ?? '', missing[2] ?? '')
  if (!/\bSyntaxError\b/.test(message) || lastModule === undefined) return undefined
  const path = fileURLToPath(lastModule)
  if (!typeScriptExtensions.has(extname(path))) return undefined
  const source = readIfPresent(path)
  return source === undefined ? undefined : decoratorHint(source, shownPath(path))
}

/**
 * Every project module this process has loaded so far: its path from the folder tests run from, POSIX, with `../` for
 * one outside it, and the SHA-256 of its source as read from disk, before types were stripped. The parent fingerprints
 * the bundle a test ran from it.
 *
 * @example loadedModules() // [{ path: 'tests/a.retest.ts', sha256: '9f86d0…' }, { path: '../shared/accounts.ts', sha256: '…' }]
 */
export function loadedModules(): ModuleRecord[] {
  return [...loadedSources].map(([path, sha256]) => ({ path: relativePosixPath(rootFolder, path), sha256 }))
}

/**
 * A message with one more sentence after it, with the full stop Node's own messages leave out.
 *
 * @example withSentence('SyntaxError: Invalid or unexpected token', 'a.ts:3 has a decorator.') // 'SyntaxError: Invalid or unexpected token. a.ts:3 has a decorator.'
 */
export function withSentence(message: string, sentence: string): string {
  return `${message}${/[.!?]$/.test(message) ? '' : '.'} ${sentence}`
}

// Remembers which project TypeScript file each specifier resolved to, for the hint about a missing export.
const resolveRecorded: ResolveHookSync = (specifier, context, nextResolve) => {
  const resolved = (resolveImport ?? nextResolve)(specifier, context, nextResolve)
  const path = projectPath(resolved.url)
  if (path !== undefined && typeScriptExtensions.has(extname(path))) resolvedFiles.set(specifier, (resolvedFiles.get(specifier) ?? new Set()).add(path))
  return resolved
}

// Types are stripped, which keeps every position, and a module stripping refuses is transformed with a source map; a
// process started with --experimental-transform-types transforms TypeScript itself, and the hook leaves it to Node.
const loadModule: LoadHookSync = (url, context, nextLoad) => {
  const path = projectPath(url)
  if (path === undefined) return nextLoad(url, context)
  const extension = extname(path)
  if (jsxExtensions.has(extension)) throw new Error(`${shownPath(path)} is a ${extension} file. Retest does not load JSX.`)
  const { loaded, formatGuessed } = loadWithFormat(url, context, nextLoad)
  // A CommonJS JavaScript helper loads as Node loads it, by its own interop; a test file, the config and TypeScript do not.
  const mustBeModule = typeScriptExtensions.has(extension) || url === entryUrl
  const readAsCommonJs = formatGuessed || commonJsFormats.has(loaded.format ?? '')
  const commonJs = mustBeModule && readAsCommonJs ? commonJsConstruct(extension, sourceText(loaded.source), formatGuessed) : undefined
  if (commonJs !== undefined) throw commonJsRefusal(path, commonJs)
  if (loaded.source !== undefined) loadedSources.set(path, sha256Hex(sourceBytes(loaded.source)))
  if (loaded.format !== 'module-typescript' || process.features.typescript === 'transform' || loaded.source === undefined) {
    lastModule = url
    return loaded
  }
  const source = transformTypeScript(sourceText(loaded.source), url, shownPath(path))
  lastModule = url
  return { format: 'module', source, shortCircuit: true }
}

// The tsconfig.json nearest a folder, found once per folder, and read once per file.
function tsconfigFor(folder: string): TsconfigRead | undefined {
  const file = nearestTsconfig(folder)
  if (file === undefined) return undefined
  const known = tsconfigRead.get(file)
  if (known !== undefined) return known
  const read = readTsconfig(file)
  tsconfigRead.set(file, read)
  return read
}

function nearestTsconfig(folder: string): string | undefined {
  if (tsconfigOfFolder.has(folder)) return tsconfigOfFolder.get(folder)
  const candidate = join(folder, tsconfigFileName)
  let found: string | undefined
  if (existsSync(candidate) && statSync(candidate).isFile()) found = candidate
  else if (dirname(folder) !== folder) found = nearestTsconfig(dirname(folder))
  tsconfigOfFolder.set(folder, found)
  return found
}

// Said only when a TypeScript file the specifier resolved to declares the name as a type or an interface.
function typeOnlyHint(specifier: string, name: string): string | undefined {
  const written = name.replaceAll('$', '\\$')
  const declaration = new RegExp(
    `\\bexport\\s+(?:declare\\s+)?(?:type|interface)\\s+${written}(?![\\w$])|\\bexport\\s+type\\s*\\{[^}]*\\b${written}(?![\\w$])|\\bexport\\s*\\{[^}]*\\btype\\s+${written}(?![\\w$])`,
  )
  for (const path of resolvedFiles.get(specifier) ?? []) {
    const source = readIfPresent(path)
    if (source !== undefined && declaration.test(source)) return `${shownPath(path)} declares ${name} only as a type: import it with import type.`
  }
  return undefined
}

// Node tells the format of a .ts file in a package with no "type" by stripping its types first, and type stripping alone
// refuses an enum or a parameter property, so in a process without the transformer that file is loaded as an ES module.
// Its format is then a guess.
function loadWithFormat(url: string, context: LoadHookContext, nextLoad: NextLoad): { loaded: LoadFnOutput; formatGuessed: boolean } {
  try {
    return { loaded: nextLoad(url, context), formatGuessed: false }
  } catch (error) {
    if (errorCode(error) !== 'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX' || process.features.typescript === 'transform') throw error
    return { loaded: nextLoad(url, { ...context, format: 'module-typescript' }), formatGuessed: true }
  }
}

// A file of the project: outside node_modules and outside Retest's own modules.
function projectPath(url: string): string | undefined {
  if (!url.startsWith('file:') || url.startsWith(ownFolderUrl)) return undefined
  const path = fileURLToPath(url)
  return path.split(sep).includes('node_modules') ? undefined : path
}

// What makes a module Node reads as CommonJS really one: its extension, or a name only CommonJS gives it. A file with
// neither, such as one with no import or export at all, runs the same either way and is left to Node. A file whose
// format was guessed is an ES module when it imports or exports anything.
function commonJsConstruct(extension: string, source: string, formatGuessed: boolean): string | undefined {
  if (extension === '.cjs' || extension === '.cts') return `the ${extension} extension`
  if (formatGuessed && moduleSyntax.test(source)) return undefined
  const found = commonJsName.exec(source)
  if (found === null) return undefined
  return found[0].startsWith('require') ? 'require()' : found[0]
}

function commonJsRefusal(path: string, construct: string): Error {
  return new Error(`${shownPath(path)} uses ${construct}, so Node loads it as CommonJS. Retest loads test files, the config and TypeScript as ES modules: write import and export, and set "type": "module" in package.json or use the .mts or .mjs extension.`)
}

function shownPath(path: string): string {
  return path.startsWith(`${rootFolder}${sep}`) ? relativePosixPath(rootFolder, path) : path
}

function readIfPresent(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    // A file that is gone since it loaded explains nothing.
    return undefined
  }
}

// Node names a module by its real path. A file that is not there fails as it loads, under the name it was given.
function realPath(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

function sourceBytes(source: ModuleSource): string | Uint8Array {
  if (typeof source === 'string') return source
  return source instanceof ArrayBuffer ? new Uint8Array(source) : new Uint8Array(source.buffer, source.byteOffset, source.byteLength)
}

function sourceText(source: ModuleSource | undefined): string {
  if (source === undefined) return ''
  return typeof source === 'string' ? source : new TextDecoder().decode(source)
}
