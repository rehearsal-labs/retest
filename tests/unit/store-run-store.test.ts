import type { RetestEvent } from '../../src/protocol/events.ts'
import type { RunResult } from '../../src/protocol/result.ts'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { readEvents } from '../../src/cli/inspect/read-run-folder.ts'
import { retestEventSchema } from '../../src/protocol/events.ts'
import { parse } from '../../src/protocol/schema.ts'
import { RunFolderError, RunStore } from '../../src/store/run-store.ts'
import { isRunning } from '../support/run-harness.ts'
import { tempFolder } from '../support/temp-folder.ts'

function scratch(): string {
  return tempFolder('store-')
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
