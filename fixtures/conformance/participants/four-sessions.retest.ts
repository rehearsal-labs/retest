import { expect } from '@rehearsal-labs/retest'
import { stateTest as test } from '../unregistered.ts'
import { signIn } from './sign-in.ts'

// The four-session isolation gate: four participants of one test, each signed in as its own account from its own
// saved state, on one origin. Each page shows only its own account, in its cookie and in its storage.

test.setup('alpha-signed-in', { apps: ['alpha'] }, async ({ alpha }) => {
  await signIn(alpha, 'alpha-account')
})

test.setup('beta-signed-in', { apps: ['beta'] }, async ({ beta }) => {
  await signIn(beta, 'beta-account')
})

test.setup('gamma-signed-in', { apps: ['gamma'] }, async ({ gamma }) => {
  await signIn(gamma, 'gamma-account')
})

test.setup('delta-signed-in', { apps: ['delta'] }, async ({ delta }) => {
  await signIn(delta, 'delta-account')
})

const state = { alpha: 'alpha-signed-in', beta: 'beta-signed-in', gamma: 'gamma-signed-in', delta: 'delta-signed-in' } as const

test('four accounts stay apart in one test', { apps: ['alpha', 'beta', 'gamma', 'delta'], state }, async ({ alpha, beta, gamma, delta }) => {
  await Promise.all([alpha.goto('/shared'), beta.goto('/shared'), gamma.goto('/shared'), delta.goto('/shared')])
  for (const [page, account] of [
    [alpha, 'alpha-account'],
    [beta, 'beta-account'],
    [gamma, 'gamma-account'],
    [delta, 'delta-account'],
  ] as const) {
    await expect(page.getByTestId('shared-account')).toHaveText(`Signed in as ${account}`)
    await expect(page.getByTestId('stored-user')).toHaveText(account)
  }
})
