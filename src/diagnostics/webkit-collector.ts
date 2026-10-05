import type { TargetEvent } from '../browser/webkit/connection.ts'
import type { PageLoss } from '../browser/webkit/page.ts'
import type { DiagnosticScope, FrameRole } from '../protocol/diagnostics.ts'
import type { Schema } from '../protocol/schema.ts'
import type { ConsoleArgument, ObjectPreview, PropertyPreview } from './console-text.ts'
import type { ConsoleObservation, DiagnosticCollection, DiagnosticSink, ObservedFrame, Observation } from './observations.ts'
import { isRecord } from '../browser/cdp/message.ts'
import { readProtocol } from '../browser/cdp-results.ts'
import { s } from '../protocol/schema.ts'
import { argumentText, cutValue } from './console-text.ts'

/**
 * What the collector needs of a WebKit page: its targets' events, its main frame, the target a navigation into another
 * web process set up and has not committed yet, if one is under way, and its end.
 */
export interface WebKitPageEvents {
  onTargetEvent(listener: (event: TargetEvent) => void): () => void
  onLost(listener: (loss: PageLoss) => void): () => void
  readonly mainFrameId: string
  readonly provisionalTargetId?: string | undefined
}

export type WebKitCollectorOptions = {
  page: WebKitPageEvents
  sink: DiagnosticSink
  /** Bounds in-flight request metadata even when the sink has already filled its artifact budget. */
  maxTrackedRequests?: number
}

/**
 * What a WebKit page's targets cover, from what Retest exercised on build 2359: the page's document, through every
 * target a navigation swaps it into, and its frames, which this build renders in the page's own web process whatever
 * their site, so a frame of another site is covered as one of the page's own. Each request names its frame; a console
 * message names its script, which the debugger the page turns on names the context and so the frame of. A dedicated
 * worker reports its console to a target of its own, which Retest does not open, and its requests to the page's target
 * under its own id, which the collector leaves out.
 */
export const webKitScope: DiagnosticScope = {
  engine: 'webkit',
  source: 'page_target',
  console: { covered: ['top_level_document', 'same_process_frames', 'out_of_process_frames'], notCovered: ['dedicated_workers', 'shared_workers', 'service_workers'] },
  network: { covered: ['top_level_document', 'same_process_frames', 'out_of_process_frames'], notCovered: ['dedicated_workers', 'shared_workers', 'service_workers'] },
  reason:
    "WebKit renders a page's frames of every site in the page's own process, so a frame of another site is covered with the page. A message whose script WebKit does not name, as one the browser logs, names no frame unless it is about a request. A response names no protocol: WebKit gives it only once the load ends.",
}

