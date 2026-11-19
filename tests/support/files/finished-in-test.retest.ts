import { expect, test } from 'retest'

test('says the file has finished while it runs', { timeout: 2000 }, async () => {
  process.send?.({ type: 'finished' })
  await new Promise(() => {})
  expect(1).toBe(1)
})

test('never gets a turn', () => {
  expect(1).toBe(1)
})
