import type { BrowserOutput } from '../../src/browser/chromium-process.ts'
import type { OutputRedactor } from '../../src/browser/contract.ts'
import type { OwnedProcessIdentity, ProcessOwnershipSystem } from '../../src/shared/process-ownership.ts'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { ChildProcess } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { ChromiumProcess } from '../../src/browser/chromium-process.ts'
import { closeGraceMs } from '../../src/browser/contract.ts'
import { writeRedactedLog } from '../../src/browser/redacted-log.ts'
import { Deadline } from '../../src/protocol/deadline.ts'
import { Redactor } from '../../src/runner/redactor.ts'
import { OwnedProcessGroup } from '../../src/shared/process-ownership.ts'

const cutoff = '\n[retest] Browser output reading stopped after verified process shutdown; later inherited output was not collected.\n'
const root: OwnedProcessIdentity = { pid: 7301, parentPid: 7001, groupId: 7301, startedAt: 'fixture birth', command: '/fixture/browser', state: 'Ss' }
const helper: OwnedProcessIdentity = { pid: 7302, parentPid: root.pid, groupId: root.pid, startedAt: 'helper birth', command: '/fixture/helper', state: 'S' }

function capturedLog() {
  const lines: string[] = []
  let closed = false
  return { lines, closed: () => closed, writeFile: async (text: string) => { lines.push(text) }, close: async () => { closed = true } }
}

async function within<T>(promise: Promise<T>, milliseconds: number, description: string): Promise<T> {
  const controller = new AbortController()
  try {
    return await Promise.race([promise, delay(milliseconds, undefined, { signal: controller.signal }).then(() => { throw new Error(description) })])
  } finally { controller.abort() }
}

function trackedBrowser(context: TestContext, options: { output: BrowserOutput; system: ProcessOwnershipSystem }) {
  const child = new ChildProcess()
  Object.defineProperty(child, 'pid', { value: root.pid })
  const ownership = new OwnedProcessGroup(root.pid, root.parentPid, options.system)
  const before = new Set(process.listeners('exit'))
  const browser = new ChromiumProcess(child, undefined, { readable: new PassThrough(), writable: new PassThrough() }, options.output, ownership)
  context.after(() => {
    for (const listener of process.listeners('exit')) if (!before.has(listener)) process.off('exit', listener)
  })
  return { child, ownership, browser }
}

function observedOutput(streams: readonly PassThrough[], file: ReturnType<typeof capturedLog>, redactor?: Redactor) {
  const supplied = redactor ?? new Redactor()
  const output = writeRedactedLog(streams, file, (text) => supplied.redact(text), () => supplied.stream())
  const finished = Promise.withResolvers<void>()
  let finishes = 0
  let cancellations = 0
  return {
    finished: finished.promise,
    finishes: () => finishes,
    cancellations: () => cancellations,
    output: {
      closed: output.closed,
      writersRemain: () => streams.some((stream) => !stream.readableEnded && !stream.destroyed),
      finishReading: () => {
        finishes += 1
        assert.ok('finishReading' in output && typeof output.finishReading === 'function')
        output.finishReading()
        finished.resolve()
      },
      cancel: () => { cancellations += 1; output.cancel() },
    },
  }
}

