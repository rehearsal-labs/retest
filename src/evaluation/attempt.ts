import type { LoadedEvaluation, LoadedJudge } from '../config/read-evaluation.ts'
import type { EventBody } from '../protocol/events.ts'
import type {
  Criterion,
  CriterionRecord,
  EvaluationAnswer,
  EvaluationCall,
  EvaluationMode,
  EvaluationRecord,
  EvaluationSource,
  EvaluationVerdict,
  EvaluatorRecord,
  EvidenceSelector,
} from '../protocol/evaluation.ts'
import type { Failure, SourceLocation } from '../protocol/failures.ts'
import type { AppPage, PagesContext } from '../runner/test-pages.ts'
import type { CheckedAnswer } from './answer.ts'
import type { CallBudget } from './budget.ts'
import type { EvaluationRequest } from './contract.ts'
import type { HeldEvidence } from './evidence.ts'
import type { Judges, PreparedJudge } from './judges.ts'
import type { JudgedCheck } from './policy.ts'
import { Deadline, elapsedMs, monotonicClock, smallestBudget } from '../protocol/deadline.ts'
import { errorMessage, truncateText } from '../protocol/failures.ts'
import { bounded } from '../runner/bounded.ts'
import { aggregateVerdict, readAnswer } from './answer.ts'
import { gatherEvidence, sha256 } from './evidence.ts'
import { judgeInstructions, promptVersion } from './instructions.ts'
import { judgeAccepts } from './judges.ts'
import { checkEffect } from './policy.ts'

/**
 * What the parent's side of a running test needs to serve `test.evaluate`: a check to run with the time the test has
 * left, and a way to stop every check in flight when the test is stopped.
 */
export interface EvaluationRequests {
  request(call: EvaluationCall, scope: RequestScope): Promise<EvaluationAnswer>
  cancel(reason: Failure): void
}

/** Where a check was asked for: its place in the test, its step, and the whole milliseconds the test had left. */
export type RequestScope = { location?: SourceLocation | undefined; stepId?: string | undefined; remainingMs: number }

/** A host check of this attempt, as the run gives it: its id, criteria, judge, context, evidence and own time. */
export type AttemptHostCheck = {
  id: string
  judge?: string
  criteria: Criterion[]
  context?: string
  evidence: EvidenceSelector[]
  timeoutMs?: number
}

export type AttemptEvaluationsOptions = {
  context: PagesContext
  pages: readonly AppPage[]
  evaluation: LoadedEvaluation | undefined
  judges: Judges
  budget: CallBudget
  hostChecks: readonly AttemptHostCheck[]
  /** Aborted when the run is interrupted. Each check listens to it only while it runs. */
  runSignal: AbortSignal
}

/** One check as the attempt runs it. */
type CheckSpec = {
  checkId: string
  source: EvaluationSource
  mode: EvaluationMode
  judge: string | undefined
  criteria: Criterion[]
  context: string | undefined
  evidence: EvidenceSelector[]
  timeoutMs: number
  location: SourceLocation | undefined
  stepId: string | undefined
}

/** What a check knows when it ends, before the policy reads it. */
type Ending = {
  verdict: EvaluationVerdict
  judge?: string
  reason?: string
  evidence?: HeldEvidence[]
  answer?: CheckedAnswer
  evaluator?: EvaluatorRecord
}

type Running = { stop: AbortController; spec: CheckSpec }

// How much of a provider's error a record keeps.
const reasonLength = 600

const interrupted: Failure = { class: 'interrupted', message: 'The run was interrupted.' }

/**
 * The checks of one attempt. The parent runs each itself: it captures the evidence from this attempt's pages, sets the
 * judge up, reserves the call, sends the request with no tools and a deadline, checks the answer and records the
 * verdict as an `evaluation.finished` event. What the test file's process does with the answer changes nothing here:
 * every required check that did not pass is in `failures()`. A stopped check ends `cancelled` at once, and an answer
 * that comes after that is never read.
 */
