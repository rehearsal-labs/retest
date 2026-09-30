import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import { once } from 'node:events'
import { createServer, request as forward } from 'node:http'
import { connect } from 'node:net'

/** The header the proxy adds to every plain request it forwards, so an app can tell a request came through it. */
export const PROXY_HEADER = 'x-retest-proxy'

export type ProxyOptions = {
  /** Answers every request with 407 and a Basic challenge, as a proxy that wants credentials does. */
  challenge?: boolean
  /** Hears of each request as it arrives. */
  onRequest?: (request: CarriedRequest) => void
}

/** A request the proxy carried: a plain request by its absolute address, or a tunnel by `CONNECT host:port`. */
export type CarriedRequest = { method: string; target: string }

export type FixtureProxy = {
  /** The proxy's address, such as `http://127.0.0.1:53124`. */
  readonly url: string
  /** Every request the proxy received, in the order it received them, whether or not it carried it. */
  requests(): readonly CarriedRequest[]
  close(): Promise<void>
}

const loopbackHosts: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '[::1]'])

/**
 * Starts an HTTP proxy on an ephemeral loopback port. It forwards plain requests with `PROXY_HEADER` added and
 * tunnels `CONNECT`, both only to loopback hosts, so no test reaches the network through it.
 *
 * @example const proxy = await startProxy()
 */
export async function startProxy(options: ProxyOptions = {}): Promise<FixtureProxy> {
  const carried: CarriedRequest[] = []
  const note = (request: CarriedRequest): void => {
    carried.push(request)
    options.onRequest?.(request)
  }
  const tunnels = new Set<Duplex>()
  const server = createServer((request, response) => {
    note({ method: request.method ?? 'GET', target: request.url ?? '' })
    if (options.challenge === true) return challenge(response)
    relay(request, response)
  })
  server.on('connect', (request: IncomingMessage, client: Duplex, head: Buffer) => {
    note({ method: 'CONNECT', target: request.url ?? '' })
    tunnels.add(client)
    client.on('close', () => tunnels.delete(client))
    client.on('error', () => client.destroy())
    if (options.challenge === true) return refuseTunnel(client, '407 Proxy Authentication Required', 'Proxy-Authenticate: Basic realm="retest"\r\n')
    tunnel(request.url ?? '', client, head, tunnels)
  })

  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('The proxy is not listening on a TCP port')
  let closing: Promise<void> | undefined

  async function stop(): Promise<void> {
    const closed = new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    server.closeAllConnections()
    for (const socket of tunnels) socket.destroy()
    await closed
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    requests: () => [...carried],
    close: () => (closing ??= stop()),
  }
}

function relay(request: IncomingMessage, response: ServerResponse): void {
  const target = URL.parse(request.url ?? '')
  if (target === null || target.protocol !== 'http:' || !loopbackHosts.has(target.hostname)) {
    response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
    response.end('The fixture proxy carries plain requests to loopback hosts only.')
    return
  }
  // Proxy-Connection is meant for the proxy, and goes no further.
  const kept = Object.entries(request.headers).filter(([name]) => name !== 'proxy-connection')
  const headers = { ...Object.fromEntries(kept), [PROXY_HEADER]: 'yes' }
  const upstream = forward(target, { method: request.method, headers }, (answer) => {
    response.writeHead(answer.statusCode ?? 502, answer.headers)
    answer.pipe(response)
  })
  upstream.on('error', () => {
    if (!response.headersSent) response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
    response.end()
  })
  request.pipe(upstream)
}

function tunnel(authority: string, client: Duplex, head: Buffer, tunnels: Set<Duplex>): void {
  const target = URL.parse(`http://${authority}`)
  if (target === null || !loopbackHosts.has(target.hostname) || target.port === '') {
    return refuseTunnel(client, '502 Bad Gateway', '')
  }
  const upstream: Socket = connect({ host: target.hostname.replace(/^\[|\]$/g, ''), port: Number(target.port) })
  tunnels.add(upstream)
  upstream.on('close', () => tunnels.delete(upstream))
  upstream.on('error', () => refuseTunnel(client, '502 Bad Gateway', ''))
  upstream.on('connect', () => {
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    if (head.length > 0) upstream.write(head)
    upstream.pipe(client)
    client.pipe(upstream)
  })
  client.on('close', () => upstream.destroy())
}

function challenge(response: ServerResponse): void {
  response.writeHead(407, { 'proxy-authenticate': 'Basic realm="retest"', 'content-type': 'text/html; charset=utf-8' })
  response.end('<!doctype html><title>Proxy</title><p data-testid="proxy-refusal">The proxy wants credentials.</p>')
}

function refuseTunnel(client: Duplex, status: string, headers: string): void {
  if (client.writable) client.end(`HTTP/1.1 ${status}\r\n${headers}Content-Length: 0\r\n\r\n`)
}