const callFrameSchema = s.object({ functionName: s.string(), url: s.string(), scriptId: s.optional(s.string()), lineNumber: s.number(), columnNumber: s.number() })
const messageSchema = s.object({
  message: s.object({
    source: s.string(),
    level: s.string(),
    text: s.string(),
    type: s.optional(s.string()),
    url: s.optional(s.string()),
    line: s.optional(s.number()),
    column: s.optional(s.number()),
    stackTrace: s.optional(s.object({ callFrames: s.array(callFrameSchema) })),
    networkRequestId: s.optional(s.string()),
    timestamp: s.optional(s.number()),
  }),
})
const repeatSchema = s.object({ count: s.number({ integer: true }), timestamp: s.optional(s.number()) })
// A console argument as WebKit sends it, read on its own: WebKit says `overflow` only when properties did not fit, names
// a collection without its size, which it sends apart, and previews a nested object as an object of its own.
const valuePreviewSchema = s.object({ type: s.string(), subtype: s.optional(s.string()), description: s.optional(s.string()), size: s.optional(s.number()) })
const propertyPreviewSchema = s.object({ name: s.string(), type: s.string(), subtype: s.optional(s.string()), value: s.optional(s.string()), valuePreview: s.optional(valuePreviewSchema) })
const objectPreviewSchema = s.object({
  type: s.string(),
  subtype: s.optional(s.string()),
  description: s.optional(s.string()),
  overflow: s.optional(s.boolean()),
  properties: s.optional(s.array(propertyPreviewSchema)),
  size: s.optional(s.number()),
})
const argumentSchema = s.object({
  type: s.string(),
  subtype: s.optional(s.string()),
  className: s.optional(s.string()),
  value: s.optional(s.union([s.string(), s.number(), s.boolean(), s.literal(null)])),
  description: s.optional(s.string()),
  size: s.optional(s.number()),
  preview: s.optional(objectPreviewSchema),
})
const contextSchema = s.object({ context: s.object({ id: s.number(), frameId: s.string() }) })
const scriptSchema = s.object({ scriptId: s.string(), executionContextId: s.number() })
const responseSchema = s.object({ url: s.string(), status: s.number(), statusText: s.optional(s.string()), mimeType: s.optional(s.string()), source: s.optional(s.string()) })
const requestSentSchema = s.object({
  requestId: s.string(),
  frameId: s.optional(s.string()),
  request: s.object({ url: s.string(), method: s.string() }),
  timestamp: s.number(),
  walltime: s.number(),
  type: s.optional(s.string()),
  redirectResponse: s.optional(responseSchema),
  targetId: s.optional(s.string()),
})
const responseReceivedSchema = s.object({ requestId: s.string(), timestamp: s.number(), response: responseSchema })
const requestIdSchema = s.object({ requestId: s.string() })
const metricsSchema = s.optional(s.object({ protocol: s.optional(s.string()), responseHeaderBytesReceived: s.optional(s.number()), responseBodyBytesReceived: s.optional(s.number()) }))
const finishedSchema = s.object({ requestId: s.string(), timestamp: s.number(), metrics: metricsSchema })
const failedSchema = s.object({ requestId: s.string(), timestamp: s.number(), errorText: s.string(), canceled: s.optional(s.boolean()) })
const memoryCacheSchema = s.object({
  requestId: s.string(),
  frameId: s.optional(s.string()),
  timestamp: s.number(),
  resource: s.object({ url: s.string(), type: s.optional(s.string()), response: s.optional(responseSchema) }),
})

/** One request id's current hop: its key, the target it was heard on, and when it started on the engine's monotonic clock. */
type Hop = { key: string; number: number; targetId: string; frameId: string | undefined; startSeconds: number; wallOffsetSeconds: number }

// WebKit's console levels by the console method's type when the type does not say more, as Chromium names them.
const consoleTypes: Readonly<Record<string, string>> = { log: 'log', info: 'info', warning: 'warning', error: 'error', debug: 'debug' }
const consoleLevels: Readonly<Record<string, 'debug' | 'info' | 'warning' | 'error'>> = { log: 'info', info: 'info', warning: 'warning', error: 'error', debug: 'debug' }
// A page that parses scripts without end, as one that evaluates code in a loop does, keeps this many per target; a
// message from a script past it names no frame.
const maxTrackedScripts = 10_000

/**
 * Collects a WebKit page's console messages, runtime errors and network metadata into a sink, from the events of the
 * page's committed and provisional targets, which had their domains turned on when the page set each one up. It sends
 * no command, never reads a page object, and never asks for a body. WebKit reports an uncaught error as a console
 * message from the `javascript` source, and a message logged again at once as a repeat count; each repeat is recorded
 * as the message it repeats.
 */
export class WebKitCollector implements DiagnosticCollection {
  readonly scope: DiagnosticScope = webKitScope
  readonly #page: WebKitPageEvents
  readonly #sink: DiagnosticSink
  readonly #stops: (() => void)[] = []
  readonly #hops = new Map<string, Hop>()
  readonly #maxTrackedRequests: number
  // By target: each execution context's frame, and the context each script was parsed in.
  readonly #contextFrames = new Map<string, Map<number, string>>()
  readonly #scriptContexts = new Map<string, Map<string, number>>()
  // The workers whose script request has been heard, by the id their requests carry.
  readonly #workers = new Set<string>()
  #committedTarget: string | undefined
  #last: Observation | undefined
  #errors = 0
  #stopped = false

