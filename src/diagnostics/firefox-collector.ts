import type { BidiClient } from '../browser/firefox/bidi-client.ts'
import type { DiagnosticScope, FrameRole } from '../protocol/diagnostics.ts'
import type { Schema } from '../protocol/schema.ts'
import type { DiagnosticCollection, DiagnosticSink, Observation } from './observations.ts'
import { readBidi } from '../browser/firefox/bidi-client.ts'
import { s } from '../protocol/schema.ts'

export type FirefoxCollectorOptions = {
  client: BidiClient
  /** The tab's top-level browsing context; events of the frames inside it are the tab's too. */
  context: string
  sink: DiagnosticSink
  /**
   * How the collector subscribes to the tab's events and ends its subscription: through the page, which counts each
   * event's subscriptions so another user of the same event keeps its own.
   */
  subscriptions: { subscribe(events: readonly string[], timeoutMs: number): Promise<void>; unsubscribe(events: readonly string[]): void }
  /** Bounds in-flight request metadata even when the sink has already filled its artifact budget. */
  maxTrackedRequests?: number
}

/**
 * Why a Firefox capture holds no console messages or runtime errors. Firefox 133 sends both through one event,
 * `log.entryAdded`. Strings, numbers, plain data objects and a DOM node left the probe's marker untouched, but logged
 * objects with enumerable getters changed the page's title before the entry arrived, including nested getters.
 * Firefox ignores extra serialization fields on subscriptions and session.new, and rejects serialization
 * capabilities. Filtering delivered entries for primitive arguments is too late to prevent that mutation.
 * A depth limit avoids the probed object's getters in script results, not in log events.
 */
export const firefoxConsoleUnavailable = "Firefox 133's console source runs the page's own enumerable getters when it serializes logged objects, before Retest can filter an entry. The log subscription ignores serialization options and offers no primitive-only filter, so Retest does not subscribe and records no console message or runtime error on Firefox."

/**
 * What Firefox's WebDriver BiDi network events cover for a tab, from what Retest exercised on Firefox 133: the tab's
 * document and the frames inside it, of its own site and of others, each request named by the browsing context that
 * made it. A request a dedicated worker makes is named by the page that started the worker, so it cannot be told from
 * the page's own; workers' requests are not claimed, and the reason says they may appear as the page's. Firefox names
 * no resource type: a request is a document only when Firefox ties it to a navigation. A response Firefox served from
 * its cache says so without naming which cache, so none is named. Console messages and runtime errors are not
 * captured at all (`firefoxConsoleUnavailable`).
 */
export const firefoxScope: DiagnosticScope = {
  engine: 'firefox',
  source: 'page_target',
  console: {
    covered: [],
    notCovered: ['top_level_document', 'same_process_frames', 'out_of_process_frames', 'dedicated_workers', 'shared_workers', 'service_workers'],
  },
  network: {
    covered: ['top_level_document', 'same_process_frames', 'out_of_process_frames'],
    notCovered: ['dedicated_workers', 'shared_workers', 'service_workers'],
  },
  reason: `${firefoxConsoleUnavailable} Firefox names each request by the browsing context that made it, so a dedicated worker's request is recorded as its page's, and it names no resource type beyond a navigation's document.`,
}

const events = ['network.beforeRequestSent', 'network.responseStarted', 'network.responseCompleted', 'network.fetchError'] as const

const requestSchema = s.object({ request: s.string(), url: s.string(), method: s.string() })
const responseSchema = s.object({
  status: s.number({ integer: true }),
  statusText: s.optional(s.string()),
  mimeType: s.optional(s.string()),
  protocol: s.optional(s.string()),
  fromCache: s.optional(s.boolean()),
  bytesReceived: s.optional(s.number()),
})
const sentSchema = s.object({ navigation: s.optional(s.nullable(s.string())), context: s.nullable(s.string()), redirectCount: s.number({ integer: true, min: 0 }), timestamp: s.number(), request: requestSchema })
const respondedSchema = s.object({ context: s.nullable(s.string()), redirectCount: s.number({ integer: true, min: 0 }), timestamp: s.number(), request: requestSchema, response: responseSchema })
const failedSchema = s.object({ context: s.nullable(s.string()), redirectCount: s.number({ integer: true, min: 0 }), timestamp: s.number(), request: requestSchema, errorText: s.string() })
const contextCreatedSchema = s.object({ context: s.string(), parent: s.nullable(s.string()) })
const contextSchema = s.object({ context: s.string() })

