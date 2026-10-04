import type { DiagnosticScope, FrameRole } from '../protocol/diagnostics.ts'
import type { Schema } from '../protocol/schema.ts'
import type { ConsoleArgument } from './console-text.ts'
import type { DiagnosticCollection, DiagnosticSink, ObservedFrame, Observation } from './observations.ts'
import { readProtocol } from '../browser/cdp-results.ts'
import { s } from '../protocol/schema.ts'
import { argumentText, consoleArgumentSchema, consoleText } from './console-text.ts'

/** What the collector needs of a CDP session: its events, its end and commands. A Chromium page's session is one. */
export interface ProtocolSession {
  on(method: string, listener: (params: unknown) => void): () => void
  onDetach(listener: (reason: string) => void): () => void
  send(method: string, params?: object, options?: { timeoutMs?: number; signal?: AbortSignal | undefined }): Promise<unknown>
}

export type ChromiumCollectorOptions = {
  session: ProtocolSession
  /** The page's main frame now, which a request or a message's frame is compared with. */
  mainFrameId: () => string
  sink: DiagnosticSink
  /** Bounds in-flight request metadata even when the sink has already filled its artifact budget. */
  maxTrackedRequests?: number
}

/**
 * What Chromium's page target covers, from what Retest exercised on real Chrome: the page's document and the frames it
 * renders in its own process; a dedicated worker's console messages, which Chrome forwards to the page's log; never a
 * frame of another site, a shared worker, a service worker's own messages or requests, or a worker's requests. A
 * response a service worker answered for the page is recorded, and says so.
 */
export const chromiumScope: DiagnosticScope = {
  engine: 'chromium',
  source: 'page_target',
  console: {
    covered: ['top_level_document', 'same_process_frames', 'dedicated_workers'],
    notCovered: ['out_of_process_frames', 'shared_workers', 'service_workers'],
  },
  network: {
    covered: ['top_level_document', 'same_process_frames'],
    notCovered: ['out_of_process_frames', 'dedicated_workers', 'shared_workers', 'service_workers'],
  },
}

const callFrameSchema = s.object({ functionName: s.string(), url: s.string(), lineNumber: s.number(), columnNumber: s.number() })
const stackTraceSchema = s.optional(s.object({ callFrames: s.array(callFrameSchema) }))
const consoleCalledSchema = s.object({
  type: s.string(),
  args: s.array(consoleArgumentSchema),
  executionContextId: s.number(),
  timestamp: s.number(),
  stackTrace: stackTraceSchema,
})
const exceptionSchema = s.object({
  timestamp: s.number(),
  exceptionDetails: s.object({
    exceptionId: s.number(),
    text: s.string(),
    lineNumber: s.number(),
    columnNumber: s.number(),
    url: s.optional(s.string()),
    stackTrace: stackTraceSchema,
    exception: s.optional(consoleArgumentSchema),
    executionContextId: s.optional(s.number()),
  }),
})
const revokedSchema = s.object({ exceptionId: s.number() })
const contextCreatedSchema = s.object({
  context: s.object({ id: s.number(), auxData: s.optional(s.object({ isDefault: s.optional(s.boolean()), frameId: s.optional(s.string()) })) }),
})
const contextDestroyedSchema = s.object({ executionContextId: s.optional(s.number()) })
const logEntrySchema = s.object({
  entry: s.object({
    source: s.string(),
    level: s.string(),
    text: s.string(),
    timestamp: s.number(),
    url: s.optional(s.string()),
    lineNumber: s.optional(s.number()),
    networkRequestId: s.optional(s.string()),
    stackTrace: stackTraceSchema,
  }),
})
const responseSchema = s.object({
  url: s.string(),
  status: s.number(),
  statusText: s.optional(s.string()),
  mimeType: s.optional(s.string()),
  fromDiskCache: s.optional(s.boolean()),
  fromServiceWorker: s.optional(s.boolean()),
  fromPrefetchCache: s.optional(s.boolean()),
  encodedDataLength: s.optional(s.number()),
  responseTime: s.optional(s.number()),
  protocol: s.optional(s.string()),
})
const requestSentSchema = s.object({
  requestId: s.string(),
  loaderId: s.optional(s.string()),
  documentURL: s.optional(s.string()),
  request: s.object({ url: s.string(), method: s.string() }),
  timestamp: s.number(),
  wallTime: s.number(),
  type: s.optional(s.string()),
  frameId: s.optional(s.string()),
  redirectResponse: s.optional(responseSchema),
})
const responseReceivedSchema = s.object({ requestId: s.string(), timestamp: s.number(), response: responseSchema })
const requestIdSchema = s.object({ requestId: s.string() })
const frameDetachedSchema = s.object({ frameId: s.string(), reason: s.optional(s.string()) })
const finishedSchema = s.object({ requestId: s.string(), timestamp: s.number(), encodedDataLength: s.optional(s.number()) })
const failedSchema = s.object({
  requestId: s.string(),
  timestamp: s.number(),
  errorText: s.string(),
  canceled: s.optional(s.boolean()),
  blockedReason: s.optional(s.string()),
})

