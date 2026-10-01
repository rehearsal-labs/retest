import type { LoadedConfig } from '../config/loaded.ts'
import type { SecretContext } from '../config/types.ts'
import type { CollectedTest } from '../protocol/events.ts'
import type { Failure } from '../protocol/failures.ts'
import type { HostCheck } from '../protocol/host-check.ts'
import type { LastRunTest } from '../protocol/last-run.ts'
import type { Timeouts } from '../protocol/timeouts.ts'
import type { Variant } from '../protocol/variant.ts'

export type { HostCheck } from '../protocol/host-check.ts'

/** What stops a run from outside. The run stops the same way for each; its exit code says which it was. */
export type StopSignal = 'SIGINT' | 'SIGTERM'

/**
 * Why a run was stopped: the signal that asked, or a `Failure` that says why, which the run records as its
 * interruption, in `run.finished` and in each test it stopped. A run stopped by a `Failure` exits 130, as for
 * SIGINT.
 */
export type StopReason = StopSignal | Failure

/** Milestone 1's mode, from `--browser`: one app, named `page`, on one browser, with no config. */
export type SingleApp = { kind: 'browser'; browserPath: string; baseUrl?: string }

/**
 * A secret ready for the run: the value of an `env` source, read once when the run started, or a function
 * source's `read`, which the parent calls each time a `fill` uses the secret, with a signal aborted when the
 * fill's time runs out.
 */
export type ResolvedSecret = { readonly value: string } | { readonly read: (context: SecretContext) => Promise<string> }

/**
 * A run from a config. `baseUrls` are the command line's base URLs by app name, each replacing that app's own.
 * `secrets` holds every secret the config declares, resolved in this process before any test runs; no value
 * ever reaches a test file's process.
 */
export type ConfiguredApps = {
  kind: 'config'
  config: LoadedConfig
  baseUrls?: Readonly<Record<string, string>>
  secrets: ReadonlyMap<string, ResolvedSecret>
}

export type RunApps = SingleApp | ConfiguredApps

/** A `--tag` expression, parsed: tags joined by `and`, `or` and `not`, with parentheses. */
export type TagExpression =
  | { kind: 'tag'; tag: string }
  | { kind: 'not'; operand: TagExpression }
  | { kind: 'and' | 'or'; left: TagExpression; right: TagExpression }

/**
 * A `file:line` from the command line, or `file:line#row` for one row of a `test.for`, counted from 1. `file` is
 * POSIX and relative to the root directory.
 */
export type FileLine = { file: string; line: number; row?: number }

/**
 * Which of the collected tests run. A test runs when it passes every filter given:
 *
 * - `grep`: a substring of its full title (`testTitle`), or a pattern that matches it.
 * - `tags`: its tags satisfy the expression.
 * - `locations`: a file named with lines keeps only the tests, `test.for` rows and `test.describe` blocks
 *   declared on those lines, and a line with a row keeps only that row; a file named without a line keeps all
 *   of its tests.
 * - `lastFailed`: the tests `.retest/last-run.json` recorded, each for the variant it recorded.
 * - `targets`: a variant runs when it uses the named target for every app named, as `--target web=beta` asks.
 *
 * A selection that keeps no test is a usage failure that says why.
 */
export type Selection = {
  grep?: string | RegExp
  tags?: TagExpression
  locations?: FileLine[]
  lastFailed?: LastRunTest[]
  targets?: Variant
}

export type RunOptions = {
  files: string[]
  rootDir: string
  /** The apps and browsers tests run in. */
  apps: RunApps
  /** The budgets after the config's and the command line's are laid over the defaults. */
  timeouts: Timeouts
  /** The budgets the command line gave, which a printed rerun command repeats; absent when there was no command line. */
  commandLineTimeouts?: Partial<Timeouts>
  outputDir: string
  /** False shows every browser, as `--headed` asks; true leaves each target's own setting, headless by default. */
  headless: boolean
  /** Absent runs every test in `files`. */
  selection?: Selection
  /** Aborted to stop the run. Its reason is a `StopReason`: 'SIGINT', 'SIGTERM' or a `Failure` that says why. */
  signal: AbortSignal
  /** Receives each test file's stdout and stderr as it arrives. The run folder keeps a copy either way. */
  onOutput?: (output: ChildOutput) => void
  /**
   * Checks the parent runs after a test's body, keyed by test id (`testId(file, title)`) or by file, POSIX and
   * relative to the root as `run.started` lists it. A file's checks apply to every test collected from it, and
   * come before a test's own. A test passes only if its checks pass. A key that names no selected test and no
   * file a selected test comes from is a usage failure before any test runs.
   */
  hostChecks?: Readonly<Record<string, readonly HostCheck[]>>
  /** The test process's whole environment. Absent: the parent's, without the variables secrets read. */
  testEnvironment?: Readonly<Record<string, string>>
  /**
   * Where the run records the tests it did not pass, which `--last-failed` reads: a path, resolved from the
   * current directory as `outputDir` is, or false to record nothing. Absent: `.retest/last-run.json` under
   * `rootDir`.
   */
  lastRunFile?: string | false
}

export type ChildOutput = { file: string; stream: 'stdout' | 'stderr'; text: string }

/**
 * `config` gives each test its apps and variants, and checks them, as a run from it would; without it, collection
 * is milestone 1's.
 */
export type CollectOptions = {
  files: string[]
  rootDir: string
  timeouts: Pick<Timeouts, 'collection'>
  config?: LoadedConfig
  selection?: Selection
}

/**
 * What collection found in one file. A file that failed collection has a failure and no tests; one whose
 * process failed after its tests were collected keeps them, with a failure.
 */
export type CollectedFile = { file: string; collection: 'ok' | 'failed'; failure?: Failure; tests: CollectedTest[] }

/** Every selected file, in order. Collecting never launches a browser. */
export type CollectResult = { files: CollectedFile[] }
