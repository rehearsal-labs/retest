import type { CommandResult, Observation } from '../protocol/commands.ts'
import type { Failure, FailureDetail } from '../protocol/failures.ts'
import type { PageFacts } from '../protocol/page-facts.ts'
import type { Schema } from '../protocol/schema.ts'
import { hostCheckRecordSchema } from '../protocol/host-check.ts'
import { recordedTitle } from '../protocol/page-facts.ts'
import { isPlainObject, parse } from '../protocol/schema.ts'
import { secretPlaceholder } from '../protocol/secret.ts'

type Scan = { text: string; held: string }
type Known = { value: string; placeholder: string }

// The text a page or a person can write a secret into: failure messages and details, what an assertion expected
// and saw, what a look observed, every address, since a page puts what it was given into its path or query, and a
// text host check's text, which a host writes. Page titles are free text too, under `titleKeys`. Identifiers
// Retest makes itself (ids, names, locators, variants, file paths) are never rewritten.
const freeText: ReadonlySet<string> = new Set(['message', 'details', 'expected', 'actual', 'observed', 'url', 'pageUrl', 'ready', 'baseUrl', 'baseUrls'])

// A page's title reaches the parent long, and is cut to the length Retest records only once it is redacted.
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
   * A copy of an event or a result with its free text redacted, checked again against its schema: every
   * `message`, `details`, `expected`, `actual`, `observed`, address, page title and text host check's text, at any
   * depth. Page titles are then cut to the length Retest records, even while no value is known. Identifiers and
   * structure stay as they are, and a value with nothing to change is returned as it is.
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
   * the command went to, whose title is also cut to the length Retest records, or a failure.
   */
  redactCommandResult(result: CommandResult): CommandResult {
    if (!result.ok) return { ok: false, failure: this.redactFailure(result.failure) }
    const page = result.page === undefined ? {} : { page: this.#redactPage(result.page) }
    if (result.kind === 'observe') return { ...result, observation: this.#redactObservation(result.observation), ...page }
    return result.kind === 'goto' ? { ...result, url: this.redact(result.url), ...page } : { ...result, ...page }
  }

  /**
   * A page's title as Retest records it: every value in it redacted, and only then cut to `pageTitleLimit`, so a
   * value that runs past the cut is hidden whole rather than cut in two.
   *
   * @example redactor.redactTitle('Signed in as hunter2') // 'Signed in as {{password}}'
   */
  redactTitle(title: string): string {
    return recordedTitle(this.redact(title))
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
  // none of whose parts changed is returned as it is.
  #redactFields(value: unknown, inText: boolean): unknown {
    if (typeof value === 'string') return inText ? this.redact(value) : value
    if (Array.isArray(value)) {
      const items = value.map((item: unknown) => this.#redactFields(item, inText))
      return items.every((item, index) => item === value[index]) ? value : items
    }
    if (!isPlainObject(value)) return value
    const entries = Object.entries(value).map(([key, item]): [string, unknown] => {
      if (titleKeys.has(key) && typeof item === 'string') return [key, this.redactTitle(item)]
      return [key, this.#redactFields(item, inText || freeText.has(key) || isHostCheckText(value, key))]
    })
    return entries.every(([key, item]) => item === value[key]) ? value : Object.fromEntries(entries)
  }

  #redactPage({ url, title }: PageFacts): PageFacts {
    return title === undefined ? { url: this.redact(url) } : { url: this.redact(url), title: this.redactTitle(title) }
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

// A host check is recorded in its events, in `run.started` and in the result, and its text may hold a secret by
// mistake. A locator's `text` is an identifier and stays as it is.
function isHostCheckText(record: Record<string, unknown>, key: string): boolean {
  return key === 'text' && record['kind'] === 'text' && parse(hostCheckRecordSchema, record).ok
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