type Context = { frameId: string | undefined; isDefault: boolean }
/** One request id's current hop: its key, when it started on the engine's monotonic clock, and that clock's offset to the epoch. */
type Hop = { key: string; number: number; frameId: string | undefined; startSeconds: number; wallOffsetSeconds: number; servedFromCache: boolean }

// The console types whose severity is not information.
const consoleLevels: Readonly<Record<string, 'debug' | 'warning' | 'error'>> = { debug: 'debug', warning: 'warning', error: 'error', assert: 'error' }
const logLevels: Readonly<Record<string, 'debug' | 'info' | 'warning' | 'error'>> = { verbose: 'debug', info: 'info', warning: 'warning', error: 'error' }

/**
 * Collects a Chromium page's console messages, runtime errors and network metadata into a sink, from the page's own
 * target session. Listeners are added before the domains are enabled, so nothing the page does afterwards is missed;
 * the parent starts it before the page's first navigation. It sends no command after it starts, never reads a page
 * object, and never asks for a body.
 */
export class ChromiumCollector implements DiagnosticCollection {
  readonly scope: DiagnosticScope = chromiumScope
  readonly #session: ProtocolSession
  readonly #mainFrameId: () => string
  readonly #sink: DiagnosticSink
  readonly #stops: (() => void)[] = []
  readonly #contexts = new Map<number, Context>()
  readonly #hops = new Map<string, Hop>()
  readonly #maxTrackedRequests: number
  #stopped = false

