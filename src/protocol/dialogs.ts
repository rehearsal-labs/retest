import { failureSchema, type Failure } from './failures.ts'
import { s, type Schema } from './schema.ts'
import { quoteText } from './text.ts'

/** The kinds of JavaScript dialog a page can open. */
export type DialogType = 'alert' | 'confirm' | 'prompt' | 'beforeunload'

export const dialogTypes: readonly DialogType[] = ['alert', 'confirm', 'prompt', 'beforeunload']

/**
 * A dialog as the test file's process receives it: its id within the attempt, its kind, the text the page showed and a
 * prompt's default, both with every value the run hides replaced. A dialog other than a prompt has an empty default.
 */
export type DialogRecord = { id: string; type: DialogType; message: string; defaultValue: string }

/**
 * What a test asks of an app's page about dialogs: to wait for the next one, to stop a wait whose action failed before
 * any dialog opened, naming the wait by its id, or to answer a dialog it was given, with the text a prompt takes.
 */
export type DialogRequest = { kind: 'wait' } | { kind: 'stop'; wait: number } | { kind: 'answer'; dialog: string; accept: boolean; promptText?: string }

/**
 * The parent's answers. A wait is first `armed`, once the page hands its next dialog to the test, then `opened` with that
 * dialog, or `failed` at either point. A stop is `stopped`, and an answer `answered` or `failed`.
 */
export type DialogAnswer = { kind: 'armed' } | { kind: 'opened'; dialog: DialogRecord } | { kind: 'stopped' } | { kind: 'answered' } | { kind: 'failed'; failure: Failure }

/** How a dialog was answered: accepted or dismissed. */
export type DialogAnswered = 'accepted' | 'dismissed'

/** How many code units of a dialog's text an event records, as a title is cut. */
export const dialogTextLimit = 300

export const dialogTypeSchema: Schema<DialogType> = s.enum(['alert', 'confirm', 'prompt', 'beforeunload'])

export const dialogRecordSchema: Schema<DialogRecord> = s.object({ id: s.string(), type: dialogTypeSchema, message: s.string(), defaultValue: s.string() })

export const dialogRequestSchema: Schema<DialogRequest> = s.discriminatedUnion('kind', [
  s.object({ kind: s.literal('wait') }),
  s.object({ kind: s.literal('stop'), wait: s.number({ integer: true, min: 0 }) }),
  s.object({ kind: s.literal('answer'), dialog: s.string(), accept: s.boolean(), promptText: s.optional(s.string()) }),
])

export const dialogAnswerSchema: Schema<DialogAnswer> = s.discriminatedUnion('kind', [
  s.object({ kind: s.literal('armed') }),
  s.object({ kind: s.literal('opened'), dialog: dialogRecordSchema }),
  s.object({ kind: s.literal('stopped') }),
  s.object({ kind: s.literal('answered') }),
  s.object({ kind: s.literal('failed'), failure: failureSchema }),
])

/**
 * Whether a value names a kind of dialog, as Chrome's `Page.javascriptDialogOpening` reports it.
 *
 * @example isDialogType('confirm') // true
 */
export function isDialogType(value: string): value is DialogType {
  return dialogTypes.some((type) => type === value)
}

/**
 * Who reads a dialog's sentence: a test, which can wrap an action in `page.dialog()`, or an agent session, which cannot
 * and is told what Retest answered instead.
 */
export type DialogReader = 'test' | 'agent'

/** A dialog Retest answered itself because nothing waited for it, as a failure's sentence names it. */
export type UnwaitedDialogParts = {
  type: DialogType
  /** The text the page showed, as a sentence may quote it: redacted, or left out where it cannot be. */
  text?: string | undefined
  answered: DialogAnswered
  /** The command that was running, as a failure names it, such as "click getByTestId('delete')"; none when idle. */
  command?: string | undefined
  /** The dialog came from a page this page opened while nothing waited for it. */
  popup?: boolean | undefined
  /** Who reads the sentence; a test unless named. */
  reader?: DialogReader | undefined
}

