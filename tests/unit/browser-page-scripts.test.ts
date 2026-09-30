import assert from 'node:assert/strict'
import { test } from 'node:test'
import { disarmFunction, guardScript, observeFunction, prepareFunction, verdictFunction } from '../../src/browser/page-scripts.ts'

const functions = [
  ['observe', observeFunction, 'function observe(value'],
  ['prepare', prepareFunction, 'async function prepare(value'],
  ['verdict', verdictFunction, 'function verdict(token'],
  ['disarm', disarmFunction, 'function disarm(token'],
] as const

for (const [name, source, start] of functions) {
  test(`the ${name} function is one self-contained function declaration`, () => {
    const compiled: unknown = new Function(`return (${source})`)()
    assert.equal(typeof compiled, 'function')
    assert.ok(source.startsWith(start))
  })
}

test('the guard script is one self-contained script that installs the guard when it runs', () => {
  assert.doesNotThrow(() => new Function(guardScript))
  assert.match(guardScript, /^\(\(\) => \{[\s\S]*installGuard\(\)\n\}\)\(\)$/)
})

test('the page scripts never read values from their own source', () => {
  for (const source of [observeFunction, prepareFunction, verdictFunction, disarmFunction, guardScript]) {
    assert.doesNotMatch(source, /\$\{/, 'nothing is interpolated into the page source')
    assert.doesNotMatch(source, /\b(eval|Function)\(/)
    assert.doesNotMatch(source, /\.click\(\)|\.value\s*=[^=]/, 'input goes through the browser, never through script')
  }
})
