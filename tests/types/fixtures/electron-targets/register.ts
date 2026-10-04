import type { AppKind } from '../../../../src/config/register.ts'
import type { Same } from '../support/same.ts'
import { expect, test, type Apps, type ElectronPage, type Page, type TestContext } from '@rehearsal-labs/retest'

// An Electron app's handle is a web page with no address: its windows are Chromium pages, found, acted on and checked
// as Chrome's are, and it opens its own first window, so goto() is a mistake before anything runs.
export const desktop: Same<AppKind<'desktop'>, 'electron'> = true
export const both: Same<AppKind<'both'>, 'electron' | 'web'> = true
export const handles: Same<Apps<'desktop' | 'web'>, { readonly desktop: ElectronPage; readonly web: Page<false> }> = true
export const defaultPage: Same<TestContext['page'], ElectronPage> = true

test('creates a task in the desktop app and finds it on the web', { apps: ['desktop', 'web'] }, async ({ desktop, web }) => {
  await desktop.getByLabel('Title').fill('Release checklist')
  await desktop.getByRole('button', { name: 'Add task' }).click()
  await desktop.reload()
  await desktop.goBack()
  await desktop.goForward()
  await desktop.keyboard.press('Enter')
  await expect(desktop).toHaveTitle('Tasks')
  await expect(desktop.getByTestId('task-name')).toHaveText('Release checklist')
  await web.goto('/tasks')
  await expect(web.getByText('Release checklist')).toBeVisible()
})

test('mistakes', { apps: ['desktop', 'both'] }, async ({ desktop, both }) => {
  await desktop.goto('/tasks') // type-error TS2349 An Electron app has no address. Its page is the first window the app opens.
  await desktop.getByTestId('add-task').tap() // type-error TS2349 One of this app's targets has no touch screen. Use click().
  await desktop.getByTestId('add-tsk').click() // type-error TS2345 Argument of type '"add-tsk"' is not assignable to parameter of type
  await both.reload() // type-error TS2339 Property 'reload' does not exist on type 'RetestTypeError<"This app's targets mix an Electron app with another kind.
})

// A test that names no apps uses the default app, here the Electron app, which has no goto.
test('uses the default app', async ({ page }) => {
  await page.getByTestId('add-task').click()
  await page.goto('/') // type-error TS2349 An Electron app has no address. Its page is the first window the app opens.
})
