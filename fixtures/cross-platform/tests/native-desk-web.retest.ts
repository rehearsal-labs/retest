import type { NativePage, Page } from '@rehearsal-labs/retest'
import { expect, secret, test } from '@rehearsal-labs/retest'

const pairedTest = test as typeof test & ((name: string, options: { apps: readonly ['desk', 'web'] }, body: (apps: { desk: NativePage<'macos'>; web: Page<false> }) => Promise<void>) => void)

pairedTest('TaskDesk and the web share one lease and task state', { apps: ['desk', 'web'] }, async ({ desk, web }) => {
  await desk.getByTestId('account-field').fill('ada')
  await desk.getByTestId('password-field').fill(secret('password'))
  await desk.getByTestId('sign-in-button').click()
  await expect(desk.getByTestId('signed-in-account')).toHaveText('ada')
  await desk.getByTestId('task-id-field').fill('seed-ada-1')
  await desk.getByTestId('show-task-button').click()
  await expect(desk.getByTestId('selected-task-id')).toHaveText('seed-ada-1')
  await expect(desk.getByTestId('selected-task-state')).toHaveText('Open')

  await web.goto('/')
  await web.getByTestId('account').fill('ada')
  await web.getByTestId('password').fill(secret('password'))
  await web.getByTestId('sign-in').click()
  await expect(web.getByTestId('signed-in-account')).toHaveText('ada')
  await web.goto('/tasks/seed-ada-1')
  await expect(web.getByTestId('selected-task-id')).toHaveText('seed-ada-1')
  await web.getByTestId('edit-done').check()
  await web.getByTestId('save-task').click()
  await expect(web.getByTestId('selected-task-state')).toHaveText('Done')
  await expect(desk.getByTestId('selected-task-state')).toHaveText('Done')
})
