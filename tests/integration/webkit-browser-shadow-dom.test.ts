import { test } from 'node:test'

// The browser-shadow-dom suite, every finder and action through open shadow roots, run unchanged on WebKit: the
// harness launches and configures the browser through tests/integration/engines.ts, and every assertion is the
// Chromium suite's own. WebKit runs on macOS only.
if (process.platform === 'darwin') {
  process.env['RETEST_TEST_ENGINE'] = 'webkit'
  await import('./browser-shadow-dom.test.ts')
} else {
  test('the browser-shadow-dom suite on WebKit', (t) => t.skip(`Retest runs WebKit on macOS only, and this host is ${process.platform}`))
}