  constructor({ page, sink, maxTrackedRequests = 1000 }: WebKitCollectorOptions) {
    if (!Number.isSafeInteger(maxTrackedRequests) || maxTrackedRequests < 1) throw new RangeError('The collector request limit must be a positive safe integer.')
    this.#page = page
    this.#sink = sink
    this.#maxTrackedRequests = maxTrackedRequests
    this.#stops.push(page.onTargetEvent((event) => this.#hear(event)))
    this.#stops.push(page.onLost(({ reason, crashed }) => this.#lose(crashed ? 'page_crashed' : 'connection_lost', reason)))
  }

  stop(): void {
    if (this.#stopped) return
    this.#stopped = true
    for (const stop of this.#stops.splice(0)) stop()
    this.#hops.clear()
    this.#workers.clear()
    this.#contextFrames.clear()
    this.#scriptContexts.clear()
  }

  #hear(event: TargetEvent): void {
    if (this.#stopped) return
    switch (event.method) {
      case 'Console.messageAdded':
        return this.#read(event, messageSchema, ({ message }) => this.#message(event.targetId, { ...message, parameters: parametersOf(event.params) }))
      case 'Runtime.executionContextCreated':
        return this.#contextCreated(event)
      case 'Debugger.scriptParsed':
        return this.#scriptParsed(event)
      case 'Console.messageRepeatCountUpdated':
        return this.#read(event, repeatSchema, ({ timestamp }) => this.#repeat(timestamp))
      case 'Network.requestWillBeSent':
        return this.#read(event, requestSentSchema, (params) => this.#requestSent(event.targetId, params))
      case 'Network.responseReceived':
        return this.#read(event, responseReceivedSchema, (params) => this.#responseReceived(params))
      case 'Network.dataReceived':
        return this.#read(event, requestIdSchema, ({ requestId }) => {
          const hop = this.#hops.get(requestId)
          if (hop !== undefined) this.#observe({ kind: 'data', key: hop.key })
        })
      case 'Network.loadingFinished':
        return this.#read(event, finishedSchema, (params) => this.#finished(params))
      case 'Network.loadingFailed':
        return this.#read(event, failedSchema, (params) => this.#failed(params))
      case 'Network.requestServedFromMemoryCache':
        return this.#read(event, memoryCacheSchema, (params) => this.#servedFromMemory(event.targetId, params))
      case 'Page.frameNavigated':
        this.#targetSeen(event.targetId)
        return
    }
  }

