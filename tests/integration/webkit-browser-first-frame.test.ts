import { test } from 'node:test'

// The browser-first-frame suite run unchanged on WebKit: the harness launches the browser through
// tests/integration/engines.ts, and every assertion is the Chromium suite's own. WebKit runs on macOS only.
if (process.platform === 'darwin') {
  process.env['RETEST_TEST_ENGINE'] = 'webkit'
  await import('./browser-first-frame.test.ts')
} else {
  test('the browser-first-frame suite on WebKit', (t) => t.skip(`Retest runs WebKit on macOS only, and this host is ${process.platform}`))
}
