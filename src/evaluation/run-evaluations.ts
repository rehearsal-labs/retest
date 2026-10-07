import type { LoadedConfig } from '../config/loaded.ts'
import type { LoadedEvaluation } from '../config/read-evaluation.ts'
import type { EvaluationRecord, HostEvaluation, HostEvaluationRecord } from '../protocol/evaluation.ts'
import type { Failure } from '../protocol/failures.ts'
import type { PlannedTest } from '../runner/plan.ts'
import type { Redactor } from '../runner/redactor.ts'
import type { AppPage, PagesContext } from '../runner/test-pages.ts'
import type { AttemptHostCheck } from './attempt.ts'
import type { AttemptDiagnosticsView } from './diagnostics-evidence.ts'
import type { AttemptRecordings } from './frames.ts'
import { withCriterionRequirement, hostCriteria, hostEvaluationProblems, hostEvaluationRecord, hostEvidence } from '../protocol/evaluation.ts'
import { failure, failureSchema } from '../protocol/failures.ts'
import { hostChecksFor, unmatchedHostCheckKeys } from '../protocol/host-check.ts'
import { formatPath, isArray, isPlainObject, parse } from '../protocol/schema.ts'
import { isOurs } from '../runner/outcome.ts'
import { AttemptEvaluations } from './attempt.ts'
import { CallBudget, defaultEvaluationLimits } from './budget.ts'
import { sha256 } from './evidence.ts'
import { evidenceKindOf, Judges } from './judges.ts'

/** Host checks by test id or by file, as `RunOptions.hostEvaluations` gives them. */
export type HostEvaluations = Readonly<Record<string, readonly HostEvaluation[]>>

export type RunEvaluationsOptions = {
  config: LoadedConfig | undefined
  /** The host's checks, unchecked: their shape is read here before anything else. */
  hostEvaluations: unknown
  redactor: Redactor
  /** The environment `env` credentials are read from: the parent's own. */
  env: Readonly<Record<string, string | undefined>>
}

/**
 * What an attempt's checks need from the run: the attempt's pages and how it records, the host checks it has, the
 * run's signal, aborted when the run is interrupted, and, from a run that has them, the attempt's recordings and a view
 * of what its diagnostics have kept so far.
 */
export type AttemptSetup = {
  context: PagesContext
  pages: readonly AppPage[]
  hostChecks: readonly AttemptHostCheck[]
  runSignal: AbortSignal
  recordings?: AttemptRecordings | undefined
  diagnostics?: AttemptDiagnosticsView | undefined
}

/**
 * The run's AI checks: its judges, made once each and shared by every file worker, the call budget the parent holds for
 * all of them, and the host's checks. Credentials are read in this process. The variables they are read from are left
 * out of the environment the run gives its test file processes, app servers and browsers; a start command that loads
 * them again, from a shell profile or a `.env` file, brings them back.
 */
export class RunEvaluations {
  /** What is wrong with the shape of the host's checks, as one usage failure; the run refuses them before it loads anything. */
  readonly shapeProblem: Failure | undefined
  readonly #evaluation: LoadedEvaluation | undefined
  readonly #judges: Judges
  readonly #budget: CallBudget
  readonly #host: HostEvaluations | undefined

  constructor(options: RunEvaluationsOptions) {
    this.#evaluation = options.config?.evaluation
    this.#judges = new Judges({ evaluation: this.#evaluation, redactor: options.redactor, env: options.env })
    this.#budget = new CallBudget(this.#evaluation?.limits ?? defaultEvaluationLimits)
    const given = options.hostEvaluations
    this.shapeProblem = given === undefined ? undefined : usage(hostEvaluationProblems(given))
    this.#host = given === undefined || this.shapeProblem !== undefined ? undefined : readHostEvaluations(given)
  }

  /** The environment variables the judges' credentials are read from, which the run leaves out of the environments it gives. */
  get hiddenVariables(): string[] {
    return this.#judges.variables
  }

