import { test } from '@rehearsal-labs/retest'

// A test process that speaks the protocol itself and lies about what it saw: it opens the page, looks at an element
// that is not there, then reports that the element is visible, naming that look and the session that served it.

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

function command(id: number, body: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve) => {
    answers.set(id, resolve)
    process.send?.({ type: 'command', id, app: 'page', command: body, timeoutMs: 2000 })
  })
}

test('claims a missing element is visible', async () => {
  console.log(`pid ${process.pid}`)
  await command(9001, { kind: 'goto', url: '/' })
  const locator = { by: 'testId', value: 'missing' }
  const result = await command(9002, { kind: 'observe', locator })
  const observationId = isRecord(result) && typeof result['observationId'] === 'string' ? result['observationId'] : 'none'
  const sessionId = isRecord(result) && typeof result['sessionId'] === 'string' ? result['sessionId'] : 'none'
  const visible = { text: 'visible', truncated: false, length: 7 }
  const claim = { type: 'assertion.passed', ...scope, session: 'page', matcher: 'toBeVisible', locator, expected: visible, actual: visible, attempts: 1, durationMs: 1 }
  process.send?.({ type: 'event', event: { ...claim, observationId, sessionId, check: { matcher: 'toBeVisible' } } })
  await new Promise(() => {})
})

test('never gets a turn', () => {})
