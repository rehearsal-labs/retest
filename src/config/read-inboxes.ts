import type { Path } from '../protocol/schema.ts'
import type { LoadedInbox } from './loaded.ts'
import type { Problems } from './problems.ts'
import type { InboxContext } from './types.ts'
import { describeValue, isArray, isPlainObject } from '../protocol/schema.ts'
import { readOrigin } from '../protocol/url.ts'

const sourceKeys: ReadonlySet<string> = new Set(['messages', 'origins'])

/**
 * Reads `inboxes`: each a function that reads the mailbox, or `{ messages, origins }`. Absent when the config declares
 * none. What a function gives back is checked on each look, by the run, since it changes as mail arrives.
 *
 * @example readInboxes({ owner: async () => [] }, problems)?.get('owner')?.origins // []
 */
export function readInboxes(value: unknown, problems: Problems): Map<string, LoadedInbox> | undefined {
  if (value === undefined) return undefined
  if (!isPlainObject(value)) {
    problems.add(['inboxes'], `expected an object of inboxes by name, received ${describeValue(value)}`)
    return undefined
  }
  const inboxes = new Map<string, LoadedInbox>()
  for (const [name, source] of Object.entries(value)) {
    const path = ['inboxes', name]
    if (!problems.checkName(path, name)) continue
    const read = readSource(source, path, problems)
    if (read !== undefined) inboxes.set(name, read)
  }
  return inboxes
}

function readSource(source: unknown, path: Path, problems: Problems): LoadedInbox | undefined {
  if (typeof source === 'function') return { read: reader(source), origins: [] }
  if (!isPlainObject(source)) {
    problems.add(path, `expected a function that returns the inbox's messages, or { messages, origins }, received ${kindOf(source)}`)
    return undefined
  }
  let readable = true
  for (const key of Object.keys(source)) {
    if (sourceKeys.has(key)) continue
    problems.add([...path, key], 'unknown key, expected messages or origins')
    readable = false
  }
  const { messages, origins } = source
  if (typeof messages !== 'function') {
    problems.add([...path, 'messages'], `expected a function that returns the inbox's messages, received ${kindOf(messages)}`)
    readable = false
  }
  const listed = readOrigins(origins, [...path, 'origins'], problems)
  if (!readable || listed === undefined || typeof messages !== 'function') return undefined
  return { read: reader(messages), origins: listed }
}

function readOrigins(value: unknown, path: Path, problems: Problems): string[] | undefined {
  if (value === undefined) return []
  if (!isArray(value)) {
    problems.add(path, `expected a list of origins such as ['https://example.com'], received ${describeValue(value)}`)
    return undefined
  }
  const origins: string[] = []
  for (const [index, text] of value.entries()) {
    const origin = typeof text === 'string' ? readOrigin(text) : undefined
    if (origin === undefined) problems.add([...path, index], `expected an origin such as https://example.com, received ${describeValue(text)}`)
    else origins.push(origin)
  }
  return origins.length === value.length ? [...new Set(origins)] : undefined
}

// The function may answer at once or later, or throw at once: each becomes a promise the run waits for within its time.
function reader(source: Function): (context: InboxContext) => Promise<unknown> {
  return (context) => new Promise<unknown>((resolve) => resolve(source(context)))
}

// A value written where a source belongs may hold a message's text, so only its kind is named.
function kindOf(value: unknown): string {
  if (value === null) return 'null'
  return Array.isArray(value) ? 'array' : typeof value
}
