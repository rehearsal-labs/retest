/**
 * The bounds a run's checks keep: calls per test attempt and per run, calls waiting on a judge at once, the tokens a
 * judge may write, and what one request may carry: its text and images in bytes, how many images, and how wide and
 * tall each may be. The defaults are bounds, not tuned numbers.
 */
export type EvaluationLimits = {
  readonly callsPerTest: number
  readonly callsPerRun: number
  readonly concurrentCalls: number
  readonly maxOutputTokens: number
  readonly maxInputBytes: number
  readonly maxImages: number
  readonly maxImageWidth: number
  readonly maxImageHeight: number
}

export const defaultEvaluationLimits: EvaluationLimits = Object.freeze({
  callsPerTest: 5,
  callsPerRun: 100,
  concurrentCalls: 2,
  maxOutputTokens: 1000,
  maxInputBytes: 8_000_000,
  maxImages: 4,
  maxImageWidth: 4096,
  maxImageHeight: 4096,
})

/** How waiting for a call slot ended. */
export type SlotOutcome = 'acquired' | 'timed_out' | 'stopped'

/** A call taken from the budget, or the limit that refused it. */
export type Reservation = { ok: true } | { ok: false; problem: string }

type Waiter = { grant: () => void }

/**
 * The run's call budget, shared by every file worker. The parent alone holds it, and JavaScript runs one turn at a
 * time, so `reserve` checks and takes a call in one step: no two checks can both take the last call. A slot bounds how
 * many calls wait on judges at once; a check waits for one in turn, within its own time.
 */
export class CallBudget {
  readonly #limits: EvaluationLimits
  readonly #attemptCalls = new Map<string, number>()
  readonly #queue: Waiter[] = []
  #runCalls = 0
  #active = 0

  constructor(limits: EvaluationLimits) {
    this.#limits = limits
  }

  /** Calls taken so far in the run. */
  get calls(): number {
    return this.#runCalls
  }

  /**
   * Waits for one of the `concurrentCalls` slots, first come first served, for at most `timeoutMs` or until `stop`
   * settles. An acquired slot must be released.
   */
  acquire(timeoutMs: number, stop: Promise<unknown>): Promise<SlotOutcome> {
    if (this.#active < this.#limits.concurrentCalls) {
      this.#active++
      return Promise.resolve('acquired')
    }
    return new Promise<SlotOutcome>((resolve) => {
      let settled = false
      const finish = (outcome: SlotOutcome): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        const index = this.#queue.indexOf(waiter)
        if (index !== -1) this.#queue.splice(index, 1)
        resolve(outcome)
      }
      const waiter: Waiter = { grant: () => finish('acquired') }
      const timer = setTimeout(() => finish('timed_out'), timeoutMs)
      void stop.then(() => finish('stopped'))
      this.#queue.push(waiter)
    })
  }

  /** Gives a slot back. The next check waiting takes it as it stands. */
  release(): void {
    const next = this.#queue.shift()
    if (next === undefined) this.#active = Math.max(0, this.#active - 1)
    else next.grant()
  }

  /**
   * Takes one call for `attemptId` from the attempt's and the run's budgets together, or takes nothing and says which
   * one is used up. A call is taken before it is sent and never given back, whatever its answer.
   */
  reserve(attemptId: string): Reservation {
    const { callsPerRun, callsPerTest } = this.#limits
    const attemptCalls = this.#attemptCalls.get(attemptId) ?? 0
    if (this.#runCalls >= callsPerRun) return { ok: false, problem: `The run has used all ${callsPerRun} of its AI check calls (evaluation.limits.callsPerRun).` }
    if (attemptCalls >= callsPerTest) return { ok: false, problem: `The test has used all ${callsPerTest} of its AI check calls (evaluation.limits.callsPerTest).` }
    this.#runCalls++
    this.#attemptCalls.set(attemptId, attemptCalls + 1)
    return { ok: true }
  }
}
