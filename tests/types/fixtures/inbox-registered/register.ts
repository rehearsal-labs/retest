import type { InboxName } from '../../../../src/config/register.ts'
import type { Same } from '../support/same.ts'
import { expect, inbox, test } from '@rehearsal-labs/retest'

// The config declares its inboxes, so a test reads only those.
export const names: Same<InboxName, 'owner' | 'member'> = true

test('reads the declared inboxes', async ({ page }) => {
  const owner = await inbox('owner').latest()
  await page.getByLabel('Code').fill(owner.code)
  const member = await inbox('member').latest({ subject: 'Invite' })
  await page.goto(member.link())
  await inbox('stranger').latest() // type-error TS2345 Argument of type '"stranger"' is not assignable to parameter of type
  await expect(page.getByLabel('Code')).toHaveValue('{{code}}')
})
