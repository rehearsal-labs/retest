import { expect, test } from '@rehearsal-labs/retest'

const later = Promise.withResolvers<void>()

test('leaves a callback behind', () => {
  void later.promise.then(() => {
    throw new Error('thrown by code the earlier test left behind')
  })
  expect(1).toBe(1)
})

test('sets it off', async () => {
  later.resolve()
  await new Promise((resolve) => setImmediate(resolve))
  expect(2).toBe(2)
})
