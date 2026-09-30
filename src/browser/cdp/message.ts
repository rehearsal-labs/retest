export type ProtocolErrorBody = { code: number; message: string; data: string | undefined }

export type IncomingEvent = {
  kind: 'event'
  method: string
  params: unknown
  sessionId: string | undefined
}

/** `id` is set when the message named a command but could not be read further. */
export type MalformedMessage = { kind: 'malformed'; problem: string; id: number | undefined }

export type IncomingMessage =
  | { kind: 'result'; id: number; result: unknown }
  | { kind: 'error'; id: number; error: ProtocolErrorBody }
  | IncomingEvent
  | MalformedMessage

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Reads one message from the browser. Problems never quote the text, which can hold page content. */
export function parseMessage(text: string): IncomingMessage {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return malformed('the message is not valid JSON')
  }
  if (!isRecord(value)) return malformed('the message is not a JSON object')
  if ('id' in value) return parseResponse(value)

  const { method, sessionId } = value
  if (sessionId !== undefined && !isNonEmptyString(sessionId)) {
    return malformed('the event has a sessionId that is not a non-empty string')
  }
  if (!isNonEmptyString(method)) return malformed('the message is neither a response nor an event')
  return { kind: 'event', method, params: value['params'], sessionId }
}

function parseResponse(value: Record<string, unknown>): IncomingMessage {
  const { id } = value
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 0) {
    return malformed('the response id is not a non-negative integer')
  }
  const hasResult = 'result' in value
  const hasError = 'error' in value
  if (hasResult === hasError) {
    return malformed(`the response has ${hasResult ? 'both a result and an error' : 'neither a result nor an error'}`, id)
  }
  if (hasResult) return { kind: 'result', id, result: value['result'] }

  const error = parseErrorBody(value['error'])
  return error === undefined ? malformed('the response error is not a CDP error', id) : { kind: 'error', id, error }
}

function parseErrorBody(value: unknown): ProtocolErrorBody | undefined {
  if (!isRecord(value)) return undefined
  const { code, message, data } = value
  if (typeof code !== 'number' || !Number.isInteger(code) || typeof message !== 'string') return undefined
  if (data !== undefined && typeof data !== 'string') return undefined
  return { code, message, data }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== ''
}

function malformed(problem: string, id?: number): MalformedMessage {
  return { kind: 'malformed', problem, id }
}