  // Each event is read against the parts Retest relies on, with every other key dropped first, so a header or a body
  // the schema does not name is never copied. One it cannot read is counted, never guessed at.
  #read<T>(event: TargetEvent, schema: Schema<T>, handle: (params: T) => void): void {
    let read: T
    try {
      read = readProtocol(schema, event.params, { method: event.method })
    } catch {
      this.#sink.unreadable(event.method)
      return
    }
    handle(read)
  }

  #observe(observation: Observation): void {
    if (this.#stopped) return
    this.#sink.observe(observation)
    if (observation.kind === 'console' || observation.kind === 'runtime_error') this.#last = observation
  }

  #lose(kind: 'page_crashed' | 'connection_lost', reason: string): void {
    if (this.#stopped) return
    this.#sink.lost({ kind, reason, time: Date.now() })
    this.stop()
  }

  // A navigation into a new web process leaves the requests of the target it left without an end there, and its
  // contexts and scripts behind.
  #targetSeen(targetId: string): void {
    if (this.#committedTarget === targetId) return
    this.#committedTarget = targetId
    for (const [requestId, hop] of this.#hops) {
      if (hop.targetId === targetId) continue
      this.#hops.delete(requestId)
      this.#observe({ kind: 'left', key: hop.key, time: Date.now() })
    }
    for (const known of [this.#contextFrames, this.#scriptContexts]) {
      for (const target of known.keys()) if (target !== targetId && target !== this.#page.provisionalTargetId) known.delete(target)
    }
  }

  // A context or a script WebKit describes in a form Retest cannot read only leaves the messages from it without a
  // frame, which is what a record without one says, so it is not counted as a lost event.
  #contextCreated({ targetId, method, params }: TargetEvent): void {
    const read = readQuietly(contextSchema, params, method)
    if (read === undefined) return
    const frames = this.#contextFrames.get(targetId) ?? new Map<number, string>()
    frames.set(read.context.id, read.context.frameId)
    this.#contextFrames.set(targetId, frames)
  }

  #scriptParsed({ targetId, method, params }: TargetEvent): void {
    const read = readQuietly(scriptSchema, params, method)
    if (read === undefined) return
    const scripts = this.#scriptContexts.get(targetId) ?? new Map<string, number>()
    if (scripts.size >= maxTrackedScripts && !scripts.has(read.scriptId)) return
    scripts.set(read.scriptId, read.executionContextId)
    this.#scriptContexts.set(targetId, scripts)
  }

  // WebKit names no frame for a console message. It names the script at the top of the message's stack, the debugger
  // names the context it parsed that script in, and the context names its frame; where any link is missing, as it is
  // for every message while WebKit's debugger is off, the message names no frame.
  #messageFrame(targetId: string, top: CallFrame | undefined): { frame?: FrameRole } {
    if (top?.scriptId === undefined) return {}
    const context = this.#scriptContexts.get(targetId)?.get(top.scriptId)
    const frameId = context === undefined ? undefined : this.#contextFrames.get(targetId)?.get(context)
    if (frameId === undefined) return {}
    return { frame: frameId === this.#page.mainFrameId ? 'main' : 'child' }
  }

  // A message with no time of its own is counted as one Retest could not read: the parent's clock is not the engine's.
  #message(targetId: string, message: WebKitMessage): void {
    if (message.timestamp === undefined) {
      this.#sink.unreadable('Console.messageAdded')
      return
    }
    const time = message.timestamp * 1000
    const [top] = message.stackTrace?.callFrames ?? []
    const position = top === undefined ? lineFields(message) : frameFields(top)
    const frame = top === undefined ? this.#requestFrame(message.networkRequestId) : this.#messageFrame(targetId, top)
    if (message.source === 'javascript' && message.level === 'error') {
      this.#errors += 1
      this.#observe({
        kind: 'runtime_error',
        key: `webkit-error-${this.#errors}`,
        errorKind: message.text.startsWith('Unhandled Promise Rejection') ? 'unhandled_rejection' : 'uncaught',
        message: message.text,
        time,
        ...position,
        ...frame,
        stack: (message.stackTrace?.callFrames ?? []).map(stackFrame),
      })
      return
    }
    const page = message.source === 'console-api'
    const consoleType = isCount(message) ? 'count' : message.type === undefined || message.type === 'log' ? (consoleTypes[message.level] ?? 'log') : message.type
    const observation: ConsoleObservation = {
      kind: 'console',
      consoleType,
      level: message.type === 'assert' ? 'error' : (consoleLevels[message.level] ?? 'info'),
      origin: page ? 'page' : 'browser',
      ...(page ? {} : { source: message.source }),
      text: page ? textOf(message) : message.text,
      time,
      ...position,
      ...frame,
      ...this.#requestOf(message.networkRequestId),
    }
    this.#observe(observation)
  }

  // WebKit folds a message logged again at once into a count; each repeat is the page logging it again.
  #repeat(timestamp: number | undefined): void {
    const last = this.#last
    if (last === undefined) return
    if (timestamp === undefined) {
      this.#sink.unreadable('Console.messageRepeatCountUpdated')
      return
    }
    const time = timestamp * 1000
    if (last.kind === 'runtime_error') {
      this.#errors += 1
      this.#observe({ ...last, key: `webkit-error-${this.#errors}`, time })
    } else if (last.kind === 'console') {
      this.#observe({ ...last, time })
    }
  }

  // A message the browser logs about a request, which names no script, is the frame's that made the request.
  #requestFrame(requestId: string | undefined): { frame?: FrameRole } {
    const hop = requestId === undefined ? undefined : this.#hops.get(requestId)
    return hop === undefined ? {} : this.#frameOf(hop.frameId, hop.targetId, undefined)
  }

  #requestOf(requestId: string | undefined): { requestKey?: string } {
    const hop = requestId === undefined ? undefined : this.#hops.get(requestId)
    return hop === undefined ? {} : { requestKey: hop.key }
  }

  // WebKit sends a redirect as the next hop's request under the same id, carrying the response that redirected it.
  #requestSent(targetId: string, params: RequestSent): void {
    const { requestId, timestamp, walltime, redirectResponse } = params
    // A worker's requests come on the page's target under the worker's own id. The first is the worker's script, which
    // the page loads before the worker runs at all, so it is the page's; every later one is the worker's, outside the scope.
    const worker = params.targetId !== undefined && params.targetId !== targetId && params.targetId !== this.#page.provisionalTargetId ? params.targetId : undefined
    if (worker !== undefined && !this.#hops.has(requestId)) {
      if (this.#workers.has(worker)) return
      if (this.#workers.size < this.#maxTrackedRequests) this.#workers.add(worker)
    }
    const previous = this.#hops.get(requestId)
    if (previous === undefined && this.#hops.size >= this.#maxTrackedRequests) {
      if (this.#sink.limited !== undefined) this.#sink.limited('Network.requestWillBeSent', 1)
      else this.#sink.unreadable('Network.requestWillBeSent')
      return
    }
    const number = previous === undefined ? 1 : previous.number + 1
    const hop: Hop = { key: `${requestId}#${number}`, number, targetId, frameId: params.frameId, startSeconds: timestamp, wallOffsetSeconds: walltime - timestamp }
    if (previous !== undefined && redirectResponse !== undefined) {
      const time = wallMs(previous, timestamp)
      this.#observe({ kind: 'response', ...responseFields(redirectResponse), key: previous.key, time, redirectedTo: hop.key })
      this.#observe({ kind: 'finished', key: previous.key, time, ...durationOf(previous, timestamp) })
    }
    this.#hops.set(requestId, hop)
    this.#observe({
      kind: 'request',
      key: hop.key,
      method: params.request.method,
      url: params.request.url,
      ...(params.type === undefined ? {} : { resourceType: params.type }),
      time: walltime * 1000,
      ...this.#frameOf(params.frameId, targetId, params.type),
      ...(previous !== undefined && redirectResponse !== undefined ? { redirectedFrom: previous.key } : {}),
    })
  }

  #responseReceived({ requestId, timestamp, response }: ResponseReceived): void {
    const hop = this.#hops.get(requestId)
    if (hop === undefined) return
    this.#observe({ kind: 'response', ...responseFields(response), key: hop.key, time: wallMs(hop, timestamp) })
  }

  #finished({ requestId, timestamp, metrics }: Finished): void {
    const hop = this.#hops.get(requestId)
    if (hop === undefined) return
    this.#hops.delete(requestId)
    const header = metrics?.responseHeaderBytesReceived
    const body = metrics?.responseBodyBytesReceived
    const transferred = header === undefined || body === undefined ? {} : { transferredBytes: Math.round(header + body) }
    this.#observe({ kind: 'finished', key: hop.key, time: wallMs(hop, timestamp), ...durationOf(hop, timestamp), ...transferred })
  }

  #failed({ requestId, timestamp, errorText, canceled }: Failed): void {
    const hop = this.#hops.get(requestId)
    if (hop === undefined) return
    this.#hops.delete(requestId)
    this.#observe({ kind: 'failed', key: hop.key, time: wallMs(hop, timestamp), ...durationOf(hop, timestamp), reason: errorText, ...(canceled === true ? { canceled: true } : {}) })
  }

  // A resource WebKit answers from its memory cache is told in one event, with no request of its own before it.
  #servedFromMemory(targetId: string, { requestId, frameId, resource }: ServedFromMemory): void {
    if (this.#hops.has(requestId)) return
    const time = Date.now()
    const key = `${requestId}#1`
    this.#observe({ kind: 'request', key, method: 'GET', url: resource.url, ...(resource.type === undefined ? {} : { resourceType: resource.type }), time, ...this.#frameOf(frameId, targetId, resource.type) })
    if (resource.response !== undefined) this.#observe({ kind: 'response', ...responseFields(resource.response), cache: 'memory', key, time })
    this.#observe({ kind: 'finished', key, time })
  }

  // A navigation into another web process loads its document in a provisional target, whose main frame becomes the
  // page's only once it commits; until then the page names it the target the navigation set up, and the document is
  // the main frame's though its frame id is not yet the page's.
  #frameOf(frameId: string | undefined, targetId: string, resourceType: string | undefined): { frame?: FrameRole } {
    if (frameId === undefined) return {}
    if (frameId === this.#page.mainFrameId) return { frame: 'main' }
    const provisional = this.#page.provisionalTargetId
    return { frame: provisional !== undefined && targetId === provisional && resourceType === 'Document' ? 'main' : 'child' }
  }
}

