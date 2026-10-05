import { test } from 'node:test'

// The fixed browser-secrets suite, the secret fill cases against the driver, run unchanged on WebKit: the harness launches and configures the browser through
// tests/integration/engines.ts, and every assertion is the Chromium suite's own. WebKit runs on macOS only.
if (process.platform === 'darwin') {
  process.env['RETEST_TEST_ENGINE'] = 'webkit'
  await import('./browser-secrets.test.ts')
} else {
  test('the browser-secrets suite on WebKit', (t) => t.skip(`Retest runs WebKit on macOS only, and this host is ${process.platform}`))
}
