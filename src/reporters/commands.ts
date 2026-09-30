import type { EventOfType } from './run-record.ts'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { formatLine } from '../protocol/location.ts'
import { defaultTimeouts, formatTimeouts, timeoutNames, type Timeouts } from '../protocol/timeouts.ts'
import { variantPairs, type Variant } from '../protocol/variant.ts'

/** How printed commands start. A project installs Retest as a development dependency. */
export const retestCommand = 'npx retest'

/** The config a run reads when `--config` does not name another, in the root directory. */
export const defaultConfigFile = 'retest.config.ts'

const bare = /^[\w@%+=:,./-]+$/
const needsSingleQuotes = /["$`\\!]/

/**
 * Quotes a value for a POSIX shell, as lightly as it allows.
 *
 * @example shellQuote('examples/task.retest.ts > saves a task') // '"examples/task.retest.ts > saves a task"'
 */
export function shellQuote(value: string): string {
  if (bare.test(value)) return value
  if (!needsSingleQuotes.test(value)) return `"${value}"`
  return `'${value.replaceAll("'", `'\\''`)}'`
}

/**
 * What to run again: a file, the line a test is declared on, the row of a `test.for` there, and the targets
 * that pick out its variant.
 */
export type RerunRequest = { file: string; line?: number | undefined; row?: number | undefined; targets?: Variant | undefined }

/**
 * Whether the command line can run this run's tests again as it ran them. It cannot when a program gave the run host
 * checks, which no flag gives, or a config with no file behind it, as one built in memory.
 *
 * @example canRerun(started) // false for a run with host checks
 */
export function canRerun(run: EventOfType<'run.started'>): boolean {
  const { config, hostChecks } = run.options
  if (hostChecks !== undefined) return false
  return config === undefined || existsSync(resolve(run.rootDir, config))
}

/**
 * Runs a test or a file again the way the original run did: with its browser, or its config, the base URLs
 * the command line gave, and the budgets it gave. A run that does not say what the command line gave repeats
 * every budget that differs from the defaults.
 *
 * @example formatRerunCommand(run, { file: 'tests/a.retest.ts', line: 7, targets: { web: 'beta' } }) // 'npx retest run tests/a.retest.ts:7 --target web=beta'
 */
export function formatRerunCommand(run: EventOfType<'run.started'>, request: RerunRequest): string {
  const { browserPath, baseUrl, baseUrls, config, timeouts, commandLineTimeouts } = run.options
  const { file, line, row } = request
  const where = line === undefined ? file : formatLine({ file, line, row })
  const parts = [retestCommand, 'run', shellQuote(where)]
  if (browserPath !== undefined) parts.push('--browser', shellQuote(browserPath))
  if (config !== undefined && config !== defaultConfigFile) parts.push('--config', shellQuote(config))
  if (baseUrl !== undefined) parts.push('--base-url', shellQuote(baseUrl))
  for (const [app, url] of Object.entries(baseUrls ?? {})) parts.push('--base-url', shellQuote(`${app}=${url}`))
  parts.push(...targetOptions(request.targets))
  const given = commandLineTimeouts === undefined ? changedTimeouts(timeouts) : formatTimeouts(commandLineTimeouts)
  if (given !== '') parts.push('--timeouts', given)
  return parts.join(' ')
}

function changedTimeouts(timeouts: Timeouts): string {
  const changed: Partial<Timeouts> = {}
  for (const name of timeoutNames) if (timeouts[name] !== defaultTimeouts[name]) changed[name] = timeouts[name]
  return formatTimeouts(changed)
}

export type InspectCommandOptions = {
  runFolder: string
  testId?: string | undefined
  targets?: Variant | undefined
  json?: boolean
}

/** @example formatInspectCommand({ runFolder: 'runs/a', json: true }) // 'npx retest inspect runs/a --json' */
export function formatInspectCommand(options: InspectCommandOptions): string {
  const parts = [retestCommand, 'inspect', shellQuote(options.runFolder)]
  if (options.testId !== undefined) parts.push('--test', shellQuote(options.testId), ...targetOptions(options.targets))
  if (options.json === true) parts.push('--json')
  return parts.join(' ')
}

function targetOptions(targets: Variant | undefined): string[] {
  return variantPairs(targets).flatMap((pair) => ['--target', shellQuote(pair)])
}
