import type { RetestEvent } from '../../protocol/events.ts'
import type { RunResult } from '../../protocol/result.ts'
import type { RunRecord } from '../run-record.ts'
import type { RunTargets } from '../targets.ts'
import type { CodeFrame } from '../code-frame.ts'
import type { ArtifactFiles } from './artifact-files.ts'

/**
 * Where a report's result came from: `result.json`; a result rebuilt from `events.jsonl` because the run left no
 * `result.json`; or the result the run handed its reporters as it ended, before it wrote `result.json`.
 */
export type ResultSource = 'result.json' | 'events.jsonl' | 'run'

/**
 * What a report is made from, and nothing else: a run's result and its events, what reading the folder warned of, and
 * the folder itself, which the report reads artifacts from and names in the commands it prints.
 */
export type ReportInput = {
  /** The run folder's absolute path. */
  directory: string
  /** The run folder as the person named it, for the commands the report prints. */
  shown: string
  source: ResultSource
  result: RunResult
  events: readonly RetestEvent[]
  warnings: readonly string[]
  /** The live run redactor; source is withheld when it is unavailable. */
  redactText?: (text: string) => string
}

/** What every part of a report reads: its input, the events by test, the targets, and the run folder's files. */
export type ReportContext = {
  input: ReportInput
  record: RunRecord
  targets: RunTargets
  /** The run's root directory, where code frames are read; absent when the events do not say it. */
  rootDir: string | undefined
  files: ArtifactFiles
  sourceFrames: ReadonlyMap<string, CodeFrame>
}
