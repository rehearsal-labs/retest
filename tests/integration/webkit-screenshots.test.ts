import assert from 'node:assert/strict'
import { test } from 'node:test'

// The fixed screenshots suite, a page's baseline missing, written and compared through the CLI, run unchanged on WebKit:
// the harness configures the browser through tests/integration/engines.ts, and every assertion is the Chromium suite's
// own. An element's picture and a device scale factor of 2 are Chromium's: that case says so, and an element's check on
// WebKit is refused by name. WebKit runs on macOS only.
if (process.platform === 'darwin') {
  process.env['RETEST_TEST_ENGINE'] = 'webkit'
  const { elementRefusal } = await import('./screenshots.test.ts')
  test('an element\'s picture is refused on WebKit, by name', async (t) => {
    const refused = await elementRefusal(t)
    assert.equal(refused.failure.class, 'unsupported')
    assert.match(refused.failure.message, /^Retest takes a picture of one element on Chrome and Chromium only, and not on WebKit yet, so it took none\. Compare the whole page instead\./)
  })
} else {
  test('the screenshots suite on WebKit', (t) => t.skip(`Retest runs WebKit on macOS only, and this host is ${process.platform}`))
}
