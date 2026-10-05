import { test } from 'node:test'

// The fixed browser-navigation suite, the navigation cases against the driver, run unchanged on WebKit: the harness launches and configures the browser through
// tests/integration/engines.ts, and every assertion is the Chromium suite's own. WebKit runs on macOS only.
if (process.platform === 'darwin') {
  process.env['RETEST_TEST_ENGINE'] = 'webkit'
  await import('./browser-navigation.test.ts')
} else {
  test('the browser-navigation suite on WebKit', (t) => t.skip(`Retest runs WebKit on macOS only, and this host is ${process.platform}`))
}
