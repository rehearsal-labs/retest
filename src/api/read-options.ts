import type { RegisteredTest } from '../protocol/messages.ts'
import { maxTimeout } from '../protocol/timeouts.ts'
import { listWords } from '../shared/list-words.ts'
import { formatValue } from './format-value.ts'

/** What a test declares for itself or takes from its blocks. */
export type Declared = Pick<RegisteredTest, 'apps' | 'tags' | 'state'>

export type OptionsKind = 'test' | 'test.describe' | 'test.setup'

export type ReadOptions = { readonly declared: Declared; readonly timeout?: number } | { readonly problem: string }

const optionNames: Readonly<Record<OptionsKind, readonly string[]>> = {
  test: ['apps', 'tags', 'state', 'timeout'],
  'test.describe': ['apps', 'tags', 'state'],
  'test.setup': ['apps', 'timeout'],
}

/**
 * Reads the options a JavaScript caller may have passed any way it liked, and says what is wrong. A key set to
 * undefined counts as absent.
 *
 * @example readOptions('test', { tags: ['smoke'], timeout: 5000 }) // { declared: { tags: ['smoke'] }, timeout: 5000 }
 */
export function readOptions(kind: OptionsKind, options: unknown): ReadOptions {
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    return { problem: `${kind === 'test' ? 'Test' : `${kind}()`} options must be an object, such as { tags: ['smoke'] }, received ${formatValue(options)}.` }
  }
  const allowed = optionNames[kind]
  const given = Object.entries(options).filter(([, value]) => value !== undefined)
  const unknown = given.find(([key]) => !allowed.includes(key))
  if (unknown !== undefined) {
    const own = kind === 'test' ? 'Test options' : `${kind}() options`
    return { problem: `Unknown ${kind} option ${JSON.stringify(unknown[0])}. ${own} are ${listWords(allowed, 'and')}.` }
  }
  let declared: Declared = {}
  let timeout: number | undefined
  for (const [key, value] of given) {
    const read = key === 'timeout' ? readTimeout(value) : readDeclared(kind, key, value)
    if (typeof read === 'string') return { problem: read }
    if ('timeout' in read) timeout = read.timeout
    else declared = { ...declared, ...read }
  }
  return timeout === undefined ? { declared } : { declared, timeout }
}

function readDeclared(kind: OptionsKind, key: string, value: unknown): Declared | string {
  if (key === 'apps') return readApps(kind, value)
  if (key === 'state') return readState(value)
  return isNameList(value) ? { tags: [...new Set(value)] } : `tags lists names, such as tags: ['smoke'], received ${formatValue(value)}.`
}

function readApps(kind: OptionsKind, value: unknown): Declared | string {
  if (kind === 'test.setup') {
    if (isNameList(value) && value.length === 1) return { apps: value }
    return `A setup uses exactly one app, such as apps: ['web'], received ${formatValue(value)}.`
  }
  if (isNameList(value) && value.length > 0 && new Set(value).size === value.length) return { apps: value }
  return `apps lists each app once, such as apps: ['owner', 'member'], received ${formatValue(value)}.`
}

function readState(value: unknown): Declared | string {
  if (isName(value)) return { state: value }
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const entries = Object.entries(value).filter(([, name]) => name !== undefined)
    const named = entries.flatMap(([app, name]) => (isName(name) ? [[app, name] as const] : []))
    if (named.length > 0 && named.length === entries.length) return { state: Object.fromEntries(named) }
  }
  return `state names a saved state, such as state: 'signed-in', or one for each app, such as state: { owner: 'signed-in' }, received ${formatValue(value)}.`
}

function readTimeout(value: unknown): { timeout: number } | string {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= maxTimeout) return { timeout: value }
  return `The timeout option must be a whole number of milliseconds from 1 to ${maxTimeout}, received ${formatValue(value)}.`
}

function isName(value: unknown): value is string {
  return typeof value === 'string' && value !== ''
}

function isNameList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isName)
}
