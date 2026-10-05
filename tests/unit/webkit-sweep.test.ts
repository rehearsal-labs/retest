import type { TestContext } from 'node:test'
import type { OwnedProcessIdentity, ProcessOwnershipSystem } from '../../src/shared/process-ownership.ts'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { homeRecordFile, processStartedAt } from '../../src/browser/webkit/process.ts'
import { sweepWebKitHomes } from '../../src/browser/webkit/sweep.ts'
import { metadataComplete, metadataFailure, metadataPending, metadataRunning, useMetadataWorkerModule } from '../../src/shared/metadata-process.ts'

const started = 'Mon Oct  5 01:00:00 2026'

/** A process table that answers readings and records the signals it is sent, ending a process it is sent SIGKILL. */
function processTable(entries: OwnedProcessIdentity[]): ProcessOwnershipSystem & { signals: string[] } {
  const live = new Map(entries.map((entry) => [entry.pid, entry]))
  const signals: string[] = []
  return {
    signals,
    read: () => [...live.values()],
    signal: (pid, signal) => {
      signals.push(`${pid} ${signal}`)
      if (signal === 'SIGKILL') live.delete(pid)
    },
  }
}

async function folder(t: TestContext): Promise<string> {
  const path = await mkdtemp(join(await realpath(tmpdir()), 'retest-webkit-sweep-test-'))
  t.after(() => rm(path, { recursive: true, force: true }))
  return path
}

async function home(parent: string, name: string, record: unknown): Promise<string> {
  const path = join(parent, name)
  await mkdir(path)
  if (record !== undefined) await writeFile(join(path, homeRecordFile), typeof record === 'string' ? record : JSON.stringify(record))
  return path
}

const browserProcess: OwnedProcessIdentity = { pid: 5001, parentPid: 1, groupId: 5001, startedAt: started, command: '/cache/webkit-2359/Playwright.app/Contents/MacOS/Playwright --inspector-pipe' }
const helper: OwnedProcessIdentity = { pid: 5002, parentPid: 1, groupId: 5002, startedAt: started, command: '/cache/webkit-2359/com.apple.WebKit.WebContent.xpc/Contents/MacOS/com.apple.WebKit.WebContent.Development' }

test('a legacy WebKit record names its file while a recorded pid lives and is removed only after whole-table absence', async (t) => {
  const parent = await folder(t)
  const path = join(parent, 'retest-webkit-76-legacy')
  const record = { version: 1, path, launcher: { pid: 76, startedAt: 'local time' }, processes: [helper] }
  await home(parent, 'retest-webkit-76-legacy', record)
  const file = join(path, homeRecordFile)
  for (const entries of [[{ ...browserProcess, pid: 76 }], [helper]]) {
    const table = processTable(entries)
    assert.deepEqual(await sweepWebKitHomes(parent, { startedAt: () => undefined, processes: table, read: table.read }), [`Left the WebKit home ${path} and its processes alone, since Retest cannot confirm the recorded start time zone in ${file}. Remove ${file} once no runner is running.`])
    assert.deepEqual(table.signals, [])
    assert.equal(await readFile(file, 'utf8'), JSON.stringify(record))
  }
  const absent = processTable([])
  assert.deepEqual(await sweepWebKitHomes(parent, { startedAt: () => undefined, processes: absent, read: absent.read }), [`Removed the WebKit home ${path}; all recorded pids are absent from the whole process table.`])
  assert.deepEqual(absent.signals, [])
  assert.ok(!existsSync(path))
})

test("a home whose Retest process still runs is left alone, and nothing of its browser is signalled", async (t) => {
  const parent = await folder(t)
  const path = join(parent, 'retest-webkit-77-a')
  await home(parent, 'retest-webkit-77-a', { version: 1, startTimeVersion: 1, path, launcher: { pid: 77, startedAt: 'launcher time' }, processes: [browserProcess] })
  const table = processTable([browserProcess])
  assert.deepEqual(await sweepWebKitHomes(parent, { startedAt: () => 'launcher time', processes: table }), [])
  assert.ok(existsSync(path))
  assert.deepEqual(table.signals, [])
})

test("a home whose Retest process is gone has each recorded process that still runs as recorded killed, and is then removed", async (t) => {
  const parent = await folder(t)
  const path = join(parent, 'retest-webkit-78-b')
  await home(parent, 'retest-webkit-78-b', { version: 1, startTimeVersion: 1, path, launcher: { pid: 78, startedAt: 'launcher time' }, processes: [browserProcess, helper] })
  const table = processTable([helper])
  const notes = await sweepWebKitHomes(parent, { startedAt: () => undefined, processes: table })
  assert.deepEqual(table.signals, ['5002 SIGKILL'])
  assert.deepEqual(notes, [
    'Ended process 5002, which a WebKit launch of Retest process 78 recorded and left running.',
    `Removed the WebKit home ${path}, which Retest process 78 left behind.`,
  ])
  assert.ok(!existsSync(path))
})

