import { test } from 'node:test'
import { firefoxPlatformProblem } from '../../src/browser/firefox/executable.ts'

// The fixed m2-state suite, the saved sign-in state cases through the CLI, run unchanged on Firefox: the harness
// launches and configures the browser through tests/integration/engines.ts, and every assertion is the Chromium
// suite's own.
const unsupported = firefoxPlatformProblem()
if (unsupported === undefined) {
  process.env['RETEST_TEST_ENGINE'] = 'firefox'
  await import('./m2-state.test.ts')
} else {
  test('the m2-state suite on Firefox', (t) => t.skip(unsupported))
}
