import { expect, test } from '@rehearsal-labs/retest'

const declaring = Promise.withResolvers<void>()
const checking = Promise.withResolvers<void>()
// Registered while the file loads, so each callback runs outside any test once a test lets it go.
void declaring.promise.then(() => {
  test('is declared after loading', () => {})
})
void checking.promise.then(() => {
  expect(1).toBe(2)
})

test('runs while another test is declared', async () => {
  declaring.resolve()
  await new Promise((resolve) => setImmediate(resolve))
  expect(1).toBe(1)
})

test('runs while a check fails outside it', async () => {
  checking.resolve()
  await new Promise((resolve) => setImmediate(resolve))
  expect(1).toBe(1)
})