test('verified shutdown finishes readers, keeps queued writes and masks an unfinished secret', { timeout: 10000 }, async (context) => {
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const first = Promise.withResolvers<void>()
  const issued = Promise.withResolvers<void>()
  const redactor = new Redactor()
  redactor.learn('password', 'hunter2')
  const file = capturedLog()
  const heldFile = { ...file, writeFile: async (text: string) => { issued.resolve(); await first.promise; await file.writeFile(text) } }
  const observed = observedOutput([stdout, stderr], heldFile, redactor)
  let present = true
  const signals: number[] = []
  const system: ProcessOwnershipSystem = { read: () => present ? [root] : [], signal: (pid) => { signals.push(pid) } }
  const { child, browser } = trackedBrowser(context, { output: observed.output, system })
  stdout.write('complete hunter2\nsecond\n')
  await issued.promise
  stderr.pause()
  stderr.write('safe partial hunt')
  present = false
  child.emit('exit', 0, null)
  let stopped = false
  let gone = false
  const stopping = browser.stop(0).then((problems) => { stopped = true; return problems })
  const ending = browser.gone().then(() => { gone = true })
  try {
    await within(observed.finished, 4000, 'verified shutdown did not reach reader finish')
    assert.equal(stopped, false, 'reader finish did not bypass an issued file write')
    assert.equal(gone, false, 'gone still waits for log settlement')
    assert.equal(file.closed(), false)
    assert.equal(stdout.readableEnded, false, 'local closure does not claim remote EOF')
    assert.equal(stderr.readableEnded, false)
    assert.equal(stdout.destroyed, true)
    assert.equal(stderr.destroyed, true)
    first.resolve()
    assert.deepEqual(await stopping, [])
    await ending
    assert.equal(observed.finishes(), 1, 'concurrent stop and gone share one finish')
    assert.equal(observed.cancellations(), 0)
    assert.deepEqual(signals, [])
    assert.equal(file.closed(), true)
    assert.equal(file.lines.join(''), `complete {{password}}\nsecond\nsafe partial ${cutoff}`)
    assert.equal(file.lines.join('').includes('hunt'), false)
  } finally { first.resolve(); if (!stopped) observed.output.cancel() }
})

test('reader finish preserves full multiline secrets and ordinary partial lines without releasing known prefixes', async () => {
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const file = capturedLog()
  const redactor = new Redactor()
  redactor.learn('password', 'sensitive-prefix\nsensitive-suffix')
  redactor.learn('token', 'tok-5512')
  const observed = observedOutput([stdout, stderr], file, redactor)
  stdout.write('typed sensitive-prefix\n')
  stdout.write('sensitive-suffix\nnormal tail')
  stderr.write('another tok-55')
  observed.output.finishReading()
  assert.deepEqual(await observed.output.closed, [])
  assert.equal(file.lines.join(''), `typed {{password}}\nnormal tailanother ${cutoff}`)
  assert.equal(file.lines.join('').includes('sensitive'), false)
  assert.equal(file.lines.join('').includes('tok-55'), false)
  assert.equal(file.closed(), true)
})

test('a redactor without safe cutoff support reports its withheld tail rather than releasing it', async () => {
  const stream = new PassThrough()
  const file = capturedLog()
  const redacting: OutputRedactor = { write: (text) => text, end: () => 'unsafe-prefix' }
  const output = writeRedactedLog([stream], file, (text) => text, () => redacting)
  stream.write('unsafe-prefix')
  assert.ok('finishReading' in output && typeof output.finishReading === 'function')
  output.finishReading()
  assert.deepEqual(await output.closed, [
    'The browser output redactor cannot safely finish a cut stream; its tail was dropped.',
    'The browser output redactor cannot safely redact a cutoff report; the report was dropped.',
  ])
  assert.equal(file.lines.join(''), '')
})

test('a line-only redactor cannot release a cut partial line that may be an unfinished known value', async () => {
  const stream = new PassThrough()
  const file = capturedLog()
  const redactor = new Redactor()
  redactor.learn('password', 'hunter2')
  const output = writeRedactedLog([stream], file, (text) => redactor.redact(text))
  stream.write('complete hunter2\nsafe hunt')
  assert.ok('finishReading' in output && typeof output.finishReading === 'function')
  output.finishReading()
  assert.deepEqual(await output.closed, [
    'A cut output line could not be checked for an unfinished secret without a streaming redactor, so it was dropped.',
    'The browser output redactor cannot safely redact a cutoff report; the report was dropped.',
  ])
  assert.equal(file.lines.join(''), 'complete {{password}}\n')
  assert.equal(file.lines.join('').includes('hunt'), false)
})

