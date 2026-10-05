import { test } from 'node:test'

// The agent session suites run unchanged on WebKit: the harness launches the build through
// tests/integration/engines.ts, and every assertion is the Chrome run's own. WebKit runs on macOS only.
if (process.platform === 'darwin') {
  process.env['RETEST_TEST_ENGINE'] = 'webkit'
  await import('./agent-sessions.test.ts')
  await import('./agent-participants.test.ts')
  await import('./agent-capacity.test.ts')
  await import('./agent-identity.test.ts')
} else {
  test('the agent session suites on WebKit', (t) => t.skip(`Retest runs WebKit on macOS only, and this host is ${process.platform}`))
}
