import type { BidiClient } from './bidi-client.ts'
import type { Deadline } from '../../protocol/deadline.ts'
import { setTimeout as sleep } from 'node:timers/promises'
import { s } from '../../protocol/schema.ts'
import { readBidi } from './bidi-client.ts'

export type NavigationHoldOptions = {
  client: BidiClient
  /** The tab's top-level browsing context: only its own navigations are held. */
  context: string
  /** Subscribes to events for the tab and ends the subscription, counted by the page so another user keeps its own. */
  subscribe(events: readonly string[], send: { timeoutMs: number; signal?: AbortSignal | undefined }): Promise<void>
  unsubscribe(events: readonly string[]): void
  /** Hears the tab's top-level navigations start, with the address each sets off for. */
  onNavigationStart(listener: (url: string) => void): () => void
  /** Ends a navigation whose request the hold failed, which Firefox then tells of no end for. */
  navigationFailed(navigation: string): void
  /** Stops a refused navigation that never made a request, as the browser's Stop button stops it. */
  stopLoading(timeoutMs: number): Promise<void>
}

// How long a refused navigation's request may take to be told of once the navigation started.
const heldRequestWaitMs = 1000
const retryPauseMs = 20
// How long the hold still answers requests Firefox paused before the intercept went but told of after: removing an
// intercept does not release what it paused.
const lateRequestMs = 2000

const event = 'network.beforeRequestSent'
const interceptSchema = s.object({ intercept: s.string() })
const pausedSchema = s.object({
  isBlocked: s.boolean(),
  navigation: s.nullable(s.string()),
  context: s.nullable(s.string()),
  intercepts: s.optional(s.array(s.string())),
  request: s.object({ request: s.string(), url: s.string() }),
})

type Paused = { request: string; navigation: string | null; context: string | null; url: string; intercepts: readonly string[] | undefined }

/**
 * The navigations of a tab held while a fill bound to origins types, through a BiDi network intercept: Firefox's
 * sandbox has no Navigation API, so the guard cannot cancel a navigation as it does on Chromium. Chromium's guard holds
 * from the moment the readiness check arms it, in the same task that focuses the field, so a navigation the focus
 * starts is held and one the page started earlier is not. Firefox cannot arm anything inside that task, so the hold is
 * armed before the fill's first look for its field, and each later look lets go what it held so far (`letGo`): a
 * navigation that started before the look that readies the field is the page's own, and one that starts during that
 * look, as the field's focus starts it, or after it, is held.
 *
 * The intercept is set on the tab, and Firefox pauses every request of the tab's frames with it. Only a navigation of
 * the tab's own document is held; every other request it paused, a frame's fetch or a frame's own navigation among
 * them, goes on at once. A navigation the page asked for before the text went makes the hold `leaving` for its origin,
 * and is cancelled when the hold is released, so the page stays where it was; one asked for while the text was being
 * typed is let go once the text has arrived, since no document but the checked one can have received it. Releasing the
 * hold releases everything it paused.
 */
export class NavigationHold {
  readonly #options: NavigationHoldOptions
  readonly #deadline: Deadline
  readonly #held: Paused[] = []
  readonly #early: Paused[] = []
  readonly #stops: (() => void)[] = []
  #intercept: string | undefined
  #typing = false
  #leaving: string | undefined
  #released: { cancel: boolean; deadline: Deadline } | undefined
  #cancelledAny = false

  /**
   * Subscribes to the tab's requests and sets the intercept within the deadline. A hold that cannot be armed leaves no
   * subscription or listener behind.
   *
   * @example const hold = await NavigationHold.arm(options, deadline)
   */
  static async arm(options: NavigationHoldOptions, deadline: Deadline): Promise<NavigationHold> {
    const hold = new NavigationHold(options, deadline)
    await hold.#arm(deadline)
    return hold
  }

  private constructor(options: NavigationHoldOptions, deadline: Deadline) {
    this.#options = options
    this.#deadline = deadline
  }

  /** The origin of a navigation the page asked for before the text went, which the fill refuses. */
  get leaving(): string | undefined {
    return this.#leaving
  }

  /** Marks the text on its way: a navigation asked for from now on is the page's answer to it, and is let go. */
  typing(): void {
    this.#typing = true
  }