test('reader finish retains read errors while flushing accepted redacted lines and closing the log', async () => {
  const stream = new PassThrough()
  const file = capturedLog()
  const redactor = new Redactor()
  redactor.learn('password', 'hunter2')
  const observed = observedOutput([stream], file, redactor)
  stream.write('accepted hunter2\n')
  stream.emit('error', new Error('fixture read failed'))
  observed.output.finishReading()
  assert.deepEqual(await observed.output.closed, ["Could not read the browser's output: fixture read failed"])
  assert.equal(file.lines.join(''), `accepted {{password}}\n${cutoff}`)
  assert.equal(file.closed(), true)
})

test('reader finish preserves redactor failures at construction, data, cutoff and its own marker', async (context) => {
  for (const stage of ['construct', 'data', 'cut', 'marker'] as const) {
    await context.test(stage, async () => {
      const stream = new PassThrough()
      const file = capturedLog()
      const output = writeRedactedLog([stream], file, (text) => {
        if (stage === 'marker' && text === cutoff) throw new Error('private marker data')
        return text
      }, () => {
        if (stage === 'construct') throw new Error('private construction data')
        return {
          write: (text: string) => {
            if (stage === 'data' || (stage === 'marker' && text === cutoff)) throw new Error('private data')
            return text
          },
          end: () => '',
          cut: () => { if (stage === 'cut') throw new Error('private cutoff data'); return '' },
        }
      })
      stream.write('ordinary line\n')
      assert.ok('finishReading' in output && typeof output.finishReading === 'function')
      output.finishReading()
      assert.deepEqual(await output.closed, ['The browser output redactor failed; its output was dropped.'])
      assert.equal(file.lines.join('').includes('private'), false)
      assert.equal(file.closed(), true)
    })
  }
})

test('a failed redactor stays disabled for later partial secret text at cutoff', async (context) => {
  for (const stage of ['construct', 'data'] as const) {
    await context.test(stage, async () => {
      const stream = new PassThrough()
      const file = capturedLog()
      const writes: string[] = []
      let constructions = 0
      const output = writeRedactedLog([stream], file, (text) => text, () => {
        constructions += 1
        if (constructions > 1) return new Redactor().stream()
        if (stage === 'construct') throw new Error('private constructor failure')
        return {
          write: (text: string) => { writes.push(text); if (writes.length === 1) throw new Error('private data failure'); return text },
          end: () => '',
          cut: () => '',
        }
      })
      if (stage === 'data') stream.write('first\n')
      stream.write('hunter2')
      assert.ok('finishReading' in output && typeof output.finishReading === 'function')
      output.finishReading()
      const problems = await output.closed
      assert.deepEqual(problems, ['The browser output redactor failed; its output was dropped.'])
      assert.deepEqual(writes, stage === 'data' ? ['first\n'] : [])
      assert.equal(file.lines.join(''), cutoff)
      assert.equal(file.lines.join('').includes('hunter2'), false)
      assert.equal(problems.join(' ').includes('private'), false)
    })
  }
})

test('cutoff and loss markers use streaming cut so a known incomplete prefix is withheld', async () => {
  const stream = new PassThrough()
  const file = capturedLog()
  const redactor = new Redactor()
  redactor.learn('first', 'output was not collected.\nremaining-secret')
  redactor.learn('second', 'from the browser log.\nremaining-secret')
  const observed = observedOutput([stream], file, redactor)
  stream.write('x'.repeat(70 * 1024))
  observed.output.finishReading()
  assert.match((await observed.output.closed).join(' '), /oversized/)
  assert.equal(file.lines.join('').includes('output was not collected.'), false)
  assert.equal(file.lines.join('').includes('from the browser log.'), false)
  assert.ok(file.lines[0]?.endsWith('later inherited '))
  assert.ok(file.lines[1]?.endsWith(' '))
})

test('a loss-marker redactor exception is reported without retaining its private exception text', async () => {
  const stream = new PassThrough()
  const file = capturedLog()
  const output = writeRedactedLog([stream], file, (text) => {
    if (text.startsWith('[retest] Retest dropped')) throw new Error('private loss marker exception')
    return text
  })
  stream.end(`${'x'.repeat(70 * 1024)}\n`)
  const problems = await output.closed
  assert.match(problems.join(' '), /oversized/)
  assert.ok(problems.includes('The browser output redactor failed; its output was dropped.'))
  assert.equal(problems.join(' ').includes('private'), false)
  assert.equal(file.lines.join('').includes('private'), false)
})

