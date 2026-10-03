import type { Route } from './route.ts'
import { once } from 'node:events'
import { createServer } from 'node:http'
import {
  FRAME_PAGE,
  MARKERS,
  PENDING_PAGE,
  QUIET_PAGE,
  REMOTE_FRAME_PAGE,
  renderDiagnosticsPage,
  renderFloodPage,
  renderMarkerPage,
  SECRETS_PAGE,
  THROWER_SCRIPT,
  WORKER_SCOPE_REGISTER_PAGE,
  WORKER_SCOPE_SCRIPT,
  WORKER_SCOPE_SERVER_PAGE,
  WORKER_SCRIPT,
} from './diagnostics-page.ts'
import { HTML_TYPE, JSON_TYPE, queryOf, respondWith } from './route.ts'

const SCRIPT_TYPE = 'text/javascript; charset=utf-8'
const TEXT_TYPE = 'text/plain; charset=utf-8'
// The most a flood page may ask for, so a mistyped address cannot make the app build a huge page.
const maxCount = 5000
const maxSize = 100_000

/**
 * The diagnostics pages and the endpoints they call. `/diagnostics/redirect/1` redirects twice before it answers,
 * `/diagnostics/missing` answers 404 and `/diagnostics/broken` 500, `/diagnostics/hang` answers its headers and never
 * finishes, and the main page's refused address is a loopback port nothing listens on, found when the app starts.
 */
export function diagnosticsRoutes(): Route[] {
  const closedPort = unusedPort()
  // A failure to find a port fails only the page that needs it.
  closedPort.catch(() => undefined)
  return [
    [
      'GET /diagnostics',
      (request, response) => {
        const port = request.socket.localPort ?? 0
        closedPort
          .then((closed) => respondWith(response, 200, HTML_TYPE, renderDiagnosticsPage(`http://127.0.0.1:${closed}/diagnostics/refused`, `http://localhost:${port}/diagnostics/remote-frame`)))
          .catch(() => response.destroy())
      },
    ],
    ['GET /diagnostics/frame', (_request, response) => respondWith(response, 200, HTML_TYPE, FRAME_PAGE)],
    ['GET /diagnostics/remote-frame', (_request, response) => respondWith(response, 200, HTML_TYPE, REMOTE_FRAME_PAGE)],
    ['GET /diagnostics/worker.js', (_request, response) => respondWith(response, 200, SCRIPT_TYPE, WORKER_SCRIPT)],
    ['GET /diagnostics/thrower.js', (_request, response) => respondWith(response, 200, SCRIPT_TYPE, THROWER_SCRIPT)],
    [
      'GET /diagnostics/data',
      (request, response) => {
        // A cookie the page could hold a secret in comes back as Set-Cookie, which Retest never records.
        const secret = queryOf(request).get('secret')
        if (secret !== null && !response.destroyed) response.setHeader('set-cookie', `echo=${encodeURIComponent(secret)}`)
        respondWith(response, 200, JSON_TYPE, JSON.stringify({ ok: true }))
      },
    ],
    ['GET /diagnostics/missing', (_request, response) => respondWith(response, 404, TEXT_TYPE, 'Not found')],
    ['GET /diagnostics/empty-404', (_request, response) => emptyAnswer(response, 404)],
    ['GET /diagnostics/empty-500', (_request, response) => emptyAnswer(response, 500)],
    ['GET /diagnostics/broken', (_request, response) => respondWith(response, 500, TEXT_TYPE, 'Broken')],
    ['GET /diagnostics/redirect/1', (_request, response) => redirect(response, 302, '/diagnostics/redirect/2')],
    ['GET /diagnostics/redirect/2', (_request, response) => redirect(response, 307, '/diagnostics/data?hop=final')],
    [
      'GET /diagnostics/hang',
      (_request, response) => {
        response.writeHead(200, { 'content-type': TEXT_TYPE, 'cache-control': 'no-store' })
        response.write('partial')
      },
    ],
    ['GET /diagnostics/quiet', (_request, response) => respondWith(response, 200, HTML_TYPE, QUIET_PAGE)],
    [
      'GET /diagnostics/flood',
      (request, response) => {
        const query = queryOf(request)
        const count = bounded(query.get('count'), maxCount)
        const size = bounded(query.get('size'), maxSize)
        const fetches = bounded(query.get('fetches'), maxCount)
        respondWith(response, 200, HTML_TYPE, renderFloodPage(count, Math.max(1, size), fetches, query.get('throws') === '1'))
      },
    ],
    ['GET /diagnostics/secrets', (_request, response) => respondWith(response, 200, HTML_TYPE, SECRETS_PAGE)],
    ['GET /diagnostics/pending', (_request, response) => respondWith(response, 200, HTML_TYPE, PENDING_PAGE)],
    ...MARKERS.flatMap((marker): Route[] => [
      [`GET /diagnostics/marker/${marker}`, (_request, response) => respondWith(response, 200, HTML_TYPE, renderMarkerPage(marker))],
      [`GET /diagnostics/marker/${marker}/data`, (_request, response) => respondWith(response, 200, JSON_TYPE, JSON.stringify({ marker }))],
    ]),
    ['GET /diagnostics/worker-scope/register', (_request, response) => respondWith(response, 200, HTML_TYPE, WORKER_SCOPE_REGISTER_PAGE)],
    ['GET /diagnostics/worker-scope/sw.js', (_request, response) => respondWith(response, 200, SCRIPT_TYPE, WORKER_SCOPE_SCRIPT)],
    ['GET /diagnostics/worker-scope/page', (_request, response) => respondWith(response, 200, HTML_TYPE, WORKER_SCOPE_SERVER_PAGE)],
  ]
}

function redirect(response: Parameters<Route[1]>[1], status: number, location: string): void {
  response.writeHead(status, { location, 'cache-control': 'no-store' })
  response.end()
}

// An error answer with no body, which Chrome will not show as a page.
function emptyAnswer(response: Parameters<Route[1]>[1], status: number): void {
  response.writeHead(status, { 'cache-control': 'no-store', 'content-length': '0' })
  response.end()
}

function bounded(text: string | null, limit: number): number {
  const value = Number(text ?? '0')
  return Number.isInteger(value) && value >= 0 ? Math.min(value, limit) : 0
}

// A port taken and given back at once: nothing listens on it while the app runs, unless another program takes it.
async function unusedPort(): Promise<number> {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  const port = address !== null && typeof address === 'object' ? address.port : 0
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}
