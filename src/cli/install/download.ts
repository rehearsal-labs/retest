import type { FileHandle } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { open, rm } from 'node:fs/promises'
import { errorMessage } from '../../protocol/failures.ts'

// Fetches one archive to a file and hashes it on the way, so the bytes are checked before anything reads them. Every
// address, the first and each redirect, is https, or http to this machine for a stand-in or mirror under test.

/** How many redirects a download follows: the publishers' own hand a request on once or twice. */
const maximumRedirects = 5

const redirectStatuses: ReadonlySet<number> = new Set([301, 302, 303, 307, 308])

/** What `downloadFile` needs. `fetch` is the global one unless a test passes another. */
export type DownloadRequest = {
  readonly url: string
  /** The file the bytes are written to; it is removed again when the download does not finish. */
  readonly to: string
  /** The size the pin expects, when it knows one; any other size stops the download. */
  readonly expectedSize?: number | undefined
  /** No download writes more than this, whatever the server says. */
  readonly maximumBytes: number
  readonly signal: AbortSignal
  /** How long the server may send nothing before the download is given up. */
  readonly idleMs: number
  /** How long the whole download may take. */
  readonly totalMs: number
  readonly userAgent: string
  readonly fetch?: typeof fetch | undefined
}

/** A finished download with its size, SHA-256 and the address that answered, or why there is none. */
export type DownloadResult =
  | { readonly ok: true; readonly size: number; readonly sha256: string; readonly answeredBy: string }
  | { readonly ok: false; readonly message: string; readonly stopped: boolean }

/**
 * Why Retest does not fetch from an address, or undefined when it may: an address that is not https, unless it is
 * plain http to this machine, or one that carries a user name or password.
 *
 * @example addressProblem(new URL('http://mirror.example.com/a.zip')) // 'Retest downloads only over https, …'
 */
export function addressProblem(url: URL): string | undefined {
  if (url.username !== '' || url.password !== '') return 'Retest does not send credentials written in an address; the address it was given carries some.'
  if (url.protocol === 'https:') return undefined
  if (url.protocol === 'http:' && isLoopback(url.hostname)) return undefined
  return `Retest downloads only over https, or over http from this machine, and was sent to ${url.protocol}//${url.host}.`
}

/**
 * An address as Retest prints and records it: its origin and path, and nothing else. A user name, password, query or
 * fragment can carry a token or a signature, such as the one on a release asset a publisher redirects to.
 *
 * @example shownAddress('https://objects.example.com/asset.zip?X-Amz-Signature=abc') // 'https://objects.example.com/asset.zip'
 */
export function shownAddress(address: string | URL): string {
  const url = typeof address === 'string' ? URL.parse(address) : address
  return url === null ? '(an address that does not parse)' : `${url.origin}${url.pathname}`
}

/**
 * The address to fetch a pinned archive from: the publisher's, or the same path under a mirror, with the publisher's
 * host as its first folder, so one mirror can serve every publisher.
 *
 * @example mirroredUrl('https://github.com/a/b.zip', 'http://127.0.0.1:4100') // 'http://127.0.0.1:4100/github.com/a/b.zip'
 */
export function mirroredUrl(url: string, mirror: string | undefined): string {
  if (mirror === undefined) return url
  const source = new URL(url)
  return `${mirror.replace(/\/+$/, '')}/${source.host}${source.pathname}`
}

/**
 * Fetches `url` into `to`, following redirects that stay on allowed addresses, and returns the size and SHA-256 of
 * what was written. A download that fails, stops, stalls, outgrows its limit or ends at another size than expected
 * leaves no file behind.
 *
 * @example await downloadFile({ url, to, maximumBytes, signal, idleMs: 60_000, totalMs: 3_600_000, userAgent: 'retest/0.1.0' })
 */
