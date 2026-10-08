import type { CaptureSourceName, RecordIdentity } from '../protocol/identity.ts'
import { formatSessionId } from '../protocol/evidence.ts'
import { s, type Schema } from '../protocol/schema.ts'

// The pixel capture policy. Text redaction hides a secret's value in every text Retest writes, but never in pixels: a
// screenshot or a frame shows whatever the screen showed. So whether pixels of an app may be taken, and when they must
// be withheld around a secret, is decided here, from the config's rules and from what the driver could observe of the
// field a secret is typed into. A withheld capture is withheld by policy, never dropped and never read as a moment in
// which nothing happened.

/** Whether an app's pixels may be taken at all. */
export type PixelPermission = 'allowed' | 'never'

/**
 * What the config allows for one app. `screenshots` covers every single capture: the screenshot taken when a test
 * fails, the screenshots an AI check sends its judge, and an agent session's frames. `recordings` covers frames: saved
 * video and live frames. Both are allowed unless the config says `never`; allowing recordings does not turn recording
 * on, which a run does only when asked.
 */
export type AppPixelRules = { readonly screenshots: PixelPermission; readonly recordings: PixelPermission }

/** The rules of an app the config says nothing about. */
export const defaultAppPixelRules: AppPixelRules = Object.freeze({ screenshots: 'allowed', recordings: 'allowed' })

/** The rules as a config writes them; a key left out is allowed. */
export type AppPixelRulesInput = { screenshots?: PixelPermission; recordings?: PixelPermission }

const permission = s.enum(['allowed', 'never'])

/** The schema of an app's rules in a config, for the config's validation. */
export const appPixelRulesSchema: Schema<AppPixelRulesInput> = s.object({ screenshots: s.optional(permission), recordings: s.optional(permission) })

/**
 * An app's rules with every key filled in.
 *
 * @example appPixelRules({ recordings: 'never' }) // { screenshots: 'allowed', recordings: 'never' }
 */
export function appPixelRules(input: AppPixelRulesInput | undefined): AppPixelRules {
  return Object.freeze({ screenshots: input?.screenshots ?? 'allowed', recordings: input?.recordings ?? 'allowed' })
}

/** A single capture: when a test failed, for an AI check's judge, or an agent session's frame. */
export type ScreenshotUse = 'failure' | 'evaluation' | 'agent'

/** A frame of a capture that runs: for a saved recording, or sent live to a viewer. */
export type FrameUse = 'recording' | 'live'

export type PixelUse = ScreenshotUse | FrameUse

const screenshotUses: ReadonlySet<PixelUse> = new Set<PixelUse>(['failure', 'evaluation', 'agent'])

// Masking -----------------------------------------------------------------------------------------------------------

export type WebEngine = 'chromium' | 'firefox' | 'webkit'

/**
 * What the driver read of the field a secret's keys go to, in the same call that checks the field before the first
 * key, and again once the last key is in. A web field is the element itself: for an `<input>`, `inputType` is its
 * `type` property, which reads `text` for a type the browser does not know; `editable` is an element edited through
 * `contenteditable`. A native field is the element's type as the platform's accessibility tree gives it, such as
 * `TextField` or `SecureTextField`. `unread` is a field the driver could not read, with why.
 */
export type FieldFact =
  | { readonly kind: 'web'; readonly engine: WebEngine; readonly element: 'input'; readonly inputType: string }
  | { readonly kind: 'web'; readonly engine: WebEngine; readonly element: 'textarea' | 'editable' | 'other' }
  | { readonly kind: 'native'; readonly platform: 'ios' | 'macos'; readonly elementType: string }
  | { readonly kind: 'unread'; readonly reason: string }

/**
 * Whether a field masks what is typed into it. `masks: true` only where the platform itself draws every character as
 * a dot as it is typed. Otherwise the field `shows` its `text`, may show `typed_characters` for a moment, or it is
 * `unknown` whether it shows them, which is treated as showing them.
 */
export type FieldMasking = { readonly masks: true; readonly reason: string } | { readonly masks: false; readonly shows: 'text' | 'typed_characters' | 'unknown'; readonly reason: string }

