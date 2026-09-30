import { defaultTimeouts, type Timeouts } from '../protocol/timeouts.ts'
import type { EventOfType } from './run-record.ts'

/** How printed commands start. A project installs Retest as a development dependency. */
export const retestCommand = 'npx retest'

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

/** Runs one file again with the browser, base URL and changed timeouts of the original run. */
export function formatRerunCommand(run: EventOfType<'run.started'>, file: string): string {
  const { browserPath, baseUrl, timeouts } = run.options
  const parts = [retestCommand, 'run', shellQuote(file), '--browser', shellQuote(browserPath)]
  if (baseUrl !== undefined) parts.push('--base-url', shellQuote(baseUrl))
  const changed = changedTimeouts(timeouts)
  if (changed !== '') parts.push('--timeouts', changed)
  return parts.join(' ')
}

function changedTimeouts(timeouts: Timeouts): string {
  return Object.keys(defaultTimeouts)
    .filter(isTimeoutName)
    .filter((name) => timeouts[name] !== defaultTimeouts[name])
    .map((name) => `${name}=${timeouts[name]}`)
    .join(',')
}

function isTimeoutName(name: string): name is keyof Timeouts {
  return Object.hasOwn(defaultTimeouts, name)
}

export type InspectCommandOptions = { runFolder: string; testId?: string | undefined; json?: boolean }

/** @example formatInspectCommand({ runFolder: 'runs/a', json: true }) // 'npx retest inspect runs/a --json' */
export function formatInspectCommand(options: InspectCommandOptions): string {
  const parts = [retestCommand, 'inspect', shellQuote(options.runFolder)]
  if (options.testId !== undefined) parts.push('--test', shellQuote(options.testId))
  if (options.json === true) parts.push('--json')
  return parts.join(' ')
}
