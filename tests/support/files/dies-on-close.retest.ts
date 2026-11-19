import { expect, test } from 'retest'

// The request to close reaches this listener right after Retest's own, which only queues the turn that says the file
// finished, so the process ends before it could say so.
process.on('message', (message: unknown) => {
  if (typeof message === 'object' && message !== null && 'type' in message && message.type === 'close') process.kill(process.pid, 'SIGKILL')
})

test('passes before its process ends on the request to close', () => {
  expect(1).toBe(1)
})