/**
 * Decides from what the driver read whether a field masks a secret typed into it. Only two kinds of field do: a web
 * `<input>` whose `type` is `password` in Chromium, Firefox or WebKit on the desktop, and a macOS `SecureTextField`.
 * An iOS secure field can show the character just typed, and the keyboard the key pressed, so it is treated as
 * showing its text. A style that hides text, such as `-webkit-text-security`, does not count: a script can take it
 * away and not every engine draws it. Anything the driver could not read is treated as showing its text.
 *
 * @example fieldMasking({ kind: 'web', engine: 'firefox', element: 'input', inputType: 'password' }).masks // true
 */
export function fieldMasking(fact: FieldFact): FieldMasking {
  if (fact.kind === 'unread') return { masks: false, shows: 'unknown', reason: `Retest could not read the field: ${fact.reason}` }
  if (fact.kind === 'native') {
    if (fact.elementType !== 'SecureTextField') return { masks: false, shows: 'text', reason: `The field is a ${fact.elementType}, which shows its text.` }
    if (fact.platform === 'macos') return { masks: true, reason: 'The field is a macOS secure text field, which draws every character as a dot.' }
    return { masks: false, shows: 'typed_characters', reason: 'The field is an iOS secure text field, which can show the character just typed, as the keyboard shows the key pressed.' }
  }
  if (fact.element !== 'input') return { masks: false, shows: 'text', reason: `The field is ${fact.element === 'editable' ? 'an editable element' : `a ${fact.element}`}, which shows its text.` }
  if (fact.inputType.toLowerCase() === 'password') return { masks: true, reason: `The field is a password input, which ${engineName(fact.engine)} draws as dots.` }
  return { masks: false, shows: 'text', reason: `The field is an input of type ${JSON.stringify(fact.inputType)}, which shows its text.` }
}

function engineName(engine: WebEngine): string {
  return engine === 'chromium' ? 'Chromium' : engine === 'firefox' ? 'Firefox' : 'WebKit'
}

// The policy --------------------------------------------------------------------------------------------------------

/** Why a capture was not taken: the app's rules forbid it, or a secret may be on screen. */
export type WithheldReason = 'app_rules' | 'secret_entry'

/** May a capture be taken or kept. A withheld one says why in words a report can show; it never quotes a value. */
export type PixelDecision = { readonly capture: true } | { readonly capture: false; readonly withheld: WithheldReason; readonly message: string }

/**
 * When a capture could have been taken, on the run's clock in whole microseconds: from `earliestUs` to `arrivedUs`,
 * when it reached Retest. `earliestUs` is the moment it was asked for: a screenshot's request, a screenshot loop's
 * tick. A screencast frame is not asked for, so its `earliestUs` is the moment the screencast last started.
 */
export type CaptureSpan = { readonly earliestUs: number; readonly arrivedUs: number }

/**
 * One capture to decide on. `identity` is the session it shows, `source` what takes it. Without `span`, the decision
 * is for a capture about to be asked for now.
 */
export type PixelRequest = { readonly identity: RecordIdentity; readonly use: PixelUse; readonly source: CaptureSourceName; readonly span?: CaptureSpan }

/**
 * How a withheld stretch ended. `nothing_typed`: the fill sent no key. `field_gone`: the field left the page or the
 * screen, or stopped being shown. `field_empty`: the field read back empty. `field_masked`: the field reads back masked.
 * Native secure entry keeps pixels under the driver's owned-tree type and masked read-back rule; other native fields
 * resume only on guarded clearance. `new_document`: the page opened another document. `session_ended`: the page closed or the app ended.
 */
export type StretchEnd = 'nothing_typed' | 'field_gone' | 'field_empty' | 'field_masked' | 'new_document' | 'session_ended'

/**
 * Why the field was taken to show the secret: it shows its `text`, it may show `typed_characters`, it is `unknown`
 * whether it does, or it masked the secret when the first key went and no longer did once the last was in
 * (`unmasked_while_typed`).
 */
export type StretchCause = 'text' | 'typed_characters' | 'unknown' | 'unmasked_while_typed'

