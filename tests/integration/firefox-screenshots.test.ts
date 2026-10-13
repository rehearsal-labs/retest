import assert from 'node:assert/strict'
import { test } from 'node:test'
import { firefoxPlatformProblem } from '../../src/browser/firefox/executable.ts'

// The fixed screenshots suite, a page's baseline missing, written and compared through the CLI, run unchanged on
// Firefox: the harness configures the browser through tests/integration/engines.ts, and every assertion is the Chromium
// suite's own. An element's picture and a device scale factor of 2 are Chromium's: that case says so, and an element's
// check on Firefox is refused by name.
const unsupported = firefoxPlatformProblem()
if (unsupported === undefined) {
  process.env['RETEST_TEST_ENGINE'] = 'firefox'
  const { elementRefusal } = await import('./screenshots.test.ts')
  test('an element\'s picture is refused on Firefox, by name', async (t) => {
    const refused = await elementRefusal(t)
    assert.equal(refused.failure.class, 'unsupported')
    assert.match(refused.failure.message, /^Retest takes a picture of one element on Chrome and Chromium only, and not on Firefox yet, so it took none\. Compare the whole page instead\./)
  })
} else {
  test('the screenshots suite on Firefox', (t) => t.skip(unsupported))
}