test('a process whose pid was reused by another, with another start time or command, is never signalled', async (t) => {
  const parent = await folder(t)
  const path = join(parent, 'retest-webkit-79-c')
  await home(parent, 'retest-webkit-79-c', { version: 1, startTimeVersion: 1, path, launcher: { pid: 79, startedAt: 'launcher time' }, processes: [helper] })
  const table = processTable([{ ...helper, startedAt: 'Mon Oct  5 02:00:00 2026' }])
  const notes = await sweepWebKitHomes(parent, { startedAt: () => 'another process with the same pid', processes: table })
  assert.deepEqual(table.signals, [])
  assert.deepEqual(notes, [`Left the WebKit home ${path} in place; its launcher pid 79 is present with a different start, which cannot prove absence. Remove ${join(path, homeRecordFile)} once no runner is running.`])
  assert.ok(existsSync(path))
  const original = await readFile(join(path, homeRecordFile), 'utf8')
  assert.deepEqual(await sweepWebKitHomes(parent, { startedAt: () => undefined, processes: table }), [`Left the WebKit home ${path}, which Retest process 79 left behind, in place and ended none of its processes: Recorded pid 5002 is present with a different identity; a mismatch cannot prove absence.`])
  assert.deepEqual(table.signals, [])
  assert.equal(await readFile(join(path, homeRecordFile), 'utf8'), original)
  const absent = processTable([])
  assert.deepEqual(await sweepWebKitHomes(parent, { startedAt: () => undefined, processes: absent, read: absent.read }), [`Removed the WebKit home ${path}, which Retest process 79 left behind.`])
  assert.deepEqual(absent.signals, [])
  assert.ok(!existsSync(path))
})

// macOS `ps` stops reading a process's arguments while it exits and prints its kernel name, at most 16 characters, in
// parentheses: that reading is no difference, but two readable command lines that differ are.
test('a recorded process whose command line reads as its bracketed kernel name is still the same process and is ended, and one with another readable command is not', async (t) => {
  const parent = await folder(t)
  const exiting = join(parent, 'retest-webkit-85-i')
  await home(parent, 'retest-webkit-85-i', { version: 1, startTimeVersion: 1, path: exiting, launcher: { pid: 85, startedAt: 'launcher time' }, processes: [helper] })
  const table = processTable([{ ...helper, command: '(com.apple.WebKit)', state: '?E' }])
  const notes = await sweepWebKitHomes(parent, { startedAt: () => undefined, processes: table })
  assert.deepEqual(table.signals, ['5002 SIGKILL'])
  assert.deepEqual(notes, [
    'Ended process 5002, which a WebKit launch of Retest process 85 recorded and left running.',
    `Removed the WebKit home ${exiting}, which Retest process 85 left behind.`,
  ])

  const other = await folder(t)
  const reused = join(other, 'retest-webkit-86-j')
  await home(other, 'retest-webkit-86-j', { version: 1, startTimeVersion: 1, path: reused, launcher: { pid: 86, startedAt: 'launcher time' }, processes: [helper] })
  const another = processTable([{ ...helper, command: '/usr/bin/some-other-tool --serve' }])
  assert.deepEqual(await sweepWebKitHomes(other, { startedAt: () => undefined, processes: another }), [`Left the WebKit home ${reused}, which Retest process 86 left behind, in place and ended none of its processes: Recorded pid 5002 is present with a different identity; a mismatch cannot prove absence.`])
  assert.ok(existsSync(reused))
  const absent = processTable([])
  assert.deepEqual(await sweepWebKitHomes(other, { startedAt: () => undefined, processes: absent, read: absent.read }), [`Removed the WebKit home ${reused}, which Retest process 86 left behind.`])
  assert.deepEqual(absent.signals, [])
  assert.ok(!existsSync(reused))
  assert.deepEqual(another.signals, [], 'a pid reused within the same second by another command is never signalled')
})

test('a home with no record, one that cannot be read, or one that names another folder, is left where it is', async (t) => {
  const parent = await folder(t)
  const bare = await home(parent, 'retest-webkit-80-d', undefined)
  const broken = await home(parent, 'retest-webkit-81-e', '{not json')
  const elsewhere = await home(parent, 'retest-webkit-82-f', { version: 1, startTimeVersion: 1, path: '/somewhere/else', launcher: { pid: 82, startedAt: 'x' }, processes: [] })
  const other = await home(parent, 'retest-profile-83-g', undefined)
  const table = processTable([])
  assert.deepEqual(await sweepWebKitHomes(parent, { startedAt: () => undefined, processes: table }), [])
  for (const path of [bare, broken, elsewhere, other]) assert.ok(existsSync(path), path)
})

