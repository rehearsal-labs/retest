import type { AppHasTouch, LockName } from '../../../../src/config/register.ts'
import type { Same } from '../support/same.ts'
import { chromium, expect, test } from '@rehearsal-labs/retest'

// The config declares its locks, so a test may hold only those; a viewport is a screen with no touch.
export const locks: Same<LockName, 'inbox' | 'staging-account'> = true
export const sizedByViewport: Same<AppHasTouch<'web'>, false> = true
export const oneTargetWithout: Same<AppHasTouch<'sizes'>, false> = true

test('reads the inbox', { locks: ['inbox'] }, async ({ page }) => {
  await page.goto('/', { timeout: 5000 })
  await page.getByTestId('save-task').click({ timeout: 2000 })
  await page.getByTestId('task-title').fill('Release checklist', { timeout: undefined })
  await page.keyboard.press('Enter', { timeout: 1000 })
  await page.getByLabel('List').select('Work', { timeout: 1000 })
  await page.getByRole('checkbox', { name: 'Done' }).check({ timeout: 1000 })
  await page.getByRole('checkbox', { name: 'Done' }).uncheck({ timeout: 1000 })
  await page.getByTestId('terms').scroll({ y: 600 }, { timeout: 1000 })
  await page.scroll({ y: -600 }, { timeout: 1000 })
  await expect(page.getByTestId('saved-task')).toBeVisible()
})

test.describe('mail', { locks: ['inbox', 'staging-account'] }, (test) => {
  test.skip('waits for a fix', async ({ page }) => {
    await page.goto('/')
  })
  test.only('runs alone', { locks: ['staging-account'], tags: ['any'] }, async ({ page }) => {
    await page.goto('/')
  })
  test.describe.skip('archive', (test) => {
    test('archives', async ({ page }) => {
      await page.goto('/')
    })
  })
  test.describe.only('restore', { locks: ['inbox'] }, (test) => {
    test('restores', async ({ page }) => {
      await page.goto('/')
    })
  })
})

test('unknown lock', { locks: ['inbx'] }, async () => {}) // type-error TS2820 Did you mean '"inbox"'?
test.skip('unknown option', { retries: 2 }, async () => {}) // type-error TS2353 'retries' does not exist in type
test.only('lock as text', { locks: 'inbox' }, async () => {}) // type-error TS2322 Type 'string' is not assignable to type 'readonly ("inbox" | "staging-account")[]'
test.describe.skip('block lock', { locks: ['outbox'] }, () => {}) // type-error TS2322 Type '"outbox"' is not assignable to type '"inbox" | "staging-account"'

test('wrong call options', async ({ page }) => {
  await page.getByTestId('save-task').click({ force: true }) // type-error TS2353 'force' does not exist in type 'CallOptions'
  await page.goto('/', { timeout: '5s' }) // type-error TS2322 Type 'string' is not assignable to type 'number'
})

export const textWidth = chromium({ viewport: { width: '1280', height: 720 } }) // type-error TS2322 Type 'string' is not assignable to type 'number'
export const noHeight = chromium({ viewport: { width: 1280 } }) // type-error TS2741 Property 'height' is missing
