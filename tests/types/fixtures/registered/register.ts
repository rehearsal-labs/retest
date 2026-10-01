import type {
  AppHasTouch,
  AppName,
  DefaultAppName,
  IsRegistered,
  SecretName,
  StateName,
  TagName,
  TestIdValue,
} from '../../../../src/config/register.ts'
import type { Same } from '../support/same.ts'
import { expect, secret, test, type Apps, type Page, type TestContext } from '@rehearsal-labs/retest'

// The config in retest.config.ts is registered, and every name the tests use comes from it.
export const registered: Same<IsRegistered, true> = true
export const apps: Same<AppName, 'web' | 'phone' | 'tablet' | 'kiosk' | 'mixed' | 'phones'> = true
export const defaultApp: Same<DefaultAppName, 'web'> = true
export const tags: Same<TagName, 'smoke' | 'slow'> = true
export const states: Same<StateName, 'signed-in'> = true
export const secrets: Same<SecretName, 'password' | 'code'> = true
export const testIds: Same<TestIdValue, 'save-task' | 'task-title' | 'saved-task'> = true
export const namedDevice: Same<AppHasTouch<'phone'>, true> = true
export const ownTouchScreen: Same<AppHasTouch<'tablet'>, true> = true
export const everyTargetTouches: Same<AppHasTouch<'phones'>, true> = true
export const noTouchScreen: Same<AppHasTouch<'kiosk'>, false> = true
export const oneTargetWithout: Same<AppHasTouch<'mixed'>, false> = true
export const desktop: Same<AppHasTouch<'web'>, false> = true
export const defaultPage: Same<TestContext['page'], Page<false>> = true
export const touchPages: Same<Apps<'phone' | 'web'>, { readonly phone: Page<true>; readonly web: Page<false> }> = true

test('saves a task', { tags: ['smoke'], state: 'signed-in' }, async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('task-title').fill(secret('password'))
  await page.getByTestId('save-task').click()
  await expect(page.getByTestId('saved-task')).toHaveText('Release checklist')
})

test('syncs a task', { apps: ['web', 'phone', 'tablet', 'phones'], state: { web: 'signed-in' } }, async ({ web, phone, tablet, phones }) => {
  await web.getByTestId('save-task').click()
  await phone.getByTestId('save-task').tap()
  await tablet.getByRole('button', { name: 'Save' }).tap()
  await phones.getByLabel('Title').tap()
  await phones.getByText('Saved').click()
})

// A touch screen chooses, ticks and scrolls as a desktop does: check taps, and scroll turns the wheel.
test('files a task', { apps: ['web', 'phone', 'kiosk'] }, async ({ web, phone, kiosk }) => {
  await web.getByLabel('List').select(['Work', { value: 'home' }])
  await phone.getByRole('checkbox', { name: 'Done' }).check()
  await phone.getByTestId('task-title').scroll({ y: 600 })
  await phone.scroll({ y: -600 })
  await kiosk.getByRole('switch', { name: 'Remind me' }).uncheck()
  await expect(phone.getByTestId('saved-task')).toBeVisible()
})

test('mistakes', { apps: ['web', 'kiosk', 'mixed'] }, async ({ web, kiosk, mixed, phone }) => { // type-error TS2339 Property 'phone' does not exist on type 'Apps<
  await web.getByTestId('save-task').tap() // type-error TS2349 One of this app's targets has no touch screen. Use click().
  await kiosk.getByTestId('save-task').tap() // type-error TS2349 One of this app's targets has no touch screen. Use click().
  await mixed.getByTestId('save-task').tap() // type-error TS2349 One of this app's targets has no touch screen. Use click().
  await web.getByTestId('sav-task').click() // type-error TS2345 Argument of type '"sav-task"' is not assignable to parameter of type
  await web.getByTestId('task-title').fill(secret('pasword')) // type-error TS2345 Argument of type '"pasword"' is not assignable to parameter of type
  await web.getByRole('buton', { name: 'Save' }).click() // type-error TS2345 Argument of type '"buton"' is not assignable to parameter of type 'AriaRole'
  expect(secret('password')).toBe('hunter2') // type-error TS2339 Property 'toBe' does not exist on type 'RetestTypeError<"A secret cannot be compared or printed.">'
  expect(web.getByTestId('save-task')).toBe(3) // type-error TS2349 RetestTypeError<"toBe is for values. Use toHaveText
})

test('unknown app', { apps: ['desktop'] }, async () => {}) // type-error TS2322 Type '"desktop"' is not assignable to type
test('unknown tag', { tags: ['smok'] }, async () => {}) // type-error TS2820 Did you mean '"smoke"'?
test('unknown state', { state: 'signed-out' }, async () => {}) // type-error TS2322 Type '"signed-out"' is not assignable to type
test('state for an app the test does not use', { apps: ['web'], state: { phone: 'signed-in' } }, async () => {}) // type-error TS2353 'phone' does not exist in type
test('state by app without apps', { state: { web: 'signed-in' } }, async () => {}) // type-error TS2322 is not assignable to type '"signed-in"'
test('an empty app list', { apps: [] }, async () => {}) // type-error TS2322 Source has 0 element(s) but target requires 1

// A block passes its apps to the `test` its function receives, so hooks and tests inside see them.
test.describe('sharing', { apps: ['web', 'phone'], state: { phone: 'signed-in' } }, (test) => {
  test.beforeEach(async ({ web, phone }) => {
    await web.goto('/')
    await phone.getByTestId('save-task').tap()
  })
  test('shares', async ({ web, phone }) => {
    await expect(web.getByTestId('saved-task')).toBeVisible()
    await expect(phone.getByTestId('saved-task')).toBeVisible()
  })
  test('adds a tablet', { apps: ['tablet'], state: { tablet: 'signed-in', web: 'signed-in' } }, async ({ web, tablet }) => {
    await web.goto('/')
    await tablet.getByTestId('save-task').tap()
  })
  test.afterEach(async ({ page }) => {}) // type-error TS2339 Property 'page' does not exist on type 'Apps<
  test.describe('nested', { tags: ['slow'] }, (test) => {
    test('still shares', async ({ phone }) => {
      await phone.getByTestId('save-task').tap()
    })
  })
})

test.for([
  { title: 'Release checklist', count: 1 },
  { title: 'Groceries', count: 2 },
])('archives "$title"', { state: 'signed-in' }, async ({ page }, { title, count }) => {
  const text: string = title
  await page.getByRole('button', { name: `Archive ${text}` }).click()
  expect(count).toBe(1)
})
test.for([{ title: 'Release checklist' }])('row keys', async (_context, { title, done }) => {}) // type-error TS2339 Property 'done' does not exist on type '{ title: string; }'
test.for([{ count: 1 }])('row types', { apps: ['phone'] }, async ({ phone }, { count }) => {
  const text: string = count // type-error TS2322 Type 'number' is not assignable to type 'string'
  await phone.getByTestId('save-task').tap()
})

test.setup('signed-in', { apps: ['web'] }, async ({ web }) => {
  await web.goto('/login')
  await web.getByLabel('Password').fill(secret('password'))
})
test.setup('signed-out', async () => {}) // type-error TS2345 Argument of type '"signed-out"' is not assignable to parameter of type
test.setup('signed-in', { apps: ['web', 'phone'] }, async () => {}) // type-error TS2322 RetestTypeError<"A setup signs in with one app.">
