import type { ConfigResult } from './validate.ts'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { explainLoadFailure, useProject, withSentence } from '../loader/project.ts'
import { errorMessage, failure } from '../protocol/failures.ts'
import { validateConfig } from './validate.ts'

/** The config a run reads from its root directory when no path is given. */
export const configFileName = 'retest.config.ts'

/**
 * The config file a run uses: `path` resolved against the root directory, or `retest.config.ts` there when it
 * exists. Undefined means the root has none, which only milestone 1's `--browser` mode accepts.
 *
 * @example findConfigFile('/work') // '/work/retest.config.ts'
 */
export function findConfigFile(rootDir: string, path?: string): string | undefined {
  if (path !== undefined) return resolve(rootDir, path)
  const found = resolve(rootDir, configFileName)
  return existsSync(found) ? found : undefined
}

/**
 * Imports a config file as test files are loaded, with the path aliases of the tsconfig nearest its folder and Node's
 * TypeScript transformer, and validates its default export. A file that is missing, does not load or holds an invalid
 * config is a usage failure that names the file, and the key when one is wrong; so is a tsconfig that cannot be read.
 *
 * @example const loaded = await loadConfig('/work/retest.config.ts')
 */
export async function loadConfig(path: string): Promise<ConfigResult> {
  const file = resolve(path)
  if (!existsSync(file)) return { ok: false, failure: failure('usage', `There is no config file at ${file}.`) }
  const project = useProject({ folder: dirname(file), entry: file })
  if (!project.ok) return project
  let module: unknown
  try {
    module = await import(pathToFileURL(file).href)
  } catch (error) {
    const message = `${file} could not be loaded: ${errorMessage(error)}`
    const explanation = explainLoadFailure(error instanceof Error ? `${error.name}: ${error.message}` : String(error))
    return { ok: false, failure: failure('usage', explanation === undefined ? message : withSentence(message, explanation)) }
  }
  if (typeof module !== 'object' || module === null || !('default' in module)) {
    return { ok: false, failure: failure('usage', `${file} has no default export. Write export default defineConfig({ ... }).`) }
  }
  return validateConfig(module.default, file)
}
