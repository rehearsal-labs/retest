import type { LoadedAdapter, LoadedEvaluation, LoadedJudge, MakeEvaluator } from '../config/read-evaluation.ts'
import type { LoadedSecretSource } from '../config/loaded.ts'
import type { EvidenceKind } from '../protocol/evaluation.ts'
import type { Redactor } from '../runner/redactor.ts'
import type { EvaluationRequest, EvaluatorIdentity } from './contract.ts'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { elapsedMs, monotonicClock } from '../protocol/deadline.ts'
import { errorMessage } from '../protocol/failures.ts'
import { isPlainObject } from '../protocol/schema.ts'
import { bounded } from '../runner/bounded.ts'

/** Asks a judge one request. What it answers is the project's value, unchecked until the parent reads it. */
export type JudgeCall = (request: EvaluationRequest) => Promise<unknown>

/** A judge ready for checks, with the identity it gave, or why it could not be made. */
export type PreparedJudge = { ok: true; call: JudgeCall; identity: EvaluatorIdentity; close?: () => unknown } | { ok: false; problem: string }

/** The judge a check names, or the reason it names none Retest can use. */
export type FoundJudge = { ok: true; judge: LoadedJudge } | { ok: false; problem: string }

export type JudgesOptions = {
  evaluation: LoadedEvaluation | undefined
  redactor: Redactor
  /** The environment `env` credentials are read from: the parent's own. */
  env: Readonly<Record<string, string | undefined>>
}

/** The shortest credential Retest takes. A shorter one would turn up inside ordinary text, which then could not be redacted. */
const minCredentialLength = 4
const maxIdentityLength = 200

/**
 * The environment variables the judges' credentials are read from, each once. A run leaves them out of the environment
 * it gives its test file processes, app servers and browsers, as `doctor` and `list` do for the ones they start.
 *
 * @example judgeVariables(config.evaluation) // ['RETEST_EVALUATION_ANTHROPIC_KEY']
 */
export function judgeVariables(evaluation: LoadedEvaluation | undefined): string[] {
  const judges = [...(evaluation?.judges.values() ?? [])]
  return [...new Set(judges.flatMap((judge) => [...judge.credentials.values()].flatMap((source) => ('env' in source ? [source.env] : []))))]
}

/**
 * Teaches the redactor every judge credential an environment variable holds, named `<judge>.<credential>`. A
 * function's credential is taught only when it is read, as a check reads it.
 *
 * @example learnJudgeCredentials({ evaluation: config.evaluation, env: process.env, redactor })
 */
export function learnJudgeCredentials({ evaluation, env, redactor }: JudgesOptions): void {
  for (const judge of evaluation?.judges.values() ?? []) {
    for (const [name, source] of judge.credentials) {
      const value = 'env' in source && Object.hasOwn(env, source.env) ? env[source.env] : undefined
      if (value !== undefined && value.length >= minCredentialLength) redactor.learn(`${judge.name}.${name}`, value)
    }
  }
}

/**
 * The run's judges. Each is made once, the first time a check names it: its credentials are read in this process, its
 * adapter is loaded here, never in a test file's process, and its factory is called with the credentials, its options
 * and a signal aborted when the run ends. Every later check gets the same evaluator, or the same reason it could not be
 * made: nothing is tried again. Each credential is taught to the redactor before it goes anywhere, so a provider that
 * echoes one has it hidden in every record.
 */
export class Judges {
  readonly #evaluation: LoadedEvaluation | undefined
  readonly #redactor: Redactor
  readonly #env: Readonly<Record<string, string | undefined>>
  readonly #prepared = new Map<string, Promise<PreparedJudge>>()
  readonly #ending = new AbortController()
  #closing: Promise<void> | undefined

  constructor(options: JudgesOptions) {
    this.#evaluation = options.evaluation
    this.#redactor = options.redactor
    this.#env = options.env
    // Taught before any page, server or check could show a credential, whether or not a check ever uses its judge.
    learnJudgeCredentials(options)
  }