export class AttemptEvaluations implements EvaluationRequests {
  readonly #options: AttemptEvaluationsOptions
  readonly #records: EvaluationRecord[] = []
  readonly #running = new Set<Running>()
  readonly #inFlight = new Set<Promise<EvaluationRecord>>()
  #checks = 0
  #cancelled: Failure | undefined
  /** The interruption that kept the host's checks from running, which the test carries as its failure. */
  #hostStoppedBy: Failure | undefined

  constructor(options: AttemptEvaluationsOptions) {
    this.#options = options
  }

  /** Every check that ended, test checks in the order they ended, then host checks in the order given. */
  get records(): readonly EvaluationRecord[] {
    return this.#records
  }

  /**
   * Runs one of the test's own checks. Its time is its own `timeoutMs`, or the config's, cut to what the test has left.
   *
   * @example await evaluations.request(call, { location, remainingMs: 4000 })
   */
  async request(call: EvaluationCall, scope: RequestScope): Promise<EvaluationAnswer> {
    this.#checks++
    const configured = this.#options.evaluation?.timeoutMs ?? scope.remainingMs
    // A check's own time may shorten the config's and what the test has left, never lengthen either.
    const spec: CheckSpec = {
      checkId: `evaluation-${this.#checks}`,
      source: 'test',
      mode: call.mode,
      judge: call.judge,
      criteria: call.criteria,
      context: call.context,
      evidence: call.evidence,
      timeoutMs: Math.max(1, smallestBudget(call.timeoutMs ?? configured, configured, scope.remainingMs)),
      location: scope.location,
      stepId: scope.stepId,
    }
    return answerOf(await this.#check(spec))
  }

  /**
   * Stops every check in flight: each ends `cancelled` with `reason` and waits for nothing more. The test's later checks
   * end `cancelled` at once; the host's run after the body unless the run itself was interrupted.
   */
  cancel(reason: Failure): void {
    this.#cancelled ??= reason
    for (const running of this.#running) running.stop.abort(reason)
  }

  /**
   * Runs the host's checks after the body, in order, each with its own time, never more than the config's. A run that
   * is stopped ends the check in flight `cancelled` and lists the rest as not run, and the interruption becomes the
   * test's failure, as a host check of a page that an interruption stops makes it: a test whose required check never
   * ran never passes.
   */
  async runHostChecks(): Promise<void> {
    const configured = this.#options.evaluation?.timeoutMs ?? 1
    for (const check of this.#options.hostChecks) {
      const interruption = this.#options.context.interruption()
      if (interruption !== undefined) {
        this.#hostStoppedBy ??= interruption
        this.#recordNotRun(check)
        continue
      }
      await this.#check({
        checkId: check.id,
        source: 'host',
        mode: 'required',
        judge: check.judge,
        criteria: check.criteria,
        context: check.context,
        evidence: check.evidence,
        timeoutMs: smallestBudget(check.timeoutMs ?? configured, configured),
        location: undefined,
        stepId: undefined,
      })
    }
  }

