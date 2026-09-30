import { expect, test } from '@rehearsal-labs/retest'

test('leaves an exit behind', () => {
  setTimeout(() => process.exit(3), 10)
  expect(1).toBe(1)
})
