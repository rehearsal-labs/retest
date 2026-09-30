import { expect, test } from '@rehearsal-labs/retest'

test('reports a step of another test', { timeout: 2000 }, async () => {
  const event = { type: 'step.started', testId: 'someone else', attemptId: 'attempt-0', stepId: 'step-1', name: 'not mine' }
  process.send?.({ type: 'event', event })
  await new Promise(() => {})
  expect(1).toBe(1)
})

test('never gets a turn', () => {
  expect(1).toBe(1)
})
