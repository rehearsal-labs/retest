import type { Writer } from '../reporters/style.ts'
import type { StopSignal } from '../runner/contract.ts'
import { stoppedExitCode } from '../runner/outcome.ts'
import { launchesHeldByJob } from '../shared/process-system.ts'

/** Where interrupts come from, such as `process`. */
export type InterruptSource = { on(event: StopSignal | 'SIGBREAK', listener: () => void): unknown }

export type InterruptOptions = { source: InterruptSource; stderr: Writer; exit: (code: 130 | 143) => void }

const stopSignals: readonly StopSignal[] = ['SIGINT', 'SIGTERM']

const stopping: Record<StopSignal, string> = {
  SIGINT: '\nStopping. Press Ctrl+C again to quit at once.\n',
  SIGTERM: '\nStopping on SIGTERM. A second signal quits at once.\n',
}

/**
 * The first SIGINT or SIGTERM aborts the returned signal with its name, so the run stops and still
 * reports; a second of either kind exits at once, with 130 for SIGINT and 143 for SIGTERM.
 *
 * @example const signal = abortOnInterrupt({ source: process, stderr: process.stderr, exit: process.exit })
 */
export function abortOnInterrupt(options: InterruptOptions): AbortSignal {
  const controller = new AbortController()
  const stop = (signal: StopSignal): void => {
    if (controller.signal.aborted) {
      options.exit(stoppedExitCode(signal))
      return
    }
    options.stderr.write(stopping[signal])
    controller.abort(signal)
  }
  for (const signal of stopSignals) options.source.on(signal, () => stop(signal))
  // Windows sends a console program no SIGTERM. Ctrl+Break, which Node gives as SIGBREAK and which a console cannot be
  // set to ignore as it can Ctrl+C, is how one is asked to stop there, so it stops a run as SIGTERM does.
  if (launchesHeldByJob) options.source.on('SIGBREAK', () => stop('SIGTERM'))
  return controller.signal
}
