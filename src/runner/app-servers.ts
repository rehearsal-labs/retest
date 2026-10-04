import type { LoadedApp } from '../config/loaded.ts'
import type { EventBody } from '../protocol/events.ts'
import type { Failure } from '../protocol/failures.ts'
import type { AppServerHandle } from './app-server.ts'
import type { Redactor } from './redactor.ts'
import { closeGraceMs } from '../browser/contract.ts'
import { errorMessage, failure } from '../protocol/failures.ts'
import { withoutCredentials } from '../protocol/url.ts'
import { AppServerError, startAppServer } from './app-server.ts'

export type AppServersOptions = {
  /** The absolute path of an app server's log. */
  logFile: (app: string) => string
  redactor: Redactor
  /** Environment variables no server may see, such as the ones AI judges' credentials are read from. */
  hiddenVariables?: readonly string[]
  setupMs: number
  /** Aborted when the run is interrupted. */
  signal: AbortSignal
  emit: (body: EventBody) => void
}

/**
 * The servers a run's apps need. Each app with `start` is made ready once, the first time a test needs it, and
 * a server that fails keeps failing every later test that needs it. The servers the run started are stopped
 * when it ends; a server it found running is left alone.
 */
export class AppServers {
  readonly #options: AppServersOptions
  readonly #ready = new Map<string, Promise<Failure | undefined>>()
  readonly #started: AppServerHandle[] = []

  constructor(options: AppServersOptions) {
    this.#options = options
  }

  /** Why the app's server is not ready, or undefined once it is, or when the app has no `start`. */
  ensure(app: LoadedApp): Promise<Failure | undefined> {
    const known = this.#ready.get(app.name)
    if (known !== undefined) return known
    const ready = this.#start(app)
    this.#ready.set(app.name, ready)
    return ready
  }

  /** Stops every server the run started, retaining every cleanup failure after all stops settle. */
  async stop(): Promise<Failure[]> {
    const stopped = await Promise.allSettled(this.#started.splice(0).map((server) => server.stop(closeGraceMs)))
    return stopped.flatMap((entry): Failure[] => entry.status === 'fulfilled' ? [] : [entry.reason instanceof AppServerError ? entry.reason.failure : failure('cleanup_failed', `Stopping an app server: ${errorMessage(entry.reason)}`)])
  }

  async #start({ name, start }: LoadedApp): Promise<Failure | undefined> {
    if (start === undefined) return undefined
    const { logFile, redactor, setupMs, signal, emit, hiddenVariables } = this.#options
    const ready = withoutCredentials(start.ready)
    try {
      const hidden = hiddenVariables === undefined ? {} : { hiddenVariables }
      const server = await startAppServer({ name, start, logFile: logFile(name), redactor, signal, ...hidden }, start.timeoutMs ?? setupMs)
      if (server.status === 'reused') {
        emit({ type: 'app.reused', app: name, ready })
        return undefined
      }
      this.#started.push(server)
      emit({ type: 'app.started', app: name, ready, pid: server.pid, durationMs: server.durationMs })
      return undefined
    } catch (error) {
      const problem = error instanceof AppServerError ? error.failure : failure('setup_failed', `The server for ${name} could not start: ${errorMessage(error)}`)
      emit({ type: 'app.failed', app: name, ready, failure: problem })
      return problem
    }
  }
}