  /** Lists every host check as not run: the test failed or stopped before the parent's checks. */
  skipHostChecks(): void {
    for (const check of this.#options.hostChecks) this.#recordNotRun(check)
  }

  /**
   * The failures of every required check that did not pass, once every check still in flight has ended, so the
   * verdict never rests on which answer came first: the order of the checks' ends, then the interruption that kept the
   * host's checks from running. A check in flight here has been stopped already, and ends at once.
   */
  async failures(): Promise<Failure[]> {
    await Promise.allSettled([...this.#inFlight])
    const failures = this.#records.flatMap((record) => (record.failure === undefined ? [] : [record.failure]))
    return this.#hostStoppedBy === undefined ? failures : [...failures, this.#hostStoppedBy]
  }

  #check(spec: CheckSpec): Promise<EvaluationRecord> {
    const checking = this.#runCheck(spec)
    this.#inFlight.add(checking)
    void checking.finally(() => this.#inFlight.delete(checking))
    return checking
  }

  // The check listens to the run's interruption only while it runs, so an attempt that has ended keeps nothing alive.
  async #runCheck(spec: CheckSpec): Promise<EvaluationRecord> {
    const { context, runSignal } = this.#options
    const startedAt = monotonicClock()
    const running: Running = { stop: new AbortController(), spec }
    const stopOnInterruption = (): void => running.stop.abort(context.interruption() ?? interrupted)
    runSignal.addEventListener('abort', stopOnInterruption, { once: true })
    const stopped = spec.source === 'test' ? this.#cancelled : context.interruption()
    if (stopped !== undefined) running.stop.abort(stopped)
    else if (runSignal.aborted) stopOnInterruption()
    this.#running.add(running)
    let ending: Ending
    try {
      ending = await this.#judge(spec, running.stop.signal)
    } catch (error) {
      ending = { verdict: 'error', reason: `Retest failed while it ran the check: ${errorMessage(error)}` }
    } finally {
      this.#running.delete(running)
      runSignal.removeEventListener('abort', stopOnInterruption)
    }
    return this.#record(spec, ending, elapsedMs(startedAt))
  }

  // Each step stops at once when the check is stopped, and every wait counts against the check's own time.
  async #judge(spec: CheckSpec, signal: AbortSignal): Promise<Ending> {
    const { judges, budget, context, pages } = this.#options
    const deadline = new Deadline(spec.timeoutMs)
    const stopped = abortedPromise(signal)
    const cancelled = (): Ending => ({ verdict: 'cancelled', reason: stopReason(signal) })
    if (signal.aborted) return cancelled()
    const found = judges.find(spec.judge)
    if (!found.ok) return { verdict: 'error', reason: found.problem }
    const { judge } = found
    const named = { judge: judge.name }
    const refusal = acceptsProblem(judge, spec.evidence)
    if (refusal !== undefined) return { ...named, verdict: 'error', reason: refusal }
    const limits = this.#limits()
    const textBytes = Buffer.byteLength(JSON.stringify(spec.criteria)) + Buffer.byteLength(spec.context ?? '')
    const gathered = await gatherEvidence(spec.evidence, { context, pages, checkId: spec.checkId, limits, timeoutMs: deadline.commandTimeoutMs, stop: stopped, textBytes })
    if (signal.aborted) return { ...named, ...cancelled(), evidence: gathered.evidence }
    if (!gathered.ok) return { ...named, verdict: gathered.problem.kind === 'missing' ? 'inconclusive' : 'error', reason: gathered.problem.reason, evidence: gathered.evidence }
    const evidence = gathered.evidence
    const wrongAttempt = attemptProblem(evidence, context.attemptId, pages)
    if (wrongAttempt !== undefined) return { ...named, verdict: 'error', reason: wrongAttempt, evidence }
    const prepared = await bounded(judges.prepare(judge), deadline.commandTimeoutMs, stopped)
    if (prepared.status === 'stopped') return { ...named, ...cancelled(), evidence }
    if (prepared.status !== 'done') return { ...named, verdict: 'error', reason: prepared.status === 'timed_out' ? `The judge ${JSON.stringify(judge.name)} was not ready within the check's ${spec.timeoutMs} ms.` : errorMessage(prepared.error), evidence }
    if (!prepared.value.ok) return { ...named, verdict: 'error', reason: prepared.value.problem, evidence }
    const slot = await budget.acquire(deadline.commandTimeoutMs, stopped)
    if (slot === 'stopped') return { ...named, ...cancelled(), evidence }
    if (slot === 'timed_out') return { ...named, verdict: 'error', reason: `No call slot came free within the check's ${spec.timeoutMs} ms (evaluation.limits.concurrentCalls is ${limits.concurrentCalls}).`, evidence }
    try {
      // A check stopped while it waited for its slot sends nothing and spends no call.
      if (signal.aborted) return { ...named, ...cancelled(), evidence }
      const reserved = budget.reserve(context.attemptId)
      if (!reserved.ok) return { ...named, verdict: 'error', reason: reserved.problem, evidence }
      return await this.#call({ spec, judge, prepared: prepared.value, evidence, deadline, signal })
    } finally {
      budget.release()
    }
  }

  async #call(call: { spec: CheckSpec; judge: LoadedJudge; prepared: Extract<PreparedJudge, { ok: true }>; evidence: HeldEvidence[]; deadline: Deadline; signal: AbortSignal }): Promise<Ending> {
    const { spec, judge, prepared, evidence, deadline, signal } = call
    const { context } = this.#options
    const limits = this.#limits()
    const named = { judge: judge.name, evidence }
    const timeoutMs = deadline.commandTimeoutMs
    const judging = new AbortController()
    const stop = (): void => judging.abort(signal.reason)
    signal.addEventListener('abort', stop, { once: true })
    if (signal.aborted) stop()
    const request: EvaluationRequest = deepFreeze({
      requestId: `${context.attemptId}:${spec.checkId}`,
      judge: judge.name,
      instructions: judgeInstructions,
      promptVersion,
      criteria: spec.criteria.map(({ id, requirement }) => ({ id, requirement: context.redact(requirement) })),
      ...(spec.context === undefined ? {} : { context: context.redact(spec.context) }),
      evidence: evidence.map(judgedCopy),
      maxOutputTokens: limits.maxOutputTokens,
      timeoutMs,
      signal: judging.signal,
    })
    const startedAt = monotonicClock()
    if (judging.signal.aborted) return { ...named, verdict: 'cancelled', reason: stopReason(signal) }
    const answered = await bounded(prepared.call(request), timeoutMs, abortedPromise(signal))
    signal.removeEventListener('abort', stop)
    const latencyMs = elapsedMs(startedAt)
    const evaluator = evaluatorRecord(prepared.identity, limits.maxOutputTokens, latencyMs)
    if (answered.status === 'stopped') {
      stop()
      return { ...named, evaluator, verdict: 'cancelled', reason: stopReason(signal) }
    }
    if (answered.status === 'timed_out') {
      judging.abort(new DOMException(`The judge did not answer within ${timeoutMs} ms.`, 'TimeoutError'))
      return { ...named, evaluator, verdict: 'error', reason: `The judge did not answer within ${timeoutMs} ms.` }
    }
    if (answered.status === 'failed') return { ...named, evaluator, verdict: 'error', reason: `The judge failed: ${errorMessage(answered.error)}` }
    const reading = readAnswer(answered.value, { criteria: spec.criteria.map((criterion) => criterion.id), evidence: evidence.map((held) => held.record.id) })
    if (!reading.ok) return { ...named, evaluator, verdict: 'error', reason: reading.problem }
    const { answer } = reading
    const verdict = aggregateVerdict(answer.criteria.map((criterion) => criterion.verdict))
    return { ...named, verdict, answer, evaluator: withAnswer(evaluator, answer) }
  }

