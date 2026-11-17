import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { errorMessage } from '../../protocol/failures.ts'
import { isPlainObject } from '../../protocol/schema.ts'
import { errorCode } from '../../shared/error-code.ts'
import { CliError } from '../errors.ts'
import { readTextIfPresent } from '../file-system.ts'
import { packageScripts } from './templates.ts'

/** What `init` did to one file. A file that is already there is never written over. */
export type FileChange = { path: string; change: 'created' | 'updated' | 'left as is'; detail?: string }

/** A project's package.json as it was read, with the indent it is written in. */
export type PackageJson = { data: Record<string, unknown>; indent: string; finalNewline: boolean }

const dependencyFields = ['dependencies', 'devDependencies']
const ignoredRuns = '.retest/'
const ignoreLines = new Set(['.retest', '.retest/', '/.retest', '/.retest/'])

/**
 * Writes a new file, or leaves one that is already there as it is.
 *
 * @example createFile('/work', 'retest.config.ts', source) // { path: 'retest.config.ts', change: 'created' }
 */
export function createFile(root: string, path: string, content: string): FileChange {
  const absolute = join(root, path)
  try {
    mkdirSync(dirname(absolute), { recursive: true })
    writeFileSync(absolute, content, { flag: 'wx' })
    return { path, change: 'created' }
  } catch (error) {
    if (errorCode(error) === 'EEXIST') return { path, change: 'left as is' }
    throw new CliError(`${path} could not be written: ${errorMessage(error)}`)
  }
}

/**
 * Reads package.json, when there is one. One that is not a JSON object, or whose scripts or dependency lists are
 * not, stops `init` before it writes anything.
 */
export function readPackageJson(root: string): PackageJson | undefined {
  const text = readTextIfPresent(join(root, 'package.json'))
  if (text === undefined) return undefined
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    throw new CliError('package.json is not valid JSON, so init changed nothing. Fix it and run init again.')
  }
  if (!isPlainObject(data)) throw new CliError('package.json does not hold a JSON object, so init changed nothing.')
  for (const field of ['scripts', ...dependencyFields]) {
    if (data[field] !== undefined && !isPlainObject(data[field])) {
      throw new CliError(`The ${field} in package.json are not a JSON object, so init changed nothing.`)
    }
  }
  const indent = /^[{[]\r?\n([ \t]+)/.exec(text)?.[1] ?? '  '
  return { data, indent, finalNewline: text.endsWith('\n') }
}

/**
 * The packages of `wanted`, with their ranges, that neither `dependencies` nor `devDependencies` names at any version.
 *
 * @example missingPackages(undefined, { typescript: '^7.0.2' }) // { typescript: '^7.0.2' }
 */
export function missingPackages(found: PackageJson | undefined, wanted: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(wanted).filter(([name]) => !listsPackage(found, name)))
}

/**
 * Adds the `test:e2e` and `typecheck:e2e` scripts that are missing and the packages given, as dev dependencies, in
 * one write, and never changes a script that is set. Without a package.json, writes a new one for ES modules.
 */
export function updatePackageJson(root: string, found: PackageJson | undefined, packages: Readonly<Record<string, string>>): FileChange[] {
  const path = 'package.json'
  const names = Object.keys(packageScripts)
  const adding = Object.keys(packages).length > 0
  const packageChange = (change: FileChange['change']): FileChange[] => (adding ? [{ path, change, detail: packageList(packages) }] : [])
  if (found === undefined) {
    const data = { private: true, type: 'module', scripts: packageScripts, ...withPackages(undefined, packages) }
    writeFileSync(join(root, path), `${JSON.stringify(data, null, 2)}\n`)
    return [{ path, change: 'created', detail: scriptList(names) }, ...packageChange('created')]
  }
  const scripts = isPlainObject(found.data['scripts']) ? found.data['scripts'] : {}
  const added = names.filter((name) => !Object.hasOwn(scripts, name))
  const kept = names.filter((name) => Object.hasOwn(scripts, name))
  if (added.length > 0 || adding) {
    const additions = Object.fromEntries(added.map((name) => [name, packageScripts[name]]))
    const withScripts = added.length === 0 ? {} : { scripts: { ...scripts, ...additions } }
    const data = { ...found.data, ...withScripts, ...withPackages(found.data['devDependencies'], packages) }
    writeFileSync(join(root, path), `${JSON.stringify(data, null, found.indent)}${found.finalNewline ? '\n' : ''}`)
  }
  const changes: FileChange[] = []
  if (added.length > 0) changes.push({ path, change: 'updated', detail: scriptList(added) })
  if (kept.length > 0) changes.push({ path, change: 'left as is', detail: scriptList(kept) })
  return [...changes, ...packageChange('updated')]
}

/** Adds `.retest/` to .gitignore, since run folders hold screenshots and logs. */
export function ignoreRunFolders(root: string): FileChange {
  const path = '.gitignore'
  const absolute = join(root, path)
  const text = readTextIfPresent(absolute)
  if (text === undefined) {
    writeFileSync(absolute, `${ignoredRuns}\n`)
    return { path, change: 'created', detail: ignoredRuns }
  }
  if (text.split(/\r?\n/).some((line) => ignoreLines.has(line.trim()))) return { path, change: 'left as is', detail: ignoredRuns }
  appendFileSync(absolute, `${text === '' || text.endsWith('\n') ? '' : '\n'}${ignoredRuns}\n`)
  return { path, change: 'updated', detail: ignoredRuns }
}

function scriptList(names: readonly string[]): string {
  return `scripts: ${names.map((name) => JSON.stringify(name)).join(', ')}`
}

function packageList(packages: Readonly<Record<string, string>>): string {
  return `devDependencies: ${Object.entries(packages).map(([name, range]) => `${name}@${range}`).join(', ')}`
}

function listsPackage(found: PackageJson | undefined, name: string): boolean {
  return dependencyFields.some((field) => {
    const dependencies = found?.data[field]
    return isPlainObject(dependencies) && Object.hasOwn(dependencies, name)
  })
}

// The packages joined to the dev dependencies already there, which keep their order. A list in alphabetical order,
// as npm writes one, stays in it.
function withPackages(existing: unknown, packages: Readonly<Record<string, string>>): { devDependencies?: Record<string, unknown> } {
  if (Object.keys(packages).length === 0) return {}
  const listed = isPlainObject(existing) ? existing : {}
  const names = Object.keys(listed)
  const alphabetical = names.every((name, index) => index === 0 || compareNames(names[index - 1] ?? '', name) <= 0)
  const merged = Object.entries({ ...listed, ...packages })
  return { devDependencies: Object.fromEntries(alphabetical ? merged.sort(([left], [right]) => compareNames(left, right)) : merged) }
}

function compareNames(left: string, right: string): number {
  return left.localeCompare(right, 'en')
}