/**
 * A stretch in which captures of one session were withheld by policy around a secret, on the run's clock in whole
 * microseconds: from `fromUs`, just before the first key, until `untilUs`, when the field was seen to stop showing the
 * secret or the page left. `untilUs` and `endedBy` are absent while it lasts, and stay absent for a session that never
 * ended it. `exposedFromUs` is set for `unmasked_while_typed`: captures between it and `fromUs` were taken while the
 * field may have shown the secret. `secret` is the secret's name, never its value. `withheld` counts what this stretch
 * withheld; a frame that arrives after `untilUs` but could have been taken before it is withheld and counted too.
 */
export type WithheldStretch = {
  readonly testId: string
  readonly attemptId: string
  readonly app: string
  readonly sessionId: string
  readonly secret: string
  readonly field: string
  readonly cause: StretchCause
  readonly fromUs: number
  readonly untilUs?: number
  readonly endedBy?: StretchEnd
  readonly exposedFromUs?: number
  readonly withheld: { readonly screenshots: number; readonly frames: number }
}

type Scope = { readonly testId: string; readonly attemptId: string; readonly session: string; readonly sessionId: string }

/**
 * What the policy asks the runner to record, as it happens: proposed as the events `capture.withheld` (a stretch
 * began), `capture.resumed` (it ended) and `capture.masked_entry` (a secret is typed into a field that masks it, and
 * capture goes on). `session` names the app, as on every event about an app; `secret` is the secret's name.
 */
export type PixelPolicyRecord =
  | (Scope & { readonly type: 'capture.withheld'; readonly secret: string; readonly cause: StretchCause; readonly fromUs: number; readonly exposedFromUs?: number })
  | (Scope & { readonly type: 'capture.resumed'; readonly secret: string; readonly endedBy: StretchEnd; readonly fromUs: number; readonly untilUs: number })
  | (Scope & { readonly type: 'capture.masked_entry'; readonly secret: string; readonly atUs: number })

/**
 * What the policy is built with. `rules` gives each app's rules, by the app's name. `clock` is the run's clock in whole
 * microseconds, the clock frames are stamped with. `record` takes each record as it happens.
 */
export type PixelPolicyOptions = {
  readonly rules: (app: string) => AppPixelRules
  readonly clock: () => number
  readonly record?: (record: PixelPolicyRecord) => void
}

/**
 * A secret's fill, from just before its first key. `field` is the driver's own key for the element the keys go to,
 * stable while that element lives, the same key `fieldChanged` names it by.
 */
export type SecretEntryStart = { readonly identity: RecordIdentity; readonly secret: string; readonly field: string; readonly fact: FieldFact }

/** How a secret's fill ended: the field as the driver read it after the last key, and how far the keys got. */
export type SecretEntryEnd = { readonly fact: FieldFact; readonly input: 'not_sent' | 'sent' | 'unknown' }

/** A secret's fill under way, as `beginSecretEntry` returns it, for `endSecretEntry`. */
export type SecretEntry = { readonly id: number; readonly masked: boolean; readonly masking: FieldMasking }

type Stretch = {
  readonly scope: Scope
  readonly secret: string
  readonly field: string
  readonly cause: StretchCause
  readonly fromUs: number
  readonly exposedFromUs?: number
  untilUs?: number
  endedBy?: StretchEnd
  readonly withheld: { screenshots: number; frames: number }
}

type Entry = { readonly start: SecretEntryStart; readonly scope: Scope; readonly masked: boolean; readonly beganUs: number; readonly stretch?: Stretch; ended: boolean }

/**
 * The pixel capture policy of one run, for every session in it. Ask `decide` before a capture is taken and again once
 * it is back, with its span; tell it when a secret's fill begins and ends, when a field that showed a secret changes,
 * and when a page leaves.
 *
 * While a secret is typed into a field that shows its text, every capture of that session is withheld, from just
 * before the first key until the field is seen to stop showing it, or the page opens another document, or the session
 * ends. A capture is withheld when the time it could have been taken overlaps that stretch, so a frame that was taken
 * before the field stopped showing the secret and arrives after is withheld too. A field that masks every character
 * stays captured. A Mac app's window capture (`window-crop`) is withheld while any session of the run is withheld, a
 * rule kept from when that capture was cut from the Mac's shared display.
 */
