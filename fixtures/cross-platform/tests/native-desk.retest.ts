import type { NativePage } from '@rehearsal-labs/retest'
import { expect, secret, test } from '@rehearsal-labs/retest'

const deskTest = test as typeof test & ((name: string, options: { apps: readonly ['desk'] }, body: (apps: { desk: NativePage<'macos'> }) => Promise<void>) => void)

export async function signInDesk(desk: NativePage<'macos'>): Promise<void> {
  await desk.getByTestId('account-field').fill('ada')
  await desk.getByTestId('password-field').fill(secret('password'))
  await desk.getByTestId('sign-in-button').click()
  await expect(desk.getByTestId('signed-in-account')).toHaveText('ada')
}

export async function openSeededTask(desk: NativePage<'macos'>): Promise<void> {
  await desk.getByTestId('task-id-field').fill('seed-ada-1')
  await desk.getByTestId('task-id-field').press('Meta+A')
  await desk.getByTestId('task-id-field').press('ArrowRight')
  await desk.getByTestId('show-task-button').click()
  await expect(desk.getByTestId('selected-task-id')).toHaveText('seed-ada-1')
}

deskTest('TaskDesk finds a task by id through the native API', { apps: ['desk'] }, async ({ desk }) => {
  await signInDesk(desk)
  await openSeededTask(desk)
  await expect(desk.getByTestId('selected-task-state')).toHaveText('Open')
})

deskTest('TaskDesk preserves a wrong task state failure', { apps: ['desk'] }, async ({ desk }) => {
  await signInDesk(desk)
  await openSeededTask(desk)
  await expect(desk.getByTestId('selected-task-state')).toHaveText('Done', { timeout: 300 })
})
