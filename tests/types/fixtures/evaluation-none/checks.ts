import type { JudgeName } from '../../../../src/config/register.ts'
import type { Same } from '../support/same.ts'
import { test } from '@rehearsal-labs/retest'

export const judges: Same<JudgeName, never> = true

test('asks for a judge the config lacks', async () => {
  await test.evaluate({ requirement: 'x', evidence: { text: 'y' } }) // type-error TS2353 Declare a judge under evaluation.judges in retest.config.ts before a test uses test.evaluate.
})
