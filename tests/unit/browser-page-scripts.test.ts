import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  disarmFunction,
  guardScript,
  observeFunction,
  prepareFunction,
  readStorageFunction,
  strayFunction,
  verdictFunction,
  writeStorageFunction,
} from '../../src/browser/page-scripts.ts'

const functions = [
  ['observe', observeFunction, 'function observe(limit, query, ...elements)'],
  ['prepare', prepareFunction, 'async function prepare(action, multiline, origins, query, ...elements)'],
  ['verdict', verdictFunction, 'function verdict(token'],
  ['disarm', disarmFunction, 'function disarm(token'],
  ['stray', strayFunction, 'function stray()'],
  ['readStorage', readStorageFunction, 'function readStorage()'],
  ['writeStorage', writeStorageFunction, 'function writeStorage(items)'],
] as const

for (const [name, source, start] of functions) {
  test(`the ${name} function is one self-contained function declaration`, () => {
    const compiled: unknown = new Function(`return (${source})`)()
    assert.equal(typeof compiled, 'function')
    assert.ok(source.startsWith(start), source.slice(0, 80))
  })
}

test('the guard script is one self-contained script that installs the guard when it runs', () => {
  assert.doesNotThrow(() => new Function(guardScript))
  assert.match(guardScript, /^\(\(\) => \{[\s\S]*installGuard\(\)\n\}\)\(\)$/)
})

test('the page scripts never read values from their own source', () => {
  for (const [, source] of [...functions, ['guard', guardScript]]) {
    assert.doesNotMatch(source, /\$\{/, 'nothing is interpolated into the page source')
    assert.doesNotMatch(source, /\b(eval|Function)\(/)
    assert.doesNotMatch(source, /\.click\(\)|\.value\s*=[^=]/, 'input goes through the browser, never through script')
  }
})