  // Everything a record says is redacted before it is kept: the judge's words, the reasons, which may quote a provider's
  // error, and the criteria, which a host may have written with its secrets at hand.
  #record(spec: CheckSpec, ending: Ending, durationMs: number): EvaluationRecord {
    const { context } = this.#options
    const redact = (text: string): string => context.redact(text)
    const verdicts = new Map((ending.answer?.criteria ?? []).map((criterion) => [criterion.id, criterion]))
    const criteria: CriterionRecord[] = spec.criteria.map(({ id, requirement }) => {
      const judged = verdicts.get(id)
      return { id, requirement: redact(requirement), ...(judged === undefined ? {} : { verdict: judged.verdict, citations: judged.citations }) }
    })
    const recordedContext = spec.context === undefined ? undefined : redact(spec.context)
    const justification = ending.answer === undefined ? undefined : redact(ending.answer.justification)
    const reason = ending.reason === undefined ? undefined : truncateText(redact(ending.reason), reasonLength).text
    const judged: JudgedCheck = {
      checkId: spec.checkId,
      mode: spec.mode,
      verdict: ending.verdict,
      criteria,
      ...(justification === undefined ? {} : { justification }),
      ...(reason === undefined ? {} : { reason }),
      location: spec.location,
    }
    // A required check the run's interruption stopped carries that interruption itself, so the test keeps it as its
    // failure rather than an evaluation error, as a host check the interruption stopped does.
    const interruption = ending.verdict === 'cancelled' && spec.mode === 'required' ? context.interruption() : undefined
    const effect = interruption === undefined ? checkEffect(judged) : { failure: interruption }
    const record: EvaluationRecord = {
      checkId: spec.checkId,
      source: spec.source,
      mode: spec.mode,
      ...(ending.judge === undefined ? {} : { judge: ending.judge }),
      verdict: ending.verdict,
      criteria,
      ...(recordedContext === undefined ? {} : { context: recordedContext }),
      criteriaSha256: sha256(JSON.stringify({ criteria: spec.criteria.map(({ id, requirement }) => ({ id, requirement: redact(requirement) })), context: recordedContext ?? null })),
      evidence: (ending.evidence ?? []).map((held) => held.record),
      ...(justification === undefined ? {} : { justification }),
      ...(reason === undefined ? {} : { reason }),
      ...(ending.evaluator === undefined ? {} : { evaluator: redactedEvaluator(ending.evaluator, redact) }),
      ...(effect.failure === undefined ? {} : { failure: effect.failure }),
      ...(effect.warning === undefined ? {} : { warning: effect.warning }),
      durationMs,
      ...(spec.location === undefined ? {} : { location: spec.location }),
    }
    this.#records.push(record)
    const step = spec.stepId === undefined ? {} : { stepId: spec.stepId }
    const event: EventBody = { type: 'evaluation.finished', testId: context.testId, attemptId: context.attemptId, ...step, evaluation: record }
    context.emit(event)
    return record
  }

  // A host check that never ran is written as such, so a result rebuilt from the events lists it as result.json does.
  #recordNotRun(check: AttemptHostCheck): void {
    const { context } = this.#options
    const criteria = check.criteria.map(({ id, requirement }) => ({ id, requirement: context.redact(requirement) }))
    const recordedContext = check.context === undefined ? undefined : context.redact(check.context)
    const record: EvaluationRecord = {
      checkId: check.id,
      source: 'host',
      mode: 'required',
      ...(check.judge === undefined ? {} : { judge: check.judge }),
      verdict: 'not_run',
      criteria,
      ...(recordedContext === undefined ? {} : { context: recordedContext }),
      criteriaSha256: sha256(JSON.stringify({ criteria, context: recordedContext ?? null })),
      evidence: [],
      durationMs: 0,
    }
    this.#records.push(record)
    context.emit({ type: 'evaluation.finished', testId: context.testId, attemptId: context.attemptId, evaluation: record })
  }

  #limits(): LoadedEvaluation['limits'] {
    const limits = this.#options.evaluation?.limits
    if (limits === undefined) throw new Error('A check ran without an evaluation config.')
    return limits
  }
}

