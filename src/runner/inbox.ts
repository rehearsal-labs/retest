import type { LoadedInbox } from '../config/loaded.ts'
import type { Failure } from '../protocol/failures.ts'
import type { InboxAnswer, InboxCodeRef, InboxLinkRef, InboxRequest, ReceivedLinkRecord, ReceivedMessageRecord } from '../protocol/inbox.ts'
import type { LocatorRecipe, TextMatch } from '../protocol/locator.ts'
import type { ReadLink } from './inbox-links.ts'
import type { Redactor } from './redactor.ts'
import type { FillContext, FillResolution, Located } from './secrets.ts'
import { waitBeforeRead } from '../assertions/wait-before-read.ts'
import { matchesText } from '../browser/text-match.ts'
import { Deadline, elapsedMs, monotonicClock } from '../protocol/deadline.ts'
import { errorMessage, failure, failureSchema } from '../protocol/failures.ts'
import { codePlaceholderName, describeInboxReference, linkName, linkPlaceholder } from '../protocol/inbox.ts'
import { describeTextMatch, patternProblem } from '../protocol/locator.ts'
import { isArray, isPlainObject, parse } from '../protocol/schema.ts'
import { originOf } from '../protocol/url.ts'
import { bounded } from './bounded.ts'
import { readLink } from './inbox-links.ts'
import { locateFill } from './secrets.ts'

/** How long a read may look, and the signal that stops it, as when its test is stopped. */
export type InboxReadBudget = { readonly timeoutMs: number; readonly signal: AbortSignal }

/**
 * How a read ended, as its event records it: the answer for the test, how many messages the mailbox held on the last
 * look, how many times Retest asked it, and how long the read took.
 */
export type InboxRead = { readonly answer: InboxAnswer; readonly messages: number; readonly looks: number; readonly waitedMs: number }

/** A code fill as the test file's process sends it: the code by its message and number, never its value. */
export type InboxCodeFill = { kind: 'fill'; locator: LocatorRecipe; value: InboxCodeRef }

/** Where a link from an inbox may open: the origins of the base URLs of the test's apps. */
export type LinkContext = { readonly appOrigins: readonly string[] }

/** A link resolved to its address, or why it may not open. */
export type LinkResolution = { ok: true; url: string } | { ok: false; failure: Failure }

export type AttemptInboxOptions = {
  readonly inboxes: ReadonlyMap<string, LoadedInbox>
  readonly redactor: Redactor
  /** When the attempt started, in milliseconds since 1970. A message received before then is not the test's. */
  readonly startedAt: number
}

/** A message as the source gave it, once its shape is checked, with when it arrived in milliseconds since 1970. */
type SourceMessage = {
  readonly subject: string
  readonly from: string
  readonly text: string
  readonly codes: readonly string[]
  readonly links: readonly { readonly url: string; readonly text: string }[]
  readonly receivedAt: number
}

/** A message the attempt was given, kept so its codes and links can be resolved later. */
type GivenMessage = { readonly inbox: string; readonly subject: string; readonly codes: readonly string[]; readonly links: readonly (ReadLink | undefined)[] }

/** What the attempt was given from one inbox: the latest arrival, and every message, by what it holds. */
type InboxHistory = { receivedAt: number; readonly given: Set<string> }

/**
 * A read that found nothing: what it asked, how often it looked, and what the mailbox held on the last look that
 * answered. `last` says whether the last look answered, gave no answer after an earlier one did, or whether no look did.
 */
type Unarrived = {
  request: InboxRequest
  looks: number
  held: readonly SourceMessage[]
  fresh: readonly SourceMessage[]
  timeoutMs: number
  last: 'answered' | 'unanswered' | 'silent'
}

type Look = { kind: 'messages'; messages: SourceMessage[] } | { kind: 'timed_out' } | { kind: 'failed'; failure: Failure }

/** The shortest code Retest hides safely, as for a secret. */
const minCodeLength = 4

// How long a read waits between looks: a mailbox is a service of its own, asked more gently than a page.
const pauses: readonly number[] = [100, 250, 500, 1000]

/**
 * One attempt's reads of the run's inboxes. Each read asks the mailbox again until a message arrives that was received
 * since the attempt started, and since the last message the attempt was given from that inbox, and that has the
 * subject the test asked for, or until its time runs out. Every code and every token in a link that a mailbox gives is
 * taught to the redactor as it arrives, whether or not the test is given that message. The test's process receives the
 * message with its codes and those links replaced by placeholders, and names a code or a link by its message and number;
 * only this process reads the values, and binds them to origins as it binds a secret.
 */
