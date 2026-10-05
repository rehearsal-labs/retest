import { test } from 'node:test'
import { firefoxPlatformProblem } from '../../src/browser/firefox/executable.ts'

// The agent session suites run unchanged on Firefox: the harness launches the browser through
// tests/integration/engines.ts, and every assertion is the Chrome run's own.
const unsupported = firefoxPlatformProblem()
if (unsupported === undefined) {
  process.env['RETEST_TEST_ENGINE'] = 'firefox'
  await import('./agent-sessions.test.ts')
  await import('./agent-participants.test.ts')
  await import('./agent-capacity.test.ts')
  await import('./agent-identity.test.ts')
} else {
  test('the agent session suites on Firefox', (t) => t.skip(unsupported))
}
