import type { CriterionKind } from '../../src/protocol/evaluation.ts'
import type { EvaluationRequest, EvaluatorIdentity, EvaluatorSetup, JudgeAnswer } from '../../src/evaluation/contract.ts'
import { appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { createHash } from 'node:crypto'
import { decodePng } from '../../src/native/png.ts'

/**
 * How the fake answers a request. It reads the behaviour from the request's first criterion id, so a test file picks
 * it by naming its criterion `pass`, `fail` and so on, and every other id gets `options.default`, `pass` unless given.
 *
 * - `pass`, `fail`, `inconclusive`: a valid answer with that verdict for every criterion, citing `e1`.
 * - `mixed`: the first criterion passes and every other is inconclusive.
 * - `malformed`: an answer of the wrong shape. `missing`: one that leaves out a criterion. `cite-unknown`: one that
 *   cites evidence it was never given. `confidence`: a passing answer with a self-reported confidence beside it.
 * - `throw`: rejects with an error that quotes its API key, as a provider error may.
 * - `echo-secret`: passes with a justification that quotes its API key.
 * - `hang`: never answers and ignores the signal.
 * - `late`: answers a pass only after the request's signal aborts, 50 ms after it, or with `options.holdLate` only once
 *   `releaseLate` lets it go. With `options.markers`, a folder, it writes `late-received` there as the call arrives and
 *   `late-answered` once it has answered, which a test file's process can wait for.
 * - `slow`: waits `options.delayMs`, 200 by default, then passes. `slow-fail` waits the same, then fails.
 * - `echo-revision`: passes, naming as its model revision a string that quotes its API key, as a proxy might.
 * - `pixel-hash`: decodes PNG pixels and looks up their SHA-256 in `options.pixelHashes`; text cannot change it.
 */
export type FakeBehaviour =
  | 'pass'
  | 'fail'
  | 'inconclusive'
  | 'mixed'
  | 'malformed'
  | 'missing'
  | 'cite-unknown'
  | 'confidence'
  | 'throw'
  | 'echo-secret'
  | 'hang'
  | 'late'
  | 'slow'
  | 'slow-fail'
  | 'echo-revision'
  | 'pixel-hash'

/** One request as the fake saw it. `tag` is the judge's `options.tag`, which tells apart runs that share this process. */
export type FakeCall = {
  tag: string | undefined
  judge: string
  behaviour: FakeBehaviour
  criteria: { id: string; kind?: CriterionKind; requirement: string; absence?: true }[]
  context: string | undefined
  instructions: string
  promptVersion: string
  evidence: { id: string; kind: string; text?: string; bytes?: number; app?: string; width?: number; height?: number }[]
  /** The frame sequences the request held, each frame by its id, size, bytes and time, and the stretches named. */
  frames: { id: string; app: string; step?: string; complete: boolean; omitted: number; frames: { id: string; mediaType: string; bytes: number; sha256: string; width: number; height: number; atMs: number }[]; stretches: { fromMs: number; toMs: number; why: string }[] }[]
  /** Every key of the request, which carries data and a signal, never a function or a handle on the app. */
  keys: string[]
  functions: string[]
  maxOutputTokens: number
  timeoutMs: number
  /** How many calls this judge had in flight, this one included, when it started. */
  concurrent: number
  /** Set once a `late` call answered after its signal aborted. */
  lateReply?: boolean
  /** When the fake handed its answer back, in milliseconds since the epoch. */
  answeredAt?: number
}

/**
 * The fake as its factory makes it. Its answers may break the contract on purpose, so `evaluate` promises nothing
 * about them: the parent reads whatever comes back, as it must from any judge.
 */
export type FakeEvaluator = { identity: EvaluatorIdentity; evaluate: (request: EvaluationRequest) => Promise<unknown> }

/** The setups the fake's factory received in this process: the judge's name, its credential names and values, and its options. */
export type FakeSetup = { tag: string | undefined; judge: string; credentials: Record<string, string>; options: Record<string, unknown> }

const behaviours: readonly FakeBehaviour[] = ['pass', 'fail', 'inconclusive', 'mixed', 'malformed', 'missing', 'cite-unknown', 'confidence', 'throw', 'echo-secret', 'hang', 'late', 'slow', 'slow-fail', 'echo-revision', 'pixel-hash']

/** Every call the fake answered or was asked in this process, in order. A test that runs in-process reads it directly. */
export const fakeCalls: FakeCall[] = []
export const fakeSetups: FakeSetup[] = []

/** Forgets every call and setup seen so far. */
export function resetFake(): void {
  fakeCalls.length = 0
  fakeSetups.length = 0
}

const lateGates = new Map<string, PromiseWithResolvers<void>>()

function lateGate(tag: string | undefined): PromiseWithResolvers<void> {
  const known = lateGates.get(tag ?? '')
  if (known !== undefined) return known
  const made = Promise.withResolvers<void>()
  lateGates.set(tag ?? '', made)
  return made
}

/** Lets every held `late` answer of the judges tagged `tag` go, as a test does once it has seen the check stopped. */
export function releaseLate(tag: string): void {
  lateGate(tag).resolve()
}

/**
 * The fake judge's factory, the module's default export as an adapter. `options.log` names a file outside the run
 * folder where each setup and call is appended as a JSON line, for a test that runs Retest in another process.
 * `options.failSetup` makes the factory throw.
 */
function createFakeEvaluator(setup: EvaluatorSetup): FakeEvaluator {
  const options = setup.options
  const log = typeof options['log'] === 'string' ? options['log'] : undefined
  const record = (entry: object): void => {
    if (log !== undefined) appendFileSync(log, `${JSON.stringify(entry)}\n`)
  }
  const tag = typeof options['tag'] === 'string' ? options['tag'] : undefined
  const made: FakeSetup = { tag, judge: setup.judge, credentials: { ...setup.credentials }, options: { ...options } }
  fakeSetups.push(made)
  record({ setup: made })
  if (options['failSetup'] === true) throw new Error('The fake judge was told to fail its setup.')
  const fallback = behaviours.find((behaviour) => behaviour === options['default']) ?? 'pass'
  const delayMs = typeof options['delayMs'] === 'number' ? options['delayMs'] : 200
  const holdLate = options['holdLate'] === true
  const markers = typeof options['markers'] === 'string' ? options['markers'] : undefined
  const mark = (name: string): void => {
    if (markers !== undefined) writeFileSync(join(markers, name), '')
  }
  const apiKey = setup.credentials['apiKey'] ?? ''
  let inFlight = 0
  return {
    identity: { provider: 'fake', model: 'scripted-1', version: 'fake-evaluator/1', sampling: { temperature: 0 } },
    async evaluate(request) {
      const [first] = request.criteria
      const behaviour = behaviours.find((each) => each === first?.id) ?? fallback
      inFlight++
      const call = { tag, ...describeCall(setup.judge, behaviour, request, inFlight) }
      fakeCalls.push(call)
      record({ call })
      if (behaviour === 'late') mark('late-received')
      try {
        const answered = await answer(behaviour, request, { apiKey, delayMs, holdLate, call, record, pixelHashes: options['pixelHashes'] })
        call.answeredAt = Date.now()
        if (call.lateReply === true) mark('late-answered')
        return answered
      } finally {
        inFlight--
      }
    },
  }
}

export default createFakeEvaluator

type AnswerContext = { apiKey: string; delayMs: number; holdLate: boolean; call: FakeCall; record: (entry: object) => void; pixelHashes: EvaluatorSetup['options'][string] | undefined }

// Each answer is what a provider adapter might return; the parent decides whether it keeps the contract.
async function answer(behaviour: FakeBehaviour, request: EvaluationRequest, context: AnswerContext): Promise<unknown> {
  const verdicts = (verdict: 'pass' | 'fail' | 'inconclusive'): JudgeAnswer['criteria'] =>
    request.criteria.map(({ id }) => ({ id, verdict, citations: verdict === 'inconclusive' ? [] : ['e1'] }))
  switch (behaviour) {
    case 'pixel-hash': {
      const hashes = context.pixelHashes
      const known = hashes !== null && typeof hashes === 'object' && !Array.isArray(hashes) ? new Map(Object.entries(hashes)) : new Map<string, EvaluatorSetup['options'][string]>()
      const images = request.evidence.filter((item) => item.kind === 'image')
      const verdicts = images.map((image) => {
        const pixels = decodePng(image.data)
        const hash = createHash('sha256').update(pixels.pixels).digest('hex')
        const verdict = known.get(hash)
        return verdict === 'pass' || verdict === 'fail' ? verdict : 'inconclusive'
      })
      const verdict = verdicts.includes('fail') ? 'fail' : images.length === 0 || verdicts.includes('inconclusive') ? 'inconclusive' : 'pass'
      return { criteria: request.criteria.map(({ id }) => ({ id, verdict, citations: verdict === 'inconclusive' ? [] : images.map((image) => image.id) })), justification: 'Judged the decoded pixel hashes against the declared samples.' }
    }
    case 'pass':
    case 'fail':
    case 'inconclusive':
      return { criteria: verdicts(behaviour), justification: `Scripted ${behaviour} for ${request.criteria.length} criteria.`, modelRevision: 'scripted-1-2026', usage: { inputTokens: 12, outputTokens: 7 } }
    case 'mixed':
      return {
        criteria: request.criteria.map(({ id }, index) => (index === 0 ? { id, verdict: 'pass', citations: ['e1'] } : { id, verdict: 'inconclusive', citations: [] })),
        justification: 'The first criterion is shown; the rest is cut off.',
      }
    case 'malformed':
      return { verdict: 'yes', reason: 'Looks fine.' }
    case 'missing':
      return { criteria: verdicts('pass').slice(1), justification: 'Answers every criterion but the first.' }
    case 'cite-unknown':
      return { criteria: request.criteria.map(({ id }) => ({ id, verdict: 'pass', citations: ['e99'] })), justification: 'Cites evidence that was never supplied.' }
    case 'confidence':
      return Object.assign({ criteria: verdicts('pass'), justification: 'Sure of it.' }, { confidence: 0.99 })
    case 'throw':
      throw new Error(`The provider refused the key ${context.apiKey}.`)
    case 'echo-secret':
      return { criteria: verdicts('pass'), justification: `The page shows the key ${context.apiKey} in its footer.` }
    case 'hang':
      return new Promise<never>(() => undefined)
    case 'late':
      if (!request.signal.aborted) await new Promise<void>((resolve) => request.signal.addEventListener('abort', () => resolve(), { once: true }))
      if (context.holdLate) await lateGate(context.call.tag).promise
      else await sleep(50)
      context.call.lateReply = true
      context.record({ lateReply: context.call.criteria[0]?.requirement })
      return { criteria: verdicts('pass'), justification: 'A pass that came after the parent stopped waiting.' }
    case 'slow-fail':
      await sleep(context.delayMs)
      return { criteria: verdicts('fail'), justification: 'A fail that took its time.' }
    case 'echo-revision':
      return { criteria: verdicts('pass'), justification: 'Shown.', modelRevision: `proxy-for-${context.apiKey}` }
    case 'slow':
      await sleep(context.delayMs)
      return { criteria: verdicts('pass'), justification: 'A pass that took its time.' }
  }
}

function describeCall(judge: string, behaviour: FakeBehaviour, request: EvaluationRequest, concurrent: number): Omit<FakeCall, 'tag'> {
  const entries = Object.entries(request)
  return {
    judge,
    behaviour,
    criteria: request.criteria.map(({ id, kind, requirement, absence }) => ({ id, ...(kind === undefined ? {} : { kind }), requirement, ...(absence === true ? { absence } : {}) })),
    context: request.context,
    instructions: request.instructions,
    promptVersion: request.promptVersion,
    evidence: request.evidence.map((item) =>
      item.kind === 'text'
        ? { id: item.id, kind: item.kind, text: item.text }
        : { id: item.id, kind: item.kind, bytes: item.data.byteLength, app: item.app, width: item.width, height: item.height },
    ),
    frames: (request.frames ?? []).map((sequence) => ({
      id: sequence.id,
      app: sequence.app,
      ...(sequence.step === undefined ? {} : { step: sequence.step }),
      complete: sequence.complete,
      omitted: sequence.omitted,
      frames: sequence.frames.map((frame) => ({ id: frame.id, mediaType: frame.mediaType, bytes: frame.data.byteLength, sha256: createHash('sha256').update(frame.data).digest('hex'), width: frame.width, height: frame.height, atMs: frame.atMs })),
      stretches: sequence.stretches.map((stretch) => ({ ...stretch })),
    })),
    keys: entries.map(([key]) => key),
    functions: entries.filter(([, value]) => typeof value === 'function').map(([key]) => key),
    maxOutputTokens: request.maxOutputTokens,
    timeoutMs: request.timeoutMs,
    concurrent,
  }
}