type WebKitMessage = {
  source: string
  level: string
  text: string
  type?: string
  url?: string
  line?: number
  column?: number
  parameters?: unknown[] | undefined
  stackTrace?: { callFrames: CallFrame[] }
  networkRequestId?: string
  timestamp?: number
}
type CallFrame = { functionName: string; url: string; scriptId?: string; lineNumber: number; columnNumber: number }
type WebKitValuePreview = { type: string; subtype?: string; description?: string; size?: number }
type WebKitPropertyPreview = { name: string; type: string; subtype?: string; value?: string; valuePreview?: WebKitValuePreview }
type WebKitObjectPreview = { type: string; subtype?: string; description?: string; overflow?: boolean; properties?: WebKitPropertyPreview[]; size?: number }
type WebKitArgument = { type: string; subtype?: string; className?: string; value?: string | number | boolean | null; description?: string; size?: number; preview?: WebKitObjectPreview }
type WebKitResponse = { url: string; status: number; statusText?: string; mimeType?: string; source?: string }
type RequestSent = { requestId: string; frameId?: string; request: { url: string; method: string }; timestamp: number; walltime: number; type?: string; redirectResponse?: WebKitResponse; targetId?: string }
type ResponseReceived = { requestId: string; timestamp: number; response: WebKitResponse }
type Finished = { requestId: string; timestamp: number; metrics?: { protocol?: string; responseHeaderBytesReceived?: number; responseBodyBytesReceived?: number } }
type Failed = { requestId: string; timestamp: number; errorText: string; canceled?: boolean }
type ServedFromMemory = { requestId: string; frameId?: string; timestamp: number; resource: { url: string; type?: string; response?: WebKitResponse } }