  /**
   * Lets every navigation held so far go on as the page's own, for a fill about to look for its field again: that look
   * then waits for the document the navigation opens. Holding goes on for any navigation that starts afterwards. Each
   * command is sent at once and bounded by the fill's own deadline.
   */
  letGo(): void {
    if (this.#released !== undefined || this.#typing) return
    this.#leaving = undefined
    for (const request of this.#held.splice(0)) {
      this.#options.client.send('network.continueRequest', { request: request.request }, { timeoutMs: this.#deadline.commandTimeoutMs }).catch(() => undefined)
    }
  }

  /**
   * Lets every request the hold paused go on, or, with `cancel`, fails the held navigations of the tab's document and
   * lets the rest go on. Every command is sent at once and waited for only until the command's own deadline: a command
   * written to Firefox is carried out whether or not Retest still waits for its answer.
   */
  async release(cancel: boolean, deadline: Deadline): Promise<void> {
    if (this.#released !== undefined) return
    // A navigation that started has its request paused only once Firefox tells of it, which can come a moment later.
    if (cancel && this.#held.length === 0) {
      const waitUntil = Math.min(heldRequestWaitMs, deadline.remainingMs)
      const startedAt = performance.now()
      while (this.#held.length === 0 && performance.now() - startedAt < waitUntil) await sleep(Math.min(retryPauseMs, deadline.remainingMs))
    }
    this.#released = { cancel, deadline }
    const timeoutMs = deadline.commandTimeoutMs
    const intercept = this.#intercept
    const sends: Promise<unknown>[] = intercept === undefined ? [] : [this.#options.client.send('network.removeIntercept', { intercept }, { timeoutMs })]
    for (const request of this.#held.splice(0)) sends.push(this.#answer(request, timeoutMs))
    await Promise.allSettled(sends)
    if (cancel && !this.#cancelledAny) await this.#options.stopLoading(deadline.commandTimeoutMs)
    const late = setTimeout(() => this.#end(), lateRequestMs)
    late.unref()
  }

  async #arm(deadline: Deadline): Promise<void> {
    const { client, context, subscribe } = this.#options
    // A navigation that starts once the intercept is in place has its request held, so it is leaving from the moment
    // it starts; Firefox tells of the start before the request.
    this.#stops.push(
      this.#options.onNavigationStart((url) => {
        if (this.#intercept !== undefined && this.#released === undefined && !this.#typing) this.#leaving ??= URL.parse(url)?.origin ?? 'null'
      }),
      client.on(event, (params) => this.#paused(params)),
    )
    const send = () => ({ timeoutMs: deadline.commandTimeoutMs, signal: deadline.signal })
    let subscribed = false
    try {
      await subscribe([event], send())
      subscribed = true
      this.#intercept = (await client.request('network.addIntercept', { phases: ['beforeRequestSent'], contexts: [context] }, interceptSchema, send())).intercept
    } catch (error) {
      for (const stop of this.#stops.splice(0)) stop()
      if (subscribed) this.#options.unsubscribe([event])
      throw error
    }
    // Firefox can tell of a request its intercept paused before it answers the command that set the intercept.
    for (const paused of this.#early.splice(0)) this.#take(paused)
  }

  #paused(params: unknown): void {
    let read
    try {
      read = readBidi(pausedSchema, params, event)
    } catch {
      return
    }
    if (!read.isBlocked) return
    const paused: Paused = { request: read.request.request, navigation: read.navigation, context: read.context, url: read.request.url, intercepts: read.intercepts }
    if (this.#intercept === undefined) this.#early.push(paused)
    else this.#take(paused)
  }

  #take(paused: Paused): void {
    // Another page's intercept pauses its own requests; this hold answers only for the requests its own paused.
    if (this.#intercept === undefined || paused.intercepts?.includes(this.#intercept) !== true) return
    const ownNavigation = paused.context === this.#options.context && paused.navigation !== null
    if (this.#released !== undefined) {
      void this.#answer(paused, this.#released.deadline.commandTimeoutMs).catch(() => undefined)
      return
    }
    if (!ownNavigation) {
      this.#options.client.send('network.continueRequest', { request: paused.request }, { timeoutMs: this.#deadline.commandTimeoutMs }).catch(() => undefined)
      return
    }
    this.#held.push(paused)
    if (!this.#typing) this.#leaving ??= URL.parse(paused.url)?.origin ?? 'null'
  }

  // A held navigation of the tab's document is failed when the hold cancels; every other paused request goes on.
  async #answer(paused: Paused, timeoutMs: number): Promise<unknown> {
    const { client } = this.#options
    const navigation = paused.context === this.#options.context ? paused.navigation : null
    if (this.#released?.cancel !== true || navigation === null) return client.send('network.continueRequest', { request: paused.request }, { timeoutMs }).catch(() => undefined)
    this.#cancelledAny = true
    // Firefox tells of no end for a navigation whose request Retest failed, so the page ends it itself.
    this.#options.navigationFailed(navigation)
    return client.send('network.failRequest', { request: paused.request }, { timeoutMs }).catch(() => undefined)
  }

  #end(): void {
    for (const stop of this.#stops.splice(0)) stop()
    this.#options.unsubscribe([event])
  }
}
