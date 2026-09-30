import { expect, secret, test } from '@rehearsal-labs/retest'

// "What tsc catches", section 5 of docs/plans/developer-experience/index.html, line for line. There `phone` is a
// native Android app; in milestone 2 every app is a web page, so `phone` is an emulated Pixel 9, and the second
// error takes its milestone 2 form: tap() on an app with no touch screen.
test('task syncs', { apps: ['phone', 'web'] }, async ({ phone, web, desktop }) => { // type-error TS2339 Property 'desktop' does not exist on type 'Apps<"phone" | "web">'.
  await web.getByTestId('save-task').tap() // type-error TS2349 Type 'RetestTypeError<"One of this app's targets has no touch screen. Use click().">' has no call signatures.
  await web.getByTestId('sav-task').click() // type-error TS2345 Argument of type '"sav-task"' is not assignable to parameter of type '"
  await web.getByRole('buton', { name: 'Save' }).click() // type-error TS2345 Argument of type '"buton"' is not assignable to parameter of type 'AriaRole'.
  await web.getByLabel('Password').fill(secret('pasword')) // type-error TS2345 Argument of type '"pasword"' is not assignable to parameter of type '"password"'.
  await expect(web.getByTestId('task-count')).toBe(3) // type-error TS2349 Type 'RetestTypeError<"toBe is for values. Use toHaveText
  await phone.getByTestId('save-task').tap()
})
