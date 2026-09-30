import type { CollectedTest } from '../protocol/events.ts'
import type { Failure } from '../protocol/failures.ts'
import type { Timeouts } from '../protocol/timeouts.ts'

/** What stops a run from outside. The run stops the same way for each; its exit code says which it was. */
export type StopSignal = 'SIGINT' | 'SIGTERM'

export type RunOptions = {
  files: string[]
  rootDir: string
  browserPath: string
  baseUrl?: string
  timeouts: Timeouts
  outputDir: string
  headless: boolean
  /** Aborted to stop the run, with the `StopSignal` that asked as its reason; any other reason counts as SIGINT. */
  signal: AbortSignal
  /** Receives each test file's stdout and stderr as it arrives. The run folder keeps a copy either way. */
  onOutput?: (output: ChildOutput) => void
}

export type ChildOutput = { file: string; stream: 'stdout' | 'stderr'; text: string }

export type CollectOptions = { files: string[]; rootDir: string; timeouts: Pick<Timeouts, 'collection'> }

/**
 * What collection found in one file. A file that failed collection has a failure and no tests; one whose
 * process failed after its tests were collected keeps them, with a failure.
 */
export type CollectedFile = { file: string; collection: 'ok' | 'failed'; failure?: Failure; tests: CollectedTest[] }

/** Every selected file, in order. Collecting never launches a browser. */
export type CollectResult = { files: CollectedFile[] }
