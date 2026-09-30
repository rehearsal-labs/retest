import { expect, test } from '@rehearsal-labs/retest'

// The harness sends SIGUSR2 while no test runs, so the error lands exactly where the check needs it.
test('leaves a listener behind', () => {
  process.once('SIGUSR2', () => {
    throw new Error('thrown after the test ended')
  })
  console.log(`pid ${process.pid}`)
  expect(1).toBe(1)
})

test('waits for the next turn', () => {
  expect(2).toBe(2)
})

test('waits after it', () => {
  expect(3).toBe(3)
})
