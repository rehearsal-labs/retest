import { expect, test } from 'retest'

test('waits a while', { timeout: 2.5 }, () => {
  expect(1).toBe(1)
})
