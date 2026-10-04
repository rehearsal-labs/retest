import { expect, test } from '@rehearsal-labs/retest'

let scope: { testId: string; attemptId: string } | undefined
process.on('message', (message: unknown) => {
  if (typeof message !== 'object' || message === null || !('type' in message) || message.type !== 'run') return
  if ('testId' in message && typeof message.testId === 'string' && 'attemptId' in message && typeof message.attemptId === 'string') scope = { testId: message.testId, attemptId: message.attemptId }
})

test('sends a command for an app it does not use', { timeout: 2000 }, async () => {
  process.send?.({ type: 'command', ...scope, id: 9999, app: 'admin', command: { kind: 'goto', url: '/' }, timeoutMs: 1000 })
  await new Promise(() => {})
  expect(1).toBe(1)
})
