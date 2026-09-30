import assert from 'node:assert/strict'
import { PassThrough, Writable } from 'node:stream'
import { test } from 'node:test'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { PipeTransport } from '../../src/browser/cdp/transport.ts'

function openPipe(writable: Writable = new PassThrough()) {
  const readable = new PassThrough()
  const transport = new PipeTransport({ readable, writable })
  const heard = { messages: [] as string[], problems: [] as string[], closes: [] as string[] }
  transport.listen({
    message: (text) => heard.messages.push(text),
    malformed: (problem) => heard.problems.push(problem),
    close: (reason) => heard.closes.push(reason),
  })
  return { transport, readable, writable, heard }
}

/** A pipe that takes one write and holds it until released, so later writes back up. */
function fullPipe() {
  const writes: string[] = []
  const pending: (() => void)[] = []
  const stream = new Writable({
    highWaterMark: 1,
    write(chunk: unknown, _encoding, callback) {
      writes.push(String(chunk))
      pending.push(() => callback())
    },
  })
  return { stream, writes, release: () => pending.shift()?.() }
}

test('delivers a message that arrives in one chunk', async () => {
  const { readable, heard } = openPipe()
  readable.write('{"id":1,"result":{}}\0')
  await nextTurn()
  assert.deepEqual(heard.messages, ['{"id":1,"result":{}}'])
})

test('joins a message split across chunks', async () => {
  const { readable, heard } = openPipe()
  readable.write('{"id":1,')
  readable.write('"result"')
  await nextTurn()
  assert.deepEqual(heard.messages, [])
  readable.write(':{}}\0')
  await nextTurn()
  assert.deepEqual(heard.messages, ['{"id":1,"result":{}}'])
})

test('splits several messages in one chunk and keeps the unfinished tail', async () => {
  const { readable, heard } = openPipe()
  readable.write('one\0two\0thr')
  await nextTurn()
  assert.deepEqual(heard.messages, ['one', 'two'])
  readable.write('ee\0\0')
  await nextTurn()
  assert.deepEqual(heard.messages, ['one', 'two', 'three', ''])
})

test('decodes multibyte characters split across chunks', async () => {
  const { readable, heard } = openPipe()
  for (const byte of Buffer.from('{"text":"€ 😀 ü"}\0')) readable.write(Buffer.from([byte]))
  await nextTurn()
  assert.deepEqual(heard.messages, ['{"text":"€ 😀 ü"}'])
})

test('reports a message that is not UTF-8 and keeps reading', async () => {
  const { readable, heard } = openPipe()
  readable.write(Buffer.from([0x7b, 0xff, 0x7d, 0x00]))
  readable.write('{}\0')
  await nextTurn()
  assert.deepEqual(heard.problems, ['the message is not valid UTF-8'])
  assert.deepEqual(heard.messages, ['{}'])
})

test('writes each message as UTF-8 followed by one NUL byte', () => {
  const output = new PassThrough()
  const { transport } = openPipe(output)
  transport.send('{"title":"Café"}')
  transport.send('{}')
  assert.deepEqual(output.read(), Buffer.from('{"title":"Café"}\0{}\0'))
})

test('refuses a message that would break the framing', () => {
  const { transport } = openPipe()
  assert.throws(() => transport.send('{"a":"\0"}'), TypeError)
})

test('holds messages while the pipe is full and writes them in order after it drains', async () => {
  const pipe = fullPipe()
  const { transport } = openPipe(pipe.stream)
  const first = transport.send('first')
  const second = transport.send('second')
  const third = transport.send('third')
  assert.deepEqual([first.written, second.written, third.written], [true, false, false])
  assert.deepEqual(pipe.writes, ['first\0'])

  pipe.release()
  await nextTurn()
  assert.deepEqual([second.written, third.written], [true, false])
  pipe.release()
  await nextTurn()
  assert.equal(third.written, true)
  assert.deepEqual(pipe.writes, ['first\0', 'second\0', 'third\0'])
})

test('never writes a withdrawn message, and withdrawing a written one changes nothing', async () => {
  const pipe = fullPipe()
  const { transport } = openPipe(pipe.stream)
  const first = transport.send('first')
  const second = transport.send('second')
  const third = transport.send('third')
  first.withdraw()
  second.withdraw()
  pipe.release()
  await nextTurn()
  assert.deepEqual([first.written, second.written, third.written], [true, false, true])
  assert.deepEqual(pipe.writes, ['first\0', 'third\0'])
})

