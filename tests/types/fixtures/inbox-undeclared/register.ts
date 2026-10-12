import type { InboxName } from '../../../../src/config/register.ts'
import type { Same } from '../support/same.ts'
import { inbox, test } from '@rehearsal-labs/retest'

// A config that declares no inbox takes none.
export const names: Same<InboxName, never> = true

test('reads no inbox', async () => {
  await inbox('owner').latest() // type-error TS2345 Argument of type '"owner"' is not assignable to parameter of type 'never'
})
