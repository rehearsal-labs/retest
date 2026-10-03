import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseBidiMessage } from './bidi-message.ts'

test('reads a success, an error and an event', () => {
  assert.deepEqual(parseBidiMessage('{"type":"success","id":4,"result":{"userContext":"u1"}}'), {
    kind: 'success',
    id: 4,
    result: { userContext: 'u1' },
  })
  assert.deepEqual(parseBidiMessage('{"type":"error","id":5,"error":"no such frame","message":"gone","stacktrace":"at x"}'), {
    kind: 'error',
    id: 5,
    error: 'no such frame',
    message: 'gone',
  })
  assert.deepEqual(parseBidiMessage('{"type":"event","method":"browsingContext.load","params":{"context":"c1"}}'), {
    kind: 'event',
    method: 'browsingContext.load',
    params: { context: 'c1' },
  })
})

test('reads an error with a null id as one that answers no command', () => {
  assert.deepEqual(parseBidiMessage('{"type":"error","id":null,"error":"invalid argument","message":"unreadable"}'), {
    kind: 'error',
    id: undefined,
    error: 'invalid argument',
    message: 'unreadable',
  })
})

test('refuses what is not a BiDi message, keeping the id it could read, and never quotes the text', () => {
  const cases: [string, string, number | undefined][] = [
    ['not json {secret-value', 'the message is not valid JSON', undefined],
    ['["secret-value"]', 'the message is not a JSON object', undefined],
    ['{"type":"answer","id":3,"value":"secret-value"}', 'the message type is not success, error or event', 3],
    ['{"type":"success","result":{}}', 'the success has no command id', undefined],
    ['{"type":"success","id":-1,"result":{}}', 'the success has no command id', undefined],
    ['{"type":"success","id":6,"result":"secret-value"}', 'the success result is not an object', 6],
    ['{"type":"error","id":7,"message":"secret-value"}', 'the error has no error code or message', 7],
    ['{"type":"error","id":"7","error":"x","message":"y"}', 'the error id is neither a command id nor null', undefined],
    ['{"type":"event","params":{}}', 'the event has no method', undefined],
    ['{"type":"event","method":"log.entryAdded","params":["secret-value"]}', 'the event params are not an object', undefined],
  ]
  for (const [text, problem, id] of cases) {
    const message = parseBidiMessage(text)
    assert.deepEqual(message, { kind: 'malformed', problem, id }, text)
    assert.ok(!JSON.stringify(message).includes('secret-value'), text)
  }
})
