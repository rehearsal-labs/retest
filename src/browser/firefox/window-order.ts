import type { BidiClient } from './bidi-client.ts'
import type { Deadline } from '../../protocol/deadline.ts'
import { BrowserError } from '../browser-error.ts'

// Firefox 133 puts a new tab in its most recent window of any kind, and reads the most recent browser window's tabs
// before it opens a window or a tab. A tab asked for while another window is still being built finds no tabs there and
// fails with `unknown error` ("TypeError: tabBrowser is undefined"): eight pages opened at once on a freshly started
// Firefox, four of them with a saved state restored through a tab, failed three of the four in every one of three
// launches. So one browser opens and closes its windows and tabs one at a time, each once the one before it has been
// answered, which Firefox does only once the new window's first document is in place.
const turns = new WeakMap<BidiClient, Promise<void>>()

/**
 * Runs `work`, which opens or closes a window or a tab of the browser `client` speaks to, after every such command
 * sent before it has been answered. Waiting for the turn is bounded by the deadline; a turn that does not come in time
 * fails before anything is sent.
 *
 * @example const context = await inWindowOrder(client, deadline, () => client.request('browsingContext.create', params, schema, options))
 */
export async function inWindowOrder<T>(client: BidiClient, deadline: Deadline, work: () => Promise<T>): Promise<T> {
  const previous = turns.get(client) ?? Promise.resolve()
  const next = Promise.withResolvers<void>()
  turns.set(client, next.promise)
  try {
    await waitForTurn(previous, deadline)
  } catch (error) {
    void previous.then(() => next.resolve())
    throw error
  }
  try {
    return await work()
  } finally {
    next.resolve()
    if (turns.get(client) === next.promise) turns.delete(client)
  }
}

function waitForTurn(previous: Promise<void>, deadline: Deadline): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const expired = (): void => {
      stop()
      reject(new BrowserError({ class: 'timeout', message: 'Firefox was still opening or closing another window when the command budget ran out. Retest sent nothing for this one.', details: { inputSent: false } }))
    }
    const aborted = (): void => {
      stop()
      reject(deadline.signal?.reason)
    }
    let timer: ReturnType<typeof setTimeout>
    const checkEnd = (): void => {
      if (deadline.reached) expired()
      else timer = setTimeout(checkEnd, deadline.waitToEndMs)
    }
    timer = setTimeout(checkEnd, deadline.waitToEndMs)
    const stop = (): void => {
      clearTimeout(timer)
      deadline.signal?.removeEventListener('abort', aborted)
    }
    deadline.signal?.addEventListener('abort', aborted, { once: true })
    void previous.then(() => {
      if (deadline.signal?.aborted === true) aborted()
      else if (deadline.reached) expired()
      else resolve()
      stop()
    })
    if (deadline.signal?.aborted === true) aborted()
  })
}
