import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LaunchError } from '../../src/browser/contract.ts'
import { failureSchema } from '../../src/protocol/failures.ts'
import { parse } from '../../src/protocol/schema.ts'

test('LaunchError carries a setup failure with its message and keeps the cause', () => {
  const cause = new Error('ENOENT')
  const error = new LaunchError('No browser at /missing/chrome.', { cause })
  assert.ok(error instanceof Error)
  assert.equal(error.name, 'LaunchError')
  assert.equal(error.message, 'No browser at /missing/chrome.')
  assert.equal(error.cause, cause)
  assert.deepEqual(error.failure, { class: 'setup_failed', message: 'No browser at /missing/chrome.' })
  assert.equal(parse(failureSchema, error.failure).ok, true)
})
