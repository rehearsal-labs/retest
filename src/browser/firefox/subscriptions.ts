import type { Schema } from '../../protocol/schema.ts'
import { s } from '../../protocol/schema.ts'

// How a subscription to a browsing context's events is ended, which WebDriver BiDi changed after Firefox 133. Firefox
// 133, the pinned build, answers `session.subscribe` with nothing and ends a subscription by its events and contexts.
// Later Firefox answers with the subscription's id, and ends one by its events only when it is global: a subscription
// bound to a context, as every one of Retest's is, is ended by its id alone, and asked by its events Firefox refuses
// with "invalid argument" (`remote/webdriver-bidi/modules/root/session.sys.mjs`, `#unsubscribeByEventNames`). So a
// subscription is ended by its id when the browser gave one, and by its events and contexts when it gave none.

/** What `session.subscribe` answers: the subscription's id, from a Firefox later than 133, or nothing. */
export type Subscribed = { subscription?: string }

export const subscribedSchema: Schema<Subscribed> = s.object({ subscription: s.optional(s.string()) })

/** One subscription as it was made: the id the browser gave it, if any, and the events and contexts it named. */
export type Subscription = { readonly id: string | undefined; readonly events: readonly string[]; readonly contexts: readonly string[] }

/** What `session.unsubscribe` is sent to end a subscription: its id, or its events and contexts. */
export type UnsubscribeParameters = { readonly subscriptions: readonly string[] } | { readonly events: readonly string[]; readonly contexts: readonly string[] }

/**
 * The parameters that end `subscription`, by its id when the browser gave one.
 *
 * @example unsubscribeParameters({ id: undefined, events: ['script'], contexts: [context] }) // { events: ['script'], contexts: [context] }
 */
export function unsubscribeParameters(subscription: Subscription): UnsubscribeParameters {
  return subscription.id === undefined ? { events: subscription.events, contexts: subscription.contexts } : { subscriptions: [subscription.id] }
}