  /** The host's checks as `run.started` records them, or undefined when there are none. */
  recorded(): Record<string, HostEvaluationRecord[]> | undefined {
    if (this.#host === undefined) return undefined
    return Object.fromEntries(Object.entries(this.#host).map(([key, checks]) => [key, checks.map(hostEvaluationRecord)]))
  }

  /**
   * What the run must refuse before any test starts, now that it knows its tests: a key that names none of them and no
   * file one comes from, a run with host checks and no judges, a judge the config lacks or one that does not take the
   * evidence, an app a test does not use, and an id a test has twice. A key that names a file which could not be
   * collected is left to that file's own failure.
   */
  scopeProblem(tests: readonly PlannedTest[], unloadedFiles: readonly string[]): Failure | undefined {
    const host = this.#host
    if (host === undefined) return undefined
    const unloaded = (key: string): boolean => unloadedFiles.some((file) => key === file || key.startsWith(`${file} > `))
    const keys = unmatchedHostCheckKeys(host, tests).filter((key) => !unloaded(key)).map((key) => `${path([key])}: names no test this run will run, and no file one comes from.`)
    return usage([...keys, ...this.#checkProblems(host, tests)])
  }

  /** A test's host checks, the file's first, each with the evidence it names. */
  hostChecksFor(test: PlannedTest): AttemptHostCheck[] {
    if (this.#host === undefined) return []
    return hostChecksFor(this.#host, test).map((check) => ({
      id: check.id,
      ...(check.judge === undefined ? {} : { judge: check.judge }),
      criteria: hostCriteria(check.criteria),
      ...(check.context === undefined ? {} : { context: check.context }),
      evidence: hostEvidence(check.evidence),
      ...(check.timeoutMs === undefined ? {} : { timeoutMs: check.timeoutMs }),
    }))
  }

  /** The checks of one attempt, sharing the run's judges and budget. */
  attempt({ context, pages, hostChecks, runSignal, recordings, diagnostics }: AttemptSetup): AttemptEvaluations {
    return new AttemptEvaluations({ context, pages, evaluation: this.#evaluation, judges: this.#judges, budget: this.#budget, hostChecks, runSignal, recordings, diagnostics })
  }

  /** Ends the judges: their signal is aborted and each evaluator closed, within `timeoutMs`. */
  close(timeoutMs: number): Promise<void> {
    return this.#judges.close(timeoutMs)
  }

  #checkProblems(host: HostEvaluations, tests: readonly PlannedTest[]): string[] {
    const evaluation = this.#evaluation
    if (evaluation === undefined || evaluation.judges.size === 0) return ['hostEvaluations: the config declares no judges under evaluation.judges, so no check can run.']
    const problems: string[] = []
    for (const [key, checks] of Object.entries(host)) {
      const covered = tests.filter((test) => test.testId === key || test.file === key)
      for (const [index, check] of checks.entries()) {
        const at = (...rest: (string | number)[]): string => path([key, index, ...rest])
        const name = check.judge ?? evaluation.defaultJudge
        const judge = name === undefined ? undefined : evaluation.judges.get(name)
        if (name === undefined) problems.push(`${at('judge')}: the config has several judges and no evaluation.defaultJudge. Name one.`)
        else if (judge === undefined) problems.push(`${at('judge')}: the config has no judge ${JSON.stringify(name)}.`)
        for (const selector of hostEvidence(check.evidence)) {
          const kind = evidenceKindOf(selector)
          if (judge !== undefined && !judge.accepts.includes(kind)) problems.push(`${at('evidence')}: the judge ${JSON.stringify(judge.name)} does not accept ${kind}.`)
          const app = selector.kind === 'text' ? undefined : selector.app
          const lacking = app === undefined ? undefined : covered.find((test) => !test.apps.includes(app))
          if (app !== undefined && lacking !== undefined) problems.push(`${at('evidence')}: ${JSON.stringify(app)} is not an app of ${JSON.stringify(lacking.testId)}, which uses ${lacking.apps.join(', ')}.`)
        }
      }
    }
    for (const test of tests) {
      const ids = hostChecksFor(host, test).map((check) => check.id)
      const repeated = ids.find((id, index) => ids.indexOf(id) !== index)
      if (repeated !== undefined) problems.push(`hostEvaluations: ${JSON.stringify(test.testId)} has two checks with the id ${JSON.stringify(repeated)}, from its file and its own key.`)
    }
    return problems
  }
}

/**
 * The host checks of a test that never ran, each listed as not run.
 *
 * @example notRunRecords(checks, (text) => redactor.redact(text))[0]?.verdict // 'not_run'
 */
export function notRunRecords(checks: readonly AttemptHostCheck[], redact: (text: string) => string): EvaluationRecord[] {
  return checks.map((check) => {
    const criteria = check.criteria.map((criterion) => withCriterionRequirement(criterion, redact(criterion.requirement)))
    const context = check.context === undefined ? undefined : redact(check.context)
    return {
      checkId: check.id,
      source: 'host',
      mode: 'required',
      ...(check.judge === undefined ? {} : { judge: check.judge }),
      verdict: 'not_run',
      criteria,
      ...(context === undefined ? {} : { context }),
      criteriaSha256: sha256(JSON.stringify({ criteria, context: context ?? null })),
      evidence: [],
      durationMs: 0,
    }
  })
}

/** What decides a test's failure once its AI checks are over. */
export type TestFailures = {
  /** The failure the body ended with, as the test file's process reported it or the parent stopped it. */
  reported: Failure | undefined
  /** The failures of the attempt's required AI checks, from the parent's own records. */
  recorded: readonly Failure[]
  /** The failures the parent saw for itself while the body and its host checks ran, as `BodyReport.observed` lists them. */
  observed: readonly Failure[]
}

/**
 * The test's failure, decided so that the test file's process can never soften what the parent saw: it cannot turn a
 * failed check into an error, an undecided result or a pass. The candidates to lead are every failure the parent saw
 * for itself (`observed`: a page command's failed answer, a check that failed on a look it served, a refusal it gave,
 * its own stop), its AI check records, and every failure the process reports that fails the test rather than leaving
 * it undecided or in error, such as a failed `expect` or `not_awaited`, since such a claim can only make the test fail.
 * With none of those, the reported failure stands, since a process may always fail its own test. A failure comes
 * first, then an undecided check, then any other, whatever order they happened in; within one rank what the parent saw
 * comes before what the process only claims. The lead sets the status, the counts and the exit code. A class the
 * process reports that is not a failure, such as `session_lost` or `interrupted`, is appended to `details.also` and
 * never leads. An AI check outcome the process reports is never its own to make: one the parent recorded or refused
 * itself is already among the parent's failures, and any other is an error of the test, kept with the process's words.
 *
 * @example withEvaluationFailures({ reported: report.failure, recorded: await evaluations.failures(), observed: report.observed ?? [] })
 */
export function withEvaluationFailures({ reported, recorded, observed }: TestFailures): Failure | undefined {
  const claimed = reported === undefined ? undefined : withoutAlso(reported)
  const seen = (candidate: Failure): boolean => observed.some((each) => sameFailure(each, candidate))
  const reportedLead = claimed !== undefined && evaluationClasses.has(claimed.class) && recorded.length === 0 && !seen(claimed) ? disowned(claimed) : claimed
  const laterLines = (reported === undefined ? [] : alsoLines(reported)).filter((line) => !evaluationClasses.has(lineClass(line)))
  const failsTheTest = (candidate: Failure): boolean => !evaluationClasses.has(candidate.class) && precedence(candidate) === 0
  const reportedFailures = [...(reportedLead === undefined ? [] : [reportedLead]), ...laterLines.flatMap(lineFailure)]
  // What the parent saw comes before what the process only claims, so among failures of one rank the parent's leads.
  const candidates = unique([...reportedFailures.filter(seen), ...observed, ...recorded, ...reportedFailures.filter(failsTheTest)])
  if (candidates.length === 0) return reportedLead === undefined ? undefined : withLines(reportedLead, laterLines)
  const [lead, ...rest] = [...candidates].sort((first, second) => precedence(first) - precedence(second))
  if (lead === undefined) return reportedLead
  const listed = new Set(candidates.map(failureLine))
  const claimedLine = reportedLead === undefined || listed.has(failureLine(reportedLead)) || evaluationClasses.has(reportedLead.class) ? [] : [failureLine(reportedLead)]
  return withLines(lead, [...rest.map(failureLine), ...claimedLine, ...laterLines.filter((line) => !listed.has(line))])
}

const evaluationClasses: ReadonlySet<string> = new Set(['evaluation_failed', 'evaluation_inconclusive', 'evaluation_error'])

// An AI check outcome the parent neither recorded nor refused is the process's claim alone, so it cannot carry the
// status that outcome would give; its words are kept.
function disowned(claimed: Failure): Failure {
  return { ...claimed, class: 'test_error', message: `The test process reported ${claimed.class} for an AI check the parent did not record: ${claimed.message}` }
}

// The status a failure gives its test, as `testStatus` decides it: the application failing first, then undecided.
function precedence(failure: Failure): number {
  if (failure.class === 'evaluation_inconclusive') return 1
  return isOurs(failure) ? 2 : 0
}

// One of ours written twice, once with more said, as a stop whose process then had to be ended, is one failure.
function sameFailure(first: Failure, second: Failure): boolean {
  if (first.class !== second.class) return false
  return first.message === second.message || (isOurs(first) && (first.message.startsWith(second.message) || second.message.startsWith(first.message)))
}

function unique(failures: readonly Failure[]): Failure[] {
  return failures.filter((each, index) => failures.findIndex((other) => sameFailure(other, each)) === index)
}

function failureLine(failure: Failure): string {
  return `${failure.class}: ${failure.message}`
}

function lineClass(line: string): string {
  return line.slice(0, Math.max(0, line.indexOf(': ')))
}

// A later failure as `withAlso` wrote it, when the line names a class Retest knows.
function lineFailure(line: string): Failure[] {
  const read = parse(failureSchema, { class: lineClass(line), message: line.slice(line.indexOf(': ') + 2) })
  return read.ok ? [read.value] : []
}

// The later failures a test reported, one line each, as `withAlso` writes them.
function alsoLines(reported: Failure): string[] {
  const also = reported.details?.['also']
  return typeof also === 'string' ? also.split('\n') : []
}

function withLines(lead: Failure, lines: readonly string[]): Failure {
  return lines.length === 0 ? lead : { ...lead, details: { ...lead.details, also: lines.join('\n') } }
}

// The reported failure's own facts, without the later failures it listed, which `alsoLines` keeps.
function withoutAlso(failure: Failure): Failure {
  const details = Object.fromEntries(Object.entries(failure.details ?? {}).filter(([key]) => key !== 'also'))
  const { class: kind, message, location } = failure
  return { class: kind, message, ...(location === undefined ? {} : { location }), ...(Object.keys(details).length === 0 ? {} : { details }) }
}

// Called once the shape is known to be right.
function readHostEvaluations(value: unknown): HostEvaluations {
  const checks: Record<string, readonly HostEvaluation[]> = {}
  if (!isPlainObject(value)) return checks
  for (const [key, list] of Object.entries(value)) if (isArray(list)) checks[key] = list.filter(isHostEvaluation)
  return checks
}

function isHostEvaluation(value: unknown): value is HostEvaluation {
  return hostEvaluationProblems({ check: [value] }).length === 0
}

function path(rest: (string | number)[]): string {
  return formatPath(['hostEvaluations', ...rest]).slice(2)
}

function usage(problems: readonly string[]): Failure | undefined {
  const [first] = problems
  if (first === undefined) return undefined
  if (problems.length === 1) return failure('usage', first)
  return failure('usage', `The host's AI checks have ${problems.length} problems:\n${problems.map((problem) => `  ${problem}`).join('\n')}`)
}