test('reader finish returns file write, cutoff report and close errors', async () => {
  const stream = new PassThrough()
  const output = writeRedactedLog([stream], {
    writeFile: async () => { throw new Error('disk full') },
    close: async () => { throw new Error('close failed') },
  }, (text) => text, () => new Redactor().stream())
  stream.write('one\n')
  assert.ok('finishReading' in output && typeof output.finishReading === 'function')
  output.finishReading()
  assert.deepEqual(await output.closed, [
    "Could not write the browser's redacted output: disk full",
    "Could not write the browser log's cutoff report: disk full",
    'Could not close the browser log: close failed',
  ])
})

test('reader finish retains the queue byte and line bounds and reports both overflow and cutoff', async () => {
  const stream = new PassThrough()
  const first = Promise.withResolvers<void>()
  const file = capturedLog()
  const output = writeRedactedLog([stream], { writeFile: async (text) => { await first.promise; await file.writeFile(text) }, close: file.close }, (text) => text, () => new Redactor().stream())
  for (let line = 0; line < 4000; line += 1) stream.write(`${'x'.repeat(1000)}\n`)
  assert.ok('finishReading' in output && typeof output.finishReading === 'function')
  output.finishReading()
  first.resolve()
  assert.match((await output.closed).join(' '), /pending log limit/)
  assert.ok(file.lines.length <= 1026)
  assert.ok(Buffer.byteLength(file.lines.join('')) < 1024 * 1024 + 1024)
  assert.ok(file.lines.includes(cutoff), 'the one bounded cutoff marker survives queue overflow')
  assert.match(file.lines.at(-1) ?? '', /Retest dropped/)
})

test('reader finish preserves oversized-line loss and never joins a held secret prefix across the loss', async () => {
  const stream = new PassThrough()
  const file = capturedLog()
  const redactor = new Redactor()
  redactor.learn('password', 'sensitive-prefix\nsensitive-suffix')
  const observed = observedOutput([stream], file, redactor)
  stream.write('typed sensitive-prefix\n')
  stream.write('x'.repeat(70 * 1024))
  observed.output.finishReading()
  assert.match((await observed.output.closed).join(' '), /1 oversized output lines/)
  assert.equal(file.lines.join('').includes('sensitive-prefix'), false)
  assert.ok(file.lines.includes(cutoff))
  assert.match(file.lines.at(-1) ?? '', /Retest dropped/)
})

test('failed ownership readings never authorize reader finish or extra signals', { timeout: 10000 }, async (context) => {
  const stream = new PassThrough()
  const observed = observedOutput([stream], capturedLog())
  let cleaning = false
  const signals: number[] = []
  const system: ProcessOwnershipSystem = {
    read: () => { if (cleaning) throw new Error('ownership unavailable'); return [root] },
    readAsync: async () => { throw new Error('ownership unavailable') },
    signal: (pid) => { signals.push(pid) },
  }
  const { child, browser } = trackedBrowser(context, { output: observed.output, system })
  cleaning = true
  child.emit('exit', 0, null)
  const problems = await browser.stop(0)
  assert.match(problems.join(' '), /ownership unavailable/)
  assert.match(problems.join(' '), /redacted output did not finish/)
  assert.equal(observed.finishes(), 0)
  assert.equal(observed.cancellations(), 1)
  assert.deepEqual(signals, [])
  await observed.output.closed
})

test('unknown group members remain a cleanup failure and are never signaled or used to authorize finish', { timeout: 10000 }, async (context) => {
  const stream = new PassThrough()
  const observed = observedOutput([stream], capturedLog())
  let initial = true
  const unknown = { ...helper, parentPid: 1 }
  const signals: number[] = []
  const system: ProcessOwnershipSystem = { read: () => initial ? [root] : [unknown], signal: (pid) => { signals.push(pid) } }
  const { child, browser } = trackedBrowser(context, { output: observed.output, system })
  initial = false
  child.emit('exit', 0, null)
  const problems = await browser.stop(0, new Deadline(4 * closeGraceMs))
  assert.match(problems.join(' '), /launch ownership could not be verified/)
  assert.equal(observed.finishes(), 0)
  assert.equal(observed.cancellations(), 1)
  assert.deepEqual(signals, [])
  await observed.output.closed
})

