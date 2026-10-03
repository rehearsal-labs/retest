import type { AppKind } from '../../../../src/config/register.ts'
import type { Same } from '../support/same.ts'
import { expect, test, type Apps, type NativePage, type Page, type TestContext } from '@rehearsal-labs/retest'

// Each app's handle offers what its targets can do: a web page has goto, a native app's handle does not.
export const web: Same<AppKind<'web'>, 'web'> = true
export const firefox: Same<AppKind<'firefox'>, 'web'> = true
export const iphone: Same<AppKind<'iphone'>, 'ios-simulator'> = true
export const mac: Same<AppKind<'mac'>, 'macos'> = true
export const phones: Same<AppKind<'phones'>, 'ios-simulator'> = true
export const mixed: Same<AppKind<'mixed'>, 'web' | 'ios-simulator'> = true
export const handles: Same<
  Apps<'web' | 'firefox' | 'iphone' | 'mac'>,
  { readonly web: Page<false>; readonly firefox: Page<false>; readonly iphone: NativePage<'ios-simulator'>; readonly mac: NativePage<'macos'> }
> = true
export const defaultPage: Same<TestContext['page'], NativePage<'ios-simulator'>> = true

test('creates a task on the phone, completes it on the web and checks it on the Mac', { apps: ['iphone', 'web', 'mac'] }, async ({ iphone, web, mac }) => {
  await iphone.getByLabel('Title').fill('Release checklist')
  await iphone.getByRole('button', { name: 'Save' }).tap()
  await iphone.getByTestId('task-title').press('Enter')
  await iphone.keyboard.press('Enter')
  await iphone.scroll({ y: 300 })
  await expect(iphone.getByText('Release checklist')).toBeVisible()
  await web.goto('/tasks')
  await web.getByRole('checkbox', { name: 'Completed' }).check()
  await mac.getByText('Release checklist').click()
  await mac.getByTestId('task-title').scroll({ y: 120 })
  await expect(mac.getByTestId('task-status')).toHaveText('Completed')
  await expect(mac.getByRole('listitem')).toHaveCount(1)
})

test('a Firefox app has a web page', { apps: ['firefox', 'phones'] }, async ({ firefox, phones }) => {
  await firefox.goto('/')
  await firefox.getByTestId('save-task').click()
  await phones.getByTestId('save-task').tap()
})

test('mistakes', { apps: ['iphone', 'mac', 'mixed'] }, async ({ iphone, mac, mixed }) => {
  await iphone.goto('/tasks') // type-error TS2349 A native app has no address. goto() is for web apps.
  await mac.goto('/tasks') // type-error TS2349 A native app has no address. goto() is for web apps.
  await iphone.getByText('Save').click() // type-error TS2349 An iOS app takes taps. Use tap().
  await mac.getByText('Save').tap() // type-error TS2349 A macOS app has no touch screen. Use click().
  await iphone.getByLabel('List').select('Work') // type-error TS2349 select() is for a web page's <select>. A native app has none.
  await mac.getByRole('checkbox', { name: 'Done' }).check() // type-error TS2349 check() is for a web page. Tap or click the native control instead.
  await mac.getByRole('checkbox', { name: 'Done' }).uncheck() // type-error TS2349 uncheck() is for a web page. Tap or click the native control instead.
  await iphone.getByTestId('sav-task').tap() // type-error TS2345 Argument of type '"sav-task"' is not assignable to parameter of type
  await mixed.goto('/') // type-error TS2339 Property 'goto' does not exist on type 'RetestTypeError<"This app's targets mix browsers and native apps.
})

// A test that names no apps uses the default app, here an iOS app, which has no goto.
test('uses the default app', async ({ page }) => {
  await page.getByTestId('save-task').tap()
  await page.goto('/') // type-error TS2349 A native app has no address. goto() is for web apps.
})
