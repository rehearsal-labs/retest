import { expect, test } from '@rehearsal-labs/retest'

// Two turns after the file loaded: the first comes before its tests are sent, the second right after.
setImmediate(() =>
  setImmediate(() => {
    throw new Error('thrown after the tests were collected')
  }),
)

test('is listed', () => {
  expect(1).toBe(1)
})
