import type { CommandIdentity } from '../cdp/errors.ts'
import type { Deadline } from '../../protocol/deadline.ts'
import { CdpAbortedError, CdpTimeoutError } from '../cdp/errors.ts'

/**
 * One holder at a time, served in the order they asked. A waiter whose budget runs out, or whose signal stops it,
 * leaves the line without ever holding it, and the turn passes to the next one.
 *
 * @example const release = await turns.take(deadline, command); try { await read() } finally { release() }
 */
export class Turns {
  readonly #line: (() => void)[] = []
  #held = false

  /** Waits for the turn within `deadline`, and resolves with the function that gives it up, which only acts once. */
  take(deadline: Deadline, command: CommandIdentity): Promise<() => void> {
    const { signal } = deadline
    if (signal?.aborted === true) return Promise.reject(new CdpAbortedError(command, { written: false }))
    if (!this.#held) {
      this.#held = true
      return Promise.resolve(this.#release())
    }
    if (deadline.expired) return Promise.reject(new CdpTimeoutError(command, { timeoutMs: deadline.budgetMs, written: false }))
    return new Promise((resolve, reject) => {
      const leave = (): void => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', stop)
        const at = this.#line.indexOf(grant)
        if (at !== -1) this.#line.splice(at, 1)
      }
      const grant = (): void => {
        leave()
        resolve(this.#release())
      }
      const stop = (): void => {
        leave()
        reject(new CdpAbortedError(command, { written: false }))
      }
      const timer = setTimeout(() => {
        leave()
        reject(new CdpTimeoutError(command, { timeoutMs: deadline.budgetMs, written: false }))
      }, deadline.commandTimeoutMs)
      this.#line.push(grant)
      signal?.addEventListener('abort', stop, { once: true })
    })
  }

  // The turn goes straight to the next in line, so nobody who asked later can slip in between.
  #release(): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      const next = this.#line.shift()
      if (next === undefined) this.#held = false
      else next()
    }
  }
}
