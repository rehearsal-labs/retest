import { writeSync } from 'node:fs'
import { test } from 'retest'

writeSync(1, `pid ${process.pid}\n`)

// The app holds the document longer than the test's budget, so the test runs out of its time while its page is still
// opening that document. The budget leaves a slow machine time to set off for the document before it runs out.
test('opens a document the app holds', { timeout: 2000 }, async ({ page }) => {
  await page.goto('/holders/hold?name=held&ms=20000')
})
