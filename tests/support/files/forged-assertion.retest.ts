import { test } from '@rehearsal-labs/retest'

// A test process that speaks the protocol itself and lies about what it saw: it looks at an element that is
// not there, then reports that the element is visible, naming that look.

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

test('claims a missing element is visible', { timeout: 3000 }, async () => {
  console.log(`pid ${process.pid}`)
  const locator = { by: 'testId', value: 'missing' }
  const result = await new Promise((resolve) => {
    answers.set(9001, resolve)
    process.send?.({ type: 'command', id: 9001, app: 'page', command: { kind: 'observe', locator }, timeoutMs: 1000 })
  })
  const observationId = isRecord(result) && typeof result['observationId'] === 'string' ? result['observationId'] : 'none'
  const visible = { text: 'visible', truncated: false, length: 7 }
  const claim = { type: 'assertion.passed', ...scope, session: 'page', matcher: 'toBeVisible', locator, expected: visible, actual: visible, attempts: 1, durationMs: 1 }
  process.send?.({ type: 'event', event: { ...claim, observationId, check: { matcher: 'toBeVisible' } } })
  await new Promise(() => {})
})

test('never gets a turn', () => {})
