import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Listeners } from '../../src/browser/listeners.ts'

function unexpected(error: unknown): never {
  throw new Error('no listener should fail here', { cause: error })
}

test('every listener hears each value, in the order they were added', () => {
  const heard: string[] = []
  const listeners = new Listeners<string>(unexpected)
  listeners.add((value) => heard.push(`a ${value}`))
  listeners.add((value) => heard.push(`b ${value}`))
  listeners.emit('one')
  assert.deepEqual(heard, ['a one', 'b one'])
})

test('a listener that throws neither stops the others nor reaches the caller', () => {
  const errors: unknown[] = []
  const heard: string[] = []
  const listeners = new Listeners<string>((error) => errors.push(error))
  const failure = new Error('listener bug')
  listeners.add(() => {
    throw failure
  })
  listeners.add((value) => heard.push(value))
  listeners.emit('one')
  assert.deepEqual(heard, ['one'])
  assert.deepEqual(errors, [failure])
})

test('a removed listener hears nothing, even when removed during an emit', () => {
  const heard: string[] = []
  const listeners = new Listeners<string>(unexpected)
  let removeSecond = () => {}
  listeners.add(() => removeSecond())
  removeSecond = listeners.add((value) => heard.push(value))
  listeners.emit('one')
  listeners.emit('two')
  assert.deepEqual(heard, [])
})

test('clear removes every listener, including those an emit in progress has not reached', () => {
  const heard: string[] = []
  const listeners = new Listeners<string>(unexpected)
  listeners.add((value) => {
    heard.push(`a ${value}`)
    listeners.clear()
  })
  listeners.add((value) => heard.push(`b ${value}`))
  listeners.emit('one')
  listeners.emit('two')
  assert.deepEqual(heard, ['a one'])
})

test('the same function added twice is two listeners, removed one at a time', () => {
  const heard: string[] = []
  const listen = (value: string) => heard.push(value)
  const listeners = new Listeners<string>(unexpected)
  const removeFirst = listeners.add(listen)
  listeners.add(listen)
  removeFirst()
  listeners.emit('one')
  assert.deepEqual(heard, ['one'])
})
