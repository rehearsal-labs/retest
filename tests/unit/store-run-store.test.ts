import type { TestContext } from 'node:test'
import type { RetestEvent } from '../../src/protocol/events.ts'
import type { RunResult } from '../../src/protocol/result.ts'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs, { chmodSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, writeFileSync, writeSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { retestEventSchema } from '../../src/protocol/events.ts'
import { parse } from '../../src/protocol/schema.ts'
import { Redactor } from '../../src/runner/redactor.ts'
import { readEvents } from '../../src/store/read-run-folder.ts'
import { RunFolderError, RunStore } from '../../src/store/run-store.ts'
import { unixOnly } from '../support/platform-skip.ts'
import { isRunning } from '../support/run-harness.ts'
import { tempFolder } from '../support/temp-folder.ts'

function scratch(): string {
  return tempFolder('store-')
}

// A file nobody may read is one a pass cannot read; Windows has no such mode, and root reads it anyway.
const unreadable = unixOnly('a mode that refuses reading exists only on Unix') || (process.getuid?.() === 0 ? 'root reads a file whatever its mode' : false)

/**
 * Every whole-file read and write of a file in `folder` from now on, by its path in the folder, through the module
 * bindings the store reads with. `take` hands over what was seen since the last time, sorted, and starts again.
 */
function fileAccess(t: TestContext, folder: string): { take(): { reads: string[]; writes: string[] } } {
  const reads = t.mock.method(fs, 'readFileSync')
  const writes = t.mock.method(fs, 'writeFileSync')
  syncBuiltinESMExports()
  t.after(() => {
    reads.mock.restore()
    writes.mock.restore()
    syncBuiltinESMExports()
  })
  const within = (calls: readonly { arguments: readonly unknown[] }[]): string[] => calls
    .map((call) => call.arguments[0])
    .flatMap((path) => (typeof path === 'string' && path.startsWith(`${folder}/`) ? [path.slice(folder.length + 1)] : []))
    .sort()
  return {
    take: () => {
      const seen = { reads: within(reads.mock.calls), writes: within(writes.mock.calls) }
      reads.mock.resetCalls()
      writes.mock.resetCalls()
      return seen
    },
  }
}

/** One console record of a diagnostics artifact, as its line is written. */
function consoleLine(id: string, text: string): string {
  const record = { type: 'console', testId: 'a.retest.ts > saves', attemptId: 'k3v9q0x2mb', app: 'web', sessionId: 'k3v9q0x2mb:web', id, consoleType: 'log', level: 'info', origin: 'page', text: { text, truncated: false, length: text.length }, time: '2026-10-03T00:00:00.000Z' }
  return `${JSON.stringify(record)}\n`
}

const event: RetestEvent = {
  schemaVersion: 1,
  runId: 'run-1',
  sequence: 0,
  time: '2026-09-30T09:15:00.000Z',
  elapsedMs: 0,
  origin: 'parent',
  type: 'browser.started',
  product: 'Chrome',
  version: '140',
  userAgent: 'Chrome/140',
  pid: 4242,
  executablePath: '/opt/chromium/chrome',
}

const result: RunResult = {
  schemaVersion: 1,
  runId: 'run-1',
  retestVersion: '0.0.0',
  startedAt: '2026-09-30T09:15:00.000Z',
  finishedAt: '2026-09-30T09:15:01.000Z',
  complete: true,
  status: 'passed',
  exitCode: 0,
  durationMs: 1000,
  browser: null,
  counts: { passed: 0, failed: 0, error: 0, notRun: 0, inconclusive: 0 },
  files: [],
}

describe('RunStore', () => {
  test('creates the folder, its logs folder and events.jsonl', () => {
    const folder = join(scratch(), 'nested', 'run')
    const store = RunStore.create(folder)
    store.close()
    assert.deepEqual(readdirSync(folder).sort(), ['events.jsonl', 'logs'])
    assert.equal(store.directory, folder)
  })

  test('takes an existing empty folder', () => {
    const folder = scratch()
    RunStore.create(folder).close()
    assert.ok(existsSync(join(folder, 'events.jsonl')))
  })

  test('refuses a folder that already holds files, and touches nothing in it', () => {
    const folder = scratch()
    writeFileSync(join(folder, 'result.json'), 'an earlier run')
    assert.throws(() => RunStore.create(folder), (error: unknown) => {
      assert.ok(error instanceof RunFolderError)
      assert.equal(error.failure.class, 'usage')
      assert.match(error.message, /already holds files/)
      return true
    })
    assert.deepEqual(readdirSync(folder), ['result.json'])
    assert.equal(readFileSync(join(folder, 'result.json'), 'utf8'), 'an earlier run')
  })

  test('two runs cannot share a folder', () => {
    const folder = scratch()
    const first = RunStore.create(folder)
    assert.throws(() => RunStore.create(folder), RunFolderError)
    first.close()
  })

  test('a path that is a file is refused', () => {
    const file = join(scratch(), 'taken')
    writeFileSync(file, '')
    assert.throws(() => RunStore.create(file), /a file is already there/)
  })

  test('writes one event per line', () => {
    const folder = scratch()
    const store = RunStore.create(folder)
    store.appendEvent(event)
    store.appendEvent({ ...event, sequence: 1 })
    store.close()
    const lines = readFileSync(join(folder, 'events.jsonl'), 'utf8').split('\n')
    assert.equal(lines.length, 3)
    assert.equal(lines[2], '')
    assert.deepEqual(JSON.parse(lines[1] ?? ''), { ...event, sequence: 1 })
  })

  test('appends logs, and never replaces an artifact', () => {
    const folder = scratch()
    const store = RunStore.create(folder)
    store.appendLog('logs/a.log', 'one\n')
    store.appendLog('logs/a.log', 'two\n')
    store.writeArtifact('artifacts/shot.png', new Uint8Array([1, 2]))
    assert.throws(() => store.writeArtifact('artifacts/shot.png', new Uint8Array([3])), { code: 'EEXIST' })
    store.close()
    assert.equal(readFileSync(join(folder, 'logs/a.log'), 'utf8'), 'one\ntwo\n')
    assert.deepEqual([...readFileSync(join(folder, 'artifacts/shot.png'))], [1, 2])
  })

  // Found by the milestone 2 verification: a server's log kept a one-time code printed before a fill read it.
  test('reads every log again with what was learned late, and leaves the rest of the folder alone', () => {
    const folder = scratch()
    const store = RunStore.create(folder)
    store.appendLog('logs/tests-a.log', 'the code is 7f3a91\n')
    writeFileSync(join(folder, 'logs', 'app-web.log'), 'RETEST_CODE=7f3a91\nlistening\n')
    writeFileSync(join(folder, 'logs', 'browser.log'), 'nothing here\n')
    store.writeArtifact('artifacts/shot.png', new Uint8Array([0x37, 0x66]))
    store.appendEvent(event)
    store.redactLogs((text) => text.replaceAll('7f3a91', '{{code}}'))
    store.appendLog('logs/tests-a.log', 'more\n')
    store.close()
    assert.equal(readFileSync(join(folder, 'logs', 'tests-a.log'), 'utf8'), 'the code is {{code}}\nmore\n')
    assert.equal(readFileSync(join(folder, 'logs', 'app-web.log'), 'utf8'), 'RETEST_CODE={{code}}\nlistening\n')
    assert.equal(readFileSync(join(folder, 'logs', 'browser.log'), 'utf8'), 'nothing here\n')
    assert.deepEqual([...readFileSync(join(folder, 'artifacts/shot.png'))], [0x37, 0x66])
    assert.equal(readFileSync(join(folder, 'events.jsonl'), 'utf8'), `${JSON.stringify(event)}\n`)
  })

  test('a value learned at the very end leaves no line written at the very start, in an artifact or a log', () => {
    const folder = scratch()
    const store = RunStore.create(folder)
    const redactor = new Redactor()
    redactor.learn('password', 'hunter2-known-first')
    store.writeArtifact('diagnostics/first.jsonl', Buffer.from(consoleLine('c1', 'code 739104 sent') + consoleLine('c2', 'nothing')))
    store.appendLog('logs/tests-a.log', 'the code is 739104\n')
    for (let index = 2; index <= 50; index++) store.writeArtifact(`diagnostics/later-${index}.jsonl`, Buffer.from(consoleLine('c1', `page ${index}`)))
    redactor.learn('code', '739104')
    store.redactLogs((text) => redactor.redact(text))
    store.redactDiagnostics((text) => redactor.redact(text))
    store.close()
    assert.equal(readFileSync(join(folder, 'diagnostics', 'first.jsonl'), 'utf8'), consoleLine('c1', 'code 739104 sent').replace('739104', '{{code}}') + consoleLine('c2', 'nothing'))
    assert.equal(readFileSync(join(folder, 'logs', 'tests-a.log'), 'utf8'), 'the code is {{code}}\n')
    assert.equal(readFileSync(join(folder, 'diagnostics', 'later-50.jsonl'), 'utf8'), consoleLine('c1', 'page 50'))
  })

  test('an artifact written after the last value was learned is not read again', { skip: unreadable }, () => {
    const folder = scratch()
    const store = RunStore.create(folder)
    const redactor = new Redactor()
    redactor.learn('password', 'hunter2-known-before')
    store.writeArtifact('diagnostics/after.jsonl', Buffer.from(consoleLine('c1', 'nothing to hide')))
    // A read of it now fails, so a pass that reads it fails too.
    chmodSync(join(folder, 'diagnostics', 'after.jsonl'), 0o000)
    try {
      store.redactDiagnostics((text) => redactor.redact(text))
    } finally {
      chmodSync(join(folder, 'diagnostics', 'after.jsonl'), 0o600)
      store.close()
    }
    assert.equal(readFileSync(join(folder, 'diagnostics', 'after.jsonl'), 'utf8'), consoleLine('c1', 'nothing to hide'))
  })

  test('a file another writer put among the artifacts is read again whatever was learned when', () => {
    const folder = scratch()
    const store = RunStore.create(folder)
    const redactor = new Redactor()
    redactor.learn('password', 'hunter2-known-before')
    mkdirSync(join(folder, 'diagnostics'))
    writeFileSync(join(folder, 'diagnostics', 'other.jsonl'), consoleLine('c1', 'hunter2-known-before was typed'))
    store.redactDiagnostics((text) => redactor.redact(text))
    store.close()
    assert.equal(readFileSync(join(folder, 'diagnostics', 'other.jsonl'), 'utf8'), consoleLine('c1', 'hunter2-known-before was typed').replace('hunter2-known-before', '{{password}}'))
  })

  test('an artifact read again is read once more only after another value is learned', { skip: unreadable }, () => {
    const folder = scratch()
    const store = RunStore.create(folder)
    const redactor = new Redactor()
    store.writeArtifact('diagnostics/early.jsonl', Buffer.from(consoleLine('c1', 'code 518230 and 920417')))
    redactor.learn('code', '518230')
    store.redactDiagnostics((text) => redactor.redact(text))
    const path = join(folder, 'diagnostics', 'early.jsonl')
    chmodSync(path, 0o000)
    try {
      store.redactDiagnostics((text) => redactor.redact(text))
    } finally {
      chmodSync(path, 0o600)
    }
    redactor.learn('second', '920417')
    store.redactDiagnostics((text) => redactor.redact(text))
    store.close()
    assert.equal(readFileSync(path, 'utf8'), consoleLine('c1', 'code 518230 and 920417').replace('518230', '{{code}}').replace('920417', '{{second}}'))
  })

  // A run passes over its logs and artifacts as its release ends, and again as it lets go of everything once more.
  test('two passes in a row read and write each file once, and a later pass reads what changed between them', (t) => {
    const folder = scratch()
    const store = RunStore.create(folder)
    const redactor = new Redactor()
    redactor.learn('password', 'hunter2-known-first')
    store.writeArtifact('diagnostics/first.jsonl', Buffer.from(consoleLine('c1', 'code 518230 and token-920417')))
    store.appendLog('logs/tests-a.log', 'the code is 518230\n')
    writeFileSync(join(folder, 'logs', 'browser.log'), 'the browser saw 518230 and token-920417\n')
    redactor.learn('code', '518230')
    store.writeArtifact('diagnostics/second.jsonl', Buffer.from(consoleLine('c1', 'nothing')))
    const touched = fileAccess(t, folder)
    const pass = (): void => {
      store.redactLogs((text) => redactor.redact(text))
      store.redactDiagnostics((text) => redactor.redact(text))
    }
    const every = ['diagnostics/first.jsonl', 'logs/browser.log', 'logs/tests-a.log']
    pass()
    assert.deepEqual(touched.take(), { reads: every, writes: every })
    pass()
    assert.deepEqual(touched.take(), { reads: [], writes: [] }, 'nothing changed and nothing was learned since the first pass')
    const added = openSync(join(folder, 'logs', 'browser.log'), 'a')
    writeSync(added, 'and again 518230\n')
    closeSync(added)
    pass()
    assert.deepEqual(touched.take(), { reads: ['logs/browser.log'], writes: ['logs/browser.log'] }, 'the line another writer added is read, and only its log')
    store.appendLog('logs/tests-a.log', 'more\n')
    store.writeArtifact('diagnostics/third.jsonl', Buffer.from(consoleLine('c1', 'later')))
    touched.take()
    pass()
    assert.deepEqual(touched.take(), { reads: ['logs/tests-a.log'], writes: [] }, 'a log this store added to is read again, and an artifact written since is not')
    redactor.learn('token', 'token-920417')
    pass()
    assert.deepEqual(touched.take(), { reads: [...every, 'diagnostics/second.jsonl', 'diagnostics/third.jsonl'].sort(), writes: ['diagnostics/first.jsonl', 'logs/browser.log'] }, 'a value learned since has every file read again')
    store.close()
    assert.equal(readFileSync(join(folder, 'diagnostics', 'first.jsonl'), 'utf8'), consoleLine('c1', 'code 518230 and token-920417').replace('518230', '{{code}}').replace('token-920417', '{{token}}'))
    assert.equal(readFileSync(join(folder, 'logs', 'browser.log'), 'utf8'), 'the browser saw {{code}} and {{token}}\nand again {{code}}\n')
    assert.equal(readFileSync(join(folder, 'logs', 'tests-a.log'), 'utf8'), 'the code is {{code}}\nmore\n')
  })

  test('writes result.json once, whole, through a temporary file', () => {
    const folder = scratch()
    const store = RunStore.create(folder)
    assert.equal(existsSync(join(folder, 'result.json')), false)
    store.writeResult(result)
    assert.throws(() => store.writeResult(result), /once/)
    store.close()
    assert.deepEqual(JSON.parse(readFileSync(join(folder, 'result.json'), 'utf8')), result)
    assert.deepEqual(readdirSync(folder).sort(), ['events.jsonl', 'logs', 'result.json'])
  })

  test('a stale temporary result is never written over', () => {
    const folder = scratch()
    const store = RunStore.create(folder)
    mkdirSync(join(folder, 'result.json.partial'))
    assert.throws(() => store.writeResult(result))
    store.close()
    assert.equal(existsSync(join(folder, 'result.json')), false)
  })

  test('a process killed while writing leaves whole lines, all but a last one it cut off, which inspect leaves out', async () => {
    const folder = join(scratch(), 'run')
    const script = fileURLToPath(new URL('../support/append-events.ts', import.meta.url))
    const child = spawn(process.execPath, ['--conditions=retest-source', script, folder], { stdio: ['ignore', 'pipe', 'inherit'] })
    const pid = child.pid
    assert.ok(pid !== undefined)
    await new Promise<void>((resolve) => child.stdout.once('data', () => resolve()))
    await new Promise((resolve) => setTimeout(resolve, 150))
    child.kill('SIGKILL')
    await new Promise((resolve) => child.once('close', resolve))
    assert.equal(isRunning(pid), false)
    const text = readFileSync(join(folder, 'events.jsonl'), 'utf8')
    const lines = text.split('\n')
    const tail = lines.pop() ?? ''
    // Linux ends a write to a file early, at a page boundary, when SIGKILL arrives during it, so there the last line
    // can be cut off. macOS finishes the write first.
    if (process.platform === 'darwin') assert.equal(tail, '', 'the file ends with a whole line')
    assert.ok(lines.length > 10, `${lines.length} lines were written`)
    for (const [index, line] of lines.entries()) {
      const parsed = parse(retestEventSchema, JSON.parse(line))
      assert.ok(parsed.ok, `line ${index + 1} is a whole event`)
      assert.equal(parsed.value.sequence, index)
    }
    const reading = readEvents(text)
    assert.ok(reading.ok)
    assert.equal(reading.events.length, lines.length, 'inspect reads every whole line')
    assert.equal(reading.tornLine, tail === '' ? undefined : lines.length + 1, 'inspect names a line cut off')
  })
})