test('a recorded process that cannot be ended keeps its home, and the note says so', async (t) => {
  const parent = await folder(t)
  const path = join(parent, 'retest-webkit-84-h')
  await home(parent, 'retest-webkit-84-h', { version: 1, startTimeVersion: 1, path, launcher: { pid: 84, startedAt: 'launcher time' }, processes: [helper] })
  const table: ProcessOwnershipSystem = {
    read: () => [helper],
    signal: () => {
      throw Object.assign(new Error('not permitted'), { code: 'EPERM' })
    },
  }
  const notes = await sweepWebKitHomes(parent, { startedAt: () => undefined, processes: table })
  assert.equal(notes.length, 1)
  assert.match(notes[0] ?? '', /^Could not end process 5002, which a WebKit launch of Retest process 84 left running: /)
  assert.ok(existsSync(path))
})

const readingFailure = 'spawn /bin/ps EMFILE'

/** `table` whose readings with the given numbers, counted from 1, fail as they do on a host with no file left to open. */
function failingReadings(table: ProcessOwnershipSystem & { signals: string[] }, ...failed: number[]): ProcessOwnershipSystem & { signals: string[] } {
  let readings = 0
  return {
    ...table,
    read: () => {
      readings += 1
      if (failed.includes(readings)) throw new Error(readingFailure)
      return table.read()
    },
  }
}

/** Runs `work` while every metadata reading of this process fails, as the host's does when `ps` cannot start. */
async function whileHostReadingsFail<T>(work: () => Promise<T>): Promise<T> {
  const worker = `import { parentPort } from 'node:worker_threads'
parentPort.on('message', ({ control, output }) => {
  const state = new Int32Array(control)
  if (Atomics.compareExchange(state, 0, ${metadataPending}, ${metadataRunning}) !== ${metadataPending}) return
  const message = new TextEncoder().encode(${JSON.stringify(readingFailure)})
  new Uint8Array(output).set(message)
  Atomics.store(state, 1, ${metadataFailure})
  Atomics.store(state, 2, message.length)
  if (Atomics.compareExchange(state, 0, ${metadataRunning}, ${metadataComplete}) === ${metadataRunning}) Atomics.notify(state, 0)
})`
  const restore = useMetadataWorkerModule(new URL(`data:text/javascript,${encodeURIComponent(worker)}`))
  try {
    return await work()
  } finally {
    restore()
  }
}

test('a home whose Retest process cannot be read is left whole, nothing of its browser is signalled, and a note says why', { timeout: 10_000 }, async (t) => {
  const parent = await folder(t)
  const path = join(parent, 'retest-webkit-87-k')
  await home(parent, 'retest-webkit-87-k', { version: 1, startTimeVersion: 1, path, launcher: { pid: 87, startedAt: 'launcher time' }, processes: [browserProcess, helper] })
  const table = processTable([browserProcess, helper])
  const notes = await sweepWebKitHomes(parent, { startedAt: () => { throw new Error(readingFailure) }, processes: table })
  assert.deepEqual(notes, [`Left the WebKit home ${path} in place, since whether Retest process 87, which made it, still runs could not be read: ${readingFailure}`])
  assert.deepEqual(table.signals, [])
  assert.ok(existsSync(path))
})

// Two runs share a host whose system file table is full. The second run's `ps` for the first run's Retest process
// fails, and that failure once read as "that process is gone": the second run ended the first one's helpers and removed
// its home while it ran.
test("the host's start time reading that fails is no proof the Retest process is gone, so its home and browser are left", { timeout: 10_000 }, async (t) => {
  const parent = await folder(t)
  const path = join(parent, 'retest-webkit-88-l')
  await home(parent, 'retest-webkit-88-l', { version: 1, startTimeVersion: 1, path, launcher: { pid: 88, startedAt: 'launcher time' }, processes: [browserProcess, helper] })
  const table = processTable([browserProcess, helper])
  const notes = await whileHostReadingsFail(() => sweepWebKitHomes(parent, { startedAt: processStartedAt, processes: table }))
  assert.deepEqual(notes, [`Left the WebKit home ${path} in place, since whether Retest process 88, which made it, still runs could not be read: ${readingFailure}`])
  assert.deepEqual(table.signals, [])
  assert.ok(existsSync(path))
})

