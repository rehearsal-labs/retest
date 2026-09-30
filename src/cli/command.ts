import type { ExitCode } from '../protocol/events.ts'
import type { RunResult } from '../protocol/result.ts'
import type { Reporter } from '../reporters/reporter.ts'
import type { CollectOptions, CollectResult, RunOptions } from '../runner/contract.ts'
import type { OptionSpecs } from './arguments.ts'
import type { Environment, Terminal } from './terminal.ts'

/** Everything the CLI reaches outside itself. `main.ts` passes the real ones; tests pass fakes. */
export type CliDependencies = {
  runFiles: (options: RunOptions, reporters: Reporter[]) => Promise<RunResult>
  collectFiles: (options: CollectOptions) => Promise<CollectResult>
  version: string
  stdout: Terminal
  stderr: Terminal
  env: Environment
  cwd: string
  /** Aborted by the first interrupt. */
  signal: AbortSignal
}

export type Command = {
  name: string
  /** What follows `retest <name>` in the usage line. */
  usage: string
  /** One line for the list of commands. */
  summary: string
  description: string
  options: OptionSpecs
  /** Printed after the options. */
  notes?: string
  run(args: readonly string[], dependencies: CliDependencies): Promise<ExitCode>
}