test('closes once when the browser closes its output pipe', async () => {
  const { readable, writable, heard } = openPipe()
  readable.end()
  await nextTurn()
  assert.deepEqual(heard.closes, ['the browser closed the pipe'])
  assert.equal(readable.destroyed, true)
  assert.equal(writable.destroyed, true)
})

test('reports an unfinished message when the pipe ends', async () => {
  const { readable, heard } = openPipe()
  readable.end('{"id":1')
  await nextTurn()
  assert.deepEqual(heard.problems, ['the pipe ended in the middle of a message'])
  assert.deepEqual(heard.closes, ['the browser closed the pipe'])
})

test('closes when reading fails', async () => {
  const { readable, heard } = openPipe()
  readable.destroy(new Error('read ECONNRESET'))
  await nextTurn()
  assert.deepEqual(heard.closes, ['reading from the browser failed: read ECONNRESET'])
})

test('closes when writing fails, as when the browser closed its input pipe', async () => {
  const broken = new Writable({
    write(_chunk, _encoding, callback) {
      callback(new Error('write EPIPE'))
    },
  })
  const { transport, heard } = openPipe(broken)
  const message = transport.send('{}')
  await nextTurn()
  assert.deepEqual(heard.closes, ['writing to the browser failed: write EPIPE'])
  assert.equal(message.written, true)
  assert.throws(() => transport.send('{}'), /The pipe is closed: writing to the browser failed/)
})

test('closes when the pipe to the browser closes', async () => {
  const { writable, heard } = openPipe()
  writable.destroy()
  await nextTurn()
  assert.deepEqual(heard.closes, ['the pipe to the browser closed'])
})

test('closing twice closes once and drops messages that were never written', async () => {
  const pipe = fullPipe()
  const { transport, readable, heard } = openPipe(pipe.stream)
  const written = transport.send('written')
  const queued = transport.send('queued')
  transport.close()
  transport.close()
  pipe.release()
  await nextTurn()
  assert.deepEqual(heard.closes, ['the connection was closed'])
  assert.deepEqual([written.written, queued.written], [true, false])
  assert.deepEqual(pipe.writes, ['written\0'])
  assert.equal(readable.destroyed, true)
  assert.equal(pipe.stream.destroyed, true)
})

test('stops delivering when a handler closes the transport in the middle of a chunk', async () => {
  const readable = new PassThrough()
  const transport = new PipeTransport({ readable, writable: new PassThrough() })
  const messages: string[] = []
  transport.listen({
    message: (text) => {
      messages.push(text)
      transport.close()
    },
    malformed: () => assert.fail('no malformed message expected'),
    close: () => {},
  })
  readable.write('first\0second\0')
  await nextTurn()
  assert.deepEqual(messages, ['first'])
})

test('reports a close that happened before anyone listened', async () => {
  const readable = new PassThrough()
  const transport = new PipeTransport({ readable, writable: new PassThrough() })
  readable.destroy()
  await nextTurn()
  const closes: string[] = []
  transport.listen({ message: () => {}, malformed: () => {}, close: (reason) => closes.push(reason) })
  assert.deepEqual(closes, ['the browser closed the pipe'])
})

test('starts closed over a pipe that had already closed', async () => {
  const readable = new PassThrough()
  readable.destroy()
  const writable = new PassThrough()
  writable.end()
  await nextTurn()
  const closes: string[] = []
  for (const streams of [{ readable, writable: new PassThrough() }, { readable: new PassThrough(), writable }]) {
    new PipeTransport(streams).listen({ message: () => {}, malformed: () => {}, close: (reason) => closes.push(reason) })
  }
  assert.deepEqual(closes, ['the browser closed the pipe', 'the pipe to the browser closed'])
})

test('ends when the pipe produces text instead of bytes', async () => {
  const { readable, heard } = openPipe()
  readable.setEncoding('utf8')
  readable.write('{}\0')
  await nextTurn()
  assert.deepEqual(heard.messages, [])
  assert.deepEqual(heard.closes, ['the pipe from the browser produced text instead of bytes'])
})

test('accepts only one listener', () => {
  const { transport } = openPipe()
  assert.throws(() => transport.listen({ message: () => {}, malformed: () => {}, close: () => {} }), /already has a listener/)
})