// WebKit's `console.count` is a log message at debug level made without the call's arguments, which every other call of
// the page's at that level and type carries, even an empty list: read against build 2359, the one way to tell it.
function isCount(message: WebKitMessage): boolean {
  return message.source === 'console-api' && message.level === 'debug' && (message.type === undefined || message.type === 'log') && message.parameters === undefined
}

// A message's arguments are remote objects of any shape, each read on its own by `textOf`.
function parametersOf(params: unknown): unknown[] | undefined {
  const message = isRecord(params) ? params['message'] : undefined
  const parameters = isRecord(message) ? message['parameters'] : undefined
  return Array.isArray(parameters) ? parameters : undefined
}

// The page's own message is read from its arguments, as Chromium's is. WebKit's own text of it holds the first argument
// only, so an argument sent in a form Retest cannot read stands as `(cut)`, and the text never reads as whole.
function textOf(message: WebKitMessage): string {
  const parameters = message.parameters
  if (parameters === undefined || parameters.length === 0) return message.text
  return parameters
    .map((parameter) => {
      const argument = readQuietly(argumentSchema, parameter, 'Console.messageAdded')
      return argument === undefined ? cutValue : argumentText(consoleArgument(argument))
    })
    .join(' ')
}

// WebKit's description of an argument in the shape Chromium's has, which the console text reads.
function consoleArgument({ preview, size, description, ...rest }: WebKitArgument): ConsoleArgument {
  const named = sizedName(description, size)
  return { ...rest, ...(named === undefined ? {} : { description: named }), ...(preview === undefined ? {} : { preview: objectPreview(preview) }) }
}

