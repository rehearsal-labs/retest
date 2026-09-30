import { expect, test } from '@rehearsal-labs/retest'

test('sends a command for an app it does not use', { timeout: 2000 }, async () => {
  process.send?.({ type: 'command', id: 9999, app: 'admin', command: { kind: 'goto', url: '/' }, timeoutMs: 1000 })
  await new Promise(() => {})
  expect(1).toBe(1)
})
