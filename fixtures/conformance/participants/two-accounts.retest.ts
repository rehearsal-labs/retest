import { randomUUID } from 'node:crypto'
import { expect } from '@rehearsal-labs/retest'
import { stateTest as test } from '../unregistered.ts'
import { signIn } from './sign-in.ts'

// The two-account workflow: the owner makes a record under a reference this attempt generated, and the member,
// signed in as another account, reads that exact record by its reference.

test.setup('owner-account', { apps: ['owner'] }, async ({ owner }) => {
  await signIn(owner, 'owner-a')
})

test.setup('member-account', { apps: ['member'] }, async ({ member }) => {
  await signIn(member, 'member-b')
})

test('the member reads the exact record the owner made', { apps: ['owner', 'member'], state: { owner: 'owner-account', member: 'member-account' } }, async ({ owner, member }) => {
  const reference = `record-${randomUUID()}`
  await owner.goto('/shared')
  await expect(owner.getByTestId('shared-account')).toHaveText('Signed in as owner-a')
  await owner.getByLabel('Reference').fill(reference)
  await owner.getByLabel('Title').fill('Quarterly report')
  await owner.getByRole('button', { name: 'Create record' }).click()
  await expect(owner.getByTestId('record-status')).toHaveText(`Created ${reference}`)
  await member.goto(`/shared/record?reference=${encodeURIComponent(reference)}`)
  await expect(member.getByTestId('shared-account')).toHaveText('Signed in as member-b')
  await expect(member.getByTestId('record-reference-shown')).toHaveText(reference)
  await expect(member.getByTestId('record-title-shown')).toHaveText('Quarterly report')
  await expect(member.getByTestId('record-owner')).toHaveText('owner-a')
})
