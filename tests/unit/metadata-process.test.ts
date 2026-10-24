import type { MetadataProcessRequest } from '../../src/shared/metadata-process.ts'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { Worker } from 'node:worker_threads'
import { Deadline } from '../../src/protocol/deadline.ts'
import { metadataOutputLimit, processTableOutputLimit, readMetadataProcess, readMetadataProcessAsync, useMetadataWorkerModule } from '../../src/shared/metadata-process.ts'
import { unixOnly, windowsOnly } from '../support/platform-skip.ts'

const metadataModule = new URL('../../src/shared/metadata-process.ts', import.meta.url).href
const environment = { PATH: '/usr/bin:/bin' }

// The programs the readings run. Windows has no /bin/echo or /bin/sleep, so Node itself stands in for them there; the
// reader is the same either way.
function echo(text: string): { readonly command: string; readonly args: readonly string[] } {
  return process.platform === 'win32' ? { command: process.execPath, args: ['-e', 'process.stdout.write(`${process.argv[1]}\\n`)', text] } : { command: '/bin/echo', args: [text] }
}
const sleepOneSecond = process.platform === 'win32' ? { command: process.execPath, args: ['-e', 'setTimeout(() => {}, 1000)'] } : { command: '/bin/sleep', args: ['1'] }

function answered(): string {
  return readMetadataProcess({ ...echo('answered'), environment })
}

// A stand-in `ps` printing a whole table of 5,000 processes in the form `ps -ww -axo pid=,ppid=,pgid=,stat=,lstart=,args=`
// prints, about 6.3 MB: more than a short reading's 4 MiB, as a busy Mac's table was (4.53 MB with about 3,600 processes).
const largeTable = { command: process.execPath, args: ['-e', "let text = ''; for (let pid = 100; pid < 5100; pid += 1) text += `${String(pid).padStart(5)}     1 ${String(pid).padStart(5)} S    Mon Oct  5 09:00:00 2026     /fake/process-${pid} ${'x'.repeat(1200)}\\n`; process.stdout.write(text)"], environment }

test('a whole process table larger than a short reading may print is read whole under the table bound, without and with holding the thread', async () => {
  for (const text of [readMetadataProcess({ ...largeTable, outputLimit: processTableOutputLimit }), await readMetadataProcessAsync({ ...largeTable, outputLimit: processTableOutputLimit })]) {
    assert.ok(text.length > metadataOutputLimit, `the table is ${text.length} bytes`)
    const lines = text.trimEnd().split('\n')
    assert.equal(lines.length, 5000)
    assert.match(lines.at(-1) ?? '', /^ 5099     1  5099 S    Mon Oct {2}5 09:00:00 2026 {5}\/fake\/process-5099 x{1200}$/, 'the last process is read whole')
  }
})

test('completed metadata readings reuse their output buffer instead of allocating a process-table buffer on every look', async (t) => {
  const buffers = new Map<number, Set<SharedArrayBuffer>>()
  const post = Worker.prototype.postMessage
  t.mock.method(Worker.prototype, 'postMessage', function (this: Worker, request: MetadataProcessRequest): void {
    const seen = buffers.get(request.output.byteLength) ?? new Set<SharedArrayBuffer>()
    seen.add(request.output)
    buffers.set(request.output.byteLength, seen)
    post.call(this, request)
  })
  for (let reading = 0; reading < 6; reading += 1) {
    for (const outputLimit of [metadataOutputLimit, processTableOutputLimit]) {
      const query = { ...echo(String(reading)), environment, outputLimit }
      assert.equal(readMetadataProcess(query), `${reading}\n`)
      assert.equal(await readMetadataProcessAsync(query), `${reading}\n`)
    }
  }
  assert.deepEqual([...buffers].map(([limit, seen]) => [limit, seen.size]), [[metadataOutputLimit, 1], [processTableOutputLimit, 1]])
})

