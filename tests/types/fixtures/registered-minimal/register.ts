import type { AppName, DefaultAppName, SecretName, StateName, TagName, TestIdValue } from '../../../../src/config/register.ts'
import type { Same } from '../support/same.ts'
import { expect, secret, test } from '@rehearsal-labs/retest'

// A config that lists no tags, states or test ids accepts any; one that declares no secrets accepts none.
export const apps: Same<AppName, 'owner' | 'member'> = true
export const defaultApp: Same<DefaultAppName, never> = true
export const tags: Same<TagName, string> = true
export const states: Same<StateName, string> = true
export const testIds: Same<TestIdValue, string> = true
export const secrets: Same<SecretName, never> = true

test('shares a task', { apps: ['owner', 'member'], tags: ['anything'], state: { owner: 'any-state' } }, async ({ owner, member }) => {
  await owner.getByTestId('any-id').click()
  await member.goto('/')
  await expect(member.getByText('Shared')).toBeVisible()
})

test.setup('any-state', { apps: ['owner'] }, async ({ owner }) => {
  await owner.goto('/login')
})

test('types a secret', { apps: ['owner'] }, async ({ owner }) => {
  await owner.getByTestId('password').fill(secret('password')) // type-error TS2345 Argument of type '"password"' is not assignable to parameter of type 'never'
})

// With two apps and no defaultApp, a test that names no apps has no page to use.
test('uses the page', async ({ page }) => {
  await page.goto('/') // type-error TS2339 Property 'goto' does not exist on type 'RetestTypeError<"This config has several apps and no defaultApp.
})
