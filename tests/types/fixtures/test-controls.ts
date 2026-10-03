import { test } from '@rehearsal-labs/retest'

// No config is registered in this program: any lock name type-checks, and skip and only take what test takes.
test('holds a lock', { locks: ['anything'] }, async ({ page }) => {
  await page.getByTestId('save-task').click({ timeout: 2000 })
})
test.skip('skipped', async () => {})
test.only('focused', { tags: ['any'] }, () => {})
test.describe.skip('block', () => {})
test.describe.only('focused block', { locks: ['anything'] }, () => {})
test.skip(42, async () => {}) // type-error TS2345 Argument of type 'number' is not assignable to parameter of type 'string'
