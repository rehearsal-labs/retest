import { expect, test } from '@rehearsal-labs/retest'

// A test process that speaks the protocol itself and claims a pass it did not earn: it looks at an element that is
// not there, reports that look as a failed assertion, which the parent accepts since it fails on that look, then ends
// its test as passed with one value assertion of its own, as if nothing had failed.

type Scope = { testId: string; attemptId: string }

let scope: Scope | undefined
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

test('claims a pass after the parent failed its assertion', { timeout: 3000 }, async () => {
  const locator = { by: 'testId', value: 'missing' }
  const result = await new Promise((resolve) => {
    answers.set(9002, resolve)
    process.send?.({ type: 'command', ...scope, id: 9002, app: 'page', command: { kind: 'observe', locator }, timeoutMs: 1000 })
  })
  const observationId = isRecord(result) && typeof result['observationId'] === 'string' ? result['observationId'] : 'none'
  const sessionId = isRecord(result) && typeof result['sessionId'] === 'string' ? result['sessionId'] : 'none'
  const visible = { text: 'visible', truncated: false, length: 7 }
  const hidden = { text: 'no element', truncated: false, length: 10 }
  const failure = { class: 'check_failed', message: "expect(getByTestId('missing')).toBeVisible() failed: nothing matched." }
  const claim = { type: 'assertion.failed', ...scope, session: 'page', matcher: 'toBeVisible', locator, expected: visible, actual: hidden, attempts: 1, durationMs: 1, failure }
  process.send?.({ type: 'event', event: { ...claim, observationId, sessionId, check: { matcher: 'toBeVisible' } } })
  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(1).toBe(1)
})
