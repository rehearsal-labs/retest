import type { IncomingMessage, ServerResponse } from 'node:http'

/** What answers one route of the task app. */
export type RouteHandler = (request: IncomingMessage, response: ServerResponse) => void

/** A route of the task app: its method and path, written as `GET /path`, and what answers it. */
export type Route = readonly [string, RouteHandler]

export const HTML_TYPE = 'text/html; charset=utf-8'
export const JSON_TYPE = 'application/json; charset=utf-8'

/** Answers with a whole body that no cache keeps, unless the client has already gone. */
export function respondWith(response: ServerResponse, status: number, contentType: string, body: string): void {
  if (response.destroyed) return
  response.writeHead(status, { 'content-type': contentType, 'cache-control': 'no-store' })
  response.end(body)
}

/** The query parameters of a request's address. */
export function queryOf(request: IncomingMessage): URLSearchParams {
  return new URL(request.url ?? '/', 'http://127.0.0.1').searchParams
}
