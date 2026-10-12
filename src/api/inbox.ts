import type { InboxName } from '../config/register.ts'
import type { InboxCodeRef, InboxLinkRef, InboxRequest, ReceivedMessageRecord } from '../protocol/inbox.ts'
import { inspect } from 'node:util'
import { describeInboxReference } from '../protocol/inbox.ts'
import { patternProblem, textPatternOf } from '../protocol/locator.ts'
import { isPlainObject } from '../protocol/schema.ts'
import { maxTimeout } from '../protocol/timeouts.ts'
import { requireScope } from './context.ts'
import { formatValue } from './format-value.ts'
import { misuse } from './misuse.ts'
import { Secret } from './secret.ts'

/**
 * How `latest()` reads: `subject` picks the newest message whose subject holds this text, in any case, or matches this
 * `RegExp`, as the test reads the subject, with its codes and links replaced by placeholders. `timeout` is how long it
 * looks, in milliseconds, the assertion budget by default, never longer than the test has left.
 */
export type InboxReadOptions = { readonly subject?: string | RegExp | undefined; readonly timeout?: number | undefined }

/** Which link `link()` takes: its number among the message's links, from 1, or the first whose path is `path` or lies under it. */
export type LinkChoice = number | { readonly path: string }

/**
 * A link in a received message: the text it was shown under, its origin, and its path with each token in it replaced
 * by its placeholder. `token` says whether it carries a token. Its query and fragment are never in the test's process.
 */
export type ReceivedLink = { readonly text: string; readonly origin: string; readonly path: string; readonly token: boolean }

let codeReference: ((code: InboxCode) => InboxCodeRef) | undefined
let linkReference: ((link: InboxLink) => InboxLinkRef) | undefined

/**
 * A one-time code from a message, named but never held: the process that runs Retest types it, bound to origins as a
 * secret is. It is a secret, so it goes only to `fill()`, and however it is printed it reads `{{code}}`.
 */
export class InboxCode extends Secret {
  readonly #reference: InboxCodeRef

  static {
    codeReference = (code) => code.#reference
  }

  constructor(reference: InboxCodeRef) {
    super('code')
    this.#reference = reference
  }
}

/**
 * A link from a message, named but never held: the process that runs Retest opens it, when its origin is one the test
 * may open. It goes only to `goto()`, and however it is printed it reads `{{link}}`, or `{{link:2}}` when it was chosen
 * by number or path.
 */
export class InboxLink {
  readonly #reference: InboxLinkRef

  static {
    linkReference = (link) => link.#reference
    // Node's inspect hook sits on the prototype, off the declared type, so the public type needs no Node types.
    Object.defineProperty(InboxLink.prototype, inspect.custom, {
      value(this: InboxLink): string {
        return this.toString()
      },
    })
  }

  constructor(reference: InboxLinkRef) {
    this.#reference = reference
  }

  toString(): string {
    return describeInboxReference(this.#reference)
  }

  toJSON(): string {
    return this.toString()
  }
}

/**
 * A message an inbox gave the test. `subject`, `from` and `text` have each code written `{{code}}` and each link that
 * carries a token written `{{link:1}}`, `{{link:2}}` and so on, by its number. `code` is its first code, for `fill()`,
 * and `link()` one of its links, for `goto()`; the test's process never holds either value.
 */
export class ReceivedMessage {
  readonly subject: string
  readonly from: string
  readonly text: string
  /** When the mailbox received it. */
  readonly receivedAt: Date
  readonly links: readonly ReceivedLink[]
  /** The message's first code. A fill of it fails when the message holds none. */
  readonly code: InboxCode
  readonly #record: ReceivedMessageRecord

  constructor(record: ReceivedMessageRecord) {
    this.#record = record
    this.subject = record.subject
    this.from = record.from
    this.text = record.text
    this.receivedAt = new Date(record.receivedAt)
    this.links = Object.freeze(record.links.map((link) => Object.freeze({ ...link })))
    this.code = new InboxCode({ inbox: record.inbox, message: record.id, code: 1 })
  }

  /**
   * One of the message's links, for `goto()`. With no argument, the first link that carries a token, or else the first
   * link. A number takes that link, from 1; `{ path }` the first link whose path is `path` or lies under it.
   *
   * @example await page.goto(message.link({ path: '/verify' }))
   */
  link(choice?: LinkChoice): InboxLink {
    const { inbox, id } = this.#record
    const chosen = this.#choose(choice)
    if (typeof chosen === 'string') throw misuse(chosen)
    return new InboxLink({ inbox, message: id, link: chosen, ...(choice === undefined ? { default: true as const } : {}) })
  }

