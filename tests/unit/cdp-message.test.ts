import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isRecord, parseMessage } from '../../src/browser/cdp/message.ts'

test('reads a result, keeping the result unvalidated', () => {
  assert.deepEqual(parseMessage('{"id":7,"result":{"frameId":"F"}}'), {
    kind: 'result',
    id: 7,
    result: { frameId: 'F' },
  })
  assert.deepEqual(parseMessage('{"id":0,"result":null,"sessionId":"S"}'), { kind: 'result', id: 0, result: null })
})

test('reads a CDP error with and without data', () => {
  assert.deepEqual(parseMessage('{"id":3,"error":{"code":-32000,"message":"Not allowed"}}'), {
    kind: 'error',
    id: 3,
    error: { code: -32000, message: 'Not allowed', data: undefined },
  })
  assert.deepEqual(parseMessage('{"id":3,"error":{"code":-32602,"message":"Invalid","data":"url"}}'), {
    kind: 'error',
    id: 3,
    error: { code: -32602, message: 'Invalid', data: 'url' },
  })
})

test('reads browser and session events', () => {
  assert.deepEqual(parseMessage('{"method":"Target.targetCreated","params":{"targetInfo":{}}}'), {
    kind: 'event',
    method: 'Target.targetCreated',
    params: { targetInfo: {} },
    sessionId: undefined,
  })
  assert.deepEqual(parseMessage('{"method":"Page.loadEventFired","sessionId":"S1"}'), {
    kind: 'event',
    method: 'Page.loadEventFired',
    params: undefined,
    sessionId: 'S1',
  })
})

test('ignores fields it does not know', () => {
  assert.deepEqual(parseMessage('{"id":1,"result":{},"extra":true}'), { kind: 'result', id: 1, result: {} })
})

test('reports malformed messages without quoting them', () => {
  const cases: [text: string, problem: string, id: number | undefined][] = [
    ['', 'the message is not valid JSON', undefined],
    ['{"id":1,', 'the message is not valid JSON', undefined],
    ['secret-token', 'the message is not valid JSON', undefined],
    ['null', 'the message is not a JSON object', undefined],
    ['[1,2]', 'the message is not a JSON object', undefined],
    ['"text"', 'the message is not a JSON object', undefined],
    ['{}', 'the message is neither a response nor an event', undefined],
    ['{"method":""}', 'the message is neither a response nor an event', undefined],
    ['{"method":42}', 'the message is neither a response nor an event', undefined],
    ['{"method":"A.b","sessionId":7}', 'the event has a sessionId that is not a non-empty string', undefined],
    ['{"method":"A.b","sessionId":""}', 'the event has a sessionId that is not a non-empty string', undefined],
    ['{"id":"1","result":{}}', 'the response id is not a non-negative integer', undefined],
    ['{"id":1.5,"result":{}}', 'the response id is not a non-negative integer', undefined],
    ['{"id":-1,"result":{}}', 'the response id is not a non-negative integer', undefined],
    ['{"id":1e300,"result":{}}', 'the response id is not a non-negative integer', undefined],
    ['{"id":4}', 'the response has neither a result nor an error', 4],
    ['{"id":4,"result":{},"error":{"code":1,"message":"x"}}', 'the response has both a result and an error', 4],
    ['{"id":5,"error":"boom"}', 'the response error is not a CDP error', 5],
    ['{"id":5,"error":{"code":"1","message":"x"}}', 'the response error is not a CDP error', 5],
    ['{"id":5,"error":{"code":1.5,"message":"x"}}', 'the response error is not a CDP error', 5],
    ['{"id":5,"error":{"code":1}}', 'the response error is not a CDP error', 5],
    ['{"id":5,"error":{"code":1,"message":"x","data":{}}}', 'the response error is not a CDP error', 5],
  ]
  for (const [text, problem, id] of cases) {
    assert.deepEqual(parseMessage(text), { kind: 'malformed', problem, id }, text)
  }
})

test('isRecord accepts objects and rejects arrays, null and primitives', () => {
  assert.equal(isRecord({}), true)
  assert.equal(isRecord([]), false)
  assert.equal(isRecord(null), false)
  assert.equal(isRecord('object'), false)
})
