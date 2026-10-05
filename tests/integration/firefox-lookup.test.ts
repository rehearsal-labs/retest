import { test } from 'node:test'
import { firefoxPlatformProblem } from '../../src/browser/firefox/executable.ts'

// The fixed lookup suite, the lookup scenario through the CLI, run unchanged on Firefox: the harness launches and
// configures the browser through tests/integration/engines.ts, and every assertion is the Chromium suite's own.
const unsupported = firefoxPlatformProblem()
if (unsupported === undefined) {
  process.env['RETEST_TEST_ENGINE'] = 'firefox'
  await import('./lookup.test.ts')
} else {
  test('the lookup suite on Firefox', (t) => t.skip(unsupported))
}