  constructor({ session, mainFrameId, sink, maxTrackedRequests = 1000 }: ChromiumCollectorOptions) {
    if (!Number.isSafeInteger(maxTrackedRequests) || maxTrackedRequests < 1) throw new RangeError('The collector request limit must be a positive safe integer.')
    this.#session = session
    this.#mainFrameId = mainFrameId
    this.#sink = sink
    this.#maxTrackedRequests = maxTrackedRequests
    this.#listen('Runtime.consoleAPICalled', consoleCalledSchema, (params) => this.#console(params))
    this.#listen('Runtime.exceptionThrown', exceptionSchema, (params) => this.#exception(params))
    this.#listen('Runtime.exceptionRevoked', revokedSchema, ({ exceptionId }) => this.#observe({ kind: 'revoked', key: String(exceptionId) }))
    this.#listen('Runtime.executionContextCreated', contextCreatedSchema, ({ context }) => {
      this.#contexts.set(context.id, { frameId: context.auxData?.frameId, isDefault: context.auxData?.isDefault !== false })
    })
    this.#listen('Runtime.executionContextDestroyed', contextDestroyedSchema, ({ executionContextId }) => {
      if (executionContextId !== undefined) this.#contexts.delete(executionContextId)
    })
    this.#listen('Runtime.executionContextsCleared', s.object({}), () => this.#contexts.clear())
    this.#listen('Log.entryAdded', logEntrySchema, ({ entry }) => this.#logEntry(entry))
    this.#listen('Network.requestWillBeSent', requestSentSchema, (params) => this.#requestSent(params))
    this.#listen('Network.requestServedFromCache', requestIdSchema, ({ requestId }) => {
      const hop = this.#hops.get(requestId)
      if (hop !== undefined) hop.servedFromCache = true
    })
    this.#listen('Network.responseReceived', responseReceivedSchema, (params) => this.#responseReceived(params))
    this.#listen('Network.dataReceived', requestIdSchema, ({ requestId }) => {
      const hop = this.#hops.get(requestId)
      if (hop !== undefined) this.#observe({ kind: 'data', key: hop.key })
    })
    this.#listen('Network.loadingFinished', finishedSchema, (params) => this.#finished(params))
    this.#listen('Network.loadingFailed', failedSchema, (params) => this.#failed(params))
    this.#listen('Page.frameDetached', frameDetachedSchema, ({ frameId, reason }) => {
      if (reason === 'swap') this.#leaveFrame(frameId)
    })
    this.#stops.push(this.#session.on('Inspector.targetCrashed', () => this.#lose({ kind: 'page_crashed', reason: 'the page crashed', time: Date.now() })))
    this.#stops.push(this.#session.onDetach((reason) => this.#lose({ kind: 'connection_lost', reason, time: Date.now() })))
  }

  /**
   * Enables the domains whose events the collector hears, within `timeoutMs`. Retest never records a body, so post
   * bodies are left out of the events and Chrome is asked to keep no response body for later reading. Rejects when the
   * page does not answer; the collector is then stopped.
   */
  async start(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs
    const options = (): { timeoutMs: number } => ({ timeoutMs: Math.max(1, deadline - Date.now()) })
    try {
      await this.#session.send('Runtime.enable', undefined, options())
      await this.#session.send('Log.enable', undefined, options())
      await this.#session.send('Network.enable', { maxPostDataSize: 0, maxTotalBufferSize: 0, maxResourceBufferSize: 0 }, options())
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
    this.#contexts.clear()
  }

  // Each event is read against the parts Retest relies on, with every other key dropped first, so a header or a body
  // the schema does not name is never copied. One it cannot read is counted, never guessed at.
  #listen<T>(method: string, schema: Schema<T>, handle: (params: T) => void): void {
    this.#stops.push(
      this.#session.on(method, (params) => {
        if (this.#stopped) return
        let read: T
        try {
          read = readProtocol(schema, params, { method })
        } catch {
          this.#sink.unreadable(method)
          return
        }
        handle(read)
      }),
    )
  }

  #observe(observation: Observation): void {
    if (!this.#stopped) this.#sink.observe(observation)
  }

  #lose(loss: { kind: 'page_crashed' | 'connection_lost'; reason: string; time: number }): void {
    if (this.#stopped) return
    this.#sink.lost(loss)
    this.stop()
  }

  // Retest's own world, and any other that is not a frame's main world, is not the app's.
  #console({ type, args, executionContextId, timestamp, stackTrace }: ConsoleCalled): void {
    const context = this.#contexts.get(executionContextId)
    if (context?.isDefault === false) return
    const [top] = stackTrace?.callFrames ?? []
    this.#observe({
      kind: 'console',
      consoleType: type,
      level: consoleLevels[type] ?? 'info',
      origin: 'page',
      text: consoleText(args),
      time: timestamp,
      ...frameFields(top),
      ...this.#frameOf(context?.frameId),
    })
  }

  #exception({ timestamp, exceptionDetails: details }: ExceptionThrown): void {
    const context = details.executionContextId === undefined ? undefined : this.#contexts.get(details.executionContextId)
    if (context?.isDefault === false) return
    const described = details.exception === undefined ? '' : argumentText(details.exception)
    const [firstLine = ''] = described.split('\n')
    // Chrome's own line already names a syntax error, which its description would repeat.
    const message = firstLine === '' || details.text.includes(firstLine) ? details.text : `${details.text} ${firstLine}`
    const frames = (details.stackTrace?.callFrames ?? []).map(stackFrame)
    this.#observe({
      kind: 'runtime_error',
      key: String(details.exceptionId),
      errorKind: details.text.includes('(in promise)') ? 'unhandled_rejection' : 'uncaught',
      message,
      time: timestamp,
      ...(details.url === undefined || details.url === '' ? {} : { url: details.url }),
      line: details.lineNumber + 1,
      column: details.columnNumber + 1,
      stack: frames,
      ...this.#frameOf(context?.frameId),
    })
  }

  // A browser entry about a request names it; a worker's entry is the worker's own message, with its level only.
  #logEntry(entry: LogEntry): void {
    const hop = entry.networkRequestId === undefined ? undefined : this.#hops.get(entry.networkRequestId)
    const [top] = entry.stackTrace?.callFrames ?? []
    const position = top === undefined ? lineOf(entry.lineNumber) : frameFields(top)
    this.#observe({
      kind: 'console',
      consoleType: entry.level,
      level: logLevels[entry.level] ?? 'info',
      origin: entry.source === 'worker' ? 'worker' : 'browser',
      source: entry.source,
      text: entry.text,
      time: entry.timestamp,
      ...(entry.url === undefined || entry.url === '' ? {} : { url: entry.url }),
      ...position,
      ...(hop === undefined ? {} : { requestKey: hop.key }),
    })
  }

  // Chrome sends a redirect as the next hop's request under the same id, carrying the response that redirected it.
  #requestSent(params: RequestSent): void {
    const { requestId, timestamp, wallTime, redirectResponse } = params
    const previous = this.#hops.get(requestId)
    if (previous === undefined && this.#hops.size >= this.#maxTrackedRequests) {
      if (this.#sink.limited !== undefined) this.#sink.limited('Network.requestWillBeSent', 1)
      else this.#sink.unreadable('Network.requestWillBeSent')
      return
    }
    const number = previous === undefined ? 1 : previous.number + 1
    const hop: Hop = { key: `${requestId}#${number}`, number, frameId: params.frameId, startSeconds: timestamp, wallOffsetSeconds: wallTime - timestamp, servedFromCache: false }
    if (previous !== undefined && redirectResponse !== undefined) {
      const time = redirectResponse.responseTime ?? wallMs(previous, timestamp)
      this.#observe({ kind: 'response', ...responseFields(redirectResponse, false), key: previous.key, time, redirectedTo: hop.key })
      const transferred = redirectResponse.encodedDataLength === undefined ? {} : { transferredBytes: Math.round(redirectResponse.encodedDataLength) }
      this.#observe({ kind: 'finished', key: previous.key, time, ...durationOf(previous, timestamp), ...transferred })
    }
    this.#hops.set(requestId, hop)
    this.#observe({
      kind: 'request',
      key: hop.key,
      method: params.request.method,
      url: params.request.url,
      ...(params.type === undefined ? {} : { resourceType: params.type }),
      time: wallTime * 1000,
      ...this.#frameOf(params.frameId),
      ...(previous !== undefined && redirectResponse !== undefined ? { redirectedFrom: previous.key } : {}),
    })
    // A dedicated worker's own script is a document of its own, with no loader: Chrome reports its end to the worker.
    // Chrome's own error page, shown for an answer it would not render, is not the app's.
    const workerScript = params.type === 'Script' && params.loaderId === '' && params.documentURL === params.request.url
    if (workerScript || params.documentURL?.startsWith('chrome-error:') === true) {
      this.#hops.delete(requestId)
      this.#observe({ kind: 'left', key: hop.key, time: wallTime * 1000 })
    }
  }

  // A frame that moved to another site's process takes its requests with it, and Chrome reports their ends there.
  #leaveFrame(frameId: string): void {
    for (const [requestId, hop] of this.#hops) {
      if (hop.frameId !== frameId) continue
      this.#hops.delete(requestId)
      this.#observe({ kind: 'left', key: hop.key, time: Date.now() })
    }
  }

  #responseReceived({ requestId, timestamp, response }: ResponseReceived): void {
    const hop = this.#hops.get(requestId)
    if (hop === undefined) return
    const time = response.responseTime ?? wallMs(hop, timestamp)
    this.#observe({ kind: 'response', ...responseFields(response, hop.servedFromCache), key: hop.key, time })
  }

  #finished({ requestId, timestamp, encodedDataLength }: Finished): void {
    const hop = this.#hops.get(requestId)
    if (hop === undefined) return
    this.#hops.delete(requestId)
    const transferred = encodedDataLength === undefined ? {} : { transferredBytes: Math.round(encodedDataLength) }
    this.#observe({ kind: 'finished', key: hop.key, time: wallMs(hop, timestamp), ...durationOf(hop, timestamp), ...transferred })
  }

  #failed({ requestId, timestamp, errorText, canceled, blockedReason }: Failed): void {
    const hop = this.#hops.get(requestId)
    if (hop === undefined) return
    this.#hops.delete(requestId)
    this.#observe({
      kind: 'failed',
      key: hop.key,
      time: wallMs(hop, timestamp),
      ...durationOf(hop, timestamp),
      reason: errorText,
      ...(canceled === true ? { canceled: true } : {}),
      ...(blockedReason === undefined ? {} : { blocked: blockedReason }),
    })
  }

  #frameOf(frameId: string | undefined): { frame?: FrameRole } {
    if (frameId === undefined) return {}
    return { frame: frameId === this.#mainFrameId() ? 'main' : 'child' }
  }
}

