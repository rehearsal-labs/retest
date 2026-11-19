import { expect, test } from 'retest'

// Says it has finished as it loads, before anyone asked it to close, then ends on the request to close before Retest's
// own code could say it finished.
process.send?.({ type: 'finished' })
process.on('message', (message: unknown) => {
  if (typeof message === 'object' && message !== null && 'type' in message && message.type === 'close') process.kill(process.pid, 'SIGKILL')
})

test('is listed', () => {
  expect(1).toBe(1)
})