export async function downloadFile(request: DownloadRequest): Promise<DownloadResult> {
  const idle = new AbortController()
  const total = AbortSignal.timeout(request.totalMs)
  const signal = AbortSignal.any([request.signal, idle.signal, total])
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  const touch = (): void => {
    clearTimeout(idleTimer)
    idleTimer = setTimeout(() => idle.abort(), request.idleMs)
  }
  const why = (): { message: string; stopped: boolean } => {
    if (request.signal.aborted) return { message: 'The download was stopped.', stopped: true }
    if (idle.signal.aborted) return { message: `The server sent nothing for ${request.idleMs} ms, so the download was given up.`, stopped: false }
    return { message: `The download did not finish within ${request.totalMs} ms.`, stopped: false }
  }
  touch()
  try {
    const response = await follow(request, signal)
    if (!response.ok) return { ok: false, ...(signal.aborted ? why() : { message: response.message, stopped: false }) }
    touch()
    return await writeBody({ response: response.response, url: response.url }, request, signal, touch, why)
  } catch (error) {
    await rm(request.to, { force: true })
    return { ok: false, ...(signal.aborted ? why() : { message: `The download failed: ${errorMessage(error)}`, stopped: false }) }
  } finally {
    clearTimeout(idleTimer)
  }
}

type Answer = { readonly ok: true; readonly response: Response; readonly url: URL } | { readonly ok: false; readonly message: string }

async function follow(request: DownloadRequest, signal: AbortSignal): Promise<Answer> {
  const fetchFile = request.fetch ?? fetch
  let current = new URL(request.url)
  for (let hop = 0; hop <= maximumRedirects; hop += 1) {
    const problem = addressProblem(current)
    if (problem !== undefined) return { ok: false, message: problem }
    const response = await fetchFile(current, { redirect: 'manual', signal, headers: { 'user-agent': request.userAgent } })
    if (redirectStatuses.has(response.status)) {
      const location = response.headers.get('location')
      await response.body?.cancel()
      if (location === null) return { ok: false, message: `${current.host} answered ${response.status} without saying where to go.` }
      current = new URL(location, current)
      continue
    }
    if (response.status !== 200) {
      await response.body?.cancel()
      return { ok: false, message: `${current.host} answered ${response.status} for ${current.pathname}.` }
    }
    const declared = response.headers.get('content-length')
    const size = declared === null ? undefined : Number(declared)
    if (size !== undefined && request.expectedSize !== undefined && size !== request.expectedSize) {
      await response.body?.cancel()
      return { ok: false, message: `${current.host} offers ${size} bytes, and the pinned archive is ${request.expectedSize} bytes.` }
    }
    if (size !== undefined && size > request.maximumBytes) {
      await response.body?.cancel()
      return { ok: false, message: `${current.host} offers ${size} bytes, more than the ${request.maximumBytes} Retest downloads for one archive.` }
    }
    return { ok: true, response, url: current }
  }
  return { ok: false, message: `The download was redirected more than ${maximumRedirects} times.` }
}

async function writeBody(answer: { readonly response: Response; readonly url: URL }, request: DownloadRequest, signal: AbortSignal, touch: () => void, why: () => { message: string; stopped: boolean }): Promise<DownloadResult> {
  const body = answer.response.body
  if (body === null) return { ok: false, message: `${answer.url.host} sent no body.`, stopped: false }
  const hash = createHash('sha256')
  const limit = request.expectedSize ?? request.maximumBytes
  let handle: FileHandle | undefined
  let size = 0
  let failure: string | undefined
  try {
    handle = await open(request.to, 'wx')
    // Leaving the loop early cancels the response body.
    for await (const chunk of body) {
      if (signal.aborted) break
      touch()
      size += chunk.byteLength
      if (size > limit) {
        failure = request.expectedSize === undefined ? `The archive grew past the ${request.maximumBytes} bytes Retest downloads for one archive.` : `The archive grew past the pinned ${request.expectedSize} bytes.`
        break
      }
      hash.update(chunk)
      await handle.write(chunk)
    }
  } catch (error) {
    if (!signal.aborted) failure = `The download failed: ${errorMessage(error)}`
  } finally {
    await handle?.close()
  }
  if (signal.aborted || failure !== undefined) {
    await rm(request.to, { force: true })
    return { ok: false, ...(failure === undefined ? why() : { message: failure, stopped: false }) }
  }
  if (request.expectedSize !== undefined && size !== request.expectedSize) {
    await rm(request.to, { force: true })
    return { ok: false, message: `The download ended after ${size} bytes, and the pinned archive is ${request.expectedSize} bytes.`, stopped: false }
  }
  return { ok: true, size, sha256: hash.digest('hex'), answeredBy: answer.url.href }
}

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '[::1]' || hostname === '::1' || /^127(?:\.\d{1,3}){3}$/.test(hostname)
}
