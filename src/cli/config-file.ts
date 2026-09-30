import type { LoadedConfig } from '../config/loaded.ts'
import type { CliDependencies } from './command.ts'
import { resolve } from 'node:path'
import { defaultConfigFile, retestCommand } from '../reporters/commands.ts'
import { CliError, UsageError } from './errors.ts'
import { statIfPresent } from './file-system.ts'

export { defaultConfigFile } from '../reporters/commands.ts'

export type ConfigRequest = { cwd: string; given: string | undefined }

/**
 * Loads the config `--config` names, or `retest.config.ts` in the root directory. Undefined when neither
 * was asked for and the default is not there. A config that does not load is an error that names it.
 *
 * @example const config = await findConfig({ cwd, given: parsed.value('config') }, dependencies)
 */
export async function findConfig(
  request: ConfigRequest,
  dependencies: Pick<CliDependencies, 'loadConfig'>,
): Promise<LoadedConfig | undefined> {
  const shown = request.given ?? defaultConfigFile
  const path = resolve(request.cwd, shown)
  const stats = statIfPresent(path)
  if (stats === undefined) {
    if (request.given === undefined) return undefined
    throw new CliError(`No config at ${shown}.`)
  }
  if (!stats.isFile()) throw new CliError(`${shown} is not a file.`)
  const loaded = await dependencies.loadConfig(path)
  if (!loaded.ok) throw new CliError(loaded.failure.message)
  return loaded.config
}

/** What to do when a command needs a config and there is none. */
export function missingConfig(what: string): UsageError {
  return new UsageError(`${what} No ${defaultConfigFile} here. Run ${retestCommand} init to write one.`)
}
