import type { OptionSpec } from './arguments.ts'
import type { Command } from './command.ts'

const column = 28
const helpOption = { flags: '-h, --help', description: 'Show this help' }

/**
 * The help for `retest`, listing its commands.
 *
 * @example generalHelp(commands, '0.0.0')
 */
export function generalHelp(commands: readonly Command[], version: string): string {
  return [
    `retest ${version}`,
    '',
    'Runs browser tests from .retest.ts files and reports what happened.',
    '',
    'Usage',
    '  retest <command> [options]',
    '',
    'Commands',
    ...commands.map((command) => row(`${command.name} ${firstArgument(command)}`, command.summary)),
    row('help [command]', 'Show the help for a command'),
    '',
    'Options',
    row(helpOption.flags, helpOption.description),
    row('-v, --version', 'Print the version'),
    '',
    'Run retest help <command> to see its options.',
    '',
  ].join('\n')
}

/**
 * The help for one command, listing exactly the options it takes.
 *
 * @example commandHelp(runCommand)
 */
export function commandHelp(command: Command): string {
  const options = Object.entries(command.options).map(([name, option]) =>
    row(optionFlags(name, option), option.description),
  )
  return [
    'Usage',
    `  retest ${command.name} ${command.usage}`,
    '',
    command.description,
    '',
    'Options',
    ...options,
    row(helpOption.flags, helpOption.description),
    '',
    ...(command.notes === undefined ? [] : [command.notes, '']),
  ].join('\n')
}

function firstArgument(command: Command): string {
  return command.usage.split(' ')[0] ?? ''
}

function optionFlags(name: string, option: OptionSpec): string {
  return option.kind === 'flag' ? `--${name}` : `--${name} ${option.placeholder}`
}

function row(left: string, right: string): string {
  const [first = '', ...rest] = right.split('\n')
  const gap = ' '.repeat(Math.max(2, column - left.length - 2))
  return [`  ${left}${gap}${first}`, ...rest.map((line) => `${' '.repeat(column)}${line}`)].join('\n')
}
