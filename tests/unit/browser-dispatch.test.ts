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
