import type { FileHandle } from 'node:fs/promises'
import type { DiagnosticIdentity, NetworkCapture, NetworkCounts, NetworkRecord } from '../protocol/diagnostics.ts'
import type { AttemptBudget, TextRedactor } from './session-capture.ts'
import { open } from 'node:fs/promises'
import { StringDecoder } from 'node:string_decoder'
import { parse, s, type Schema } from '../protocol/schema.ts'
import { boundText, sanitizeUrl } from './sanitize.ts'

/** The metadata channel used by the fixture service. No header or body field is accepted. */
export type NativeNetworkMetadata = {
  schemaVersion: 1; type: 'http.request'; sequence: number; startedAt: string; method: string; path: string
  status: number; durationMs: number; client: 'web' | 'ios' | 'macos' | 'electron' | 'test' | 'unknown'; completed: boolean
}
export type NativeNetworkDeclaration = { path: string; client: 'ios' | 'macos' }
/** Positioned reads permit a bounded snapshot without retaining the whole source in memory. */
export type NativeNetworkFile = { size(): Promise<number>; read(offset: number, length: number): Promise<Uint8Array>; close(): Promise<void> }
export type NativeNetworkOptions = {
  identity: DiagnosticIdentity; budget: AttemptBudget; redactor: TextRedactor; source?: NativeNetworkDeclaration
  enabled?: boolean; openFile?: (path: string) => Promise<NativeNetworkFile>
}
export type NativeNetworkResult = { records: NetworkRecord[]; capture: NetworkCapture }

const metadataSchema: Schema<NativeNetworkMetadata> = s.object({
  schemaVersion: s.literal(1), type: s.literal('http.request'), sequence: s.number({ integer: true, min: 1 }),
  startedAt: s.string(), method: s.string(), path: s.string(),
  status: s.number({ integer: true, min: 100 }), durationMs: s.number({ min: 0 }),
  client: s.enum(['web', 'ios', 'macos', 'electron', 'test', 'unknown']), completed: s.boolean(),
})

