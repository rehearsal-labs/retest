import { isPlainObject } from '../../src/protocol/schema.ts'

export type IncomingEvent = { kind: 'event'; method: string; params: unknown }

/** `id` is set when the message named a command but could not be read further. */
export type MalformedMessage = { kind: 'malformed'; problem: string; id: number | undefined }

/**
 * One message from the browser. An error without an id answers a command the browser could not read at all, so
 * nothing can be matched to it.
 */
export type IncomingMessage =
  | { kind: 'success'; id: number; result: unknown }
  | { kind: 'error'; id: number | undefined; error: string; message: string }
  | IncomingEvent
  | MalformedMessage

/**
 * Reads one WebDriver BiDi message. Problems never quote the text, which can hold page content.
 *
 * @example parseBidiMessage('{"type":"success","id":1,"result":{}}') // { kind: 'success', id: 1, result: {} }
 */
export function parseBidiMessage(text: string): IncomingMessage {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return malformed('the message is not valid JSON')
  }
  if (!isPlainObject(value)) return malformed('the message is not a JSON object')
  switch (value['type']) {
    case 'success':
      return parseSuccess(value)
    case 'error':
      return parseError(value)
    case 'event':
      return parseEvent(value)
    default:
      return malformed('the message type is not success, error or event', readId(value['id']))
  }
}

function parseSuccess(value: Record<string, unknown>): IncomingMessage {
  const id = readId(value['id'])
  if (id === undefined) return malformed('the success has no command id')
  if (!isPlainObject(value['result'])) return malformed('the success result is not an object', id)
  return { kind: 'success', id, result: value['result'] }
}

function parseError(value: Record<string, unknown>): IncomingMessage {
  const { error, message } = value
  const id = readId(value['id'])
  if (value['id'] !== null && id === undefined) return malformed('the error id is neither a command id nor null')
  if (typeof error !== 'string' || typeof message !== 'string') return malformed('the error has no error code or message', id)
  return { kind: 'error', id, error, message }
}

function parseEvent(value: Record<string, unknown>): IncomingMessage {
  const { method, params } = value
  if (typeof method !== 'string' || method === '') return malformed('the event has no method')
  if (!isPlainObject(params)) return malformed('the event params are not an object')
  return { kind: 'event', method, params }
}

function readId(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function malformed(problem: string, id?: number): MalformedMessage {
  return { kind: 'malformed', problem, id }
}
