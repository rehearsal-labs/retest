import { expect, test } from '@rehearsal-labs/retest'

// Two turns after the file loaded: the first comes before its tests are sent, the second right after.
setImmediate(() => setImmediate(() => process.exit(4)))

test('is listed', () => {
  expect(1).toBe(1)
})
