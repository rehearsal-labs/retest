import { expect, test } from 'retest'

test('leaves a loop behind', () => {
  setTimeout(() => {
    for (;;) {
      // Never yields, so the process cannot take the request to close.
    }
  }, 10)
  expect(1).toBe(1)
})