type ConsoleCalled = { type: string; args: ConsoleArgument[]; executionContextId: number; timestamp: number; stackTrace?: StackTrace }
type CallFrame = { functionName: string; url: string; lineNumber: number; columnNumber: number }
type StackTrace = { callFrames: CallFrame[] }
type ExceptionThrown = {
  timestamp: number
  exceptionDetails: {
    exceptionId: number
    text: string
    lineNumber: number
    columnNumber: number
    url?: string
    stackTrace?: StackTrace
    exception?: ConsoleArgument
    executionContextId?: number
  }
}
type LogEntry = { source: string; level: string; text: string; timestamp: number; url?: string; lineNumber?: number; networkRequestId?: string; stackTrace?: StackTrace }
type Response = {
  url: string
  status: number
  statusText?: string
  mimeType?: string
  fromDiskCache?: boolean
  fromServiceWorker?: boolean
  fromPrefetchCache?: boolean
  encodedDataLength?: number
  responseTime?: number
  protocol?: string
}
type RequestSent = {
  requestId: string
  loaderId?: string
  documentURL?: string
  request: { url: string; method: string }
  timestamp: number
  wallTime: number
  type?: string
  frameId?: string
  redirectResponse?: Response
}
type ResponseReceived = { requestId: string; timestamp: number; response: Response }
type Finished = { requestId: string; timestamp: number; encodedDataLength?: number }
type Failed = { requestId: string; timestamp: number; errorText: string; canceled?: boolean; blockedReason?: string }

