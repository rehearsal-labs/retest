import type { CdpSession } from '../../src/browser/cdp/session.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Channel } from '../../src/browser/cdp/channel.ts'
import {
  CdpAbortedError,
  CdpClosedError,
  CdpDisconnectedError,
  CdpPendingLimitError,
  CdpProtocolError,
  CdpTimeoutError,
} from '../../src/browser/cdp/errors.ts'
import { CdpSession as Session } from '../../src/browser/cdp/session.ts'
import { Dispatch } from '../../src/browser/dispatch.ts'
import { Deadline } from '../../src/protocol/deadline.ts'

const command = { method: 'Input.dispatchMouseEvent', sessionId: 'S1' }

function sessionAnswering(answer: () => Promise<unknown>): CdpSession {
  return new Session('S1', new Channel('S1', () => {}), answer)
}

async function sentAfter(answer: () => Promise<unknown>): Promise<boolean> {
  const dispatch = new Dispatch()
  await dispatch.send(sessionAnswering(answer), 'Input.dispatchMouseEvent', {}, new Deadline(1000)).catch(() => undefined)
  return dispatch.sent
}

test('nothing is sent until a command is', () => {
  assert.equal(new Dispatch().sent, false)
})

test('an answered command was sent', async () => {
  assert.equal(await sentAfter(async () => ({})), true)
})

test('a command that certainly never reached the browser was not sent', async () => {
  const errors = [
    new CdpClosedError(command, 'the browser closed the pipe'),
    new CdpPendingLimitError(command, 1000),
    new CdpDisconnectedError(command, { reason: 'gone', written: false }),
    new CdpTimeoutError(command, { timeoutMs: 1, written: false }),
    new CdpAbortedError(command, { written: false }),
  ]
  for (const error of errors) assert.equal(await sentAfter(() => Promise.reject(error)), false, error.name)
})

test('a command that may have reached the browser counts as sent', async () => {
  const errors = [
    new CdpDisconnectedError(command, { reason: 'gone', written: true }),
    new CdpTimeoutError(command, { timeoutMs: 1, written: true }),
    new CdpProtocolError(command, { code: -32000, message: 'odd', data: undefined }),
    new CdpAbortedError(command, { written: true }),
  ]
  for (const error of errors) assert.equal(await sentAfter(() => Promise.reject(error)), true, error.name)
})

test('the error reaches the caller unchanged', async () => {
  const error = new CdpTimeoutError(command, { timeoutMs: 1, written: true })
  const session = sessionAnswering(() => Promise.reject(error))
  await assert.rejects(new Dispatch().send(session, 'Input.insertText', { text: 'x' }, new Deadline(1000)), error)
})

test('the command carries the time the deadline has left, and its signal', async () => {
  let timeoutMs: number | undefined
  let signal: AbortSignal | undefined
  const session = new Session('S1', new Channel('S1', () => {}), async (_method, _params, options) => {
    timeoutMs = options?.timeoutMs
    signal = options?.signal
    return {}
  })
  const stop = new AbortController()
  await new Dispatch().send(session, 'Input.insertText', { text: 'x' }, new Deadline(700, { signal: stop.signal }))
  assert.ok(timeoutMs !== undefined && timeoutMs <= 700 && timeoutMs > 600, String(timeoutMs))
  assert.equal(signal, stop.signal)
})

test('a call that never ran, because its document had gone before it arrived, was not sent', async () => {
  const neverRan = new CdpProtocolError(command, { code: -32000, message: 'Cannot find context with specified id', data: undefined })
  assert.equal(await sentAfter(() => Promise.reject(neverRan)), false)
})

test('an attempt counts as sent only when its answer says it acted, or when no answer came', async () => {
  const session = sessionAnswering(async () => ({ acted: false }))
  const dispatch = new Dispatch()
  const acted = (answer: unknown) => typeof answer === 'object' && answer !== null && 'acted' in answer && answer.acted === true
  assert.deepEqual(await dispatch.attempt((attempt) => attempt.send(session, 'Runtime.callFunctionOn', {}, new Deadline(1000)), acted), { acted: false })
  assert.equal(dispatch.sent, false, 'an answer that says it did not act')
  const actingSession = sessionAnswering(async () => ({ acted: true }))
  await dispatch.attempt((attempt) => attempt.send(actingSession, 'Runtime.callFunctionOn', {}, new Deadline(1000)), acted)
  assert.equal(dispatch.sent, true, 'an answer that says it acted')
  const lost = new Dispatch()
  const gone = new CdpDisconnectedError(command, { reason: 'gone', written: true })
  const failing = sessionAnswering(() => Promise.reject(gone))
  await assert.rejects(lost.attempt((attempt) => attempt.send(failing, 'Runtime.callFunctionOn', {}, new Deadline(1000)), acted), gone)
  assert.equal(lost.sent, true, 'no answer came')
  const unwritten = new Dispatch()
  const refused = sessionAnswering(() => Promise.reject(new CdpClosedError(command, 'closed')))
  await assert.rejects(unwritten.attempt((attempt) => attempt.send(refused, 'Runtime.callFunctionOn', {}, new Deadline(1000)), acted))
  assert.equal(unwritten.sent, false, 'it never reached the browser')
})
