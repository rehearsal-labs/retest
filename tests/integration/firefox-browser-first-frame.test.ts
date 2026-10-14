import { test } from 'node:test'
import { firefoxPlatformProblem } from '../../src/browser/firefox/executable.ts'

// The browser-first-frame suite run unchanged on Firefox: the harness launches the browser through
// tests/integration/engines.ts, and every assertion is the Chromium suite's own.
const unsupported = firefoxPlatformProblem()
if (unsupported === undefined) {
  process.env['RETEST_TEST_ENGINE'] = 'firefox'
  await import('./browser-first-frame.test.ts')
} else {
  test('the browser-first-frame suite on Firefox', (t) => t.skip(unsupported))
}
