import type { CommandResult, Observation, PageObservation } from '../protocol/commands.ts'
import type { Failure, FailureDetail } from '../protocol/failures.ts'
import type { LocatorCheckRecord } from '../protocol/locator-checks.ts'
import type { PageFacts } from '../protocol/page-facts.ts'
import type { Schema } from '../protocol/schema.ts'
import { isNavigationKind } from '../protocol/commands.ts'
import { evaluationTextKeys, isEvaluationPart } from '../protocol/evaluation.ts'
import { hostCheckRecordSchema } from '../protocol/host-check.ts'
import { mapLocatorCheckText } from '../protocol/locator-checks.ts'
import { locatorRecipeSchema } from '../protocol/locator.ts'
import { cleanTitle, recordedTitle, titleReadLimit } from '../protocol/page-facts.ts'
import { isPlainObject, parse } from '../protocol/schema.ts'
import { secretPlaceholder } from '../protocol/secret.ts'
import { normalizeText } from '../protocol/text.ts'

type Scan = { text: string; held: string }
type Known = { value: string; placeholder: string }

// The text a page or a person can write a secret into: failure messages and details, what an assertion expected
// and saw, what a look observed, every address, since a page puts what it was given into its path or query, what a
// host writes into a check, and the text a locator matches, under `writtenKeys`. Page titles are free text too,
// under `titleKeys`. Identifiers Retest makes itself (ids, names, test ids, variants, file paths) are never rewritten.
// A config's lock names are written by a person too, and travel with every attempt that holds them.
const freeText: ReadonlySet<string> = new Set(['message', 'details', 'expected', 'actual', 'observed', 'url', 'pageUrl', 'ready', 'baseUrl', 'baseUrls', 'locks'])

// A host writes a check's text, name and path itself, and holds the run's secrets, so each is free text wherever
// a check is recorded. The page is still asked for the text, and the path still matched, as written. A locator's
// text, name and CSS selector are matched against the page's own text and attributes, so a test could have copied a
// value into one. Each step a locator is scoped to is a recipe of its own.
const writtenKeys: readonly { keys: ReadonlySet<string>; holds: (record: Record<string, unknown>) => boolean }[] = [
  { keys: new Set(['text', 'name', 'path']), holds: (record) => parse(hostCheckRecordSchema, record).ok },
  { keys: new Set(['text', 'name', 'selector']), holds: (record) => parse(locatorRecipeSchema, record).ok },
  // An AI check's criteria, context and evidence text come from a test or a host, and its justification, reasons and
  // model names from a provider: each may hold a value.
  { keys: evaluationTextKeys, holds: isEvaluationPart },
]

// A page's title reaches the parent as the page has it, and is cleaned and cut only once it is redacted.
const titleKeys: ReadonlySet<string> = new Set(['title', 'pageTitle'])

/**
 * Replaces every secret value the run has read with `{{name}}` in free text: page text, addresses, failure
 * messages and details, assertion values and output. It learns each value as the parent reads it, so a value a
 * function source returns later is hidden from then on, in every form a URL gives it. Where two values
 * overlap, the longest one found first wins. Text that was redacted already comes out the same, even when a
 * value is part of its own placeholder.
 */
export class Redactor {
  readonly #names = new Map<string, string>()
  readonly #placeholders = new Set<string>()
  /** Values and their placeholders by the value's first character, longest value first. */
  #byFirst = new Map<string, Known[]>()

  /** Whether any value has been learned; until then every text passes as it is. */
  get active(): boolean {
    return this.#names.size > 0
  }

