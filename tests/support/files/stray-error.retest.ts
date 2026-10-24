import { createServer } from 'node:net'
import { expect, test } from '@rehearsal-labs/retest'

// The harness sets the error off while no test runs, so it lands exactly where the check needs it: with SIGUSR2 on
// Unix, and on Windows, which has no such signal, by connecting to a port this test listens on.
test('leaves a listener behind', async () => {
  const thrown = (): never => {
    throw new Error('thrown after the test ended')
  }
  if (process.platform === 'win32') {
    const server = createServer(thrown)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    server.unref()
    const address = server.address()
    console.log(`port ${address !== null && typeof address === 'object' ? address.port : 0}`)
  } else {
    process.once('SIGUSR2', thrown)
  }
  console.log(`pid ${process.pid}`)
  expect(1).toBe(1)
})

test('waits for the next turn', () => {
  expect(2).toBe(2)
})

test('waits after it', () => {
  expect(3).toBe(3)
})
