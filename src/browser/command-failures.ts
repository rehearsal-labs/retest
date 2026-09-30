import type { Failure } from '../protocol/failures.ts'
import { errorMessage, failureSchema } from '../protocol/failures.ts'
import { parse } from '../protocol/schema.ts'
import { CdpClosedError, CdpDisconnectedError, CdpTimeoutError } from './cdp/errors.ts'

/** A command as failure messages name it, such as "click getByTestId('save-task')", and how far it got. */
export type Attempt = {
  command: string
  timeoutMs: number
  /** True once the command's effect may have reached the page. */
  inputSent: boolean
}

/**
 * The failure for a command whose page went away: nothing happened if its input was never sent, and nobody
 * can tell otherwise.
 *
 * @example connectionEnded("click getByTestId('save-task')", true, 'the browser closed the pipe')
 */
export function connectionEnded(command: string, inputSent: boolean, reason: string): Failure {
  if (inputSent) {
    return {
      class: 'outcome_unknown',
      message: `Retest lost the page after it began to ${command}, so it cannot tell whether that took effect: ${reason}.`,
      details: { reason },
    }
  }
  return {
    class: 'session_lost',
    message: `Retest lost the page before it could ${command}: ${reason}.`,
    details: { reason },
  }
}

/**
 * The failure for a command its caller stopped. `reason` is the `Failure` that says why, and gives the class;
 * any other reason reads as the command's time running out. Input already sent is not taken back.
 *
 * @example commandStopped("click getByTestId('save-task')", false, { class: 'timeout', message: 'The test ran longer than its 400 ms budget.' })
 */
export function commandStopped(command: string, inputSent: boolean, reason: unknown): Failure {
  const parsed = parse(failureSchema, reason)
  const cause: Failure = parsed.ok ? parsed.value : { class: 'timeout', message: `The time to ${command} ran out.` }
  const input = inputSent
    ? `Retest had already begun to ${command}. Input it sent is not taken back, so it may have taken effect.`
    : `Retest stopped before it could ${command}, and sent nothing.`
  return { class: cause.class, message: `${cause.message} ${input}`, details: { ...cause.details, inputSent } }
}

/**
 * The failure for a command the page could not take because it opened a JavaScript dialog, which blocks it.
 *
 * @example dialogOpened("click getByTestId('delete')", 'confirm', true)
 */
export function dialogOpened(command: string, dialog: string, inputSent: boolean): Failure {
  return {
    class: 'unsupported',
    message: `The page opened ${article(dialog)} ${dialog} dialog while Retest tried to ${command}. Retest does not answer dialogs yet, and the dialog blocks the page.`,
    details: { dialog, inputSent },
  }
}

/**
 * Turns an error from talking to the browser into the command's failure. An error that says nothing about the
 * page, such as a result Retest cannot read, is thrown again unless input may already have reached the page.
 */
export function failureFromError(error: unknown, attempt: Attempt): Failure {
  if (error instanceof CdpDisconnectedError || error instanceof CdpClosedError) {
    return connectionEnded(attempt.command, attempt.inputSent, error.reason)
  }
  if (error instanceof CdpTimeoutError) return timedOut(attempt)
  if (!attempt.inputSent) throw error
  return {
    class: 'outcome_unknown',
    message: `Retest began to ${attempt.command}, then the browser gave an answer it cannot read, so it cannot tell whether that took effect: ${errorMessage(error)}`,
  }
}

function timedOut({ command, timeoutMs, inputSent }: Attempt): Failure {
  if (inputSent) {
    return {
      class: 'timeout',
      message: `Retest began to ${command}, but the page did not confirm it within ${timeoutMs} ms. It may or may not have taken effect.`,
      details: { inputSent: true },
    }
  }
  return {
    class: 'timeout',
    message: `The page did not answer within ${timeoutMs} ms while Retest tried to ${command}.`,
    details: { inputSent: false },
  }
}

function article(word: string): string {
  return /^[aeiou]/.test(word) ? 'an' : 'a'
}