// A preview WebKit could not finish comes without its properties, which are then left out as well.
function objectPreview(preview: WebKitObjectPreview): ObjectPreview {
  const named = sizedName(preview.description, preview.size)
  return {
    type: preview.type,
    ...(preview.subtype === undefined ? {} : { subtype: preview.subtype }),
    ...(named === undefined ? {} : { description: named }),
    overflow: preview.overflow === true || preview.properties === undefined,
    properties: (preview.properties ?? []).map(propertyPreview),
  }
}

// A nested object reads as its name, as Chromium writes a nested value.
function propertyPreview({ name, type, subtype, value, valuePreview }: WebKitPropertyPreview): PropertyPreview {
  const shown = value ?? sizedName(valuePreview?.description, valuePreview?.size)
  return { name, type, ...(subtype === undefined ? {} : { subtype }), ...(shown === undefined ? {} : { value: shown }) }
}

// Chromium's name of a collection carries its size, as `Array(3)`; WebKit sends the size apart.
function sizedName(description: string | undefined, size: number | undefined): string | undefined {
  if (description === undefined || size === undefined || description.endsWith(')')) return description
  return `${description}(${size})`
}

function readQuietly<T>(schema: Schema<T>, value: unknown, method: string): T | undefined {
  try {
    return readProtocol(schema, value, { method })
  } catch {
    return undefined
  }
}

// WebKit numbers lines and columns from 1, as the records do.
function stackFrame({ functionName, url, lineNumber, columnNumber }: CallFrame): ObservedFrame {
  return { ...(functionName === '' ? {} : { function: functionName }), ...(url === '' ? {} : { url }), line: Math.max(1, lineNumber), column: Math.max(1, columnNumber) }
}

function frameFields(frame: CallFrame): { url?: string; line?: number; column?: number } {
  return { ...(frame.url === '' ? {} : { url: frame.url }), line: Math.max(1, frame.lineNumber), column: Math.max(1, frame.columnNumber) }
}

function lineFields(message: WebKitMessage): { url?: string; line?: number; column?: number } {
  return {
    ...(message.url === undefined || message.url === '' ? {} : { url: message.url }),
    ...(message.line === undefined || message.line < 1 ? {} : { line: message.line }),
    ...(message.column === undefined || message.column < 1 ? {} : { column: message.column }),
  }
}

// A response's facts Retest keeps: no header, and only the media type of its content type. WebKit names where a
// response came from; when it says it does not know, nothing is said.
function responseFields(response: WebKitResponse): { status: number; statusText?: string; contentType?: string; cache?: 'disk' | 'memory' | 'none'; serviceWorker?: boolean } {
  const cache = response.source === 'memory-cache' ? 'memory' : response.source === 'disk-cache' ? 'disk' : response.source === 'network' || response.source === 'service-worker' ? 'none' : undefined
  return {
    status: response.status,
    ...(response.statusText === undefined || response.statusText === '' ? {} : { statusText: response.statusText }),
    ...(response.mimeType === undefined || response.mimeType === '' ? {} : { contentType: response.mimeType }),
    ...(cache === undefined ? {} : { cache }),
    ...(response.source === undefined || response.source === 'unknown' ? {} : { serviceWorker: response.source === 'service-worker' }),
  }
}

function wallMs(hop: Hop, timestampSeconds: number): number {
  return (timestampSeconds + hop.wallOffsetSeconds) * 1000
}

// The browser's own clock measures a hop; a reading that runs backwards measures nothing, so it is left out.
function durationOf(hop: Hop, endSeconds: number): { durationMs?: number } {
  const durationMs = (endSeconds - hop.startSeconds) * 1000
  return durationMs >= 0 ? { durationMs: Math.round(durationMs * 1000) / 1000 } : {}
}
