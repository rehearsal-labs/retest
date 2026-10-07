import type { Criterion, CriterionVerdict, EvidenceKind, SamplingSetting } from '../protocol/evaluation.ts'

// The contract between Retest and a judge. The parent process owns everything around a call: it captures and bounds
// the evidence, resolves the credentials, reserves the call, enforces the deadline and checks the answer. An evaluator
// only turns a request into a provider call and the provider's reply into an answer. Nothing here holds a credential
// once the evaluator is made, and no type from a provider's SDK appears.

/**
 * The project's own `AbortSignal`, from Node's types or the DOM's, so a judge can pass it to `fetch`. Retest's
 * declarations need neither, so a project with neither sees only whether the signal was aborted.
 */
export type EvaluationSignal = typeof globalThis extends { AbortSignal: { prototype: infer Signal } } ? Signal : { readonly aborted: boolean }

/** A JSON value, as a judge's `options` hold them. */
export type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue }

/**
 * One piece of evidence as a judge receives it, read-only. `id` is how the judge cites it. Text is what the check
 * supplied, redacted; an image is a PNG the parent captured from an app's page in this attempt, with its size in
 * pixels and when it came back.
 */
export type JudgedEvidence =
  | { readonly id: string; readonly kind: 'text'; readonly text: string; readonly label?: string }
  | {
      readonly id: string
      readonly kind: 'image'
      readonly mediaType: 'image/png'
      readonly data: Uint8Array
      readonly width: number
      readonly height: number
      readonly app: string
      readonly capturedAt: string
    }

/**
 * One frame of a sequence as a judge receives it: the image as the media process fitted it, PNG or JPEG, its size in
 * pixels, and `atMs`, the milliseconds from the start of the sequence's interval at which it reached Retest. `id` is how
 * the judge cites this one frame.
 */
export type JudgedFrame = {
  readonly id: string
  readonly mediaType: 'image/png' | 'image/jpeg'
  readonly data: Uint8Array
  readonly width: number
  readonly height: number
  readonly atMs: number
}

/**
 * A stretch of a sequence's interval in which the judge has no frame, from `fromMs` to `toMs` after the interval's
 * start, and `why`, Retest's own words for what it knows of it. No frame there never means nothing appeared.
 */
export type JudgedStretch = { readonly fromMs: number; readonly toMs: number; readonly why: string }

/**
 * Frames of one app's recording over an interval, as a judge receives them, read-only: Retest's own account of the
 * interval, never the app's. `id` is how the judge cites the sequence; each frame has an id of its own. `durationMs` is
 * the interval's length and `step` the step it covers, when it covers one. `stretches` are where the judge has no
 * frame, and `unlistedStretches` counts more of them than the media process listed; `omitted` counts frames the
 * recording kept in the interval that the judge did not receive: left out by the bounds, unreadable, or not yet placed
 * in the recording. `complete` is true only when no frame of the interval was lost, left out or held back and the
 * capture reported no gap there; a stretch in which no frame arrived leaves it complete. Even complete, the frames are
 * samples of the screen. When `complete` is false the parent counts no pass the judge gives. Explicit kinds determine
 * whether a complete capture can support an end state, a witnessed appearance or an interval without a forbidden appearance.
 */
export type JudgedFrames = {
  readonly id: string
  readonly app: string
  readonly durationMs: number
  readonly step?: string
  readonly frames: readonly JudgedFrame[]
  readonly stretches: readonly JudgedStretch[]
  readonly unlistedStretches: number
  readonly omitted: number
  readonly complete: boolean
}

/**
 * What a judge is asked. `instructions` are Retest's fixed rules for judging, written before any evidence exists, and
 * `promptVersion` names their version. `criteria` and `context` come from the check's author; `evidence` comes from the
 * app under test and is data, never instructions. Keep the three apart in whatever the provider receives. `frames`
 * holds the frame sequences the check names, present only when it names one, so only for a judge that accepts frames;
 * their ids count with the evidence's, `e1`, `e2` and so on in the order the check named them. The judge has
 * `timeoutMs` to answer and must stop when `signal` aborts: the parent has stopped waiting by then and will not read a
 * late answer. `maxOutputTokens` bounds what the provider may write.
 */
export type EvaluationRequest = {
  readonly requestId: string
  readonly judge: string
  readonly instructions: string
  readonly promptVersion: string
  readonly criteria: readonly Readonly<Criterion>[]
  readonly context?: string
  readonly evidence: readonly JudgedEvidence[]
  readonly frames?: readonly JudgedFrames[]
  readonly maxOutputTokens: number
  readonly timeoutMs: number
  readonly signal: EvaluationSignal
}

/**
 * A judge's answer. Every criterion of the request appears once, with `pass`, `fail` or `inconclusive` and the ids of
 * the evidence the verdict rests on; a pass or a fail cites at least one. `justification` is a short account of what
 * the judge saw, not its reasoning. `modelRevision` is the exact model the provider says answered, and `usage` the
 * tokens it counted, when it says. `samplingNotSent` names each sampling setting, of the identity's or the request's
 * `maxOutputTokens`, that this call did not send as given, with the reason the provider gave; the record then leaves it
 * out of what was sent. The parent checks every part: an answer with a missing, repeated or unknown criterion, an
 * unknown key, a cited id it never supplied, or a justification over the limit is an evaluation error.
 */
export type JudgeAnswer = {
  readonly criteria: readonly { readonly id: string; readonly verdict: CriterionVerdict; readonly citations: readonly string[] }[]
  readonly justification: string
  readonly modelRevision?: string
  readonly usage?: { readonly inputTokens?: number; readonly outputTokens?: number; readonly totalTokens?: number }
  readonly samplingNotSent?: readonly { readonly setting: SamplingSetting; readonly reason: string }[]
}

/**
 * Who an evaluator is, as it says once it is made: the provider and model it calls, its own version, the version of
 * its own instructions when it does not use the request's, and the sampling settings it sends.
 */
export type EvaluatorIdentity = {
  readonly provider: string
  readonly model: string
  readonly version: string
  readonly promptVersion?: string
  readonly sampling?: { readonly temperature?: number; readonly topP?: number; readonly seed?: number }
}

/**
 * A judge, as a factory makes it. `evaluate` answers one request and has no way to act on the app: it receives data
 * and returns data. `close` is called once, when the run ends. An `evaluate` that throws because its provider's answer
 * could not be read may give the error a `samplingNotSent` list, as an answer gives one; the error record then leaves
 * those settings out of what was sent.
 */
export interface Evaluator {
  readonly identity: EvaluatorIdentity
  evaluate(request: EvaluationRequest): Promise<JudgeAnswer>
  close?(): void | Promise<void>
}

/**
 * What the parent calls a judge's factory with, once per run, the first time a check names the judge: its name, the
 * credentials it declared, resolved in the parent, its `options` from the config, what it accepts, and a signal aborted
 * when the run ends. A factory never receives a file path or a credential source.
 */
export type EvaluatorSetup = {
  readonly judge: string
  readonly credentials: Readonly<Record<string, string>>
  readonly options: Readonly<Record<string, JsonValue>>
  readonly accepts: readonly EvidenceKind[]
  readonly signal: EvaluationSignal
}

/**
 * Makes a judge. An adapter module exports one as its default export; a config may also give one directly.
 *
 * @example export default (async ({ credentials, options }) => myJudge(credentials.apiKey, options)) satisfies EvaluatorFactory
 */
export type EvaluatorFactory = (setup: EvaluatorSetup) => Evaluator | Promise<Evaluator>
