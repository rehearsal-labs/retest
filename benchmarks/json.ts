export type JsonRecord = Readonly<Record<string, unknown>>

/** Whether a parsed JSON value is an object with keys, not an array or a primitive. */
export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function readString(record: JsonRecord, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' ? value : undefined
}

export function readNumber(record: JsonRecord, key: string): number | undefined {
  const value = record[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export function readArray(record: JsonRecord, key: string): readonly unknown[] {
  const value = record[key]
  return Array.isArray(value) ? value : []
}

export function readRecord(record: JsonRecord, key: string): JsonRecord | undefined {
  const value = record[key]
  return isRecord(value) ? value : undefined
}

/** The first JSON object in a text, or undefined when there is none or it does not parse. */
export function parseFirstObject(text: string): JsonRecord | undefined {
  const start = text.indexOf('{')
  if (start === -1) return undefined
  try {
    const parsed: unknown = JSON.parse(text.slice(start))
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}