/**
 * The answer to a check the parent refused to start, as when its test was already stopped.
 *
 * @example refusedAnswer('required', failure('interrupted', 'The run was interrupted.')).verdict // 'cancelled'
 */
export function refusedAnswer(mode: EvaluationMode, reason: Failure): EvaluationAnswer {
  return { checkId: 'refused', mode, verdict: reason.class === 'evaluation_error' ? 'error' : 'cancelled', criteria: [], failure: reason }
}

/**
 * The answer the test file's process receives: the verdicts, and the failure or warning as the record holds them. The
 * evidence and the justification stay with the parent.
 *
 * @example answerOf(record).verdict // 'pass'
 */
export function answerOf(record: EvaluationRecord): EvaluationAnswer {
  return {
    checkId: record.checkId,
    mode: record.mode,
    verdict: record.verdict,
    criteria: record.criteria.map(({ id, verdict }) => ({ id, ...(verdict === undefined ? {} : { verdict }) })),
    ...(record.failure === undefined ? {} : { failure: record.failure }),
    ...(record.warning === undefined ? {} : { warning: record.warning }),
  }
}

// A judge takes only what it accepts: a text-only judge never receives a screenshot read out as text.
function acceptsProblem(judge: LoadedJudge, evidence: readonly EvidenceSelector[]): string | undefined {
  if (evidence.length === 0) return 'The check names no evidence.'
  if (evidence.some((selector) => selector.kind === 'recording')) return "Evidence from a recorded step needs recordings, which Retest does not make yet. Use { capture: 'screenshot' } or text."
  for (const selector of evidence) {
    const kind = selector.kind === 'text' ? 'text' : selector.kind === 'screenshot' ? 'images' : 'frames'
    if (!judgeAccepts(judge, kind)) return `The judge ${JSON.stringify(judge.name)} does not accept ${kind}: its accepts lists ${judge.accepts.join(', ')}.`
  }
  return undefined
}

