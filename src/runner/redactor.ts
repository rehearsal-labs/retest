import type { CommandResult, Observation } from '../protocol/commands.ts'
import type { Failure, FailureDetail } from '../protocol/failures.ts'
import type { Schema } from '../protocol/schema.ts'
import { isPlainObject, parse } from '../protocol/schema.ts'
import { secretPlaceholder } from '../protocol/secret.ts'

type Scan = { text: string; held: string }
type Known = { value: string; placeholder: string }

// The text a page or a person can write a secret into: failure messages and details, what an assertion expected
// and saw, and every address, since a page puts what it was given into its path or query. Identifiers Retest
// makes itself (ids, names, locators, variants, file paths) are never rewritten.
const freeText: ReadonlySet<string> = new Set(['message', 'details', 'expected', 'actual', 'url', 'pageUrl', 'ready', 'baseUrl', 'baseUrls'])

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
   * A copy of an event or a result with its free text redacted, checked again against its schema: every
   * `message`, `details`, `expected`, `actual` and address, at any depth. Identifiers and structure stay as they are.
   *
   * @example redactor.redactFields(runResultSchema, result)
   */
  redactFields<T>(schema: Schema<T>, value: T): T {
    if (!this.active) return value
    const parsed = parse(schema, this.#redactFields(value, false))
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

  /** An answer for the test file's process with the page text in it redacted: an observation, an address, or a failure. */
  redactCommandResult(result: CommandResult): CommandResult {
    if (!this.active) return result
    if (!result.ok) return { ok: false, failure: this.redactFailure(result.failure) }
    if (result.kind === 'observe') return { ...result, observation: this.#redactObservation(result.observation) }
    return result.kind === 'goto' ? { ...result, url: this.redact(result.url) } : result
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

  // Inside a free-text key every string is text; outside one, only the keys below it can be.
  #redactFields(value: unknown, inText: boolean): unknown {
    if (typeof value === 'string') return inText ? this.redact(value) : value
    if (Array.isArray(value)) return value.map((item: unknown) => this.#redactFields(item, inText))
    if (!isPlainObject(value)) return value
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.#redactFields(item, inText || freeText.has(key))]))
  }

  #redactDetail(detail: FailureDetail): FailureDetail {
    if (typeof detail === 'string') return this.redact(detail)
    return detail !== null && typeof detail === 'object' ? { ...detail, text: this.redact(detail.text) } : detail
  }

  #redactObservation(observation: Observation): Observation {
    const { text, value, items } = observation
    return {
      ...observation,
      text: text === null ? null : this.redact(text),
      value: value === null ? null : this.redact(value),
      items: items.map((item) => ({ ...item, text: this.redact(item.text) })),
    }
  }
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
