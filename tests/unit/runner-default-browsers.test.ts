import assert from 'node:assert/strict'
import { test } from 'node:test'
import { defaultBrowsers } from '../../src/runner/workers.ts'

// How many browsers a target's tests are spread over when the run does not say. What one more browser saves was
// measured on a real machine, not here.

test('each worker has a browser of its own unless the run says otherwise', () => {
  assert.deepEqual([1, 2, 3, 4, 7, 8].map((workers) => defaultBrowsers(workers)), [1, 2, 3, 4, 7, 8])
})

test('a run always has a browser to start, whatever it is told about workers', () => {
  assert.equal(defaultBrowsers(0), 1)
})
