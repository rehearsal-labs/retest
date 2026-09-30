import type {
  AppName,
  DefaultAppName,
  IsRegistered,
  RegisteredConfig,
  SecretName,
  StateName,
  TagName,
  TestIdValue,
} from '../../../src/config/register.ts'
import type { Same } from './support/same.ts'
import { expect, secret, test, type Page, type TestContext } from '@rehearsal-labs/retest'

// No config is registered in this program: a test gets `page`, and any tag, secret or test id type-checks.
export const registered: Same<IsRegistered, false> = true
export const config: Same<RegisteredConfig, never> = true
export const apps: Same<AppName, never> = true
export const defaultApp: Same<DefaultAppName, never> = true
export const states: Same<StateName, never> = true
export const tags: Same<TagName, string> = true
export const secrets: Same<SecretName, string> = true
export const testIds: Same<TestIdValue, string> = true
export const page: Same<TestContext['page'], Page<false>> = true

test('uses the page', { tags: ['anything'], timeout: 5000 }, async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('any-id').fill(secret('any-name'))
  await page.getByRole('button', { name: 'Save', exact: false }).click()
  await page.getByLabel('Title').fill('Release checklist')
  await expect(page.getByText('Saved', { exact: false })).toBeVisible()
})

test.describe('archive', { tags: ['slow'] }, () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/tasks')
  })
  test('archives a task', async ({ page }) => {
    await page.getByRole('button', { name: 'Archive' }).click()
  })
})

// Declaring apps or state without a registered config fails loudly and says how to register.
test('declares apps', { apps: ['web'] }, async () => {}) // type-error TS2741 RetestTypeError<"Register your config: declare module
test('declares state', { state: 'signed-in' }, async ({ page }) => { // type-error TS2322 RetestTypeError<"Register your config: declare module
  await page.goto('/')
})
test.describe('declares apps', { apps: ['web'] }, () => {}) // type-error TS2741 RetestTypeError<"Register your config: declare module
test.setup('signed-in', async ({ page }) => { // type-error TS2345 RetestTypeError<"Register your config: declare module
  await page.goto('/login')
})
test('taps the page', {}, async ({ page }) => {
  await page.getByTestId('menu').tap() // type-error TS2349 One of this app's targets has no touch screen. Use click().
})
