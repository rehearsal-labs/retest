import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chromiumArguments } from '../../src/browser/launch.ts'

// The command line Retest starts Chromium with: what the arguments are, not what Chromium does with them, which the
// integration files show on a real browser.

const backgrounding = ['--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling']

test('a page keeps its renderer and its timers at full speed, headless or shown, whatever covers its window', () => {
  for (const headless of [true, false]) {
    const args = chromiumArguments('/tmp/retest-profile-1', headless)
    assert.deepEqual(backgrounding.filter((flag) => !args.includes(flag)), [], `every backgrounding switch, headless ${headless}`)
    assert.equal(args.at(-1), 'about:blank', 'the start page comes last')
    assert.equal(args.includes('--headless'), headless)
  }
})

test('the browser speaks over its debugging pipe, from the profile it was given, with no first-run screens', () => {
  const args = chromiumArguments('/tmp/retest-profile-2', true)
  for (const flag of ['--remote-debugging-pipe', '--user-data-dir=/tmp/retest-profile-2', '--no-first-run', '--no-default-browser-check', '--disable-background-networking']) {
    assert.ok(args.includes(flag), flag)
  }
  assert.equal(args.includes('--use-mock-keychain'), process.platform === 'darwin', 'the mock keychain on macOS alone')
})
