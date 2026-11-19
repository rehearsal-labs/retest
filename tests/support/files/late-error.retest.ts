import { expect, test } from 'retest'

test('leaves a timer behind', () => {
  setTimeout(() => {
    throw new Error('thrown after the last test ended')
  }, 10)
  expect(1).toBe(1)
})
