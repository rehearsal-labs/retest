import { test } from 'node:test'
import { firefoxPlatformProblem } from '../../src/browser/firefox/executable.ts'

// The browser-shadow-dom suite, every finder and action through open shadow roots, run unchanged on Firefox: the
// harness launches and configures the browser through tests/integration/engines.ts, and every assertion is the
// Chromium suite's own.
const unsupported = firefoxPlatformProblem()
if (unsupported === undefined) {
  process.env['RETEST_TEST_ENGINE'] = 'firefox'
  await import('./browser-shadow-dom.test.ts')
} else {
  test('the browser-shadow-dom suite on Firefox', (t) => t.skip(unsupported))
}