  learn(name: string, value: string): void {
    if (value === '' || this.#names.get(value) === name) return
    for (const form of writtenForms(value)) this.#names.set(form, name)
    this.#placeholders.add(secretPlaceholder(name))
    const known = [...this.#names].map(([each, owner]) => ({ value: each, placeholder: secretPlaceholder(owner) }))
    known.sort((first, second) => second.value.length - first.value.length)
    this.#byFirst = Map.groupBy(known, ({ value: each }) => each.charAt(0))
  }

  redact(text: string): string {
    return this.active ? this.#scan(text, false).text : text
  }

  /**
   * Whether `text` holds a whole value the run has read, in any form a URL gives it, compared as a locator compares
   * text: whitespace read as one space on both sides, and in any case when not `exact`. Part of a value is not the
   * value: answering that would tell whoever asks which texts are part of a secret.
   *
   * @example redactor.holdsValue('Signed in as HUNTER2', false) // true, once hunter2 is known
   */
  holdsValue(text: string, exact: boolean): boolean {
    const compared = (each: string): string => (exact ? normalizeText(each) : normalizeText(each).toLowerCase())
    const held = compared(text)
    for (const form of this.#names.keys()) {
      const value = compared(form)
      if (value !== '' && held.includes(value)) return true
    }
    return false
  }

  /**
   * A copy of an event or a result with its free text redacted, checked again against its schema: every
   * `message`, `details`, `expected`, `actual`, `observed`, address, page title, a host check's text, name and
   * path, and a locator's text and name, at any depth. Page titles are then cleaned and cut to the length Retest
   * records, even while no value is known, and one that leaves nothing is left out. Identifiers and structure stay
   * as they are, and a value with nothing to change is returned as it is.
   *
   * @example redactor.redactFields(runResultSchema, result)
   */
  redactFields<T>(schema: Schema<T>, value: T): T {
    const redacted = this.#redactFields(value, false)
    if (redacted === value) return value
    const parsed = parse(schema, redacted)
    if (parsed.ok) return parsed.value
    throw new Error(`Redacting changed the shape of a value: ${parsed.issues.map((issue) => `${issue.path} ${issue.message}`).join('; ')}`)
  }

  /** A failure with its message and details redacted. */
  redactFailure(failure: Failure): Failure {
    if (!this.active) return failure
    const { details } = failure
    const redacted = { ...failure, message: this.redact(failure.message) }
    if (details === undefined) return redacted
    return { ...redacted, details: Object.fromEntries(Object.entries(details).map(([key, detail]) => [key, this.#redactDetail(detail)])) }
  }

  /**
   * An answer for the test file's process with the page text in it redacted: an observation, an address, the page
   * the command went to, whose title is also cleaned and cut to the length Retest records, or a failure.
   */
  redactCommandResult(result: CommandResult): CommandResult {
    if (!result.ok) return { ok: false, failure: this.redactFailure(result.failure) }
    const page = result.page === undefined ? {} : { page: this.#redactPage(result.page) }
    if (result.kind === 'observePage') {
      const base = result.baseUrl === undefined ? {} : { baseUrl: this.redact(result.baseUrl) }
      return { ...result, observation: this.redactPageLook(result.observation), ...base, ...page }
    }
    if (result.kind === 'observe') return { ...result, observation: this.redactObservation(result.observation), ...page }
    return isNavigationKind(result.kind) && 'url' in result ? { ...result, url: this.redact(result.url), ...page } : { ...result, ...page }
  }

  /**
   * A page's title as Retest records it, from the title as the page has it: every value in it redacted, then its
   * control characters removed and its ends trimmed, then redacted again, since removing a control character joins
   * the text around it, and only then cut to `pageTitleLimit`. So a value with a space at its end, a tab in it, or
   * one that runs past the cut is hidden whole. A title as long as the page hands over may have been cut inside a
   * value, so a tail that may begin one is dropped. A title that leaves nothing is none.
   *
   * @example redactor.redactTitle('  Signed in as hunter2 ') // 'Signed in as {{password}}'
   */
  redactTitle(title: string): string | undefined {
    const redacted = this.scan(title, title.length >= titleReadLimit - 1).text
    const cleaned = cleanTitle(redacted)
    return cleaned === undefined ? undefined : recordedTitle(this.redact(cleaned))
  }

  /**
   * A locator check with every value in its expected text redacted, as the parent records what it judged.
   *
   * @example redactor.redactCheck({ matcher: 'toHaveText', text: 'Hi hunter2' }) // { matcher: 'toHaveText', text: 'Hi {{password}}' }
   */
  redactCheck(check: LocatorCheckRecord): LocatorCheckRecord {
    return mapLocatorCheckText(check, (text) => this.redact(text))
  }

  /** An observation with the page text in it redacted, as the test process receives one. */
  redactObservation(observation: Observation): Observation {
    const { text, value, items } = observation
    return {
      ...observation,
      text: text === null ? null : this.redact(text),
      value: value === null ? null : this.redact(value),
      items: items.map((item) => ({ ...item, text: this.redact(item.text) })),
    }
  }

  /** A stream of text redacted as it arrives, for output that may cut a value in two. */
  stream(): RedactedStream {
    return new RedactedStream(this)
  }

  /** Redacts `text`, and with `holding`, keeps back a tail that may be the start of a value still to come. */
  scan(text: string, holding: boolean): Scan {
    return this.active ? this.#scan(text, holding) : { text, held: '' }
  }

  // A placeholder already in the text is copied as it is, unless a longer value starts at the same place.
  #scan(text: string, holding: boolean): Scan {
    let redacted = ''
    let index = 0
    while (index < text.length) {
      const candidates = this.#byFirst.get(text.charAt(index)) ?? []
      if (holding && candidates.some(({ value }) => value.length > text.length - index && value.startsWith(text.slice(index)))) {
        return { text: redacted, held: text.slice(index) }
      }
      const found = candidates.find(({ value }) => text.startsWith(value, index))
      const placeholder = this.#placeholderAt(text, index)
      if (found !== undefined && found.value.length >= (placeholder?.length ?? 0)) {
        redacted += found.placeholder
        index += found.value.length
      } else {
        const kept = placeholder ?? text.charAt(index)
        redacted += kept
        index += kept.length
      }
    }
    return { text: redacted, held: '' }
  }

  #placeholderAt(text: string, index: number): string | undefined {
    if (text.charAt(index) !== '{') return undefined
    for (const placeholder of this.#placeholders) if (text.startsWith(placeholder, index)) return placeholder
    return undefined
  }

  // Inside a free-text key every string is text; outside one, only the keys below it can be. An array or an object
  // none of whose parts changed is returned as it is. A title that leaves nothing is left out.
  #redactFields(value: unknown, inText: boolean): unknown {
    if (typeof value === 'string') return inText ? this.redact(value) : value
    if (Array.isArray(value)) {
      const items = value.map((item: unknown) => this.#redactFields(item, inText))
      return items.every((item, index) => item === value[index]) ? value : items
    }
    if (!isPlainObject(value)) return value
    const entries = Object.entries(value).map(([key, item]): [string, unknown] => {
      if (titleKeys.has(key) && typeof item === 'string') return [key, this.redactTitle(item)]
      return [key, this.#redactFields(item, inText || freeText.has(key) || isWritten(value, key))]
    })
    if (entries.every(([key, item]) => item === value[key])) return value
    return Object.fromEntries(entries.filter(([key, item]) => !(titleKeys.has(key) && item === undefined)))
  }

  /**
   * A look at the page as the parent judges it and the test process receives it: its whole address and title with
   * every value in them redacted, and the title cleaned as every title is but not cut, so a check compares all the page
   * showed. A part the page held more of than Retest read keeps back a tail that may begin a value. `hidden` names each
   * part that holds a placeholder, where a negation cannot tell what the page showed.
   *
   * @example redactor.redactPageLook({ url: 'https://app.test/reset?token=hunter2', title: 'Reset' }).hidden // ['url']
   */
  redactPageLook({ url, title, cut = [] }: PageObservation): PageObservation {
    const address = url === null ? null : this.scan(url, cut.includes('url')).text
    const cleaned = title === null ? undefined : cleanTitle(this.scan(title, cut.includes('title')).text)
    const shown = title === null ? null : cleaned === undefined ? '' : this.redact(cleaned)
    const hidden = [...(address !== null && this.#holdsPlaceholder(address) ? ['url' as const] : []), ...(shown !== null && this.#holdsPlaceholder(shown) ? ['title' as const] : [])]
    return { url: address, title: shown, ...(cut.length === 0 ? {} : { cut }), ...(hidden.length === 0 ? {} : { hidden }) }
  }

  #holdsPlaceholder(text: string): boolean {
    return [...this.#placeholders].some((placeholder) => text.includes(placeholder))
  }

  #redactPage({ url, title }: PageFacts): PageFacts {
    const recorded = title === undefined ? undefined : this.redactTitle(title)
    return recorded === undefined ? { url: this.redact(url) } : { url: this.redact(url), title: recorded }
  }

  #redactDetail(detail: FailureDetail): FailureDetail {
    if (typeof detail === 'string') return this.redact(detail)
    return detail !== null && typeof detail === 'object' ? { ...detail, text: this.redact(detail.text) } : detail
  }

}

// A host check is recorded in its events, in `run.started` and in the result, and a locator in every event about
// an action, a look or an assertion; what a person wrote into either may hold a secret. Any other `text`, `name` or
// `path` Retest records is an identifier and stays as it is.
function isWritten(record: Record<string, unknown>, key: string): boolean {
  return writtenKeys.some(({ keys, holds }) => keys.has(key) && holds(record))
}

// The characters each part of a URL percent-encodes, from the URL standard: every one is encoded in a path,
// and a query and a fragment each leave some of them alone. Controls and non-ASCII are always encoded.
const pathSet = new Set([...' "#<>?`{}'])
const querySet = new Set([...' "#<>\''])
const fragmentSet = new Set([...' "<>`'])

/**
 * Every way a value is written once a page puts it in a URL: the value itself, then as `encodeURIComponent`,
 * `encodeURI`, a form submission and the URL standard's path, query and fragment write it, each also with
 * lowercase hex. A form that equals the value is left out, so a value of unreserved characters has one form.
 *
 * @example writtenForms('a b') // ['a b', 'a%20b', 'a+b']
 */
function writtenForms(value: string): string[] {
  const encoded = [
    encodeURIComponent(value),
    encodeURI(value),
    new URLSearchParams([['', value]]).toString().slice(1),
    percentEncode(value, pathSet),
    percentEncode(value, querySet),
    percentEncode(value, fragmentSet),
  ]
  const lowered = encoded.map((form) => form.replace(/%[0-9A-F]{2}/g, (escape) => escape.toLowerCase()))
  return [...new Set([value, ...encoded, ...lowered])]
}

function percentEncode(value: string, set: ReadonlySet<string>): string {
  let encoded = ''
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0
    if (code < 0x20 || code > 0x7e || set.has(character)) {
      for (const byte of Buffer.from(character, 'utf8')) encoded += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`
    } else {
      encoded += character
    }
  }
  return encoded
}

/**
 * Output redacted chunk by chunk. A chunk that ends partway into a secret value is held back until the next
 * chunk shows whether it is one; `end` returns whatever is still held.
 */
export class RedactedStream {
  readonly #redactor: Redactor
  #held = ''

  constructor(redactor: Redactor) {
    this.#redactor = redactor
  }

  write(text: string): string {
    const scanned = this.#redactor.scan(this.#held + text, true)
    this.#held = scanned.held
    return scanned.text
  }

  end(): string {
    const rest = this.#redactor.redact(this.#held)
    this.#held = ''
    return rest
  }
}