/** Reads the exact versioned shape, including finite timing and a valid ISO timestamp. */
export function readNativeNetworkMetadata(line: string): NativeNetworkMetadata | undefined {
  let value: unknown
  try { value = JSON.parse(line) } catch { return undefined }
  const read = parse(metadataSchema, value)
  if (!read.ok || !Number.isSafeInteger(read.value.sequence) || !['GET', 'HEAD', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS', 'OTHER'].includes(read.value.method) || read.value.status > 599 || !Number.isFinite(read.value.durationMs)) return undefined
  const time = Date.parse(read.value.startedAt)
  if (!Number.isFinite(time) || new Date(time).toISOString() !== read.value.startedAt || !Number.isFinite(time + read.value.durationMs) || Math.abs(time + read.value.durationMs) > 8.64e15) return undefined
  return read.value
}

/** The parent opens this before launching the app. Only appended records for the declared client enter this attempt. */
export class NativeNetworkSource {
  readonly #options: NativeNetworkOptions
  readonly #records: NetworkRecord[] = []
  readonly #counts: NetworkCounts = { requests: 0, httpErrors: 0, transportFailures: 0, canceled: 0, pending: 0, outOfScope: 0, dropped: 0, truncated: 0, bytes: 0 }
  readonly #reasons = new Set<string>()
  #file: NativeNetworkFile | undefined
  #offset = 0
  #opened = false
  #starting: Promise<void> | undefined
  #unavailable: string | undefined
  #finished: Promise<NativeNetworkResult> | undefined

  constructor(options: NativeNetworkOptions) { this.#options = { ...options, identity: { ...options.identity }, ...(options.source === undefined ? {} : { source: { ...options.source } }) } }

  start(): Promise<void> {
    if (this.#opened || this.#finished !== undefined) return Promise.reject(new Error('The native network source was already opened or finished.'))
    this.#opened = true
    this.#starting = this.#start()
    return this.#starting
  }

  async #start(): Promise<void> {
    if (this.#options.enabled === false) return
    const source = this.#options.source
    if (source === undefined) { this.#unavailable = 'the app provides no network source'; return }
    try {
      this.#file = await (this.#options.openFile ?? openNetworkFile)(source.path)
      this.#offset = await this.#file.size()
      if (!Number.isSafeInteger(this.#offset) || this.#offset < 0) throw new Error('invalid file size')
    } catch (error) {
      this.#unavailable = error instanceof Error && 'code' in error && error.code === 'ENOENT' ? 'the declared network file is missing' : 'the declared network file is unreadable'
      try { await this.#file?.close() } catch { this.#unavailable = 'the declared network file is unreadable and could not be closed' }
      this.#file = undefined
    }
  }

  finish(): Promise<NativeNetworkResult> { this.#finished ??= this.#finish(); return this.#finished }

  async #finish(): Promise<NativeNetworkResult> {
    await this.#starting
    if (!this.#opened) this.#unavailable = 'the network source was not opened before the app ran'
    const file = this.#file
    if (file !== undefined) {
      try {
        const end = await file.size()
        if (!Number.isSafeInteger(end) || end < 0) throw new Error('invalid file size')
        if (end < this.#offset) this.#reasons.add('the network file was truncated during capture')
        else await this.#read(file, end)
      } catch { this.#reasons.add('the network file could not be read to its end') }
      finally { try { await file.close() } catch { this.#reasons.add('the network file could not be closed') } }
    }
    if (this.#counts.dropped > 0) this.#reasons.add('network records over the diagnostics limits were dropped')
    if (this.#counts.truncated > 0) this.#reasons.add('network routes over the text limit were cut')
    const capture: NetworkCapture = this.#options.enabled === false ? { state: 'disabled' }
      : this.#unavailable !== undefined ? { state: 'unavailable', reason: this.#unavailable }
      : this.#reasons.size > 0 ? { state: 'partial', ...this.#counts, reason: [...this.#reasons].join('; ') }
      : this.#records.length === 0 ? { state: 'unavailable', reason: 'the source wrote no network records for the owned app' }
      : { state: 'complete', ...this.#counts }
    return { records: this.#records, capture }
  }

  async #read(file: NativeNetworkFile, end: number): Promise<void> {
    const decoder = new StringDecoder('utf8')
    let line = ''
    let oversized = false
    let lastSequence = 0
    const consume = (text: string): void => {
      for (const part of text.split(/(?<=\n)/)) {
        const ended = part.endsWith('\n')
        const piece = ended ? part.slice(0, -1) : part
        // The input cap includes protocol overhead and applies before JSON parsing. Oversized lines are never kept.
        if (!oversized) {
          const limit = Math.max(4096, this.#options.budget.limits.textLength * 4)
          if (line.length + piece.length > limit) { line = ''; oversized = true }
          else line += piece
        }
        if (!ended) continue
        if (oversized) { this.#counts.dropped++; this.#reasons.add('a network source line exceeded the input limit') }
        else if (line !== '') {
          const record = readNativeNetworkMetadata(line)
          if (record === undefined || record.sequence <= lastSequence) this.#reasons.add('a network source record was invalid or out of order')
          else { lastSequence = record.sequence; if (record.client === this.#options.source?.client) this.#keep(record) }
        }
        line = ''; oversized = false
      }
    }
    // Bound work even when another client floods the shared file. No unbounded whole-file read.
    const scanLimit = Math.max(4096, this.#options.budget.limits.networkBytes * 4)
    const through = Math.min(end, this.#offset + scanLimit)
    for (let offset = this.#offset; offset < through;) {
      const bytes = await file.read(offset, Math.min(4096, through - offset))
      if (bytes.length === 0) { this.#reasons.add('the network file ended before its captured size'); break }
      offset += bytes.length; consume(decoder.write(Buffer.from(bytes)))
    }
    consume(decoder.end())
    if (through < end) this.#reasons.add('the network file exceeded the input byte limit')
    if (line !== '' || oversized) this.#reasons.add('the network file ended inside a record')
  }

  #keep(metadata: NativeNetworkMetadata): void {
    const { identity, budget, redactor } = this.#options
    const client = this.#options.source?.client
    if (client === undefined) return
    const clean = redactor.redact(metadata.path)
    // Relative routes get the same credential, query, fragment and token-path cleaning as browser URLs.
    const address = sanitizeUrl(new URL(clean, 'http://native.invalid').href)
    const route = boundText(address.replace(/^http:\/\/native\.invalid/, ''), budget.limits.textLength)
    const provenance = { ...identity, source: 'app-network-file' as const, client }
    const requestId = `n${this.#counts.requests + 1}`
    const time = new Date(Date.parse(metadata.startedAt) + metadata.durationMs).toISOString()
    const records: NetworkRecord[] = [
      { ...provenance, type: 'network.request', requestId, method: metadata.method, url: route.text, ...(route.truncated ? { urlTruncated: true } : {}), time: metadata.startedAt },
      { ...provenance, type: 'network.response', requestId, status: metadata.status, time },
      metadata.completed ? { ...provenance, type: 'network.finished', requestId, durationMs: metadata.durationMs, time }
        : { ...provenance, type: 'network.failed', requestId, durationMs: metadata.durationMs, time, reason: 'the connection closed before the response completed' },
    ]
    const bytes = records.reduce((sum, record) => sum + Buffer.byteLength(JSON.stringify(record)) + 1, 0)
    if (budget.requests >= budget.limits.requests || budget.networkBytes + budget.reservedBytes + bytes > budget.limits.networkBytes) { this.#counts.dropped++; return }
    budget.requests++; budget.networkBytes += bytes
    this.#counts.requests++; this.#counts.bytes += bytes
    if (metadata.status >= 400) this.#counts.httpErrors++
    else if (!metadata.completed) this.#counts.transportFailures++
    if (route.truncated) this.#counts.truncated++
    this.#records.push(...records)
  }
}

async function openNetworkFile(path: string): Promise<NativeNetworkFile> {
  const file = await open(path, 'r')
  const stat = await file.stat()
  if (!stat.isFile()) { await file.close(); throw new Error('not a regular file') }
  return networkFile(file)
}
function networkFile(file: FileHandle): NativeNetworkFile {
  return {
    size: async () => (await file.stat()).size,
    read: async (offset, length) => { const buffer = Buffer.alloc(length); const read = await file.read(buffer, 0, length, offset); return buffer.subarray(0, read.bytesRead) },
    close: () => file.close(),
  }
}
