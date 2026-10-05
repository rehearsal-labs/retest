import { test } from 'node:test'
import { firefoxPlatformProblem } from '../../src/browser/firefox/executable.ts'

// The fixed browser-secrets suite, the secret cases against the driver, run unchanged on Firefox: the harness
// launches and configures the browser through tests/integration/engines.ts, and every assertion is the Chromium
// suite's own.
const unsupported = firefoxPlatformProblem()
if (unsupported === undefined) {
  process.env['RETEST_TEST_ENGINE'] = 'firefox'
  await import('./browser-secrets.test.ts')
} else {
  test('the browser-secrets suite on Firefox', (t) => t.skip(unsupported))
}
