import type { ChildProcess } from 'node:child_process'
import type { InstallCommand } from './package-manager.ts'
import { spawn } from 'node:child_process'
import { errorMessage } from '../../protocol/failures.ts'
import { stopSignalOf } from '../../runner/outcome.ts'

/** How an install ended: with its exit code, by a signal, or before it could start. */
export type InstallEnd = { kind: 'exited'; code: number } | { kind: 'signalled'; signal: NodeJS.Signals } | { kind: 'not started'; problem: string }

/** The install to run, the folder it runs in and the signal that stops it. */
export type InstallRequest = { command: InstallCommand; cwd: string; signal: AbortSignal }

/**
 * Runs a package manager's install in a project with this process's own environment and terminal, so the manager
 * reads and writes the terminal itself, and resolves once it has ended. A stop is passed on to it on macOS and Linux,
 * where a signal sent to Retest alone would leave it running. On Windows Ctrl+C and Ctrl+Break reach every program
 * of the console, the install among them, and ending the shell it runs under would leave the install running.
 *
 * @example const end = await runInstall({ command: installCommand(manager, process.platform), cwd, signal })
 */
export function runInstall(request: InstallRequest): Promise<InstallEnd> {
  const { command, cwd, signal } = request
  return new Promise((resolve) => {
    // An abort that came first has no event left to pass on, so nothing is started.
    if (signal.aborted) {
      resolve({ kind: 'not started', problem: 'it was stopped first' })
      return
    }
    let child: ChildProcess
    try {
      child = spawn(command.file, command.args, { cwd, stdio: 'inherit', shell: command.shell })
    } catch (error) {
      resolve({ kind: 'not started', problem: errorMessage(error) })
      return
    }
    const passStop = (): void => {
      if (process.platform !== 'win32') child.kill(stopSignalOf(signal))
    }
    const settle = (end: InstallEnd): void => {
      signal.removeEventListener('abort', passStop)
      resolve(end)
    }
    signal.addEventListener('abort', passStop, { once: true })
    // A program that cannot start reports it here, with no pid. Once it has started, its end comes through close.
    child.on('error', (error) => {
      if (child.pid === undefined) settle({ kind: 'not started', problem: errorMessage(error) })
    })
    child.on('close', (code, ended) => {
      if (child.pid !== undefined) settle(ended === null ? { kind: 'exited', code: code ?? 1 } : { kind: 'signalled', signal: ended })
    })
  })
}
