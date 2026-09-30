import assert from 'node:assert/strict'

/** Calls a method the way JavaScript may, with arguments its types would refuse. */
export function callLoosely(target: unknown, method: string, args: readonly unknown[]): unknown {
  const fn: unknown = Reflect.get(Object(target), method)
  assert.ok(typeof fn === 'function', `${method} is a method`)
  return Reflect.apply(fn, target, args)
}
