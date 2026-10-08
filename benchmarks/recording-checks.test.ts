import assert from 'node:assert/strict'
import { test } from 'node:test'
import { recordingConfig, matchedPlaywrightConfig } from './recording-config.ts'
import { spread } from './recording-report.ts'
import { recordingOptions } from './recording-options.ts'

test('five unsorted samples keep the median, observed range and quartiles', () => {
  assert.deepEqual(spread([150, 90, 110, 100, 120]), { median: 110, min: 90, max: 150, q1: 100, q3: 120, p95: 150 })
})
test('empty cells have no statistics', () => { assert.equal(spread([]), null) })
test('an even sample count uses the two middle values', () => {
  assert.deepEqual(spread([20, 10, 40, 30]), { median: 25, min: 10, max: 40, q1: 17.5, q3: 32.5, p95: 40 })
})
test('a short repetition count is refused', () => {
  assert.throws(() => recordingOptions(['--workspace', '/tmp/work', '--observer', '/tmp/observer', '--runs', '3']), /at least five/)
})
test('the recording toggle preserves target, diagnostics and action/assertion budgets', () => {
  const off = recordingConfig('firefox', '/browser', 'http://127.0.0.1:1234', false, true)
  const on = recordingConfig('firefox', '/browser', 'http://127.0.0.1:1234', true, true)
  assert.equal(off.replace('record: false, required: false', 'record: true, required: true'), on)
  assert.match(on, /keep: 'all', fps: 10/)
})
test('matched Playwright settings explicitly disable evidence and retries', () => {
  const config = matchedPlaywrightConfig('/browser', 'http://127.0.0.1:1234')
  assert.match(config, /workers: 1, retries: 0/)
  assert.match(config, /video: 'off', trace: 'off', screenshot: 'off'/)
  assert.match(recordingConfig('chromium', '/browser', 'http://127.0.0.1:1234', false, false), /screenshots: 'never', recordings: 'never'/)
})
