import type { NativePage } from '@rehearsal-labs/retest'
import { expect, secret, test } from '@rehearsal-labs/retest'

// The harness supplies this fixture's app configuration; native type fixtures check its fixed context.
const phoneTest = test as typeof test & ((name: string, options: { apps: readonly ['phone'] }, body: (apps: { phone: NativePage<'ios-simulator'> }) => Promise<void>) => void)

async function signIn(phone: NativePage<'ios-simulator'>): Promise<void> {
  await phone.getByTestId('account-field').fill('ada')
  await phone.getByTestId('password-field').fill(secret('password'))
  await phone.getByTestId('sign-in-button').tap()
  await expect(phone.getByTestId('signed-in-account')).toHaveText('ada')
}

phoneTest('TaskPhone creates a task through the native API', { apps: ['phone'] }, async ({ phone }) => {
  await signIn(phone)
  await phone.getByTestId('new-task-title-field').fill('Native API task')
  await phone.getByTestId('create-task-button').tap()
  await expect(phone.getByTestId('created-task-id')).toHaveText(/^task-[0-9a-f]{12}$/)
  await expect(phone.getByTestId('created-task-title')).toHaveText('Native API task')
  await expect(phone.getByTestId('created-task-state')).toHaveText('Open')
})

phoneTest('TaskPhone preserves a wrong task state failure', { apps: ['phone'] }, async ({ phone }) => {
  await signIn(phone)
  await phone.getByTestId('new-task-title-field').fill('Wrong state task')
  await phone.getByTestId('create-task-button').tap()
  await expect(phone.getByTestId('created-task-id')).toHaveText(/^task-[0-9a-f]{12}$/)
  // Longer than one tree read on the simulator, so the check fails on a look that shows the state, never before any look.
  await expect(phone.getByTestId('created-task-state')).toHaveText('Done', { timeout: 3000 })
})