test('concurrent metadata readings hold separate output buffers until each completion is consumed', async (t) => {
  const restore = useMetadataWorkerModule(new URL('./metadata-gated-worker.ts', import.meta.url))
  t.after(restore)
  let worker: Worker | undefined
  const buffers: SharedArrayBuffer[] = []
  const post = Worker.prototype.postMessage
  t.mock.method(Worker.prototype, 'postMessage', function (this: Worker, request: MetadataProcessRequest): void {
    worker = this
    buffers.push(request.output)
    post.call(this, request)
  })
  const readings = ['first', 'second', 'third'].map((text) => readMetadataProcessAsync({ ...echo(text), environment, outputLimit: processTableOutputLimit }))
  assert.equal(new Set(buffers).size, 3, 'a query in flight never shares its output with another')
  assert.ok(worker !== undefined)
  post.call(worker, { release: true })
  assert.deepEqual(await Promise.all(readings), ['first\n', 'second\n', 'third\n'])
  assert.equal(readMetadataProcess({ ...echo('later'), environment, outputLimit: processTableOutputLimit }), 'later\n')
  const reused = buffers[3]
  assert.ok(reused !== undefined && buffers.slice(0, 3).includes(reused), 'a completed buffer can serve the next reading')
})

test('an abandoned metadata query never returns its output buffer for another reading', async (t) => {
  const restore = useMetadataWorkerModule(new URL('./metadata-gated-worker.ts', import.meta.url))
  t.after(restore)
  const buffers: SharedArrayBuffer[] = []
  const post = Worker.prototype.postMessage
  t.mock.method(Worker.prototype, 'postMessage', function (this: Worker, request: MetadataProcessRequest): void {
    buffers.push(request.output)
    post.call(this, request)
  })
  const stop = new AbortController()
  const waiting = readMetadataProcessAsync({ ...echo('abandoned'), environment, outputLimit: processTableOutputLimit, deadline: new Deadline(1000, { signal: stop.signal }) })
  stop.abort()
  await assert.rejects(waiting, /caller deadline.*cancelled/)
  restore()
  assert.equal(readMetadataProcess({ ...echo('fresh'), environment, outputLimit: processTableOutputLimit }), 'fresh\n')
  assert.equal(buffers.length, 2)
  assert.notEqual(buffers[0], buffers[1], 'a worker whose completion was never confirmed cannot lend its buffer')
})

test('a short reading keeps its 4 MiB bound, a bound past the table bound is refused, and a table past its bound fails rather than being cut', () => {
  assert.throws(() => readMetadataProcess(largeTable), /^Error: The metadata process exceeded its output limit\.$/)
  assert.throws(() => readMetadataProcess({ ...largeTable, outputLimit: processTableOutputLimit + 1 }), RangeError)
  assert.throws(() => readMetadataProcess({ ...largeTable, outputLimit: metadataOutputLimit - 1 }), RangeError)
  const tooLarge = { ...largeTable, args: ['-e', `process.stdout.write(Buffer.alloc(${processTableOutputLimit + 1}, 'x'))`], outputLimit: processTableOutputLimit }
  assert.throws(() => readMetadataProcess(tooLarge), /^Error: The metadata process exceeded its output limit\.$/)
  assert.equal(answered(), 'answered\n', 'a refused reading leaves later readings answered')
})

test('a worker that stalls on one query fails that query alone, and the next query starts a fresh worker that answers', () => {
  assert.equal(answered(), 'answered\n', 'the usual worker answers before the stall')
  const restore = useMetadataWorkerModule(new URL('./metadata-stalled-worker.ts', import.meta.url))
  try {
    assert.throws(() => readMetadataProcess({ ...echo('never'), environment, timeoutMs: 100 }), /The metadata worker did not answer the query/)
  } finally {
    restore()
  }
  assert.equal(answered(), 'answered\n', 'one stalled worker does not refuse every later reading')
  assert.equal(answered(), 'answered\n')
})

