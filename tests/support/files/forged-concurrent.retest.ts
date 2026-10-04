import { expect, test } from '@rehearsal-labs/retest'

// A test process that speaks the protocol itself and skips the test runtime's own lanes: it sends two clicks to the same
// app at once, waits for both answers, then ends its test as passed with one value assertion of its own.

let scope: { testId: string; attemptId: string } | undefined
const answers = new Map<number, (result: unknown) => void>()

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

process.on('message', (message: unknown) => {
  if (!isRecord(message)) return
  const { type, testId, attemptId, id, result } = message
  if (type === 'run' && typeof testId === 'string' && typeof attemptId === 'string') scope = { testId, attemptId }
  if (type === 'command-result' && typeof id === 'number') answers.get(id)?.(result)
})

function send(id: number, value: string): Promise<unknown> {
  return new Promise((resolve) => {
    answers.set(id, resolve)
    process.send?.({ type: 'command', ...scope, id, app: 'page', command: { kind: 'click', locator: { by: 'testId', value } }, timeoutMs: 1000 })
  })
}

test('sends two clicks at once behind the runtime’s back', { timeout: 3000 }, async () => {
  const [first, second] = await Promise.all([send(9101, 'save-task'), send(9102, 'save-task')])
  process.stdout.write(`answers ${JSON.stringify([isRecord(first) && first['ok'], isRecord(second) && second['ok']])}\n`)
  expect(1).toBe(1)
})
