import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import { writeRedactedLog } from '../../src/browser/redacted-log.ts'
import { Redactor, RedactedStream } from '../../src/runner/redactor.ts'

function logFile() {
  const lines: string[] = []
  let closed = false
  return {
    lines,
    closed: () => closed,
    writeFile: async (text: string) => { lines.push(text) },
    close: async () => { closed = true },
  }
}

test('completion waits for the last write and the file close, including a final line without a newline', async () => {
  const stream = new PassThrough()
  const written = Promise.withResolvers<void>()
  const closing = Promise.withResolvers<void>()
  const file = logFile()
  const output = writeRedactedLog([stream], {
    writeFile: async (text) => { await written.promise; await file.writeFile(text) },
    close: async () => { await closing.promise; await file.close() },
  }, (text) => text.replaceAll('password', '{{secret}}'))
  let finished = false
  void output.closed.then(() => { finished = true })
  stream.end('a password')
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(finished, false)
  written.resolve()
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.deepEqual(file.lines, ['a {{secret}}\n'])
  assert.equal(finished, false)
  closing.resolve()
  assert.deepEqual(await output.closed, [])
  assert.equal(file.closed(), true)
})

test('a secret split at the oversized line boundary exposes neither part, and loss is reported', async () => {
  const stream = new PassThrough()
  const file = logFile()
  const secret = 'split-sensitive-value'
  const output = writeRedactedLog([stream], file, (text) => text.replaceAll(secret, '{{password}}'))
  stream.write(`${'x'.repeat(64 * 1024 - 3)}spl`)
  stream.write('it-sensitive-value')
  stream.end(`\nsafe ${secret}\n`)
  const problems = await output.closed
  const logged = file.lines.join('')
  assert.equal(logged.includes('sensitive-value'), false)
  assert.equal(logged.includes('spl'), false)
  assert.ok(logged.includes('safe {{password}}'))
  assert.match(problems.join(' '), /1 oversized output lines/)
  assert.match(logged, /Retest dropped/)
})

test('a streaming redactor keeps a known secret spanning two lines out of the output', async () => {
  const stream = new PassThrough()
  const file = logFile()
  const redactor = new Redactor()
  redactor.learn('password', 'sensitive-prefix\nsensitive-suffix')
  const output = writeRedactedLog([stream], file, (text) => redactor.redact(text), () => new RedactedStream(redactor))
  stream.write('typed sensitive-prefix\n')
  stream.end('sensitive-suffix\n')
  assert.deepEqual(await output.closed, [])
  assert.equal(file.lines.join(''), 'typed {{password}}\n')
})

test('discarding an oversized line also discards a multiline secret prefix held before that line', async () => {
  const stream = new PassThrough()
  const file = logFile()
  const redactor = new Redactor()
  redactor.learn('password', 'sensitive-prefix\nsensitive-suffix')
  const output = writeRedactedLog([stream], file, (text) => redactor.redact(text), () => new RedactedStream(redactor))
  stream.write('typed sensitive-prefix\n')
  stream.end(`${'x'.repeat(70 * 1024)}\nafter\n`)
  assert.match((await output.closed).join(' '), /oversized/)
  const logged = file.lines.join('')
  assert.equal(logged.includes('sensitive-prefix'), false)
  assert.ok(logged.includes('after\n'))
})

test('slow writes bound pending output by bytes and lines and make the loss explicit', async () => {
  const stream = new PassThrough()
  const first = Promise.withResolvers<void>()
  const file = logFile()
  const output = writeRedactedLog([stream], {
    writeFile: async (text) => { await first.promise; await file.writeFile(text) },
    close: file.close,
  }, (text) => text)
  for (let line = 0; line < 4000; line += 1) stream.write(`${'x'.repeat(1000)}\n`)
  stream.end()
  await new Promise<void>((resolve) => setImmediate(resolve))
  first.resolve()
  const problems = await output.closed
  assert.ok(file.lines.length <= 1025, 'at most the queued lines and one loss marker are written')
  assert.ok(Buffer.byteLength(file.lines.join('')) < 1024 * 1024 + 1024)
  assert.match(problems.join(' '), /pending log limit/)
  assert.match(file.lines.at(-1) ?? '', /Retest dropped/)
})

test('cancel drops unissued writes but waits for the issued write and file close', async () => {
  const stream = new PassThrough()
  const first = Promise.withResolvers<void>()
  const issued = Promise.withResolvers<void>()
  const file = logFile()
  const output = writeRedactedLog([stream], {
    writeFile: async (text) => { issued.resolve(); await first.promise; await file.writeFile(text) },
    close: file.close,
  }, (text) => text)
  stream.write('first\nsecond\nthird\n')
  await issued.promise
  output.cancel()
  first.resolve()
  assert.match((await output.closed).join(' '), /2 output lines/)
  assert.deepEqual(file.lines.slice(0, -1), ['first\n'])
  assert.equal(file.closed(), true)
})

test('write and close failures are reported without leaving completion pending', async () => {
  const stream = new PassThrough()
  const output = writeRedactedLog([stream], {
    writeFile: async () => { throw new Error('disk full') },
    close: async () => { throw new Error('close failed') },
  }, (text) => text)
  stream.end('one\n')
  assert.deepEqual(await output.closed, ["Could not write the browser's redacted output: disk full", 'Could not close the browser log: close failed'])
})