// A redirect Firefox follows has one of these statuses; its next hop comes under the same request id.
const redirectStatuses: ReadonlySet<number> = new Set([301, 302, 303, 307, 308])

/** One request id's current hop: its key, its redirect count, and when it started on the engine's clock. */
type Hop = { key: string; redirectCount: number; frame: FrameRole; startMs: number }

/**
 * Collects a Firefox tab's network metadata into a sink, from the BiDi events of its own browsing context and the
 * frames inside it, and names the console kind unavailable (`firefoxConsoleUnavailable`). Listeners are added before
 * the subscription, so nothing the tab does afterwards is missed; the parent starts it before the tab's first
 * navigation. It subscribes to network events only, sends no command after it starts but its own unsubscription,
 * never reads a page object, never asks for a body, and keeps no header.
 */
export class FirefoxCollector implements DiagnosticCollection {
  readonly scope: DiagnosticScope = firefoxScope
  readonly unavailable: { readonly console: string } = { console: firefoxConsoleUnavailable }
  readonly #client: BidiClient
  readonly #context: string
  readonly #sink: DiagnosticSink
  readonly #subscriptions: FirefoxCollectorOptions['subscriptions']
  readonly #stops: (() => void)[] = []
  readonly #frames = new Set<string>()
  readonly #hops = new Map<string, Hop>()
  readonly #maxTrackedRequests: number
  #subscribed = false
  #stopped = false

  constructor({ client, context, sink, subscriptions, maxTrackedRequests = 1000 }: FirefoxCollectorOptions) {
    if (!Number.isSafeInteger(maxTrackedRequests) || maxTrackedRequests < 1) throw new RangeError('The collector request limit must be a positive safe integer.')
    this.#client = client
    this.#context = context
    this.#sink = sink
    this.#subscriptions = subscriptions
    this.#maxTrackedRequests = maxTrackedRequests
    this.#listen('network.beforeRequestSent', sentSchema, (sent) => this.#requestSent(sent))
    this.#listen('network.responseStarted', respondedSchema, (responded) => this.#responseStarted(responded))
    this.#listen('network.responseCompleted', respondedSchema, (responded) => this.#responseCompleted(responded))
    this.#listen('network.fetchError', failedSchema, (failed) => this.#fetchFailed(failed))
    this.#stops.push(
      this.#client.on('browsingContext.contextCreated', (params) => {
        const created = readQuietly(contextCreatedSchema, params, 'browsingContext.contextCreated')
        if (created !== undefined && created.parent !== null && this.#inTab(created.parent)) this.#frames.add(created.context)
      }),
      this.#client.on('browsingContext.contextDestroyed', (params) => {
        const destroyed = readQuietly(contextSchema, params, 'browsingContext.contextDestroyed')
        if (destroyed === undefined) return
        if (destroyed.context === this.#context) this.#lose({ kind: 'page_crashed', reason: 'the page was closed', time: Date.now() })
        else this.#frames.delete(destroyed.context)
      }),
      this.#client.onDisconnect((reason) => this.#lose({ kind: 'connection_lost', reason, time: Date.now() })),
    )
  }

  /** Subscribes to the tab's network events within `timeoutMs`. Rejects when Firefox does not answer; the collector is then stopped. */
  async start(timeoutMs: number): Promise<void> {
    try {
      await this.#subscriptions.subscribe(events, Math.max(1, timeoutMs))
      this.#subscribed = true
    } catch (error) {
      this.stop()
      throw error
    }
  }

  stop(): void {
    if (this.#stopped) return
    this.#stopped = true
    for (const stop of this.#stops.splice(0)) stop()
    this.#hops.clear()
    if (this.#subscribed) this.#subscriptions.unsubscribe(events)
  }

  // Each event is read against the parts Retest relies on, with every other key dropped first, so a header or a body
  // the schema does not name is never copied. One it cannot read is counted, never guessed at.
  #listen<T>(method: string, schema: Schema<T>, handle: (params: T) => void): void {
    this.#stops.push(
      this.#client.on(method, (params) => {
        if (this.#stopped) return
        let read: T
        try {
          read = readBidi(schema, params, method)
        } catch {
          this.#sink.unreadable(method)
          return
        }
        handle(read)
      }),
    )
  }

  #inTab(context: string | null | undefined): boolean {
    return context !== null && context !== undefined && (context === this.#context || this.#frames.has(context))
  }

  #frameOf(context: string | null | undefined): FrameRole {
    return context === this.#context ? 'main' : 'child'
  }

  #observe(observation: Observation): void {
    if (!this.#stopped) this.#sink.observe(observation)
  }

  #lose(loss: { kind: 'page_crashed' | 'connection_lost'; reason: string; time: number }): void {
    if (this.#stopped) return
    this.#sink.lost(loss)
    this.#subscribed = false
    this.stop()
  }

  // Firefox sends a redirect's next hop under the same request id, with its redirect count, after the redirect's own
  // response completed.
  #requestSent({ context, navigation, redirectCount, timestamp, request }: Sent): void {
    if (!this.#inTab(context)) return
    const previous = this.#hops.get(request.request)
    if (previous === undefined && this.#hops.size >= this.#maxTrackedRequests) {
      if (this.#sink.limited !== undefined) this.#sink.limited('network.beforeRequestSent', 1)
      else this.#sink.unreadable('network.beforeRequestSent')
      return
    }
    const hop: Hop = { key: hopKey(request.request, redirectCount), redirectCount, frame: this.#frameOf(context), startMs: timestamp }
    const redirectedFrom = redirectCount > 0 ? { redirectedFrom: hopKey(request.request, redirectCount - 1) } : {}
    this.#hops.set(request.request, hop)
    this.#observe({ kind: 'request', key: hop.key, method: request.method, url: request.url, frame: hop.frame, time: timestamp, ...(navigation === undefined || navigation === null ? {} : { resourceType: 'Document' }), ...redirectedFrom })
  }

  #responseStarted({ redirectCount, timestamp, request, response }: Responded): void {
    const hop = this.#hops.get(request.request)
    if (hop === undefined || hop.redirectCount !== redirectCount) return
    const redirect = redirectStatuses.has(response.status) ? { redirectedTo: hopKey(request.request, redirectCount + 1) } : {}
    this.#observe({ kind: 'response', key: hop.key, ...responseFields(response), time: timestamp, ...redirect })
  }

  #responseCompleted({ redirectCount, timestamp, request, response }: Responded): void {
    const hop = this.#hops.get(request.request)
    if (hop === undefined || hop.redirectCount !== redirectCount) return
    const transferred = response.bytesReceived === undefined ? {} : { transferredBytes: Math.round(response.bytesReceived) }
    this.#observe({ kind: 'finished', key: hop.key, time: timestamp, ...durationOf(hop, timestamp), ...transferred })
    if (!redirectStatuses.has(response.status)) this.#hops.delete(request.request)
  }

  #fetchFailed({ redirectCount, timestamp, request, errorText }: Failed): void {
    const hop = this.#hops.get(request.request)
    if (hop === undefined || hop.redirectCount !== redirectCount) return
    this.#hops.delete(request.request)
    this.#observe({ kind: 'failed', key: hop.key, time: timestamp, ...durationOf(hop, timestamp), reason: errorText })
  }
}

