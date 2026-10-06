import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fsPromises from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { appendFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { maximumRecordBytes, openRegularFile, readFileSha256, readRecordText } from '../../src/shared/regular-file.ts'
import { sha256Hex } from '../../src/shared/sha256.ts'
import { Deadline } from '../../src/protocol/deadline.ts'
import { tempFolder } from '../support/temp-folder.ts'

// Something put at a path between the check that found a regular file there and the open. Each case swaps the file at
// that moment through the reader's own hook, and each defence of the open is what catches one of them: O_NONBLOCK a
// FIFO, O_NOFOLLOW a link to the very file that was checked, the inode comparison another regular file.

function mkfifo(path: string): void {
  assert.equal(spawnSync('/usr/bin/mkfifo', [path]).status, 0, 'mkfifo made the FIFO')
}

function recordAt(text = '{"kept":true}\n'): string {
  const path = join(tempFolder('retest-regular-file-'), 'build.json')
  writeFileSync(path, text)
  return path
}

describe('opening a file that is swapped between its check and its open', () => {
  test('a FIFO put there is opened without waiting and refused as replaced', { timeout: 10_000 }, async () => {
    const path = recordAt()
    const opened = await openRegularFile(path, { afterCheck: async () => { rmSync(path); mkfifo(path) } })
    assert.equal(opened.kind, 'replaced')
  })

  test('a link put there to the very file that was checked is never followed', async () => {
    const path = recordAt()
    const moved = `${path}.moved`
    const opened = await openRegularFile(path, { afterCheck: async () => { renameSync(path, moved); symlinkSync(moved, path) } })
    if (opened.kind === 'opened') await opened.handle.close()
    assert.equal(opened.kind, 'replaced', 'the link led to the same file, so only refusing to follow it tells')
  })

  test('another regular file renamed over it is refused, since it is not the file that was checked', async () => {
    const path = recordAt()
    const opened = await openRegularFile(path, { afterCheck: async () => { writeFileSync(`${path}.new`, '{"other":true}\n'); renameSync(`${path}.new`, path) } })
    if (opened.kind === 'opened') await opened.handle.close()
    assert.equal(opened.kind, 'replaced')
  })
})

test('a sparse media binary past its byte bound is refused before a descriptor read', async t => {
  const path = recordAt('')
  const maximumBytes = 64 * 1024 * 1024
  const handle = await fsPromises.open(path, 'w')
  await handle.truncate(maximumBytes + 1)
  await handle.close()
  const original = fsPromises.open
  let reads = 0
  t.mock.method(fsPromises, 'open', async (...args: Parameters<typeof original>) => {
    const file = await original(...args)
    const read = file.read.bind(file)
    t.mock.method(file, 'read', async (buffer: Buffer, offset: number, length: number, position: number | null) => { reads++; return read(buffer, offset, length, position) })
    return file
  })
  syncBuiltinESMExports()
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
  const reading = await readFileSha256(path, { maximumBytes })
  assert.equal(reading.kind, 'other')
  assert.ok(reading.kind === 'other')
  assert.ok(reading.problem.includes(path))
  assert.match(reading.problem, /bytes.*(?:limit|maximum|more than)/)
  assert.equal(reads, 0)
})

for (const mode of ['growth', 'cancellation', 'deadline'] as const) {
  test(`hashing refuses ${mode} inside the read loop and closes the descriptor`, async t => {
    const path = recordAt('')
    writeFileSync(path, Buffer.alloc(2 * 1024 * 1024))
    const controller = new AbortController()
    let now = 0
    const deadline = new Deadline(10, { clock: () => now })
    const original = fsPromises.open
    let reads = 0
    let closed = false
    t.mock.method(fsPromises, 'open', async (...args: Parameters<typeof original>) => {
      const file = await original(...args)
      const read = file.read.bind(file)
      const close = file.close.bind(file)
      t.mock.method(file, 'read', async (buffer: Buffer, offset: number, length: number, position: number | null) => {
        const result = await read(buffer, offset, length, position)
        reads++
        if (mode === 'growth' && reads < 4) appendFileSync(path, Buffer.alloc(1024 * 1024))
        if (mode === 'cancellation') controller.abort()
        if (mode === 'deadline') now = 20
        return result
      })
      t.mock.method(file, 'close', async () => { closed = true; await close() })
      return file
    })
    syncBuiltinESMExports()
    t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
    const options = { maximumBytes: 64 * 1024 * 1024, signal: controller.signal, deadline }
    const reading = await readFileSha256(path, options)
    assert.equal(reading.kind, 'other')
    assert.ok(reading.kind === 'other')
    assert.ok(reading.problem.includes(path))
    assert.match(reading.problem, mode === 'growth' ? /grew|changed size/ : mode === 'cancellation' ? /stopped|cancel/ : /deadline|budget/)
    assert.equal(reads, 1, 'no further read is issued after refusal')
    assert.equal(closed, true)
  })
}

describe('reading a record', () => {
  test('a record a writer renamed into place during the read is read again, and the new one is what is read', async () => {
    const path = recordAt('{"generation":1}\n')
    const reading = await readRecordText(path, { afterCheck: async (attempt) => { if (attempt === 1) { writeFileSync(`${path}.new`, '{"generation":2}\n'); renameSync(`${path}.new`, path) } } })
    assert.deepEqual(reading, { kind: 'text', text: '{"generation":2}\n' })
    const hashed = await readFileSha256(path, { afterCheck: async (attempt) => { if (attempt === 1) { writeFileSync(`${path}.new`, 'three'); renameSync(`${path}.new`, path) } } })
    const stats = statSync(path, { bigint: true })
    assert.deepEqual(hashed, { kind: 'file', sha256: sha256Hex('three'), identity: { device: stats.dev.toString(), inode: stats.ino.toString() } })
  })

  test('a path that stays swapped is judged after a bounded number of attempts, for what it has become', { timeout: 10_000 }, async () => {
    const path = recordAt()
    let attempts = 0
    const reading = await readRecordText(path, { afterCheck: async () => { attempts += 1; rmSync(path); mkfifo(path) } })
    assert.deepEqual(reading, { kind: 'unreadable', problem: 'it is a FIFO, not a file' })
    assert.equal(attempts, 1, 'the second look found the FIFO before any open')
    let swaps = 0
    const churning = recordAt()
    const settled = await readRecordText(churning, { afterCheck: async () => { swaps += 1; writeFileSync(`${churning}.new`, `{"swap":${swaps}}\n`); renameSync(`${churning}.new`, churning) } })
    assert.deepEqual(settled, { kind: 'unreadable', problem: 'it was replaced while Retest read it' })
    assert.equal(swaps, 3, 'three attempts, then a judgement')
  })

  test('a record that grows after it was opened is refused, never read whole', async () => {
    const path = recordAt('{}')
    const reading = await readRecordText(path, { afterOpen: async () => appendFileSync(path, Buffer.alloc(3 * 1024 * 1024, 0x20)) })
    assert.deepEqual(reading, { kind: 'unreadable', problem: `it grew past the ${maximumRecordBytes} bytes a record Retest writes may take while Retest read it` })
  })
})
