/**
 * The CLI, started by `main.ts` once the compile cache is on: wires the commands to the runner, the browser and the
 * terminal, runs the one the arguments name, and exits with its code once every write has settled. The runner, the
 * browser launch, the config loader and the app server load only when a command first calls them, so `retest
 * --version` and the commands that need none of them never load that code.
 */
import type { CliDependencies } from './command.ts'
import process from 'node:process'
import { resolveExecutable, systemHost } from '../browser/executables.ts'
import { executableRequest } from '../runner/target-executable.ts'
import { retestVersion } from '../version.ts'
import { createCli } from './cli.ts'
import { abortOnInterrupt } from './interrupt.ts'
import { terminalPrompt } from './prompt.ts'
import { exitCodeAfterOutput, messageTerminal, reportTerminal } from './terminal.ts'

const stdout = reportTerminal(process.stdout)
const stderr = messageTerminal(process.stderr)

const loadedWhenCalled: Pick<CliDependencies, 'runFiles' | 'collectFiles' | 'loadConfig' | 'launchBrowser' | 'probeReady' | 'startAppServer'> = {
  runFiles: async (options, reporters) => (await import('../runner/run.ts')).runFiles(options, reporters),
  collectFiles: async (options) => (await import('../runner/run.ts')).collectFiles(options),
  loadConfig: async (path) => (await import('../config/load.ts')).loadConfig(path),
  launchBrowser: async (options, timeoutMs) => (await import('../browser/launch.ts')).launchBrowser(options, timeoutMs),
  probeReady: async (url, timeoutMs) => (await import('../runner/app-server.ts')).probeReady(url, timeoutMs),
  startAppServer: async (options, timeoutMs) => (await import('../runner/app-server.ts')).startAppServer(options, timeoutMs),
}

const cli = createCli({
  ...loadedWhenCalled,
  // Commands call it without awaiting it, so its module loads with the program.
  resolveExecutable: (target) => resolveExecutable(executableRequest(target), systemHost()),
  version: retestVersion,
  stdout: stdout.terminal,
  stderr,
  // Emitted, not sent, so the interrupt is seen before the unanswered question returns.
  prompt: terminalPrompt(process.stdin, process.stdout, () => process.emit('SIGINT')),
  env: process.env,
  cwd: process.cwd(),
  signal: abortOnInterrupt({ source: process, stderr, exit: (code) => process.exit(code) }),
})
const exitCode = await cli(process.argv.slice(2))
await Promise.all([drain(process.stdout), drain(process.stderr)])
process.exit(exitCodeAfterOutput(exitCode, stdout.failure() !== undefined))

// Exiting before the last write settles would cut a piped report short and could miss a closed pipe,
// whose error arrives after the write returns.
function drain(stream: NodeJS.WriteStream): Promise<void> {
  return new Promise((resolve) => {
    if (stream.destroyed) resolve()
    else stream.write('', () => resolve())
  })
}
