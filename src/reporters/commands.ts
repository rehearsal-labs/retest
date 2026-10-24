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

type Quoting = { bare: RegExp; needsSingleQuotes: RegExp; singleQuoted: (value: string) => string }

// A POSIX shell, and on Windows PowerShell and Git Bash, which read the same quotes. PowerShell takes a bare comma for its
// array operator and a leading @ for splatting, so on Windows a value holding either is quoted too; a backslash is
// single-quoted there as everywhere, which Git Bash would otherwise read as an escape. PowerShell also reads the
// typographic double quotes “ ” „ as a double quote, so a value holding one is single-quoted, and the typographic single
// quotes ‘ ’ ‚ ‛ as a single quote, so inside single quotes each is doubled, as a plain one is. cmd.exe reads no single
// quotes and is not a shell these commands are written for.
const posixQuoting: Quoting = { bare: /^[\w@%+=:,./-]+$/, needsSingleQuotes: /["$`\\!]/, singleQuoted: (value) => value.replaceAll("'", `'\\''`) }
const windowsQuoting: Quoting = { bare: /^[\w%+=:./-][\w@%+=:./-]*$/, needsSingleQuotes: /["$`\\!“”„]/, singleQuoted: (value) => value.replace(/['‘’‚‛]/g, '$&$&') }

/**
 * Quotes a value for the shell a person pastes the command into, as lightly as it allows: a POSIX shell, or on Windows
 * PowerShell and Git Bash.
 *
 * @example shellQuote('examples/task.retest.ts > saves a task') // '"examples/task.retest.ts > saves a task"'
 */
export function shellQuote(value: string, platform: NodeJS.Platform = process.platform): string {
  const { bare, needsSingleQuotes, singleQuoted } = platform === 'win32' ? windowsQuoting : posixQuoting
  if (bare.test(value)) return value
  if (!needsSingleQuotes.test(value)) return `"${value}"`
  return `'${singleQuoted(value)}'`
}

/**
 * A run folder as a printed command names it: with forward slashes on Windows too, which cmd.exe, PowerShell and Git
 * Bash all hand to the program as they are, and Windows reads as separators, so a folder with no space needs no quotes
 * in any of them.
 *
 * @example commandPath('.retest\\runs\\2026-09-30T09-15-00.000Z', 'win32') // '.retest/runs/2026-09-30T09-15-00.000Z'
 */
export function commandPath(path: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? path.replaceAll('\\', '/') : path
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
  if (given !== '') parts.push('--timeouts', shellQuote(given))
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
export function formatInspectCommand(options: InspectCommandOptions, platform: NodeJS.Platform = process.platform): string {
  const parts = [retestCommand, 'inspect', shellQuote(commandPath(options.runFolder, platform), platform)]
  if (options.testId !== undefined) parts.push('--test', shellQuote(options.testId, platform), ...targetOptions(options.targets, platform))
  if (options.json === true) parts.push('--json')
  return parts.join(' ')
}

function targetOptions(targets: Variant | undefined, platform: NodeJS.Platform = process.platform): string[] {
  return variantPairs(targets).flatMap((pair) => ['--target', shellQuote(pair, platform)])
}