function stackFrame({ functionName, url, lineNumber, columnNumber }: CallFrame): ObservedFrame {
  return {
    ...(functionName === '' ? {} : { function: functionName }),
    ...(url === '' ? {} : { url }),
    line: lineNumber + 1,
    column: columnNumber + 1,
  }
}

function frameFields(frame: CallFrame | undefined): { url?: string; line?: number; column?: number } {
  if (frame === undefined) return {}
  return { ...(frame.url === '' ? {} : { url: frame.url }), line: frame.lineNumber + 1, column: frame.columnNumber + 1 }
}

function lineOf(lineNumber: number | undefined): { line?: number } {
  return lineNumber === undefined ? {} : { line: lineNumber + 1 }
}

// A response's facts Retest keeps: no header, and only the media type of its content type. A cache the browser named
// is kept; when it named none, `none`; when it said nothing, nothing.
function responseFields(response: Response, servedFromCache: boolean): Omit<Extract<Observation, { kind: 'response' }>, 'kind' | 'key' | 'time' | 'redirectedTo'> {
  const said = response.fromDiskCache !== undefined || response.fromPrefetchCache !== undefined || servedFromCache
  const cache = servedFromCache ? 'memory' : response.fromDiskCache === true ? 'disk' : response.fromPrefetchCache === true ? 'prefetch' : 'none'
  return {
    status: response.status,
    ...(response.statusText === undefined || response.statusText === '' ? {} : { statusText: response.statusText }),
    ...(response.mimeType === undefined || response.mimeType === '' ? {} : { contentType: response.mimeType }),
    ...(said ? { cache } : {}),
    ...(response.fromServiceWorker === undefined ? {} : { serviceWorker: response.fromServiceWorker }),
    ...(response.protocol === undefined || response.protocol === '' ? {} : { protocol: response.protocol }),
  }
}

function wallMs(hop: Hop, timestampSeconds: number): number {
  return (timestampSeconds + hop.wallOffsetSeconds) * 1000
}

// The browser's own clock measures a hop; a reading that runs backwards measures nothing, so it is left out rather
// than written as zero.
function durationOf(hop: Hop, endSeconds: number): { durationMs?: number } {
  const durationMs = (endSeconds - hop.startSeconds) * 1000
  return durationMs >= 0 ? { durationMs: Math.round(durationMs * 1000) / 1000 } : {}
}
