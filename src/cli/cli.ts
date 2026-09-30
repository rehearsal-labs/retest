import type { ExitCode } from '../protocol/events.ts'
import type { CliDependencies, Command } from './command.ts'
import { failureSchema } from '../protocol/failures.ts'
import { parse } from '../protocol/schema.ts'
import { createStyle } from '../reporters/style.ts'
import { interruptedExitCode } from '../runner/outcome.ts'
import { listWords } from '../shared/list-words.ts'
import { doctorCommand } from './commands/doctor.ts'
import { initCommand } from './commands/init.ts'
import { inspectCommand } from './commands/inspect.ts'
import { listCommand } from './commands/list.ts'
import { runCommand } from './commands/run.ts'
import { CliError, UsageError } from './errors.ts'
import { commandHelp, generalHelp } from './help.ts'
import { suggest } from './suggest.ts'
import { shouldUseColor } from './terminal.ts'

export type { CliDependencies } from './command.ts'

/** Runs one command line to the end and returns the exit code. It never exits the process itself. */
export type Cli = (argv: readonly string[]) => Promise<ExitCode>

export const commands: readonly Command[] = [initCommand, doctorCommand, listCommand, runCommand, inspectCommand]

const commandNames = commands.map((command) => command.name)

/**
 * The `retest` command line, with everything it reaches outside itself passed in.
 *
 * @example const exitCode = await createCli(dependencies)(process.argv.slice(2))
 */
export function createCli(dependencies: CliDependencies): Cli {
  return async (argv) => {
    try {
      return await dispatch(argv, dependencies)
    } catch (error) {
      const command = commands.find((candidate) => candidate.name === argv[0])
      return reportError(error, command, dependencies)
    }
  }
}

async function dispatch(argv: readonly string[], dependencies: CliDependencies): Promise<ExitCode> {
  const [first, ...rest] = argv
  const { stdout } = dependencies
  if (first === undefined) {
    dependencies.stderr.write(generalHelp(commands, dependencies.version))
    return 2
  }
  if (first === 'help' || first === '--help' || first === '-h') {
    stdout.write(help(rest, dependencies.version))
    return 0
  }
  if (first === '--version' || first === '-v') {
    if (rest.length > 0) throw new UsageError(`${first} takes nothing after it.`)
    stdout.write(`${dependencies.version}\n`)
    return 0
  }
  const command = findCommand(first)
  if (rest.includes('--help') || rest.includes('-h')) {
    stdout.write(commandHelp(command))
    return 0
  }
  return command.run(rest, dependencies)
}

function help(args: readonly string[], version: string): string {
  const [name, ...extra] = args
  if (extra.length > 0) throw new UsageError('help takes one command at most.')
  return name === undefined || name === 'help' ? generalHelp(commands, version) : commandHelp(findCommand(name))
}

function findCommand(name: string): Command {
  const command = commands.find((candidate) => candidate.name === name)
  if (command !== undefined) return command
  if (name.startsWith('-')) {
    const guess = suggest(name.replace(/^-+/, ''), ['help', 'version'])
    const hint =
      guess === undefined ? ` Name a command first: ${listWords(commandNames)}.` : ` Did you mean --${guess}?`
    throw new UsageError(`Unknown option ${name}.${hint}`)
  }
  const guess = suggest(name, [...commandNames, 'help'])
  const hint = guess === undefined ? ` The commands are ${listWords(commandNames)}.` : ` Did you mean ${guess}?`
  throw new UsageError(`Unknown command ${name}.${hint}`)
}

function reportError(error: unknown, command: Command | undefined, dependencies: CliDependencies): ExitCode {
  const { stderr } = dependencies
  const label = createStyle(shouldUseColor(stderr, dependencies.env)).red('error')
  if (error instanceof CliError) {
    stderr.write(`${label}: ${error.message}\n`)
    if (error instanceof UsageError) {
      stderr.write(`See ${command === undefined ? 'retest --help' : `retest help ${command.name}`}.\n`)
    }
    return 2
  }
  if (dependencies.signal.aborted) {
    stderr.write('Interrupted.\n')
    return interruptedExitCode(dependencies.signal)
  }
  stderr.write(`${label}: ${describeError(error)}\n`)
  return 2
}

// Setup errors from the runner and the browser carry a failure, and their message is the whole story.
// Anything else is a fault in Retest, so its stack helps whoever reports it.
function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const expected = 'failure' in error && parse(failureSchema, error.failure).ok
  return expected ? error.message : (error.stack ?? error.message)
}
