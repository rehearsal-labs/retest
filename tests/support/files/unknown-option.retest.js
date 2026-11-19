import { expect, test } from 'retest'

test('retries twice', { retries: 2 }, () => {
  expect(1).toBe(1)
})
