import type { Failure } from '../protocol/failures.ts'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { errorMessage, failure } from '../protocol/failures.ts'
import { isPlainObject } from '../protocol/schema.ts'

/** The file a project's TypeScript settings are read from, the nearest one at or above the folder Retest loads from. */
export const tsconfigFileName = 'tsconfig.json'

/**
 * One `paths` entry: the pattern as written, and the absolute paths it maps to, in the order they are tried. A
 * pattern holds at most one `*`, and each target the same, which the part of the import the `*` matched replaces.
 *
 * @example { pattern: '@helpers/*', targets: ['/work/tests/helpers/*'] }
 */
export type PathAlias = { pattern: string; targets: string[] }

/** What Retest takes from a project's tsconfig: its `paths`, resolved against `baseUrl` or the file that declares them. */
export type ProjectPaths = {
  /** The tsconfig.json that was read. */
  file: string
  /** The folder whose files the aliases apply to: the tsconfig's own, and everything under it outside node_modules. */
  folder: string
  aliases: PathAlias[]
}

export type TsconfigRead = { ok: true; paths: ProjectPaths } | { ok: false; failure: Failure }

type Declared = { value: string; folder: string }
type DeclaredPaths = { entries: [string, string[]][]; folder: string }
type Settings = { baseUrl?: Declared | null; paths?: DeclaredPaths | null }

/** A tsconfig that cannot be read: its message names the file and what is wrong with it. */
class TsconfigError extends Error {}

const configDirectory = '${configDir}'

/**
 * The tsconfig.json nearest `folder`: in it, or in the closest folder above it. Undefined when there is none up to
 * the file system's root.
 *
 * @example findTsconfig('/work/tests') // '/work/tsconfig.json'
 */
export function findTsconfig(folder: string): string | undefined {
  for (let current = resolve(folder); ; current = dirname(current)) {
    const candidate = join(current, tsconfigFileName)
    if (isFile(candidate)) return candidate
    if (dirname(current) === current) return undefined
  }
}

/**
 * The path aliases of a tsconfig.json, following `extends`. A file that is empty or holds only comments reads as `{}`,
 * as `tsc` reads it. A file that is not JSON with comments, extends a file that is not there or holds `paths` `tsc`
 * would refuse is a usage failure that names the file.
 *
 * @example readTsconfig('/work/tsconfig.json') // { ok: true, paths: { file: '/work/tsconfig.json', folder: '/work', aliases: [...] } }
 */
export function readTsconfig(found: string): TsconfigRead {
  // Node names modules by their real paths, so the folder the aliases apply to is compared in the same terms.
  const file = realpathSync(found)
  try {
    return { ok: true, paths: projectPaths(file, readSettings(file, [])) }
  } catch (error) {
    if (error instanceof TsconfigError) return { ok: false, failure: failure('usage', error.message) }
    throw error
  }
}

/**
 * JSON with the comments and trailing commas a tsconfig may hold. Each comment and trailing comma is read as spaces,
 * so a position JSON.parse names in an error is the position in the file.
 *
 * @example parseJsonWithComments('{ "a": 1, // one\n }') // { a: 1 }
 * @example parseJsonWithComments('// nothing yet') // undefined
 */
export function parseJsonWithComments(text: string): unknown {
  const blanked = blankComments(text.replace(/^\uFEFF/, ' '))
  // Undefined for a file with nothing in it but space and comments, which tsc reads as an empty object.
  return blanked.trim() === '' ? undefined : JSON.parse(blanked)
}

// `extends` comes first and each later file wins, then the file's own settings win over everything it extends.
function readSettings(file: string, chain: readonly string[]): Settings {
  if (chain.includes(file)) throw new TsconfigError(`${chain[0] ?? file} extends itself: ${[...chain, file].join(' extends ')}.`)
  const json = readJson(file)
  const folder = dirname(file)
  let settings: Settings = {}
  for (const specifier of extendsList(json['extends'], file)) settings = { ...settings, ...readSettings(extendedFile(specifier, file), [...chain, file]) }
  const options = json['compilerOptions']
  if (options === undefined) return settings
  if (!isPlainObject(options)) throw new TsconfigError(`${file}: compilerOptions must be an object.`)
  return { ...settings, ...ownBaseUrl(options['baseUrl'], file, folder), ...ownPaths(options['paths'], file, folder) }
}

function readJson(file: string): Record<string, unknown> {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    throw new TsconfigError(`${file} could not be read: ${errorMessage(error)}`)
  }
  let json: unknown
  try {
    json = parseJsonWithComments(text)
  } catch (error) {
    throw new TsconfigError(`${file} is not valid JSON: ${errorMessage(error)}`)
  }
  if (json === undefined) return {}
  if (!isPlainObject(json)) throw new TsconfigError(`${file} must hold a JSON object.`)
  return json
}

function extendsList(value: unknown, file: string): string[] {
  if (value === undefined) return []
  if (typeof value === 'string') return [value]
  if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) return value
  throw new TsconfigError(`${file}: extends must be a path or a list of paths.`)
}

