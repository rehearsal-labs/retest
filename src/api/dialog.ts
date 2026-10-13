import type { DialogRecord, DialogType } from '../protocol/dialogs.ts'
import type { SourceLocation } from '../protocol/failures.ts'
import type { Dialog } from './page.ts'
import type { TestRun } from './test-run.ts'
import { readCallOptions } from './call-options.ts'
import { formatValue } from './format-value.ts'
import { misuse } from './misuse.ts'
import { isThenable } from './operation.ts'

/** A dialog the parent handed to the test, which the test answers through the page that showed it. */
export class AppDialog implements Dialog {
  readonly type: DialogType
  readonly message: string
  readonly defaultValue: string
  readonly #run: TestRun
  readonly #app: string
  readonly #id: string
  readonly #acted: Promise<void>
  #answered: { readonly how: string; readonly location: SourceLocation | undefined } | undefined

  constructor(run: TestRun, app: string, record: DialogRecord, acted: Promise<void>) {
    this.type = record.type
    this.message = record.message
    this.defaultValue = record.defaultValue
    this.#run = run
    this.#app = app
    this.#id = record.id
    this.#acted = acted
  }

  accept(promptText?: unknown): Promise<void> {
    const location = this.#run.location()
    if (promptText !== undefined && typeof promptText !== 'string') throw misuse(`accept() takes the text a prompt dialog answers with, received ${formatValue(promptText)}.`, this.#run)
    if (promptText !== undefined && this.type !== 'prompt') throw misuse(`accept() takes text only for a prompt dialog, and this is ${article(this.type)} ${this.type} dialog.`, this.#run)
    return this.#answer({ accept: true, promptText, label: 'dialog.accept()', how: 'accepted', location })
  }

  dismiss(): Promise<void> {
    return this.#answer({ accept: false, promptText: undefined, label: 'dialog.dismiss()', how: 'dismissed', location: this.#run.location() })
  }

  #answer({ accept, promptText, label, how, location }: Answer): Promise<void> {
    const answered = this.#answered
    if (answered !== undefined) throw misuse(`This ${this.type} dialog was already ${answered.how} on ${this.#run.describeLine(answered.location)}. Answer each dialog once.`, this.#run)
    this.#answered = { how, location }
    return this.#run.answerDialog({ app: this.#app, dialog: this.#id, accept, promptText, label, location, acted: this.#acted })
  }
}

type Answer = { readonly accept: boolean; readonly promptText: string | undefined; readonly label: string; readonly how: string; readonly location: SourceLocation | undefined }

/** The test, the app and the dialect behind a page, for the waits it starts. */
export type WaitTarget = { readonly run: TestRun; readonly app: string }

/**
 * Arms an app's page for its next dialog, runs `action`, and resolves with the dialog as soon as it opens, while the
 * action still waits on it. `options` may shorten the wait, as `{ timeout }` does an action's.
 *
 * @example const dialog = await waitForDialog({ run, app: 'web' }, () => page.getByRole('button', { name: 'Delete' }).click())
 */
export function waitForDialog({ run, app }: WaitTarget, action: unknown, options: unknown): Promise<AppDialog> {
  const location = run.location()
  const read = readOpening('dialog', run, action, options)
  return run.waitForDialog({ app, label: 'page.dialog()', location, timeoutMs: read.timeoutMs, action: read.action }, (record, acted) => new AppDialog(run, app, record, acted))
}

/** What a wait for a dialog or a popup was given, once read: the action, which must return a promise, and its time. */
export type OpeningCall = { readonly action: () => Promise<unknown>; readonly timeoutMs: number | undefined }

/**
 * Reads the action and the options `page.dialog()` or `page.popup()` was given, as a JavaScript caller may have passed
 * them any way it liked. The action must be a function, and what it returns must be a promise, the action's own.
 *
 * @example readOpening('popup', run, () => page.getByRole('link', { name: 'Terms' }).click(), undefined).timeoutMs // undefined
 */
export function readOpening(kind: 'dialog' | 'popup', run: TestRun, action: unknown, options: unknown): OpeningCall {
  const call = `page.${kind}()`
  const example = kind === 'dialog' ? "() => page.getByRole('button', { name: 'Delete' }).click()" : "() => page.getByRole('link', { name: 'Terms' }).click()"
  if (typeof action !== 'function') throw misuse(`${call} takes a function that runs the action, such as ${example}, received ${formatValue(action)}.`, run)
  const read = readCallOptions(kind, options)
  if (!read.ok) throw misuse(read.problem, run)
  const returning = async (): Promise<unknown> => {
    const returned: unknown = action()
    if (!isThenable(returned)) throw misuse(`${call} runs its function and waits for the promise it returns, and it returned ${formatValue(returned)}. Return the action, as in ${example}.`, run)
    return returned
  }
  return { action: returning, timeoutMs: read.timeoutMs }
}

function article(word: string): string {
  return /^[aeiou]/.test(word) ? 'an' : 'a'
}
