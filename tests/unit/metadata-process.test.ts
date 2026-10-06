import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { Deadline } from '../../src/protocol/deadline.ts'
import { metadataOutputLimit, processTableOutputLimit, readMetadataProcess, readMetadataProcessAsync, useMetadataWorkerModule } from '../../src/shared/metadata-process.ts'

const metadataModule = new URL('../../src/shared/metadata-process.ts', import.meta.url).href
const environment = { PATH: '/usr/bin:/bin' }

function answered(): string {
  return readMetadataProcess({ command: '/bin/echo', args: ['answered'], environment })
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
    assert.throws(() => readMetadataProcess({ command: '/bin/echo', args: ['never'], environment, timeoutMs: 100 }), /The metadata worker did not answer the query/)
  } finally {
    restore()
  }
  assert.equal(answered(), 'answered\n', 'one stalled worker does not refuse every later reading')
  assert.equal(answered(), 'answered\n')
})

test('a caller deadline bounds a stalled synchronous worker including its startup allowance', () => {
  const restore = useMetadataWorkerModule(new URL('./metadata-stalled-worker.ts', import.meta.url))
  const started = performance.now()
  try {
    assert.throws(() => readMetadataProcess({ command: '/bin/echo', args: ['never'], environment, timeoutMs: 100, deadline: new Deadline(100) }), /did not answer|not confirmed/)
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
    await assert.rejects(readMetadataProcessAsync({ command: '/bin/echo', args: ['never'], environment, timeoutMs: 100, deadline: new Deadline(100) }), /did not answer|not confirmed/)
    assert.ok(performance.now() - started < 600, 'the caller does not also spend the worker startup allowance')
    assert.ok(ticks > 0, 'waiting for metadata leaves the event loop free')
  } finally {
    clearInterval(timer)
    restore()
  }
  assert.equal(answered(), 'answered\n')
})

test('an ended caller deadline refuses a metadata query before it can start', async () => {
  const options = { command: '/bin/echo', args: ['must not run'], environment, deadline: new Deadline(0) }
  assert.throws(() => readMetadataProcess(options), /not started.*caller deadline/)
  await assert.rejects(readMetadataProcessAsync(options), /not started.*caller deadline/)
  assert.equal(answered(), 'answered\n')
})

test('cancelling a caller wakes an asynchronous metadata wait and leaves later readings available', async () => {
  const restore = useMetadataWorkerModule(new URL('./metadata-stalled-worker.ts', import.meta.url))
  const controller = new AbortController()
  const started = performance.now()
  try {
    const pending = readMetadataProcessAsync({ command: '/bin/echo', args: ['never'], environment, timeoutMs: 1000, deadline: new Deadline(2000, { signal: controller.signal }) })
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
  assert.throws(() => readMetadataProcess({ command: '/bin/sleep', args: ['1'], environment, timeoutMs: 50 }), /The metadata process did not answer before its deadline/)
  assert.equal(answered(), 'answered\n', 'the stuck child is not yet ended, and a new reading is still taken')
  await delay(1500)
})

test('stuck metadata processes cannot pile up: past a few, queries are refused naming them until they end', async () => {
  for (let stuck = 0; stuck < 4; stuck += 1) {
    assert.throws(() => readMetadataProcess({ command: '/bin/sleep', args: ['1'], environment, timeoutMs: 50 }), /did not answer before its deadline/)
  }
  assert.throws(answered, /4 earlier metadata processes that did not answer have not been confirmed ended/)
  await delay(1500)
  assert.equal(answered(), 'answered\n', 'once they end on their own, readings are taken again')
})

// A host started as `node --input-type=module -e`, as a script that embeds Retest can be. Its worker once inherited
// `--input-type`, which only an entry given as text may take, ended at start, and left every reading unanswered.
test('a host started from text with --input-type reads metadata through its worker', async () => {
  const script = `
    const { readMetadataProcess } = await import(${JSON.stringify(metadataModule)})
    process.stdout.write(readMetadataProcess({ command: '/bin/echo', args: ['answered'], environment: { PATH: '/usr/bin:/bin' } }))
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

test('a host with only an asynchronous metadata query stays alive until its answer or caller failure', async () => {
  for (const stalled of [false, true]) {
    const worker = new URL('./metadata-stalled-worker.ts', import.meta.url).href
    const script = `
      const { readMetadataProcessAsync, useMetadataWorkerModule } = await import(${JSON.stringify(metadataModule)})
      const { Deadline } = await import(${JSON.stringify(new URL('../../src/protocol/deadline.ts', import.meta.url).href)})
      ${stalled ? `useMetadataWorkerModule(new URL(${JSON.stringify(worker)}))` : ''}
      try {
        process.stdout.write(await readMetadataProcessAsync({ command: '/bin/echo', args: ['answered'], environment: { PATH: '/usr/bin:/bin' }, deadline: new Deadline(200) }))
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
