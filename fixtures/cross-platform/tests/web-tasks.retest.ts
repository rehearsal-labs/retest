import { expect, secret, test } from '@rehearsal-labs/retest'

// The cross-platform fixture's web front end, signed in as the seeded account ada. The password is the secret
// `password`, which the run's config reads from RETEST_CROSS_PLATFORM_PASSWORD. Every task is found by its id. The
// service must start fresh or be reset first: the second test renames a seeded task.

test('creates a task, shows the id the service gave it, and marks that task done', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('account').fill('ada')
  await page.getByTestId('password').fill(secret('password'))
  await page.getByTestId('sign-in').click()
  await expect(page.getByTestId('signed-in-account')).toHaveText('ada')

  await page.getByTestId('new-task-title').fill('Release checklist')
  await page.getByTestId('create-task').click()
  // The editor opens on the task just created, and the page's address names it: /tasks/<id>.
  await expect(page).toHaveURL(/\/tasks\/task-[0-9a-f]{12}$/)
  const id = /\/tasks\/(task-[0-9a-f]{12})$/.exec(await page.url())?.[1]
  if (id === undefined) throw new Error(`The address names no task: ${await page.url()}`)
  await expect(page.getByTestId('created-task-id')).toHaveText(id)
  await expect(page.getByTestId('selected-task-id')).toHaveText(id)
  await expect(page.getByTestId(`task-title-${id}`)).toHaveText('Release checklist')
  await expect(page.getByTestId(`task-state-${id}`)).toHaveText('Open')
  await expect(page.getByTestId('selected-task-revision')).toHaveText('1')

  await page.getByTestId('edit-done').check()
  await page.getByTestId('save-task').click()
  await expect(page.getByTestId('save-status')).toHaveText('Saved revision 2.')
  await expect(page.getByTestId('selected-task-state')).toHaveText('Done')
  await expect(page.getByTestId(`task-state-${id}`)).toHaveText('Done')
})

test('changes one of two tasks that share a title, by its id, and leaves the other as it was', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('account').fill('ada')
  await page.getByTestId('password').fill(secret('password'))
  await page.getByTestId('sign-in').click()
  await expect(page.getByTestId('task-title-seed-ada-1')).toHaveText('Release checklist')
  await expect(page.getByTestId('task-title-seed-ada-2')).toHaveText('Release checklist')
  await expect(page.getByTestId('task-state-seed-ada-1')).toHaveText('Open')

  await page.getByTestId('open-task-id').fill('seed-ada-1')
  await page.getByTestId('open-task').click()
  await expect(page.getByTestId('selected-task-id')).toHaveText('seed-ada-1')
  await page.getByTestId('edit-title').fill('Release checklist, signed off')
  await page.getByTestId('edit-done').check()
  await page.getByTestId('save-task').click()

  await expect(page.getByTestId('task-state-seed-ada-1')).toHaveText('Done')
  await expect(page.getByTestId('task-title-seed-ada-1')).toHaveText('Release checklist, signed off')
  await expect(page.getByTestId('task-title-seed-ada-2')).toHaveText('Release checklist')
  await expect(page.getByTestId('task-state-seed-ada-2')).toHaveText('Done')
  await expect(page.getByTestId('task-state-seed-ada-3')).toHaveText('Open')
})
