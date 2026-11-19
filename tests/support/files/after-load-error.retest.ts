import { expect, test } from 'retest'

setTimeout(() => {
  throw new Error('thrown after the file loaded')
}, 50)

test('waits its turn', () => {
  expect(1).toBe(1)
})
