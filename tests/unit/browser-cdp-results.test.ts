import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CdpInvalidResponseError } from '../../src/browser/cdp/errors.ts'
import { readProtocol, request } from '../../src/browser/cdp-results.ts'
import { s } from '../../src/protocol/schema.ts'

const source = { method: 'Page.frameNavigated', sessionId: 'S1' }
const frameSchema = s.object({
  frame: s.object({ id: s.string(), parentId: s.optional(s.string()), url: s.string() }),
  children: s.optional(s.array(s.object({ id: s.string() }))),
})

test('keeps only the fields the schema names, at every depth', () => {
  const params = {
    frame: { id: 'F1', url: 'https://app.test/', loaderId: 'L1', secureContextType: 'Secure' },
    children: [{ id: 'F2', url: 'https://ads.test/' }],
    type: 'Navigation',
  }
  assert.deepEqual(readProtocol(frameSchema, params, source), {
    frame: { id: 'F1', url: 'https://app.test/' },
    children: [{ id: 'F2' }],
  })
})

test('keeps an optional field that is present', () => {
  const params = { frame: { id: 'F2', parentId: 'F1', url: 'https://app.test/frame' } }
  assert.deepEqual(readProtocol(frameSchema, params, source), params)
})

test('refuses a missing or mistyped field and names only its path', () => {
  const cases: [unknown, RegExp][] = [
    [{ frame: { id: 'F1' } }, /^\$\.frame\.url missing required key$/],
    [{ frame: { id: 'F1', url: 'https://app.test/?token=secret-value' , parentId: 7 } }, /^\$\.frame\.parentId expected string$/],
    [{ frame: 'F1' }, /^\$\.frame expected object$/],
    [null, /^\$ expected object$/],
  ]
  for (const [params, problem] of cases) {
    assert.throws(
      () => readProtocol(frameSchema, params, source),
      (error) =>
        error instanceof CdpInvalidResponseError &&
        error.method === 'Page.frameNavigated' &&
        error.sessionId === 'S1' &&
        problem.test(error.problem) &&
        !error.message.includes('secret'),
    )
  }
})

test('request sends the command with its timeout and reads the result', async () => {
  const sent: unknown[] = []
  const sender = {
    id: 'S9',
    send: async (method: string, params?: object, options?: { timeoutMs?: number }) => {
      sent.push({ method, params, options })
      return { targetId: 'T1', extra: true }
    },
  }
  const result = await request(sender, 'Target.createTarget', { url: 'about:blank' }, s.object({ targetId: s.string() }), { timeoutMs: 250 })
  assert.deepEqual(result, { targetId: 'T1' })
  assert.deepEqual(sent, [{ method: 'Target.createTarget', params: { url: 'about:blank' }, options: { timeoutMs: 250 } }])
})

test('request names the method and session of an unreadable result', async () => {
  const sender = { id: 'S9', send: async () => ({ targetId: 5 }) }
  await assert.rejects(
    request(sender, 'Target.createTarget', undefined, s.object({ targetId: s.string() }), { timeoutMs: 250 }),
    (error) => error instanceof CdpInvalidResponseError && error.method === 'Target.createTarget' && error.sessionId === 'S9',
  )
})
