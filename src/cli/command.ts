import type { LaunchOptions, OwnedBrowser } from '../browser/contract.ts'
import type { ResolvedExecutable } from '../browser/executables.ts'
import type { LoadedChromiumTarget } from '../config/loaded.ts'
import type { ConfigResult } from '../config/validate.ts'
import type { ExitCode } from '../protocol/events.ts'
import type { RunResult } from '../protocol/result.ts'
import type { Reporter } from '../reporters/reporter.ts'
import type { AppServerHandle, AppServerOptions } from '../runner/app-server.ts'
import type { CollectOptions, CollectResult, RunOptions } from '../runner/contract.ts'
import type { OptionSpecs } from './arguments.ts'
import type { Prompt } from './prompt.ts'
import type { Environment, Terminal } from './terminal.ts'

/** Everything the CLI reaches outside itself. `main.ts` passes the real ones; tests pass fakes. */
export type CliDependencies = {
  runFiles: (options: RunOptions, reporters: Reporter[]) => Promise<RunResult>
  collectFiles: (options: CollectOptions) => Promise<CollectResult>
  /** Imports a config file and validates it. `path` is absolute. */
  loadConfig: (path: string) => Promise<ConfigResult>
  /** Where a Chromium target's browser is installed, or why it was not found. */
  resolveExecutable: (target: LoadedChromiumTarget) => ResolvedExecutable
  launchBrowser: (options: LaunchOptions, timeoutMs: number) => Promise<OwnedBrowser>
  /** Whether any HTTP answer comes from `url` within `timeoutMs`. */
  probeReady: (url: string, timeoutMs: number) => Promise<boolean>
  /** Reuses the server that answers at `ready`, or runs the command and waits for it. Throws when it never answers. */
  startAppServer: (options: AppServerOptions, timeoutMs: number) => Promise<AppServerHandle>
  version: string
  stdout: Terminal
  stderr: Terminal
  /** Where questions are asked. Only a person at a terminal is asked anything. */
  prompt: Prompt
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
