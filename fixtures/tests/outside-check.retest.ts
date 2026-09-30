import { expect, test } from '@rehearsal-labs/retest'

const running = Promise.withResolvers<void>()
// Registered while the file loads, so the check runs outside any test once a test lets it go.
void running.promise.then(() => {
  expect(1).toBe(2)
})

test('runs while a check fails outside it', async () => {
  running.resolve()
  await new Promise((resolve) => setImmediate(resolve))
  expect(1).toBe(1)
})