  // A link's number from 1, or why there is none to take.
  #choose(choice: unknown): number | string {
    const { links } = this
    const subject = JSON.stringify(this.subject)
    if (choice === undefined) {
      if (links.length === 0) return `link() found no link in the message ${subject}.`
      const carrying = links.findIndex((link) => link.token)
      return (carrying === -1 ? 0 : carrying) + 1
    }
    if (typeof choice === 'number') {
      if (Number.isInteger(choice) && choice >= 1 && choice <= links.length) return choice
      return `link(${formatValue(choice)}) takes a link's number from 1 to ${links.length}, the links of the message ${subject}.`
    }
    if (isPlainObject(choice) && Object.keys(choice).length === 1 && typeof choice['path'] === 'string') {
      const path = choice['path']
      const under = path.endsWith('/') ? path : `${path}/`
      const found = links.findIndex((link) => link.path === path || link.path.startsWith(under))
      if (found !== -1) return found + 1
      const paths = links.map((link) => link.path).filter((each) => each !== '')
      const listed = paths.length === 0 ? 'Its links have no web address.' : `Its links go to ${paths.join(', ')}.`
      return `link({ path: ${JSON.stringify(path)} }) matches no link in the message ${subject}. ${listed}`
    }
    return `link() takes a link's number from 1, such as link(2), or its path, such as link({ path: '/verify' }), received ${formatValue(choice)}.`
  }
}

/** A test mailbox from the config, named for the reads a test makes of it. */
export class Inbox {
  readonly #name: string

  constructor(name: string) {
    this.#name = name
  }

  /** The inbox's name in the config. */
  get name(): string {
    return this.#name
  }

  /**
   * Waits for the newest message the mailbox received since the test started, or since the last message this test was
   * given from it, and gives it to the test. It looks again, as a matcher does, until one arrives or its time runs out.
   *
   * @example const message = await inbox('owner').latest({ subject: 'Your sign-in code' })
   */
  latest(options?: InboxReadOptions): Promise<ReceivedMessage> {
    const call = `inbox(${JSON.stringify(this.#name)}).latest()`
    const { run } = requireScope(call)
    const location = run.location()
    const read = readOptions(options)
    if (typeof read === 'string') throw misuse(`${call} ${read}`, run)
    const request: InboxRequest = { inbox: this.#name, ...(read.subject === undefined ? {} : { subject: read.subject }) }
    return run.readInbox({ label: call, request, location, ...(read.timeoutMs === undefined ? {} : { timeoutMs: read.timeoutMs }) }, (record) => new ReceivedMessage(record))
  }
}

/**
 * Names an inbox from the config, whose messages a test reads with `latest()`. The test's process never holds a code or
 * a link that carries a token.
 *
 * @example
 * const message = await inbox('owner').latest({ subject: 'Your sign-in code' })
 * await page.getByLabel('Code').fill(message.code)
 */
export function inbox(name: InboxName): Inbox {
  // Read as JavaScript passed it: a registered config narrows the type, not what arrives.
  const given: unknown = name
  if (typeof given !== 'string' || given === '') throw misuse(`inbox() takes the name of an inbox from the config, received ${formatValue(given)}.`)
  return new Inbox(given)
}

/** The code a value names, when it is a code from an inbox. */
export function inboxCodeReference(value: unknown): InboxCodeRef | undefined {
  return value instanceof InboxCode ? codeReference?.(value) : undefined
}

/** The link a value names, when it is a link from an inbox. */
export function inboxLinkReference(value: unknown): InboxLinkRef | undefined {
  return value instanceof InboxLink ? linkReference?.(value) : undefined
}

type ReadOptions = { readonly subject?: InboxRequest['subject']; readonly timeoutMs?: number }

// Every option is checked, because JavaScript callers have no types. A key set to undefined counts as absent.
function readOptions(options: unknown): ReadOptions | string {
  if (options === undefined) return {}
  if (!isPlainObject(options)) return `takes options such as { subject: 'Your code', timeout: 10_000 }, received ${formatValue(options)}.`
  const given = Object.entries(options).filter(([, value]) => value !== undefined)
  const unknown = given.find(([key]) => key !== 'subject' && key !== 'timeout')
  if (unknown !== undefined) return `has no option ${JSON.stringify(unknown[0])}. It takes subject and timeout.`
  const { subject, timeout } = Object.fromEntries(given)
  if (timeout !== undefined && !(typeof timeout === 'number' && Number.isInteger(timeout) && timeout >= 1 && timeout <= maxTimeout)) {
    return `takes timeout as a whole number of milliseconds from 1 to ${maxTimeout}, received ${formatValue(timeout)}.`
  }
  const timed = timeout === undefined ? {} : { timeoutMs: timeout }
  if (subject === undefined) return timed
  if (typeof subject === 'string') return subject === '' ? 'takes subject as text to find in the subject, received an empty string.' : { subject, ...timed }
  if (!(subject instanceof RegExp)) return `takes subject as text or a RegExp, received ${formatValue(subject)}.`
  const pattern = textPatternOf(subject)
  const problem = patternProblem(pattern)
  return problem === undefined ? { subject: pattern, ...timed } : `received a subject RegExp Retest cannot read: ${problem}.`
}