/**
 * The sentence for a dialog nobody waited for, when it is the whole failure of the command that ran meanwhile: its kind
 * and text, what was running, how Retest answered it, and, for a test, how to answer it. A `beforeunload` dialog is
 * accepted, so the navigation the test asked for happens.
 *
 * @example unwaitedDialogMessage({ type: 'confirm', text: 'Delete?', answered: 'dismissed', command: "click getByTestId('delete')" })
 */
export function unwaitedDialogMessage(parts: UnwaitedDialogParts): string {
  const { type, command, popup, reader } = parts
  const agent = reader === 'agent'
  const who = popup === true ? 'A page this page opened showed' : agent ? 'The page showed' : 'The page opened'
  const when = command === undefined ? (agent ? 'between commands' : 'while no action was running') : `while Retest tried to ${command}`
  const opened = `${who} ${article(type)} ${type} dialog${says(parts.text)} ${when}.`
  if (agent) return `${opened} ${capitalize(answeredWords(parts))}.`
  const fix = popup === true ? 'To answer it, take that page with page.popup() and wrap its action in dialog().' : command === undefined ? 'To answer it, wrap the action that opens it in page.dialog().' : 'To answer it, wrap the action in page.dialog().'
  return `${opened} ${capitalize(answeredWords(parts))}. ${fix}`
}

/**
 * The sentence for a dialog nobody waited for, when the command that ran meanwhile failed of its own accord: it follows
 * that command's own message and names the dialog and Retest's answer.
 *
 * @example unwaitedDialogSentence({ type: 'alert', text: 'Saved', answered: 'dismissed' }) // 'The page also opened an alert dialog that says "Saved", and Retest dismissed it.'
 */
export function unwaitedDialogSentence(parts: UnwaitedDialogParts): string {
  const { type, popup, reader } = parts
  const verb = reader === 'agent' ? 'showed' : 'opened'
  const who = popup === true ? 'A page this page opened also showed' : `The page also ${verb}`
  return `${who} ${article(type)} ${type} dialog${says(parts.text)}, and ${answeredWords(parts)}.`
}

// What Retest did with a dialog, as a test reads it, or as an agent reads it: the answer a person would have given.
function answeredWords({ type, answered, reader }: UnwaitedDialogParts): string {
  if (reader !== 'agent') return answered === 'accepted' ? 'Retest accepted it, so the page could leave' : 'Retest dismissed it'
  if (answered === 'accepted') return 'Retest answered yes, so the page could leave'
  return type === 'alert' ? 'Retest closed it' : 'Retest answered no'
}

/**
 * A failure that names a dialog Retest answered, in words for its reader, with the dialog's text quoted once `redact` has
 * hidden every value in it. The page gives that text apart, in `details.dialogMessage`, and a failure whose `details`
 * name the command was the dialog's alone; any other is the command's own, with the dialog's sentence after it. Any
 * other failure is given back as it is.
 *
 * @example withDialogWords(failure, (text) => redactor.redact(text), 'agent')
 */
export function withDialogWords(failure: Failure, redact: (text: string) => string, reader: DialogReader = 'test'): Failure {
  const { details } = failure
  const text = details?.['dialogMessage']
  const type = details?.['dialog']
  const given = details?.['answered']
  const command = details?.['command']
  const answered: DialogAnswered | undefined = given === 'accepted' || given === 'dismissed' ? given : undefined
  if (typeof text !== 'string' || typeof type !== 'string' || !isDialogType(type) || answered === undefined) return failure
  const { dialogMessage: _text, command: _command, ...kept } = details ?? {}
  const parts = { type, answered, popup: details?.['popup'] === true, reader }
  if (typeof command === 'string') return { ...failure, message: unwaitedDialogMessage({ ...parts, text: redact(text), command }), details: kept }
  // The page wrote the dialog's sentence after the command's own message, for a test and without the text.
  const written = ` ${unwaitedDialogSentence({ type, answered, popup: parts.popup })}`
  const own = failure.message.endsWith(written) ? failure.message.slice(0, -written.length) : failure.message
  return { ...failure, message: `${own} ${unwaitedDialogSentence({ ...parts, text: redact(text) })}`, details: kept }
}

function says(text: string | undefined): string {
  return text === undefined || text === '' ? '' : ` that says ${quoteText(text)}`
}

function capitalize(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`
}

function article(word: string): string {
  return /^[aeiou]/.test(word) ? 'an' : 'a'
}
