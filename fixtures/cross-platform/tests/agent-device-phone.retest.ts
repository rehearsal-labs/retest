import type { NativePage } from '@rehearsal-labs/retest'
import { expect, secret, test } from '@rehearsal-labs/retest'

// TaskPhone on an iPhone simulator, driven through agent-device. The harness supplies the config: the app on
// `{ platform: 'ios-simulator', driver: 'agent-device' }`. Every finder, chain, pick, action and check of the first
// agent-device slice runs here once on the real simulator.
const phoneTest = test as typeof test & ((name: string, options: { apps: readonly ['phone'] }, body: (apps: { phone: NativePage<'ios-simulator'> }) => Promise<void>) => void)

async function signIn(phone: NativePage<'ios-simulator'>): Promise<void> {
  // The sign-in button turns on once the app has its service address.
  await expect(phone.getByRole('button', { name: 'Sign in' })).toBeEnabled()
  // The section header and the button both read "Sign in": the first is the header's text, the last the button.
  await expect(phone.getByText('Sign in')).toHaveCount(2)
  await expect(phone.getByText('Sign in').last()).toBeEnabled()
  // The third cell of the form holds the account field: a chain inside a pick.
  await expect(phone.getByRole('cell').nth(2).getByTestId('account-field')).toBeVisible()
  await phone.getByRole('cell').getByTestId('account-field').fill('ada')
  await expect(phone.getByTestId('account-field')).toHaveValue('ada')
  await phone.getByTestId('password-field').fill(secret('password'))
  await phone.getByRole('button', { name: 'Sign in' }).tap()
  await expect(phone.getByTestId('signed-in-account')).toHaveText('ada')
  await expect(phone.getByTestId('sign-in-button')).toBeHidden()
}

phoneTest('TaskPhone through agent-device signs in with a secret, creates a task and checks it', { apps: ['phone'] }, async ({ phone }) => {
  await signIn(phone)
  await expect(phone.getByTestId('create-task-button')).not.toBeEnabled()
  await phone.getByTestId('new-task-title-field').fill('Agent device task')
  await expect(phone.getByTestId('new-task-title-field')).toHaveValue('Agent device task')
  await phone.getByTestId('new-task-title-field').press('Enter')
  await expect(phone.getByTestId('create-task-button')).toBeEnabled()
  await phone.getByTestId('create-task-button').tap()
  await expect(phone.getByTestId('created-task-id')).toHaveText(/^task-[0-9a-f]{12}$/)
  await expect(phone.getByTestId('created-task-title')).toHaveText('Agent device task')
  await expect(phone.getByTestId('created-task-state')).toHaveText('Open')
  await phone.scroll({ y: 120 })
  await phone.scroll({ y: -120 })
  await expect(phone.getByTestId('created-task-state')).toBeVisible()
  await expect(phone.getByRole('cell').first().getByTestId('service-status')).toBeVisible()
})

phoneTest('TaskPhone through agent-device preserves a wrong task state failure', { apps: ['phone'] }, async ({ phone }) => {
  await signIn(phone)
  await phone.getByTestId('new-task-title-field').fill('Wrong state task')
  await phone.getByTestId('create-task-button').tap()
  await expect(phone.getByTestId('created-task-id')).toHaveText(/^task-[0-9a-f]{12}$/)
  // Longer than one look at the simulator, so the check fails on a look that shows the state, never before any look.
  await expect(phone.getByTestId('created-task-state')).toHaveText('Done', { timeout: 3000 })
})