// Every screenshot must come from a session of this attempt. A capture is the parent's own, so this holds by
// construction; the check keeps it true should that ever change.
function attemptProblem(evidence: readonly HeldEvidence[], attemptId: string, pages: readonly AppPage[]): string | undefined {
  for (const { record } of evidence) {
    if (record.attemptId !== attemptId) return `The evidence ${record.id} belongs to another attempt, so Retest did not send it.`
    if (record.kind === 'screenshot' && !pages.some((page) => page.session.sessionId === record.sessionId)) return `The screenshot ${record.id} came from no session of this attempt, so Retest did not send it.`
  }
  return undefined
}

function evaluatorRecord(identity: Extract<PreparedJudge, { ok: true }>['identity'], maxOutputTokens: number, latencyMs: number): EvaluatorRecord {
  return {
    provider: identity.provider,
    model: identity.model,
    evaluatorVersion: identity.version,
    promptVersion: identity.promptVersion ?? promptVersion,
    sampling: { ...identity.sampling, maxOutputTokens },
    latencyMs,
  }
}

// Every string an evaluator or its provider supplied is free text: a provider or a proxy may echo a key into any of them.
function redactedEvaluator(evaluator: EvaluatorRecord, redact: (text: string) => string): EvaluatorRecord {
  const { provider, model, modelRevision, evaluatorVersion, promptVersion: version, samplingNotSent } = evaluator
  return {
    ...evaluator,
    provider: redact(provider),
    model: redact(model),
    ...(modelRevision === undefined ? {} : { modelRevision: redact(modelRevision) }),
    evaluatorVersion: redact(evaluatorVersion),
    promptVersion: redact(version),
    ...(samplingNotSent === undefined ? {} : { samplingNotSent: samplingNotSent.map(({ setting, reason }) => ({ setting, reason: redact(reason) })) }),
  }
}

// The record keeps under `sampling` only what the call sent: a setting the answer says was not sent as given leaves it,
// and is named beside it with the provider's reason.
function withAnswer(evaluator: EvaluatorRecord, answer: CheckedAnswer): EvaluatorRecord {
  const notSent = answer.samplingNotSent ?? []
  const sampling = evaluator.sampling === undefined ? undefined : { ...evaluator.sampling }
  if (sampling !== undefined) for (const { setting } of notSent) delete sampling[setting]
  return {
    ...evaluator,
    ...(sampling === undefined ? {} : { sampling }),
    ...(notSent.length === 0 ? {} : { samplingNotSent: notSent }),
    ...(answer.modelRevision === undefined ? {} : { modelRevision: answer.modelRevision }),
    ...(answer.usage === undefined ? {} : { usage: answer.usage }),
  }
}

function stopReason(signal: AbortSignal): string {
  const reason: unknown = signal.reason
  if (typeof reason === 'object' && reason !== null && 'message' in reason && typeof reason.message === 'string') return reason.message
  return 'The check was stopped before its answer came.'
}

function abortedPromise(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
}

// A typed array cannot be frozen, so the judge gets a copy of a screenshot's bytes: the ones hashed and saved stay as
// they were.
function judgedCopy({ judged }: HeldEvidence): EvaluationRequest['evidence'][number] {
  return judged.kind === 'image' ? { ...judged, data: judged.data.slice() } : judged
}

// The request is data the judge reads, so nothing in it can be changed on the way: not the criteria, not the evidence
// list.
function deepFreeze<T extends object>(value: T): T {
  for (const item of Object.values(value)) {
    if (typeof item === 'object' && item !== null && !ArrayBuffer.isView(item) && !(item instanceof AbortSignal) && !Object.isFrozen(item)) deepFreeze(item)
  }
  return Object.freeze(value)
}
