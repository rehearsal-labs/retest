import { test } from 'node:test'
import { engineExpectations } from '../integration/engine-expectations.ts'

// A shared suite in miniature, which engine-expectations.test.ts runs as a test process of its own: one case observes
// RETEST_EXPECTATIONS_OBSERVED where Chrome observes 'chrome', and WebKit declares 'webkit' for the case
// RETEST_EXPECTATIONS_CASE names, which may be no case of this file. It cites the WebKit page's first difference.

const declaredCase = process.env['RETEST_EXPECTATIONS_CASE'] ?? ''
const observed = process.env['RETEST_EXPECTATIONS_OBSERVED'] ?? ''

const engineCase = engineExpectations('browser-navigation', [
  {
    engine: 'webkit',
    suite: 'browser-navigation',
    case: [declaredCase],
    reason: 'A stand-in for the mechanism test.',
    documented: { item: 1, title: "A failed navigation is told in WebKit's words." },
    observed: 'webkit',
  },
])

test('a case that asserts its outcome', (t) => {
  if (process.env['RETEST_EXPECTATIONS_SKIP'] === 'yes') {
    t.skip('a skipped case must leave its declaration unchecked and fail the suite')
    return
  }
  if (process.env['RETEST_EXPECTATIONS_CATCH'] === 'yes') {
    try {
      engineCase.assertOutcome(t, observed, 'chrome')
    } catch {
      // The end-of-suite validator must retain a mismatch even if the case catches it.
    }
    return
  }
  engineCase.assertOutcome(t, observed, 'chrome')
})

test('a case that asserts nothing through it', () => {})
