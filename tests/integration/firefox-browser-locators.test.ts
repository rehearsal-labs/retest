import { test } from 'node:test'
import { firefoxPlatformProblem } from '../../src/browser/firefox/executable.ts'

// The fixed browser-locators suite, the locator cases against the driver, run unchanged on Firefox: the harness
// launches and configures the browser through tests/integration/engines.ts, and every assertion is the Chromium
// suite's own.
const unsupported = firefoxPlatformProblem()
if (unsupported === undefined) {
  process.env['RETEST_TEST_ENGINE'] = 'firefox'
  await import('./browser-locators.test.ts')
} else {
  test('the browser-locators suite on Firefox', (t) => t.skip(unsupported))
}
