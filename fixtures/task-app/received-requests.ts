import type { IncomingMessage } from 'node:http'

/**
 * A request the task app received, with the headers that say what sent it and why: a service worker's script fetch
 * carries `Service-Worker: script`, and Chrome names each request's destination and mode.
 */
export type ReceivedRequest = {
  readonly method: string
  readonly path: string
  readonly serviceWorker: string | undefined
  readonly fetchDest: string | undefined
  readonly fetchMode: string | undefined
  readonly userAgent: string | undefined
  /** When it arrived, on the host's monotonic clock. */
  readonly atMs: number
}

/**
 * What a request says of itself, as the task app records it.
 *
 * @example receivedRequest(request) // { method: 'GET', path: '/service-worker.js', serviceWorker: 'script', fetchDest: 'serviceworker', ... }
 */
export function receivedRequest(request: IncomingMessage): ReceivedRequest {
  const { headers } = request
  return {
    method: request.method ?? 'GET',
    path: new URL(request.url ?? '/', 'http://127.0.0.1').pathname,
    serviceWorker: headerValue(headers['service-worker']),
    fetchDest: headerValue(headers['sec-fetch-dest']),
    fetchMode: headerValue(headers['sec-fetch-mode']),
    userAgent: headerValue(headers['user-agent']),
    atMs: performance.now(),
  }
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value.join(', ') : value
}
