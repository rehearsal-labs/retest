/** How a process ended: its exit code, or the signal that ended it. */
export type ProcessExit = { code: number | null; signal: NodeJS.Signals | null }

/**
 * Says how a process ended.
 *
 * @example describeExit({ code: null, signal: 'SIGKILL' }) // 'signal SIGKILL'
 */
export function describeExit(exit: ProcessExit): string {
  return exit.signal === null ? `exit code ${exit.code ?? 'unknown'}` : `signal ${exit.signal}`
}