// A Retest process whose own start could not be read records it as 'unknown', which no reading matches; such a home
// was once swept by any later launch, its own Retest process's next one too.
test("a home whose Retest process's start was never read is left while any process has its pid, whatever its start, and swept once none has", { timeout: 10_000 }, async (t) => {
  const parent = await folder(t)
  const path = join(parent, 'retest-webkit-89-m')
  await home(parent, 'retest-webkit-89-m', { version: 1, startTimeVersion: 1, path, launcher: { pid: 89, startedAt: 'unknown' }, processes: [helper] })
  const table = processTable([helper])
  for (const running of [started, 'Mon Oct  5 03:00:00 2026']) {
    assert.deepEqual(await sweepWebKitHomes(parent, { startedAt: () => running, processes: table }), [
      `Left the WebKit home ${path} in place, since Retest process 89 made it without reading its own start and a process 89 still runs.`,
    ])
  }
  assert.deepEqual(table.signals, [])
  assert.ok(existsSync(path))
  assert.deepEqual(await sweepWebKitHomes(parent, { startedAt: () => undefined, processes: table }), [
    'Ended process 5002, which a WebKit launch of Retest process 89 recorded and left running.',
    `Removed the WebKit home ${path}, which Retest process 89 left behind.`,
  ])
  assert.deepEqual(table.signals, ['5002 SIGKILL'])
  assert.ok(!existsSync(path))
})

test("this Retest process's own home with a start that was never read is left by its next launch, read through the host's ps", { timeout: 10_000 }, async (t) => {
  const parent = await folder(t)
  const path = join(parent, `retest-webkit-${process.pid}-n`)
  await home(parent, `retest-webkit-${process.pid}-n`, { version: 1, startTimeVersion: 1, path, launcher: { pid: process.pid, startedAt: 'unknown' }, processes: [helper] })
  const table = processTable([helper])
  assert.deepEqual(await sweepWebKitHomes(parent, { startedAt: processStartedAt, processes: table }), [
    `Left the WebKit home ${path} in place, since Retest process ${process.pid} made it without reading its own start and a process ${process.pid} still runs.`,
  ])
  assert.deepEqual(table.signals, [])
  assert.ok(existsSync(path))
})

function heldForReading(path: string, launcher: number): string[] {
  return [`Left the WebKit home ${path}, which Retest process ${launcher} left behind, in place and ended none of its processes: Could not read ownership of process 5002: ${readingFailure}`]
}

test("a recorded process whose first reading fails holds the home, and nothing of it is signalled", { timeout: 10_000 }, async (t) => {
  const parent = await folder(t)
  const path = join(parent, 'retest-webkit-90-o')
  await home(parent, 'retest-webkit-90-o', { version: 1, startTimeVersion: 1, path, launcher: { pid: 90, startedAt: 'launcher time' }, processes: [helper] })
  const table = processTable([helper])
  assert.deepEqual(await sweepWebKitHomes(parent, { startedAt: () => undefined, processes: failingReadings(table, 1) }), heldForReading(path, 90))
  assert.deepEqual(table.signals, [])
  assert.ok(existsSync(path))
})

test('a recorded process whose reading fails as it is checked to run as recorded holds the home, and nothing of it is signalled', { timeout: 10_000 }, async (t) => {
  const parent = await folder(t)
  const path = join(parent, 'retest-webkit-91-p')
  await home(parent, 'retest-webkit-91-p', { version: 1, startTimeVersion: 1, path, launcher: { pid: 91, startedAt: 'launcher time' }, processes: [helper] })
  const table = processTable([helper])
  assert.deepEqual(await sweepWebKitHomes(parent, { startedAt: () => undefined, processes: failingReadings(table, 2) }), heldForReading(path, 91))
  assert.deepEqual(table.signals, [])
  assert.ok(existsSync(path))
})

// The browser's main process reads as recorded in readings 1 and 2; the helper's first reading, the third, fails once.
test('a reading that fails for one recorded process leaves another already read as recorded unsignalled', { timeout: 10_000 }, async (t) => {
  const parent = await folder(t)
  const path = join(parent, 'retest-webkit-92-q')
  await home(parent, 'retest-webkit-92-q', { version: 1, startTimeVersion: 1, path, launcher: { pid: 92, startedAt: 'launcher time' }, processes: [browserProcess, helper] })
  const table = processTable([browserProcess, helper])
  assert.deepEqual(await sweepWebKitHomes(parent, { startedAt: () => undefined, processes: failingReadings(table, 3) }), heldForReading(path, 92))
  assert.deepEqual(table.signals, [])
  assert.ok(existsSync(path))
})
