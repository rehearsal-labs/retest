import { expect, test } from '@rehearsal-labs/retest'

// Runs once on each target of desktop: Google Chrome, then the Chromium that RETEST_CHROMIUM points to.
test('saves a task in each desktop browser', { apps: ['desktop'], tags: ['browsers'] }, async ({ desktop }) => {
  await desktop.goto('/')
  await desktop.getByLabel('Title').fill('Release checklist')
  await desktop.getByRole('button', { name: 'Save' }).click()
  await expect(desktop.getByTestId('saved-task')).toHaveText('Release checklist')
})

// Every target of phone emulates a touch screen, so its locators have tap().
test('taps a button on each phone', { apps: ['phone'], tags: ['phone'] }, async ({ phone }) => {
  await phone.goto('/device')
  await expect(phone.getByTestId('touch')).toHaveText('true')
  await phone.getByRole('button', { name: 'Touch me' }).tap()
  await expect(phone.getByTestId('touch-events')).toHaveText('touchstart touchend click:touch')
})

// Runs once for each entry of runs in the config: Chrome beside the Pixel, Chromium beside the iPhone.
test('the desktop clicks and the phone taps', { apps: ['desktop', 'phone'], tags: ['browsers', 'phone'] }, async ({ desktop, phone }) => {
  await desktop.goto('/device')
  await phone.goto('/device')
  await desktop.getByRole('button', { name: 'Touch me' }).click()
  await phone.getByRole('button', { name: 'Touch me' }).click()
  await expect(desktop.getByTestId('touch-events')).toHaveText('click:mouse')
  await expect(phone.getByTestId('touch-events')).toHaveText('touchstart touchend click:touch')
})