export class AttemptInbox {
  readonly #inboxes: ReadonlyMap<string, LoadedInbox>
  readonly #redactor: Redactor
  readonly #startedAt: number
  readonly #given = new Map<string, GivenMessage>()
  readonly #histories = new Map<string, InboxHistory>()

  constructor({ inboxes, redactor, startedAt }: AttemptInboxOptions) {
    this.#inboxes = inboxes
    this.#redactor = redactor
    this.#startedAt = startedAt
  }

  /** Reads an inbox for the test, looking again until a message arrives or the read's time runs out. */
  async read(request: InboxRequest, { timeoutMs, signal }: InboxReadBudget): Promise<InboxRead> {
    const startedAt = monotonicClock()
    const ended = (answer: InboxAnswer, messages: number, looks: number): InboxRead => ({ answer, messages, looks, waitedMs: elapsedMs(startedAt) })
    const inbox = this.#inboxes.get(request.inbox)
    if (inbox === undefined) return ended({ ok: false, failure: unknownInbox(request.inbox, [...this.#inboxes.keys()]) }, 0, 0)
    const problem = subjectProblem(request.subject)
    if (problem !== undefined) return ended({ ok: false, failure: problem }, 0, 0)
    const deadline = new Deadline(timeoutMs, { signal })
    const history = this.#history(request.inbox)
    let looks = 0
    let held: SourceMessage[] = []
    let fresh: SourceMessage[] = []
    let answered = false
    for (;;) {
      looks += 1
      const look = await this.#look(request.inbox, inbox, deadline, signal)
      if (look.kind === 'failed') return ended({ ok: false, failure: look.failure }, held.length, looks)
      if (look.kind === 'messages') {
        answered = true
        held = look.messages
        fresh = this.#fresh(held, history)
        const chosen = fresh.find((message) => request.subject === undefined || matchesText(this.#hidden(message, message.subject), request.subject, false))
        if (chosen !== undefined) return ended(this.#give(request.inbox, chosen, history), held.length, looks)
      }
      const last = look.kind === 'timed_out' ? (answered ? 'unanswered' : 'silent') : 'answered'
      if (deadline.reached) return ended({ ok: false, failure: this.#nothingArrived({ request, looks, held, fresh, timeoutMs, last }) }, held.length, looks)
      try {
        await waitBeforeRead(deadline, pauses[Math.min(looks, pauses.length) - 1] ?? 1000)
      } catch (error) {
        if (!signal.aborted) throw error
        return ended({ ok: false, failure: stopped(request.inbox, signal.reason) }, held.length, looks)
      }
    }
  }

  /**
   * Turns a fill of a code into the text the page types, bound to the origins the code may be typed on: those of the
   * test's apps' base URLs and the inbox's own, or on an Electron app's window only the inbox's. A native app takes none.
   */
  async resolveCode(command: InboxCodeFill, context: FillContext): Promise<FillResolution> {
    const reference = command.value
    const given = this.#given.get(reference.message)
    const inbox = this.#inboxes.get(reference.inbox)
    if (given === undefined || given.inbox !== reference.inbox || inbox === undefined) return refused('usage', notGiven('code', reference.inbox))
    const code = given.codes[reference.code - 1]
    if (code === undefined) return refused('usage', `The message ${JSON.stringify(given.subject)} from the inbox ${JSON.stringify(reference.inbox)} holds no code, so Retest typed nothing.`)
    if (context.bundleId !== undefined) return refused('unsupported', `Retest types a code from an inbox only into a web page, and typed nothing into ${context.bundleId}.`, { bundleId: context.bundleId })
    const electron = context.target === 'electron'
    const allowedOrigins = electron ? [...inbox.origins] : [...new Set([...context.appOrigins, ...inbox.origins])]
    const located: Located = await locateFill(context)
    if (located.kind === 'stopped') return { ok: false, failure: stoppedFill(reference.inbox, context.signal.reason) }
    const web = originOf(located.pageUrl)
    if (web === undefined || !allowedOrigins.includes(web)) {
      return refused('not_actionable', wrongCodeOrigin({ inbox: reference.inbox, origin: web, allowed: allowedOrigins, electron }), { origin: web ?? null })
    }
    return { ok: true, command: { kind: 'fill', locator: command.locator, value: code, secret: codePlaceholderName, allowedOrigins } }
  }

  /** Turns a link into the address the page opens, when its origin is one of the test's apps' or the inbox's own. */
  resolveLink(reference: InboxLinkRef, { appOrigins }: LinkContext): LinkResolution {
    const given = this.#given.get(reference.message)
    const inbox = this.#inboxes.get(reference.inbox)
    if (given === undefined || given.inbox !== reference.inbox || inbox === undefined) return refusedLink('usage', notGiven('link', reference.inbox))
    const shown = describeInboxReference(reference)
    if (reference.link > given.links.length) {
      return refusedLink('usage', `The message ${JSON.stringify(given.subject)} from the inbox ${JSON.stringify(reference.inbox)} holds no link ${reference.link}, so Retest opened nothing.`)
    }
    const link = given.links[reference.link - 1]
    if (link === undefined) return refusedLink('unsupported', `${shown} from the inbox ${JSON.stringify(reference.inbox)} is not an http or https address, so Retest opened nothing.`)
    const allowed = [...new Set([...appOrigins, ...inbox.origins])]
    const { origin } = link.url
    if (!allowed.includes(origin)) {
      const permitted = allowed.length === 0 ? 'no origin, since no app the test uses has a base URL and the inbox lists no origins' : allowed.join(', ')
      const message = `Retest did not open ${shown} from the inbox ${JSON.stringify(reference.inbox)}: it goes to ${origin}, and a link from this inbox may open only on ${permitted}. Add the origin to the inbox's origins if it belongs there.`
      return { ok: false, failure: { ...failure('not_actionable', message), details: { origin } } }
    }
    return { ok: true, url: link.url.href }
  }

  #history(inbox: string): InboxHistory {
    const known = this.#histories.get(inbox)
    if (known !== undefined) return known
    const history: InboxHistory = { receivedAt: this.#startedAt, given: new Set() }
    this.#histories.set(inbox, history)
    return history
  }

  // One look at the mailbox, within the read's time. The function is told through its signal when Retest stops waiting.
  // Whatever it gives is taught to the redactor as it arrives, even after the read stopped waiting for it, since the app
  // may show it next.
  async #look(name: string, inbox: LoadedInbox, deadline: Deadline, signal: AbortSignal): Promise<Look> {
    const waiting = new AbortController()
    const stop = Promise.withResolvers<void>()
    const onAbort = (): void => stop.resolve()
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
    const reading = inbox.read({ signal: waiting.signal })
    void reading.then((value) => this.#learn(value), () => undefined)
    const read = await bounded(reading, deadline.commandTimeoutMs, stop.promise)
    signal.removeEventListener('abort', onAbort)
    if (read.status === 'stopped') {
      waiting.abort(new DOMException(`Retest stopped reading the inbox ${JSON.stringify(name)}: its read was stopped.`, 'AbortError'))
      return { kind: 'failed', failure: stopped(name, signal.reason) }
    }
    if (read.status === 'timed_out') {
      waiting.abort(new DOMException(`Retest stopped reading the inbox ${JSON.stringify(name)}: it took longer than ${deadline.budgetMs} ms.`, 'TimeoutError'))
      return { kind: 'timed_out' }
    }
    if (read.status === 'failed') return { kind: 'failed', failure: failure('setup_failed', `Retest could not read the inbox ${JSON.stringify(name)}: ${this.#redactor.redact(errorMessage(read.error))}`) }
    const checked = checkMessages(read.value)
    if (typeof checked === 'string') return { kind: 'failed', failure: failure('setup_failed', `The inbox ${JSON.stringify(name)} gave messages Retest cannot read: ${checked}.`) }
    return { kind: 'messages', messages: checked }
  }

  // Each token of each link is hidden as its link's placeholder, and each code as `{{code}}`, which is learned last so a
  // code a link carries reads as the code. Only text long enough to hide safely is learned.
  #learn(value: unknown): void {
    if (!isArray(value)) return
    for (const message of value) {
      if (!isPlainObject(message)) continue
      const codes = isArray(message['codes']) ? message['codes'].filter((code): code is string => typeof code === 'string') : []
      const links = isArray(message['links']) ? message['links'] : []
      for (const [index, link] of links.entries()) {
        const url = isPlainObject(link) ? link['url'] : undefined
        const read = typeof url === 'string' ? readLink(url, codes) : undefined
        for (const token of read?.tokens ?? []) if (token.length >= minCodeLength) this.#redactor.learn(linkName(index + 1), token)
      }
      for (const code of codes) if (code.length >= minCodeLength) this.#redactor.learn(codePlaceholderName, code)
    }
  }

  // The messages received since the attempt started, and since the last one it was given from this inbox, that it was
  // not given already, newest first. Two messages received at the same moment keep the mailbox's order.
  #fresh(messages: readonly SourceMessage[], history: InboxHistory): SourceMessage[] {
    const fresh = messages.filter((message) => message.receivedAt >= history.receivedAt && !history.given.has(fingerprint(message)))
    return fresh.toSorted((first, second) => second.receivedAt - first.receivedAt)
  }

  #give(inbox: string, message: SourceMessage, history: InboxHistory): InboxAnswer {
    const short = message.codes.find((code) => code.length < minCodeLength)
    if (short !== undefined) {
      return { ok: false, failure: failure('setup_failed', `The inbox ${JSON.stringify(inbox)} gave a message with a code shorter than ${minCodeLength} characters, too short to redact safely, so Retest gave the test nothing.`) }
    }
    history.given.add(fingerprint(message))
    history.receivedAt = Math.max(history.receivedAt, message.receivedAt)
    const id = `m${this.#given.size + 1}`
    const reads = message.links.map((link) => readLink(link.url, message.codes))
    const subject = this.#hidden(message, message.subject)
    this.#given.set(id, { inbox, subject, codes: message.codes, links: reads })
    const links = message.links.map((link, index): ReceivedLinkRecord => {
      const read = reads[index]
      const text = this.#hidden(message, link.text)
      if (read === undefined) return { text, origin: '', path: '', token: false }
      return { text, origin: read.url.origin, path: this.#redactor.redact(read.url.pathname), token: read.tokens.length > 0 }
    })
    const record: ReceivedMessageRecord = {
      id,
      inbox,
      subject,
      from: this.#hidden(message, message.from),
      text: this.#hidden(message, message.text),
      codes: message.codes.length,
      links,
      receivedAt: new Date(message.receivedAt).toISOString(),
    }
    return { ok: true, message: record }
  }

  // Text of a message as the test reads it: each link that carries a token, written whole, replaced by its placeholder,
  // and then every value the run hides, the message's codes and the tokens of its links among them.
  #hidden(message: SourceMessage, text: string): string {
    const whole = message.links.flatMap((link, index) => {
      const read = readLink(link.url, message.codes)
      if (read === undefined || read.tokens.length === 0) return []
      return [...new Set([link.url.trim(), read.url.href])].map((written) => ({ written, placeholder: linkPlaceholder(index + 1) }))
    })
    whole.sort((first, second) => second.written.length - first.written.length)
    let replaced = text
    for (const { written, placeholder } of whole) replaced = replaced.replaceAll(written, placeholder)
    return this.#redactor.redact(replaced)
  }

  #nothingArrived({ request, looks, held, fresh, timeoutMs, last }: Unarrived): Failure {
    const history = this.#histories.get(request.inbox)
    const since = history !== undefined && history.given.size > 0 ? 'since the last message this test was given' : 'since the test started'
    const wanted = request.subject === undefined ? '' : `, and none of them has a subject matching ${describeTextMatch(request.subject)}`
    const holding = held.length === 0 ? 'the inbox held no message' : `the inbox held ${count(held.length, 'message')}, ${fresh.length === 0 ? 'none' : String(fresh.length)} received ${since}${fresh.length === 0 ? '' : wanted}`
    const seen =
      last === 'answered' ? `On the last look, ${holding}.`
      : last === 'silent' ? 'The inbox gave no answer in that time.'
      : `The last look got no answer in the time left. On the last look that answered, ${holding}.`
    const message = `No message arrived in the inbox ${JSON.stringify(request.inbox)} within ${timeoutMs} ms. Retest looked ${count(looks, 'time')}. ${seen}`
    return { ...failure('timeout', message), details: { inbox: request.inbox, looks, messages: held.length, fresh: fresh.length, timeoutMs } }
  }
}

/**
 * Checks what an inbox's function gave: a list of messages, each with a subject, a sender and text, a list of codes, a
 * list of links of `{ url, text }`, and when it arrived. A problem names the message and the field, never a value.
 *
 * @example checkMessages([{ subject: 'Hi' }]) // 'message 1 has no from'
 */
export function checkMessages(value: unknown): SourceMessage[] | string {
  if (!isArray(value)) return `expected a list of messages, received ${kindOf(value)}`
  const messages: SourceMessage[] = []
  for (const [index, message] of value.entries()) {
    const which = `message ${index + 1}`
    if (!isPlainObject(message)) return `${which} is ${kindOf(message)}, not an object`
    const { subject, from, text, codes, links, receivedAt } = message
    if (typeof subject !== 'string') return fieldProblem(which, 'subject', subject)
    if (typeof from !== 'string') return fieldProblem(which, 'from', from)
    if (typeof text !== 'string') return fieldProblem(which, 'text', text)
    if (!isArray(codes) || codes.some((code) => typeof code !== 'string' || code === '')) return `${which} has codes that are not a list of text`
    const checkedLinks: { url: string; text: string }[] = []
    if (!isArray(links)) return `${which} has links that are not a list`
    for (const [place, link] of links.entries()) {
      if (!isPlainObject(link) || typeof link['url'] !== 'string' || typeof link['text'] !== 'string') return `link ${place + 1} of ${which} is not { url, text }`
      checkedLinks.push({ url: link['url'], text: link['text'] })
    }
    const time = timeOf(receivedAt)
    if (time === undefined) return `${which} has no receivedAt that reads as a time`
    messages.push({ subject, from, text, codes: codes.filter((code): code is string => typeof code === 'string'), links: checkedLinks, receivedAt: time })
  }
  return messages
}

function fieldProblem(which: string, key: string, field: unknown): string {
  return field === undefined ? `${which} has no ${key}` : `${which} has a ${key} that is ${kindOf(field)}, not text`
}

function timeOf(value: unknown): number | undefined {
  const time = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : Number.NaN
  return Number.isFinite(time) ? time : undefined
}

// What a message holds, as the attempt tells two messages apart: two alike in every field are one message.
function fingerprint(message: SourceMessage): string {
  return JSON.stringify([message.receivedAt, message.subject, message.from, message.text, message.codes, message.links])
}

function unknownInbox(name: string, declared: readonly string[]): Failure {
  const known = declared.length === 0 ? 'This run has no inboxes.' : `The config's inboxes are ${declared.map((each) => JSON.stringify(each)).join(', ')}.`
  return failure('usage', `inbox(${JSON.stringify(name)}) is not one of the config's inboxes. ${known}`)
}

function subjectProblem(subject: TextMatch | undefined): Failure | undefined {
  if (subject === undefined || typeof subject === 'string') return undefined
  const problem = patternProblem(subject)
  return problem === undefined ? undefined : failure('usage', `latest() received a subject RegExp Retest cannot read: ${problem}.`)
}

function notGiven(what: 'code' | 'link', inbox: string): string {
  return `This ${what} belongs to no message the inbox ${JSON.stringify(inbox)} gave this test, so Retest ${what === 'code' ? 'typed' : 'opened'} nothing.`
}

// A read stopped while it waited ends as the reason it was stopped says.
function stopped(inbox: string, reason: unknown): Failure {
  const parsed = parse(failureSchema, reason)
  const cause = parsed.ok ? parsed.value : failure('interrupted', 'The read was stopped.')
  return { ...cause, message: `${cause.message} Retest stopped reading the inbox ${JSON.stringify(inbox)}.` }
}

function stoppedFill(inbox: string, reason: unknown): Failure {
  const parsed = parse(failureSchema, reason)
  const cause = parsed.ok ? parsed.value : failure('interrupted', 'The fill was stopped.')
  const message = `${cause.message} Retest stopped waiting for the page to open an address for the code from the inbox ${JSON.stringify(inbox)}, and typed nothing.`
  return { class: cause.class, message, details: { ...cause.details, inputSent: false } }
}

type CodeRefusal = { inbox: string; origin: string | undefined; allowed: readonly string[]; electron: boolean }

function wrongCodeOrigin({ inbox, origin, allowed, electron }: CodeRefusal): string {
  const where = origin === undefined ? 'the page has not opened a web address yet' : `the page is on ${origin}`
  const none = electron ? 'no origin, since in an Electron app only the inbox\'s origins count and it lists none' : 'no origin, since no app the test uses has a base URL and the inbox lists no origins'
  const permitted = allowed.length === 0 ? none : allowed.join(', ')
  return `Retest did not type the code from the inbox ${JSON.stringify(inbox)}: ${where}, and it may be typed only on ${permitted}. Add the origin to the inbox's origins if it belongs there.`
}

function refused(kind: Failure['class'], message: string, details?: Failure['details']): FillResolution {
  return { ok: false, failure: { ...failure(kind, message), ...(details === undefined ? {} : { details }) } }
}

function refusedLink(kind: Failure['class'], message: string): LinkResolution {
  return { ok: false, failure: failure(kind, message) }
}

function count(amount: number, noun: string): string {
  return `${amount} ${noun}${amount === 1 ? '' : 's'}`
}

function kindOf(value: unknown): string {
  if (value === null) return 'null'
  return Array.isArray(value) ? 'an array' : typeof value
}
