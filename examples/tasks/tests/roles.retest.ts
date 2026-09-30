import { expect, test } from '@rehearsal-labs/retest'

test('each role has a session of its own', { apps: ['web', 'admin'], state: { web: 'signed-in' }, tags: ['roles'] }, async ({ web, admin }) => {
  await web.goto('/account')
  await admin.goto('/account')
  await expect(web.getByTestId('account')).toHaveText('Signed in as alice')
  await expect(admin.getByTestId('account')).toHaveText('Signed out')
})

test('a task one role saves stays in its own browser', { apps: ['web', 'admin'], tags: ['roles'] }, async ({ web, admin }) => {
  await web.goto('/')
  await web.getByLabel('Title').fill('Release checklist')
  await web.getByRole('button', { name: 'Save' }).click()
  await expect(web.getByTestId('saved-task')).toHaveText('Release checklist')
  await web.goto('/')
  await admin.goto('/')
  await expect(web.getByTestId('last-saved')).toHaveText('Release checklist')
  await expect(admin.getByTestId('last-saved')).toHaveText('')
})