test('a retained recorded helper remains owned after reparenting and group change, so reader finish cannot succeed', { timeout: 10000 }, async (context) => {
  const stream = new PassThrough()
  const observed = observedOutput([stream], capturedLog())
  let initial = true
  const detached = { ...helper, parentPid: 1, groupId: 7402 }
  const signals: number[] = []
  const system: ProcessOwnershipSystem = { read: () => initial ? [root, helper] : [detached], signal: (pid) => { signals.push(pid) } }
  const { child, browser, ownership } = trackedBrowser(context, { output: observed.output, system })
  initial = false
  child.emit('exit', 0, null)
  const problems = await browser.stop(0, new Deadline(4 * closeGraceMs))
  assert.notDeepEqual(problems, [])
  assert.equal(ownership.remains(), true)
  assert.equal(observed.finishes(), 0)
  assert.equal(observed.cancellations(), 1)
  assert.deepEqual(signals, [helper.pid], 'only the original recorded helper receives the existing cleanup signal')
  await observed.output.closed
})

test('a changed recorded helper stays refused and cannot authorize reader finish', { timeout: 10000 }, async (context) => {
  const stream = new PassThrough()
  const observed = observedOutput([stream], capturedLog())
  let initial = true
  const changed = { ...helper, parentPid: 1, groupId: 7402, command: '/another/helper' }
  const signals: number[] = []
  const system: ProcessOwnershipSystem = { read: () => initial ? [root, helper] : [changed], signal: (pid) => { signals.push(pid) } }
  const { child, browser } = trackedBrowser(context, { output: observed.output, system })
  initial = false
  child.emit('exit', 0, null)
  const problems = await browser.stop(0, new Deadline(4 * closeGraceMs))
  assert.match(problems.join(' '), /different identity/)
  assert.equal(observed.finishes(), 0)
  assert.deepEqual(signals, [])
  await observed.output.closed
})

test('absence without a main-process exit does not authorize reader finish', { timeout: 10000 }, async (context) => {
  const stream = new PassThrough()
  const observed = observedOutput([stream], capturedLog())
  let present = true
  const signals: number[] = []
  const system: ProcessOwnershipSystem = { read: () => present ? [root] : [], signal: (pid) => { signals.push(pid) } }
  const { browser } = trackedBrowser(context, { output: observed.output, system })
  present = false
  assert.notDeepEqual(await browser.stop(0), [])
  assert.equal(observed.finishes(), 0)
  assert.deepEqual(signals, [])
  await observed.output.closed
})

test('reader finish retains the existing ten-second bound on Retest writes', { timeout: 20000 }, async (context) => {
  const stream = new PassThrough()
  const first = Promise.withResolvers<void>()
  const issued = Promise.withResolvers<void>()
  const file = capturedLog()
  const observed = observedOutput([stream], { ...file, writeFile: async (text) => { issued.resolve(); await first.promise; await file.writeFile(text) } })
  let present = true
  const system: ProcessOwnershipSystem = { read: () => present ? [root] : [], signal: () => { throw new Error('no signal is permitted') } }
  const { child, browser } = trackedBrowser(context, { output: observed.output, system })
  stream.write('one\n')
  await issued.promise
  present = false
  child.emit('exit', 0, null)
  try {
    assert.deepEqual(await browser.stop(0), [`Retest did not finish writing and closing the browser's log within ${10 * closeGraceMs} ms after its output reading stopped.`])
    assert.equal(observed.finishes(), 1)
    assert.equal(observed.cancellations(), 1)
    assert.equal(file.closed(), false)
  } finally { first.resolve(); await observed.output.closed }
})
