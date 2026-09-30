import type { Same } from './support/same.ts'
import { expect, test, type KeyArgument, type Keyboard, type Locator } from '@rehearsal-labs/retest'

// The keys press() takes. A key the types can read is judged here; one they cannot, such as a string, when the test runs.
declare const typed: string
declare const direction: 'ArrowUp' | 'ArrowDown'
declare const misspelt: 'ArrowUp' | 'ArrowDwn'
declare const digits: `${number}`

export const named: Same<KeyArgument<'Enter'>, 'Enter'> = true
export const unread: Same<KeyArgument<string>, string> = true

test('presses keys', async ({ page }) => {
  const search = page.getByLabel('Search')
  await search.press('Enter')
  await search.press('a')
  await search.press('A')
  await search.press('7')
  await search.press('é')
  await search.press('?')
  await page.keyboard.press('Shift+Tab')
  await page.keyboard.press('PageDown')
  await page.keyboard.press(typed)
  await page.keyboard.press(direction)
  await page.keyboard.press(digits)
  await expect(search).toBeVisible()
})

// A helper takes a key the way press() does, and passes it on.
export async function pressTwice<const K extends string>(target: Keyboard | Locator, key: KeyArgument<K>): Promise<void> {
  await target.press(key)
  await target.press(key)
}

test('refuses keys it does not send', async ({ page }) => {
  const search = page.getByLabel('Search')
  await search.press('Entr') // type-error TS2345 RetestTypeError<"press() takes a named key such as Enter or ArrowDown, Shift+ and a named key, or one character.">
  await page.keyboard.press('Control+a') // type-error TS2345 RetestTypeError<"press() does not send Control, Alt or Meta.
  await page.keyboard.press('Meta') // type-error TS2345 press() does not send Control, Alt or Meta.
  await page.keyboard.press('Shift+Control+z') // type-error TS2345 press() does not send Control, Alt or Meta.
  await search.press('Shift+a') // type-error TS2345 RetestTypeError<"Shift+ goes only with a named key. For an uppercase letter, press the letter itself, such as A.">
  await search.press('enter') // type-error TS2345 press() takes a named key such as Enter
  await search.press('Alternate') // type-error TS2345 press() takes a named key such as Enter
  await search.press('ab') // type-error TS2345 press() takes a named key such as Enter
  await search.press('') // type-error TS2345 press() takes a named key such as Enter
  await search.press(' ') // type-error TS2345 press() takes a named key such as Enter
  await page.keyboard.press('\n') // type-error TS2345 press() takes a named key such as Enter
  await page.keyboard.press(misspelt) // type-error TS2345 press() takes a named key such as Enter
  await page.keyboard.press(13) // type-error TS2345 Argument of type 'number' is not assignable to parameter of type 'string'
  await page.keyboard.press() // type-error TS2554 Expected 1 arguments, but got 0.
  await pressTwice(page.keyboard, 'Entr') // type-error TS2345 press() takes a named key such as Enter
})