type Request = { request: string; url: string; method: string }
type Response = { status: number; statusText?: string; mimeType?: string; protocol?: string; fromCache?: boolean; bytesReceived?: number }
type Sent = { navigation?: string | null; context: string | null; redirectCount: number; timestamp: number; request: Request }
type Responded = Sent & { response: Response }
type Failed = Sent & { errorText: string }

function hopKey(request: string, redirectCount: number): string {
  return `${request}#${redirectCount + 1}`
}

// A response's facts Retest keeps: no header, only the media type of its content type, and `none` for a response
// Firefox said it did not take from a cache. One it took from a cache names none, since Firefox does not say which.
function responseFields(response: Response): Omit<Extract<Observation, { kind: 'response' }>, 'kind' | 'key' | 'time' | 'redirectedTo'> {
  const mediaType = response.mimeType?.split(';')[0]?.trim()
  return {
    status: response.status,
    ...(response.statusText === undefined || response.statusText === '' ? {} : { statusText: response.statusText }),
    ...(mediaType === undefined || mediaType === '' ? {} : { contentType: mediaType }),
    ...(response.fromCache === false ? { cache: 'none' as const } : {}),
    ...(response.protocol === undefined || response.protocol === '' ? {} : { protocol: response.protocol }),
  }
}

// Firefox stamps each event with its own clock in milliseconds; a reading that runs backwards measures nothing.
function durationOf(hop: Hop, endMs: number): { durationMs?: number } {
  const durationMs = endMs - hop.startMs
  return durationMs >= 0 ? { durationMs: Math.round(durationMs * 1000) / 1000 } : {}
}

function readQuietly<T>(schema: Schema<T>, params: unknown, method: string): T | undefined {
  try {
    return readBidi(schema, params, method)
  } catch {
    return undefined
  }
}