  /** The environment variables the judges' credentials are read from, as `judgeVariables` gives them. */
  get variables(): string[] {
    return judgeVariables(this.#evaluation)
  }

  /**
   * The judge `name` names, or without a name the default judge.
   *
   * @example judges.find('visual')
   */
  find(name: string | undefined): FoundJudge {
    const evaluation = this.#evaluation
    if (evaluation === undefined || evaluation.judges.size === 0) {
      return { ok: false, problem: 'This run has no judges. Declare one under evaluation.judges in retest.config.ts.' }
    }
    const chosen = name ?? evaluation.defaultJudge
    if (chosen === undefined) return { ok: false, problem: `The check names no judge, and the config has several and no evaluation.defaultJudge. Name one of ${[...evaluation.judges.keys()].join(', ')}.` }
    const judge = evaluation.judges.get(chosen)
    if (judge === undefined) return { ok: false, problem: `The config has no judge ${JSON.stringify(chosen)}. It has ${[...evaluation.judges.keys()].join(', ')}.` }
    return { ok: true, judge }
  }

  /** The judge's evaluator, made on first use within the config's `timeoutMs` for each step. */
  prepare(judge: LoadedJudge): Promise<PreparedJudge> {
    const known = this.#prepared.get(judge.name)
    if (known !== undefined) return known
    const preparing = this.#make(judge)
    this.#prepared.set(judge.name, preparing)
    return preparing
  }

  /**
   * Aborts the judges' signal and closes each evaluator that was made, once, within `timeoutMs`. A failure to close is
   * ignored. A second call waits for the first.
   */
  close(timeoutMs: number): Promise<void> {
    this.#closing ??= this.#close(timeoutMs)
    return this.#closing
  }

  // A judge still being made when the run ends is waited for within the same time, so a factory or an adapter that
  // never settles cannot keep the run from ending.
  async #close(timeoutMs: number): Promise<void> {
    this.#ending.abort(new DOMException('The run has ended.', 'AbortError'))
    const started = monotonicClock()
    const made = await bounded(Promise.all([...this.#prepared.values()]), timeoutMs)
    if (made.status !== 'done') return
    const closing = made.value.flatMap((prepared) => (prepared.ok && prepared.close !== undefined ? [Promise.resolve().then(prepared.close)] : []))
    await bounded(Promise.allSettled(closing), Math.max(1, timeoutMs - elapsedMs(started)))
  }

  async #make(judge: LoadedJudge): Promise<PreparedJudge> {
    const timeoutMs = this.#evaluation?.timeoutMs ?? 1
    const credentials = await this.#credentials(judge, timeoutMs)
    if (!credentials.ok) return credentials
    const loading = await bounded(loadFactory(judge.adapter), timeoutMs, abortedPromise(this.#ending.signal))
    if (loading.status === 'timed_out') return { ok: false, problem: this.#problem(judge, `its adapter ${describeAdapter(judge.adapter)} did not load within ${timeoutMs} ms`) }
    if (loading.status === 'stopped') return { ok: false, problem: this.#problem(judge, 'the run ended first') }
    if (loading.status === 'failed') return { ok: false, problem: this.#problem(judge, `could not load its adapter: ${errorMessage(loading.error)}`) }
    const factory = loading.value
    if (!factory.ok) return { ok: false, problem: this.#problem(judge, `could not load its adapter: ${factory.problem}`) }
    const setup = { judge: judge.name, credentials: Object.freeze(credentials.values), options: judge.options, accepts: judge.accepts, signal: this.#ending.signal }
    const making = Promise.resolve().then(() => factory.make(setup))
    const made = await bounded(making, timeoutMs, abortedPromise(this.#ending.signal))
    if (made.status === 'timed_out') return { ok: false, problem: this.#problem(judge, `its factory did not finish within ${timeoutMs} ms`) }
    if (made.status === 'stopped') return { ok: false, problem: this.#problem(judge, 'the run ended first') }
    if (made.status === 'failed') return { ok: false, problem: this.#problem(judge, `its factory failed: ${errorMessage(made.error)}`) }
    const evaluator = readEvaluator(made.value)
    if (typeof evaluator === 'string') return { ok: false, problem: this.#problem(judge, evaluator) }
    return { ok: true, ...evaluator }
  }

  async #credentials(judge: LoadedJudge, timeoutMs: number): Promise<{ ok: true; values: Record<string, string> } | { ok: false; problem: string }> {
    const values: Record<string, string> = {}
    for (const [name, source] of judge.credentials) {
      const read = await this.#credential(judge.name, name, source, timeoutMs)
      if (typeof read !== 'string') return read
      this.#redactor.learn(`${judge.name}.${name}`, read)
      values[name] = read
    }
    return { ok: true, values }
  }

  // A value is checked before it is used; no message ever quotes one.
  async #credential(judge: string, name: string, source: LoadedSecretSource, timeoutMs: number): Promise<string | { ok: false; problem: string }> {
    const label = `The credential ${name} of the judge ${JSON.stringify(judge)}`
    if ('env' in source) {
      const value = Object.hasOwn(this.#env, source.env) ? this.#env[source.env] : undefined
      if (value === undefined || value === '') return { ok: false, problem: `${label} reads ${source.env}, which is ${value === undefined ? 'not set' : 'empty'}. Set it in the environment that runs Retest.` }
      return value.length < minCredentialLength ? { ok: false, problem: `${label}, read from ${source.env}, is shorter than ${minCredentialLength} characters, too short to redact safely.` } : value
    }
    const reading = new AbortController()
    const read = await bounded(
      Promise.resolve().then(() => source.read({ signal: reading.signal })),
      timeoutMs,
      abortedPromise(this.#ending.signal),
    )
    if (read.status === 'done' && read.value.length >= minCredentialLength) return read.value
    reading.abort(new DOMException(`Retest stopped reading ${name}.`, read.status === 'timed_out' ? 'TimeoutError' : 'AbortError'))
    if (read.status === 'done') return { ok: false, problem: `${label} is shorter than ${minCredentialLength} characters, too short to redact safely.` }
    if (read.status === 'timed_out') return { ok: false, problem: `${label} was not read within ${timeoutMs} ms.` }
    if (read.status === 'stopped') return { ok: false, problem: `${label} was not read: the run ended first.` }
    return { ok: false, problem: `Retest could not read ${label.charAt(0).toLowerCase()}${label.slice(1)}: ${this.#redactor.redact(errorMessage(read.error))}` }
  }

  #problem(judge: LoadedJudge, detail: string): string {
    return this.#redactor.redact(`The judge ${JSON.stringify(judge.name)} could not be set up: ${detail}`)
  }
}

/** Whether a judge takes a kind of evidence. A judge takes only what its `accepts` lists: nothing stands in for an image. */
export function judgeAccepts(judge: LoadedJudge, kind: EvidenceKind): boolean {
  return judge.accepts.includes(kind)
}

type LoadedFactory = { ok: true; make: MakeEvaluator } | { ok: false; problem: string }

function describeAdapter(adapter: LoadedAdapter): string {
  if (adapter.kind === 'file') return adapter.path
  return adapter.kind === 'package' ? adapter.specifier : 'function'
}

// A file is imported by its path; a package is resolved from the config's folder, as the project resolves it, so the
// judge's own dependencies come from the project too.
async function loadFactory(adapter: LoadedAdapter): Promise<LoadedFactory> {
  if (adapter.kind === 'factory') return { ok: true, make: adapter.factory }
  let module: unknown
  try {
    const path = adapter.kind === 'file' ? adapter.path : createRequire(adapter.from).resolve(adapter.specifier)
    module = await import(pathToFileURL(path).href)
  } catch (error) {
    return { ok: false, problem: errorMessage(error) }
  }
  const made = isPlainObject(module) ? module['default'] : undefined
  if (typeof made !== 'function') {
    const name = adapter.kind === 'file' ? adapter.path : adapter.specifier
    return { ok: false, problem: `${name} has no default export that makes a judge. Export a function that takes the setup and returns an evaluator.` }
  }
  return { ok: true, make: (setup) => made(setup) }
}

type ReadEvaluator = { call: JudgeCall; identity: EvaluatorIdentity; close?: () => unknown }

// What a factory returns is the project's object; Retest keeps a frozen copy of its identity and calls `evaluate` on it.
function readEvaluator(value: unknown): ReadEvaluator | string {
  if (typeof value !== 'object' || value === null) return `its factory returned ${value === null ? 'null' : typeof value}, not an evaluator`
  const evaluate: unknown = Reflect.get(value, 'evaluate')
  const close: unknown = Reflect.get(value, 'close')
  if (typeof evaluate !== 'function') return 'the evaluator its factory returned has no evaluate function'
  if (close !== undefined && typeof close !== 'function') return 'the evaluator its factory returned has a close that is not a function'
  const identity = readIdentity(Reflect.get(value, 'identity'))
  if (typeof identity === 'string') return identity
  const call: JudgeCall = async (request) => {
    const answer: unknown = await Reflect.apply(evaluate, value, [request])
    return answer
  }
  if (typeof close !== 'function') return { call, identity }
  return { call, identity, close: (): unknown => Reflect.apply(close, value, []) }
}

function readIdentity(value: unknown): EvaluatorIdentity | string {
  if (!isPlainObject(value)) return 'the evaluator has no identity: give { provider, model, version }'
  const text = (key: string): string | undefined => {
    const found = value[key]
    return typeof found === 'string' && found.trim() !== '' && found.length <= maxIdentityLength ? found : undefined
  }
  const provider = text('provider')
  const model = text('model')
  const version = text('version')
  if (provider === undefined || model === undefined || version === undefined) return 'the evaluator identity needs provider, model and version, each a short text'
  const promptVersion = value['promptVersion'] === undefined ? undefined : text('promptVersion')
  if (value['promptVersion'] !== undefined && promptVersion === undefined) return 'the evaluator identity has a promptVersion that is not a short text'
  const sampling = readSampling(value['sampling'])
  if (typeof sampling === 'string') return sampling
  return Object.freeze({ provider, model, version, ...(promptVersion === undefined ? {} : { promptVersion }), ...(sampling === undefined ? {} : { sampling }) })
}

function readSampling(value: unknown): EvaluatorIdentity['sampling'] | string {
  if (value === undefined) return undefined
  if (!isPlainObject(value)) return 'the evaluator identity has sampling that is not an object'
  const sampling: { temperature?: number; topP?: number; seed?: number } = {}
  for (const [key, setting] of Object.entries(value)) {
    if (setting === undefined) continue
    if (typeof setting !== 'number' || !Number.isFinite(setting)) return `the evaluator identity has sampling.${key} that is not a number`
    if (key === 'temperature') sampling.temperature = setting
    else if (key === 'topP') sampling.topP = setting
    else if (key === 'seed' && Number.isInteger(setting)) sampling.seed = setting
    else return `the evaluator identity has sampling.${key}, which Retest does not record`
  }
  return Object.freeze(sampling)
}

function abortedPromise(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
}
