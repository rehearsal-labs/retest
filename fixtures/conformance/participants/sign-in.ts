import type { Page } from '@rehearsal-labs/retest'
import { expect, secret } from '@rehearsal-labs/retest'

/** Signs a participant's page in as `account` on the task app, with the secret `password`. */
export async function signIn(page: Page<false>, account: string): Promise<void> {
  await page.goto('/login')
  await page.getByLabel('User name').fill(account)
  await page.getByLabel('Password').fill(secret('password'))
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByTestId('account')).toHaveText(`Signed in as ${account}`)
}
