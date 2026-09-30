import type { CdpSession, SendOptions } from './cdp/session.ts'
import type { Deadline } from '../protocol/deadline.ts'
import type { Schema } from '../protocol/schema.ts'
import { parse, toJsonSchema } from '../protocol/schema.ts'
import { CdpInvalidResponseError } from './cdp/errors.ts'
import { isRecord } from './cdp/message.ts'

type SchemaNode = Parameters<typeof toJsonSchema>[0]

/** Anything that sends CDP commands: the browser connection or one of its sessions. */
export type CdpSender = Pick<CdpSession, 'send'> & { readonly id?: string }

/**
 * Sends a command and validates the parts of its result that Retest relies on.
 *
 * @example const { targetId } = await request(connection, 'Target.createTarget', { url }, targetSchema, sendOptions(deadline))
 */
export async function request<T>(
  sender: CdpSender,
  method: string,
  params: object | undefined,
  schema: Schema<T>,
  options: SendOptions,
): Promise<T> {
  return readProtocol(schema, await sender.send(method, params, options), { method, sessionId: sender.id })
}

/**
 * What one command may spend of a deadline: the time it has left, and the signal that stops it sooner.
 *
 * @example await session.send('Input.insertText', { text }, sendOptions(deadline))
 */
export function sendOptions(deadline: Deadline): SendOptions {
  return { timeoutMs: deadline.commandTimeoutMs, signal: deadline.signal }
}

/**
 * Validates a CDP result or event. Keys the schema does not name are dropped first, because each browser
 * release may add fields. A problem names only the paths, since values can hold page content.
 *
 * @example const frame = readProtocol(frameSchema, params, { method: 'Page.frameNavigated', sessionId })
 */
export function readProtocol<T>(schema: Schema<T>, value: unknown, source: { method: string; sessionId?: string | undefined }): T {
  const result = parse(schema, project(schema, value))
  if (result.ok) return result.value
  const problem = result.issues.map((issue) => `${issue.path} ${issue.message.replace(/, received .*$/, '')}`).join('; ')
  throw new CdpInvalidResponseError({ method: source.method, sessionId: source.sessionId }, problem)
}

function project(node: SchemaNode, value: unknown): unknown {
  if (node.kind === 'array' && Array.isArray(value)) return value.map((item: unknown) => project(node.item, item))
  if (node.kind !== 'object' || !isRecord(value)) return value
  const known: Record<string, unknown> = {}
  for (const [key, field] of Object.entries(node.shape)) {
    if (Object.hasOwn(value, key)) known[key] = project(field.kind === 'optional' ? field.inner : field, value[key])
  }
  return known
}