export class PixelCapturePolicy {
  readonly #options: PixelPolicyOptions
  readonly #stretches: Stretch[] = []
  readonly #entries = new Map<number, Entry>()
  #nextEntry = 1

  constructor(options: PixelPolicyOptions) {
    this.#options = options
  }

  /**
   * Whether a capture may be taken, or kept once it is back. The app's rules come first; then any withheld stretch of
   * the session, or of any session for `window-crop`, that overlaps the time the capture could have been taken.
   *
   * @example policy.decide({ identity, use: 'failure', source: 'chromium' })
   */
  decide(request: PixelRequest): PixelDecision {
    const scope = scopeOf(request.identity)
    const rules = this.#options.rules(scope.session)
    const screenshot = screenshotUses.has(request.use)
    const allowed = screenshot ? rules.screenshots : rules.recordings
    if (allowed === 'never') {
      return { capture: false, withheld: 'app_rules', message: `The config does not allow ${screenshot ? 'screenshots' : 'recordings'} of ${scope.session}, so Retest took none.` }
    }
    const now = this.#options.clock()
    const earliestUs = Math.min(request.span?.earliestUs ?? now, request.span?.arrivedUs ?? now)
    const arrivedUs = request.span?.arrivedUs ?? now
    const shared = request.source === 'window-crop'
    const overlapping = this.#stretches.filter((stretch) => (shared || stretch.scope.sessionId === scope.sessionId) && stretch.fromUs <= arrivedUs && (stretch.untilUs === undefined || stretch.untilUs > earliestUs))
    const [first] = overlapping
    if (first === undefined) return { capture: true }
    for (const stretch of overlapping) {
      if (screenshot) stretch.withheld.screenshots += 1
      else stretch.withheld.frames += 1
    }
    return { capture: false, withheld: 'secret_entry', message: withheldMessage(first, scope) }
  }

  /**
   * Call just before the first key of a secret's fill, with the field as the driver read it then. A field that does
   * not mask every character begins a withheld stretch for its session at this moment.
   *
   * @example const entry = policy.beginSecretEntry({ identity, secret: 'password', field: 'node-41', fact })
   */
  beginSecretEntry(start: SecretEntryStart): SecretEntry {
    const scope = scopeOf(start.identity)
    const masking = fieldMasking(start.fact)
    const beganUs = this.#options.clock()
    const id = this.#nextEntry++
    if (masking.masks) {
      this.#entries.set(id, { start, scope, masked: true, beganUs, ended: false })
      this.#record({ ...scope, type: 'capture.masked_entry', secret: start.secret, atUs: beganUs })
      return Object.freeze({ id, masked: true, masking })
    }
    const stretch = this.#open({ scope, secret: start.secret, field: start.field, cause: masking.shows, fromUs: beganUs })
    this.#entries.set(id, { start, scope, masked: false, beganUs, stretch, ended: false })
    return Object.freeze({ id, masked: false, masking })
  }

  /**
   * Call once a secret's fill is over, with the field as the driver read it after the last key and how far the keys
   * got. A fill that sent no key ends its stretch. A masked field that no longer masks begins a stretch now, marked
   * with the moment the first key went, since captures in between may show the secret.
   */
  endSecretEntry(entry: SecretEntry, end: SecretEntryEnd): void {
    const held = this.#entries.get(entry.id)
    if (held === undefined || held.ended) return
    held.ended = true
    if (!held.masked) {
      if (end.input === 'not_sent' && held.stretch !== undefined) this.#close(held.stretch, 'nothing_typed')
      return
    }
    if (end.input === 'not_sent' || fieldMasking(end.fact).masks) return
    this.#open({ scope: held.scope, secret: held.start.secret, field: held.start.field, cause: 'unmasked_while_typed', fromUs: this.#options.clock(), exposedFromUs: held.beganUs })
  }