// A query that holds the thread cannot hear its worker end, so it fails at its own bound; one that waits without holding
// it hears each end and asks a fresh worker, a few times at most.
test('a worker that ends before it answers fails a query that holds the thread at its bound, and is replaced a few times at most for one that does not', async (t) => {
  const restore = useMetadataWorkerModule(new URL('./metadata-exiting-worker.ts', import.meta.url))
  t.after(restore)
  let posted = 0
  const post = Worker.prototype.postMessage
  t.mock.method(Worker.prototype, 'postMessage', function (this: Worker, request: MetadataProcessRequest): void {
    posted += 1
    post.call(this, request)
  })
  assert.throws(() => readMetadataProcess({ ...echo('never'), environment, timeoutMs: 200 }), /The metadata worker (did not answer|ended before it answered) the query\./)
  posted = 0
  const started = performance.now()
  await assert.rejects(readMetadataProcessAsync({ ...echo('never'), environment }), /The metadata worker ended before it answered the query\./)
  assert.ok(posted <= 3, `the query was posted to at most three workers, not as many as could start: ${posted}`)
  assert.ok(performance.now() - started < 3000, 'the query did not wait out its whole bound')
  restore()
  assert.equal(answered(), 'answered\n', 'the usual worker answers again')
})

test('a caller deadline bounds a stalled synchronous worker including its startup allowance', () => {
  const restore = useMetadataWorkerModule(new URL('./metadata-stalled-worker.ts', import.meta.url))
  const started = performance.now()
  try {
    assert.throws(() => readMetadataProcess({ ...echo('never'), environment, timeoutMs: 100, deadline: new Deadline(100) }), /did not answer|not confirmed/)
    assert.ok(performance.now() - started < 600, 'the caller does not also spend the worker startup allowance')
  } finally {
    restore()
  }
  assert.equal(answered(), 'answered\n', 'the failed query does not disable later readings')
})

test('a caller deadline bounds a stalled asynchronous worker while the event loop can run', async () => {
  const restore = useMetadataWorkerModule(new URL('./metadata-stalled-worker.ts', import.meta.url))
  const started = performance.now()
  let ticks = 0
  const timer = setInterval(() => { ticks += 1 }, 5)
  try {
    await assert.rejects(readMetadataProcessAsync({ ...echo('never'), environment, timeoutMs: 100, deadline: new Deadline(100) }), /did not answer|not confirmed/)
    assert.ok(performance.now() - started < 600, 'the caller does not also spend the worker startup allowance')
    assert.ok(ticks > 0, 'waiting for metadata leaves the event loop free')
  } finally {
    clearInterval(timer)
    restore()
  }
  assert.equal(answered(), 'answered\n')
})

test('an ended caller deadline refuses a metadata query before it can start', async () => {
  const options = { ...echo('must not run'), environment, deadline: new Deadline(0) }
  assert.throws(() => readMetadataProcess(options), /not started.*caller deadline/)
  await assert.rejects(readMetadataProcessAsync(options), /not started.*caller deadline/)
  assert.equal(answered(), 'answered\n')
})

test('cancelling a caller wakes an asynchronous metadata wait and leaves later readings available', async () => {
  const restore = useMetadataWorkerModule(new URL('./metadata-stalled-worker.ts', import.meta.url))
  const controller = new AbortController()
  const started = performance.now()
  try {
    const pending = readMetadataProcessAsync({ ...echo('never'), environment, timeoutMs: 1000, deadline: new Deadline(2000, { signal: controller.signal }) })
    const timer = setTimeout(() => controller.abort(), 20)
    try {
      await assert.rejects(pending, /caller deadline.*cancelled/)
      assert.ok(performance.now() - started < 600, 'cancellation wakes the wait without spending its remaining budget')
    } finally {
      clearTimeout(timer)
    }
  } finally {
    restore()
  }
  assert.equal(answered(), 'answered\n')
})

