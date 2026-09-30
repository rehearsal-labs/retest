import { formatValue } from '../api/format-value.ts'

/** How `toEqual` compares, printed with every result so a reader never has to guess. */
export const equalComparison =
  'deep equality: primitives by Object.is, plain objects by their own keys, arrays item by item, Date by its time, Map by key then value, Set by member; any other object must be the same object'

// The pairs being compared further up, so a cycle is taken as equal instead of followed forever.
type Comparing = Map<object, Set<object>>

/**
 * Where two values first differ under `equalComparison`, such as `.items[2].title`; `''` when they differ
 * as a whole, and undefined when they are equal. A key set to undefined still counts as a key.
 *
 * @example firstDifference({ items: [{ title: 'a' }] }, { items: [{ title: 'b' }] }) // '.items[0].title'
 */
export function firstDifference(actual: unknown, expected: unknown): string | undefined {
  return differ(actual, expected, '', new Map())
}

function differ(actual: unknown, expected: unknown, path: string, comparing: Comparing): string | undefined {
  if (Object.is(actual, expected)) return undefined
  if (typeof actual !== 'object' || typeof expected !== 'object' || actual === null || expected === null) return path
  const pairs = comparing.get(actual) ?? new Set<object>()
  if (pairs.has(expected)) return undefined
  comparing.set(actual, pairs.add(expected))
  const found = differObjects(actual, expected, path, comparing)
  pairs.delete(expected)
  return found
}

function differObjects(actual: object, expected: object, path: string, comparing: Comparing): string | undefined {
  if (Array.isArray(actual) && Array.isArray(expected)) return differArrays(actual, expected, path, comparing)
  if (actual instanceof Date && expected instanceof Date) return Object.is(actual.getTime(), expected.getTime()) ? undefined : path
  if (actual instanceof Map && expected instanceof Map) return differMaps(actual, expected, path, comparing)
  if (actual instanceof Set && expected instanceof Set) return differSets(actual, expected, path, comparing)
  if (isPlain(actual) && isPlain(expected)) return differKeys(actual, expected, path, comparing)
  return path
}

function differArrays(actual: readonly unknown[], expected: readonly unknown[], path: string, comparing: Comparing): string | undefined {
  if (actual.length !== expected.length) return `${path}.length`
  for (let index = 0; index < actual.length; index++) {
    const found = differ(actual[index], expected[index], `${path}[${index}]`, comparing)
    if (found !== undefined) return found
  }
  return undefined
}

function differKeys(actual: object, expected: object, path: string, comparing: Comparing): string | undefined {
  const extra = Object.keys(expected).find((key) => !Object.hasOwn(actual, key))
  if (extra !== undefined) return keyPath(path, extra)
  for (const key of Object.keys(actual)) {
    if (!Object.hasOwn(expected, key)) return keyPath(path, key)
    const found = differ(Reflect.get(actual, key), Reflect.get(expected, key), keyPath(path, key), comparing)
    if (found !== undefined) return found
  }
  return undefined
}

function differMaps(actual: Map<unknown, unknown>, expected: Map<unknown, unknown>, path: string, comparing: Comparing): string | undefined {
  if (actual.size !== expected.size) return `${path}.size`
  for (const [key, value] of actual) {
    const at = `${path}.get(${formatValue(key)})`
    if (!expected.has(key)) return at
    const found = differ(value, expected.get(key), at, comparing)
    if (found !== undefined) return found
  }
  return undefined
}

// A member either side holds as is matches itself; each other member needs its own equal partner.
function differSets(actual: Set<unknown>, expected: Set<unknown>, path: string, comparing: Comparing): string | undefined {
  if (actual.size !== expected.size) return `${path}.size`
  const unmatched = [...expected].filter((member) => !actual.has(member))
  for (const member of actual) {
    if (expected.has(member)) continue
    const index = unmatched.findIndex((candidate) => differ(member, candidate, '', comparing) === undefined)
    if (index === -1) return path
    unmatched.splice(index, 1)
  }
  return undefined
}

function isPlain(value: object): boolean {
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function keyPath(path: string, key: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`
}
