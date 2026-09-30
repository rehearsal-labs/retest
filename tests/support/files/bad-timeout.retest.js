import { expect, test } from '@rehearsal-labs/retest'

test('waits a while', { timeout: 2.5 }, () => {
  expect(1).toBe(1)
})