test('a metadata process stuck past its deadline fails its own query, and later queries are still read', async () => {
  assert.throws(() => readMetadataProcess({ ...sleepOneSecond, environment, timeoutMs: 50 }), /The metadata process did not answer before its deadline/)
  assert.equal(answered(), 'answered\n', 'the stuck child is not yet ended, and a new reading is still taken')
  await delay(1500)
})

test('stuck metadata processes cannot pile up: past a few, queries are refused naming them until they end', { skip: unixOnly('on Windows a stuck metadata process is ended when its query is given up on; the case below') }, async () => {
  for (let stuck = 0; stuck < 4; stuck += 1) {
    assert.throws(() => readMetadataProcess({ ...sleepOneSecond, environment, timeoutMs: 50 }), /did not answer before its deadline/)
  }
  assert.throws(answered, /4 earlier metadata processes that did not answer have not been confirmed ended/)
  await delay(1500)
  assert.equal(answered(), 'answered\n', 'once they end on their own, readings are taken again')
})

// On Windows a metadata process is a run of retest-supervisor, which may be making a job; one given up on is ended.
test('on Windows a stuck metadata process is ended when its query is given up on, so none piles up', { skip: windowsOnly('a stuck metadata process is left to end by itself on macOS and Linux; the case above') }, () => {
  for (let stuck = 0; stuck < 4; stuck += 1) {
    assert.throws(() => readMetadataProcess({ ...sleepOneSecond, environment, timeoutMs: 50 }), /did not answer before its deadline/)
  }
  assert.equal(answered(), 'answered\n', 'the stuck ones were ended, so the next reading is taken at once')
})

// A host started as `node --input-type=module -e`, as a script that embeds Retest can be. Its worker once inherited
// `--input-type`, which only an entry given as text may take, ended at start, and left every reading unanswered.
test('a host started from text with --input-type reads metadata through its worker', async () => {
  const script = `
    const { readMetadataProcess } = await import(${JSON.stringify(metadataModule)})
    process.stdout.write(readMetadataProcess({ ...${JSON.stringify(echo('answered'))}, environment: { PATH: '/usr/bin:/bin' } }))
  `
  const child = spawn(process.execPath, ['--conditions=retest-source', '--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
  const [code] = await once(child, 'exit')
  assert.equal(code, 0, stderr)
  assert.equal(stdout, 'answered\n')
})

// The successful query waits for its completion under the production query bound. Only the case testing expiry
// imposes a short deadline; worker startup speed is not what this host-liveness check proves.
test('a host with only an asynchronous metadata query stays alive until its answer or caller failure', async () => {
  for (const stalled of [false, true]) {
    const worker = new URL('./metadata-stalled-worker.ts', import.meta.url).href
    const script = `
      const { readMetadataProcessAsync, useMetadataWorkerModule } = await import(${JSON.stringify(metadataModule)})
      const { Deadline } = await import(${JSON.stringify(new URL('../../src/protocol/deadline.ts', import.meta.url).href)})
      ${stalled ? `useMetadataWorkerModule(new URL(${JSON.stringify(worker)}))` : ''}
      try {
        process.stdout.write(await readMetadataProcessAsync({ ...${JSON.stringify(echo('answered'))}, environment: { PATH: '/usr/bin:/bin' }${stalled ? ', deadline: new Deadline(200)' : ''} }))
      } catch (error) {
        process.stderr.write(String(error))
        process.exitCode = 2
      }
    `
    const child = spawn(process.execPath, ['--conditions=retest-source', '--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    const [code] = await once(child, 'close')
    assert.equal(code, stalled ? 2 : 0, stderr)
    if (stalled) {
      assert.equal(stdout, '')
      assert.match(stderr, /did not answer|not confirmed/)
    } else {
      assert.equal(stderr, '')
      assert.equal(stdout, 'answered\n')
    }
  }
})
