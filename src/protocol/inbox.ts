import { failureSchema, type Failure } from './failures.ts'
import { textPatternSchema, type TextMatch } from './locator.ts'
import { s, type Schema } from './schema.ts'
import { secretPlaceholder } from './secret.ts'

/**
 * A code from a message an inbox gave the test, named in place of its value: the inbox, the message as the parent
 * numbered it for the attempt, and which of its codes, from 1. Only the parent knows the value.
 */
export type InboxCodeRef = { inbox: string; message: string; code: number }

/**
 * A link from such a message, by its number among the message's links, from 1. `default` marks the link `link()`
 * chose with no argument, which prints as `{{link}}`. Only the parent knows the address.
 */
export type InboxLinkRef = { inbox: string; message: string; link: number; default?: true }

/** What a test asks an inbox for: its newest message since the last one the test was given, by a subject when given. */
export type InboxRequest = { inbox: string; subject?: TextMatch }

/**
 * A link in a message as the test file's process receives it: its text, its origin, and its path with each token in it
 * replaced by the link's placeholder. `token` says whether the link carries a token, which makes it a secret. A query
 * and a fragment never reach the process.
 */
export type ReceivedLinkRecord = { text: string; origin: string; path: string; token: boolean }

/**
 * A message as the test file's process receives it. `id` names it within the attempt. `subject`, `from` and `text` have
 * every code and every link that carries a token replaced by its placeholder, and every value the run hides replaced
 * too. `codes` is how many codes it holds. `receivedAt` is when the mailbox received it, as an ISO time.
 */
export type ReceivedMessageRecord = {
  id: string
  inbox: string
  subject: string
  from: string
  text: string
  codes: number
  links: ReceivedLinkRecord[]
  receivedAt: string
}

/** The parent's answer to an inbox read: the message, or why there is none. */
export type InboxAnswer = { ok: true; message: ReceivedMessageRecord } | { ok: false; failure: Failure }

/** What stands for a message's code wherever Retest records or prints it. */
export const codePlaceholderName = 'code'

/**
 * The name a link's placeholder carries: `link:2` for a message's second link, `link` for the one `link()` chose.
 *
 * @example linkName(2) // 'link:2'
 */
export function linkName(index?: number): string {
  return index === undefined ? 'link' : `link:${index}`
}

/**
 * What stands for a link wherever Retest records or prints it.
 *
 * @example linkPlaceholder(2) // '{{link:2}}'
 */
export function linkPlaceholder(index?: number): string {
  return secretPlaceholder(linkName(index))
}

const index = s.number({ integer: true, min: 1 })

export const inboxCodeRefSchema: Schema<InboxCodeRef> = s.object({ inbox: s.string(), message: s.string(), code: index })

export const inboxLinkRefSchema: Schema<InboxLinkRef> = s.object({ inbox: s.string(), message: s.string(), link: index, default: s.optional(s.literal(true)) })

export const inboxRequestSchema: Schema<InboxRequest> = s.object({ inbox: s.string(), subject: s.optional(s.union([s.string(), textPatternSchema])) })

const receivedLinkRecordSchema: Schema<ReceivedLinkRecord> = s.object({ text: s.string(), origin: s.string(), path: s.string(), token: s.boolean() })

export const receivedMessageRecordSchema: Schema<ReceivedMessageRecord> = s.object({
  id: s.string(),
  inbox: s.string(),
  subject: s.string(),
  from: s.string(),
  text: s.string(),
  codes: s.number({ integer: true, min: 0 }),
  links: s.array(receivedLinkRecordSchema),
  receivedAt: s.string(),
})

export const inboxAnswerSchema: Schema<InboxAnswer> = s.union([
  s.object({ ok: s.literal(true), message: receivedMessageRecordSchema }),
  s.object({ ok: s.literal(false), failure: failureSchema }),
])

/**
 * The placeholder a code or a link prints as, as a command names it in a message.
 *
 * @example describeInboxReference({ inbox: 'owner', message: 'm1', link: 2 }) // '{{link:2}}'
 */
export function describeInboxReference(reference: InboxCodeRef | InboxLinkRef): string {
  if ('code' in reference) return secretPlaceholder(codePlaceholderName)
  return linkPlaceholder(reference.default === true ? undefined : reference.link)
}
