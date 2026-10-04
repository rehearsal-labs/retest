import type { ClientName } from './clients.ts'
import { isClientName } from './clients.ts'
import { TASK_ID_PATTERN } from './store.ts'

/**
 * One request as the network log records it. It holds no header, no body, no query and no credential: the client
 * comes from a fixed list, and the path is the route's template, holding a task id only when the segment has a task
 * id's shape, or `unknown` for a path that is no route.
 */
export type RequestRecord = {
  schemaVersion: 1
  type: 'http.request'
  /** Counts the requests this service started, from 1. */
  sequence: number
  startedAt: string
  method: string
  path: string
  /** The status the service sent, or began to send when the connection closed first. */
  status: number
  durationMs: number
  client: ClientName
  /** False when the connection closed before the whole response was sent. */
  completed: boolean
}

const recordKeys: readonly string[] = ['schemaVersion', 'type', 'sequence', 'startedAt', 'method', 'path', 'status', 'durationMs', 'client', 'completed']

/** The routes whose path is logged as it is. */
const fixedPaths: ReadonlySet<string> = new Set(['/', '/app.js', '/styles.css', '/api/health', '/api/sign-in', '/api/sign-out', '/api/tasks', '/admin/reset'])

/** The routes that end in a task id. */
const taskPaths: readonly string[] = ['/api/tasks/', '/tasks/']

/** What the logs write for a path that is no route, and for a task route whose last segment is no task id. */
export const UNKNOWN_PATH = 'unknown'

/** The methods the logs write as they are; any other is written as `OTHER`. */
const knownMethods: ReadonlySet<string> = new Set(['GET', 'HEAD', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'])

/**
 * The path the logs write for a request target: a route's own path, a task route with the id only when it has a task
 * id's shape, and `unknown` for anything else, so text a client put in a path never reaches a log.
 *
 * @example loggedPath('/api/tasks/seed-ada-1?token=abc') // '/api/tasks/seed-ada-1'
 * @example loggedPath('/api/sign-in/hunter2') // 'unknown'
 */
export function loggedPath(target: string | undefined): string {
  const path = URL.parse(target ?? '/', 'http://fixture.invalid')?.pathname ?? '/'
  if (fixedPaths.has(path)) return path
  for (const prefix of taskPaths) {
    if (!path.startsWith(prefix)) continue
    const id = path.slice(prefix.length)
    return TASK_ID_PATTERN.test(id) ? `${prefix}${id}` : `${prefix}${UNKNOWN_PATH}`
  }
  return UNKNOWN_PATH
}

/** The method the logs write: one they know as it is, any other as `OTHER`. */
export function loggedMethod(method: string | undefined): string {
  return method !== undefined && knownMethods.has(method) ? method : 'OTHER'
}

/**
 * The plain line the service prints for a request.
 *
 * @example formatRequestLine(record) // '2026-10-03T09:00:00.000Z POST /api/tasks 201 2.4ms client=ios'
 */
export function formatRequestLine(record: RequestRecord): string {
  const ending = record.completed ? '' : ' closed early'
  return `${record.startedAt} ${record.method} ${record.path} ${record.status} ${record.durationMs}ms client=${record.client}${ending}`
}

/**
 * Reads one line of a network log back, accepting exactly the fields the service writes. Undefined for anything else.
 *
 * @example parseRequestRecord(line)?.client // 'web'
 */
export function parseRequestRecord(line: string): RequestRecord | undefined {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const keys = Object.keys(value)
  if (keys.length !== recordKeys.length || !recordKeys.every((key) => keys.includes(key))) return undefined
  const entries = new Map(Object.entries(value))
  const schemaVersion = entries.get('schemaVersion')
  const type = entries.get('type')
  const sequence = entries.get('sequence')
  const startedAt = entries.get('startedAt')
  const method = entries.get('method')
  const path = entries.get('path')
  const status = entries.get('status')
  const durationMs = entries.get('durationMs')
  const client = entries.get('client')
  const completed = entries.get('completed')
  if (schemaVersion !== 1 || type !== 'http.request') return undefined
  if (!isWholeNumber(sequence) || !isWholeNumber(status) || typeof durationMs !== 'number' || durationMs < 0) return undefined
  if (typeof startedAt !== 'string' || Number.isNaN(Date.parse(startedAt))) return undefined
  if (typeof method !== 'string' || typeof path !== 'string' || typeof completed !== 'boolean') return undefined
  if (typeof client !== 'string' || !isClientName(client)) return undefined
  return { schemaVersion, type, sequence, startedAt, method, path, status, durationMs, client, completed }
}

function isWholeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}