// A path is read from the extending file's folder, with .json added when it names no file. Anything else is a package,
// as tsc finds one: the JSON file its exports give for the name, then, in each node_modules up from the extending file,
// the file of that name, with .json added, the file the package.json's tsconfig field names, or its tsconfig.json.
function extendedFile(specifier: string, file: string): string {
  if (specifier.startsWith('.') || isAbsolute(specifier)) {
    const path = resolve(dirname(file), specifier)
    const found = [path, `${path}.json`].find(isFile)
    if (found !== undefined) return found
  } else {
    const exported = resolvePackageFile(createRequire(file), specifier)
    if (exported?.endsWith('.json') === true) return exported
    const found = packageTsconfig(specifier, dirname(file))
    if (found !== undefined) return found
  }
  throw new TsconfigError(`${file} extends ${JSON.stringify(specifier)}, and there is no file for it.`)
}

function packageTsconfig(specifier: string, from: string): string | undefined {
  for (let folder = from; ; folder = dirname(folder)) {
    const path = join(folder, 'node_modules', specifier)
    const found = [path, `${path}.json`].find(isFile) ?? (existsSync(path) ? packageField(path) : undefined)
    if (found !== undefined) return found
    if (dirname(folder) === folder) return undefined
  }
}

// The file the package.json's tsconfig field names, and otherwise the package's own tsconfig.json.
function packageField(packageFolder: string): string | undefined {
  const manifest = join(packageFolder, 'package.json')
  if (isFile(manifest)) {
    const field = readJson(manifest)['tsconfig']
    if (typeof field === 'string' && isFile(join(packageFolder, field))) return join(packageFolder, field)
  }
  const own = join(packageFolder, tsconfigFileName)
  return isFile(own) ? own : undefined
}

function resolvePackageFile(require: NodeJS.Require, specifier: string): string | undefined {
  try {
    return require.resolve(specifier)
  } catch {
    // The next candidate may name the file.
    return undefined
  }
}

// `null` clears what an extended file set, as TypeScript reads it.
function ownBaseUrl(value: unknown, file: string, folder: string): Settings {
  if (value === undefined) return {}
  if (value === null) return { baseUrl: null }
  if (typeof value !== 'string') throw new TsconfigError(`${file}: baseUrl must be a path.`)
  return { baseUrl: { value, folder } }
}

function ownPaths(value: unknown, file: string, folder: string): Settings {
  if (value === undefined) return {}
  if (value === null) return { paths: null }
  if (!isPlainObject(value)) throw new TsconfigError(`${file}: paths must be an object of patterns and their paths.`)
  const entries = Object.entries(value).map(([pattern, targets]): [string, string[]] => {
    if (!Array.isArray(targets) || !targets.every((target) => typeof target === 'string')) {
      throw new TsconfigError(`${file}: paths[${JSON.stringify(pattern)}] must be a list of paths.`)
    }
    for (const written of [pattern, ...targets]) {
      if (written.split('*').length > 2) throw new TsconfigError(`${file}: ${JSON.stringify(written)} in paths has more than one *.`)
    }
    return [pattern, targets]
  })
  return { paths: { entries, folder } }
}

// Paths are read from baseUrl when one is set, wherever it was declared, and otherwise from the file that declared
// them. `${configDir}` is the folder of the tsconfig that was read, not the one that wrote it.
function projectPaths(file: string, settings: Settings): ProjectPaths {
  const folder = dirname(file)
  const declaredBase = settings.baseUrl ?? undefined
  const baseUrl = declaredBase === undefined ? undefined : fromFolder(declaredBase.value, declaredBase.folder, folder)
  const paths = settings.paths ?? undefined
  const base = baseUrl ?? paths?.folder ?? folder
  const aliases = (paths?.entries ?? []).map(([pattern, targets]) => ({ pattern, targets: targets.map((target) => fromFolder(target, base, folder)) }))
  return { file, folder, aliases }
}

function fromFolder(path: string, folder: string, readFolder: string): string {
  return path.startsWith(configDirectory) ? join(readFolder, path.slice(configDirectory.length)) : resolve(folder, path)
}

function isFile(path: string): boolean {
  return existsSync(path) && statSync(path).isFile()
}

// Strings are kept as they are, so a comment marker inside one is text.
function blankComments(text: string): string {
  let kept = ''
  let index = 0
  while (index < text.length) {
    const end = skippedEnd(text, index)
    if (end !== index) {
      kept += text.slice(index, end).replaceAll(/[^\n]/g, ' ')
      index = end
    } else if (text[index] === '"') {
      const close = stringEnd(text, index)
      kept += text.slice(index, close)
      index = close
    } else {
      kept += text[index] === ',' && closesNext(text, index + 1) ? ' ' : text[index]
      index += 1
    }
  }
  return kept
}

// The end of a comment starting at `index`, or `index` itself when none does.
function skippedEnd(text: string, index: number): number {
  if (text.startsWith('//', index)) {
    const newline = text.indexOf('\n', index)
    return newline === -1 ? text.length : newline
  }
  if (text.startsWith('/*', index)) {
    const close = text.indexOf('*/', index + 2)
    return close === -1 ? text.length : close + 2
  }
  return index
}

function stringEnd(text: string, open: number): number {
  for (let index = open + 1; index < text.length; index += 1) {
    if (text[index] === '\\') index += 1
    else if (text[index] === '"') return index + 1
  }
  return text.length
}

// Whether the next thing after whitespace and comments closes an object or a list, which makes a comma before it trailing.
function closesNext(text: string, from: number): boolean {
  let index = from
  while (index < text.length) {
    const end = skippedEnd(text, index)
    if (end !== index) index = end
    else if (/\s/.test(text[index] ?? '')) index += 1
    else return text[index] === '}' || text[index] === ']'
  }
  return false
}
