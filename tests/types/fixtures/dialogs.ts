import type { Same } from './support/same.ts'
import { expect, test, type Dialog, type DialogType, type ElectronPage, type Page } from '@rehearsal-labs/retest'

// page.dialog() gives a Dialog, whose kind is one of four; accept() takes a prompt's text and nothing else. page.popup()
// gives a Page, with the same touch screen as the page that opened it. Each takes a function that returns the action's
// promise. An Electron page's popup() gives another Electron page, which has no address to go to either.
export const kinds: Same<DialogType, 'alert' | 'confirm' | 'prompt' | 'beforeunload'> = true

test('a dialog and a popup', async ({ page }) => {
  const dialog: Dialog = await page.dialog(() => page.getByRole('button', { name: 'Delete' }).click())
  const kind: DialogType = dialog.type
  const text: string = dialog.message
  const answer: string = dialog.defaultValue
  await dialog.accept()
  await dialog.accept('Ada')
  await dialog.dismiss()
  await dialog.accept(1) // type-error TS2345 Argument of type 'number' is not assignable to parameter of type 'string'
  await dialog.dismiss('No') // type-error TS2554 Expected 0 arguments, but got 1.
  const popup: Page = await page.popup(() => page.getByRole('link', { name: 'Terms' }).click(), { timeout: 2000 })
  await popup.getByLabel('Email').fill('alice@example.com')
  const second: Dialog = await popup.dialog(() => popup.close())
  await second.accept()
  await page.dialog(() => undefined) // type-error TS2322 Type 'undefined' is not assignable to type 'Promise<unknown>'
  await page.popup('/terms') // type-error TS2345 Argument of type 'string' is not assignable to parameter of type '() => Promise<unknown>'
  await page.dialog(() => page.goto('/'), { wait: true }) // type-error TS2353 Object literal may only specify known properties, and 'wait' does not exist in type 'CallOptions'
  expect([kind, text, answer]).toContain(kind)
})

export async function openedFromElectron(desktop: ElectronPage): Promise<void> {
  const dialog: Dialog = await desktop.dialog(() => desktop.getByRole('button', { name: 'Quit' }).click())
  await dialog.dismiss()
  const settings: ElectronPage = await desktop.popup(() => desktop.getByRole('button', { name: 'Settings' }).click(), { timeout: 2000 })
  await settings.getByLabel('Dark mode').check()
  const help: ElectronPage = await settings.popup(() => settings.getByRole('link', { name: 'Help' }).click())
  await help.close()
  await settings.goto('/settings') // type-error TS2349 An Electron app has no address. Its page is the first window the app opens.
  const browserPage: Page = await desktop.popup(() => desktop.getByRole('link').click()) // type-error TS2322 Type 'ElectronPage' is not assignable to type 'Page<boolean>'.
  await desktop.popup('/terms') // type-error TS2345 Argument of type 'string' is not assignable to parameter of type '() => Promise<unknown>'
  await expect(browserPage).toHaveTitle('Terms')
}