  /**
   * Call when the driver sees that a field a secret was typed into no longer shows it: it is `gone` from the page or
   * the screen, or hidden; it reads back `empty`; or it is now `masked`. Ends that field's stretches in the session.
   */
  fieldChanged(identity: RecordIdentity, field: string, change: 'gone' | 'empty' | 'masked'): void {
    const { sessionId } = scopeOf(identity)
    const endedBy: StretchEnd = change === 'gone' ? 'field_gone' : change === 'empty' ? 'field_empty' : 'field_masked'
    for (const stretch of this.#stretches) if (stretch.untilUs === undefined && stretch.scope.sessionId === sessionId && stretch.field === field) this.#close(stretch, endedBy)
  }

  /** Call when the page opens another document, or the session ends. Ends every stretch of the session. */
  pageLeft(identity: RecordIdentity, cause: 'new_document' | 'session_ended'): void {
    const { sessionId } = scopeOf(identity)
    for (const stretch of this.#stretches) if (stretch.untilUs === undefined && stretch.scope.sessionId === sessionId) this.#close(stretch, cause)
  }

  /** Every withheld stretch so far, oldest first, as it stands now. */
  stretches(): readonly WithheldStretch[] {
    return Object.freeze(this.#stretches.map((stretch) => snapshot(stretch)))
  }

  #open(fields: { scope: Scope; secret: string; field: string; cause: StretchCause; fromUs: number; exposedFromUs?: number }): Stretch {
    const stretch: Stretch = { ...fields, withheld: { screenshots: 0, frames: 0 } }
    this.#stretches.push(stretch)
    const exposed = fields.exposedFromUs === undefined ? {} : { exposedFromUs: fields.exposedFromUs }
    this.#record({ ...fields.scope, type: 'capture.withheld', secret: fields.secret, cause: fields.cause, fromUs: fields.fromUs, ...exposed })
    return stretch
  }

  #close(stretch: Stretch, endedBy: StretchEnd): void {
    if (stretch.untilUs !== undefined) return
    // A stretch never ends before it began, whatever the clock read.
    stretch.untilUs = Math.max(stretch.fromUs, this.#options.clock())
    stretch.endedBy = endedBy
    this.#record({ ...stretch.scope, type: 'capture.resumed', secret: stretch.secret, endedBy, fromUs: stretch.fromUs, untilUs: stretch.untilUs })
  }

  #record(record: PixelPolicyRecord): void {
    this.#options.record?.(Object.freeze(record))
  }
}

function scopeOf(identity: RecordIdentity): Scope {
  const { testId, attemptId, app, sessionId } = identity
  if (sessionId !== formatSessionId(attemptId, app)) {
    throw new RangeError(`The identity names session ${JSON.stringify(sessionId)}, which is not ${JSON.stringify(formatSessionId(attemptId, app))}, the session of attempt ${JSON.stringify(attemptId)} and app ${JSON.stringify(app)}.`)
  }
  return { testId, attemptId, session: app, sessionId }
}

function withheldMessage(stretch: Stretch, scope: Scope): string {
  const secret = JSON.stringify(stretch.secret)
  if (stretch.scope.sessionId !== scope.sessionId) {
    return `Retest withheld this capture of ${scope.session} by policy: the secret ${secret} was on screen in ${stretch.scope.sessionId}, and a Mac window capture waits while any session of the run has a secret on screen.`
  }
  const why = stretch.cause === 'unmasked_while_typed' ? 'a field that stopped masking it' : stretch.cause === 'typed_characters' ? 'a field that can show the characters typed' : stretch.cause === 'unknown' ? 'a field Retest could not read' : 'a field that shows its text'
  return `Retest withheld this capture of ${scope.session} by policy: the secret ${secret} was typed into ${why}, and the field had not been seen to stop showing it.`
}

function snapshot(stretch: Stretch): WithheldStretch {
  const { scope, secret, field, cause, fromUs, untilUs, endedBy, exposedFromUs, withheld } = stretch
  return Object.freeze({
    testId: scope.testId,
    attemptId: scope.attemptId,
    app: scope.session,
    sessionId: scope.sessionId,
    secret,
    field,
    cause,
    fromUs,
    ...(untilUs === undefined ? {} : { untilUs }),
    ...(endedBy === undefined ? {} : { endedBy }),
    ...(exposedFromUs === undefined ? {} : { exposedFromUs }),
    withheld: Object.freeze({ ...withheld }),
  })
}
