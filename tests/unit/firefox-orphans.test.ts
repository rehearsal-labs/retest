import type { OwnedProcessIdentity } from '../../src/shared/process-ownership.ts'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { sweepOrphanedFirefoxes } from '../../src/browser/firefox/orphans.ts'
import { ownerRecordFile } from '../../src/browser/firefox/profile.ts'

// The sweep ends only the Firefoxes launches recorded, when their launcher is gone and the process is still exactly
// the one recorded, and never anything else.

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'retest-sweep-test-'))
})

afterEach(() => rm(root, { recursive: true, force: true }))

const started = 'Mon Oct  5 01:00:00 2026'
const owner = { pid: 4001, startedAt: started, command: 'node retest run' }

function firefoxCommand(folder: string): string {
  return `/Applications/Firefox.app/Contents/MacOS/firefox --headless --no-remote --profile ${join(folder, 'profile')} --remote-debugging-port=0 about:blank`
}

async function launchFolder(record: boolean, ownerPid = owner.pid): Promise<{ folder: string; command: string }> {
  const folder = join(root, `retest-firefox-${ownerPid}-abc${Math.random().toString(36).slice(2, 8)}`)
  await mkdir(join(folder, 'profile'), { recursive: true })
  const command = firefoxCommand(folder)
  if (record) {
    const firefox = { pid: 5001, startedAt: started, command, route: 'spawn' }
    await writeFile(join(folder, ownerRecordFile), JSON.stringify({ version: 1, startTimeVersion: 1, owner: { ...owner, pid: ownerPid }, firefox, profile: join(folder, 'profile') }))
  }
  return { folder, command }
}

function system(table: OwnedProcessIdentity[]): { read: () => OwnedProcessIdentity[]; kill: (pid: number) => void; killed: number[] } {
  const killed: number[] = []
  return {
    killed,
    read: () => [...table],
    kill: (pid) => {
      killed.push(pid)
      const index = table.findIndex((entry) => entry.pid === pid)
      if (index !== -1) table.splice(index, 1)
    },
  }
}

function entry(pid: number, command: string, extra: Partial<OwnedProcessIdentity> = {}): OwnedProcessIdentity {
  return { pid, parentPid: 1, groupId: pid, startedAt: started, command, state: 'S', ...extra }
}

describe('the Firefox orphan sweep', () => {
  test('a launch whose launcher is still running is left alone', async () => {
    const { command } = await launchFolder(true)
    const fake = system([entry(owner.pid, owner.command), entry(5001, command)])
    const report = await sweepOrphanedFirefoxes(root, fake)
    assert.deepEqual([report.ended, report.removed, fake.killed], [[], [], []])
  })

  test('the recorded Firefox of a launcher that is gone is ended, with the processes it started, and its folder removed', async () => {
    const { folder, command } = await launchFolder(true)
    const child = entry(5002, '/Applications/Firefox.app/Contents/MacOS/plugin-container.app/Contents/MacOS/plugin-container -parentPid 5001 tab', { parentPid: 5001, groupId: 5001 })
    const stranger = entry(6001, 'other app', { parentPid: 5001, groupId: 6001 })
    const fake = system([entry(5001, command), child, stranger])
    const report = await sweepOrphanedFirefoxes(root, fake)
    assert.deepEqual(report.ended, [5001])
    assert.deepEqual(fake.killed.sort(), [5001, 5002], 'only the Firefox and its children in its own group')
    assert.deepEqual(report.removed, [folder])
    assert.equal(existsSync(folder), false)
  })

  test('a present launcher with a different start keeps its record and Firefox unsignalled', async () => {
    const { folder, command } = await launchFolder(true)
    const file = join(folder, ownerRecordFile)
    const original = await readFile(file, 'utf8')
    const fake = system([entry(owner.pid, 'another program', { startedAt: 'Mon Oct  5 02:00:00 2026' }), entry(5001, command)])
    const report = await sweepOrphanedFirefoxes(root, fake)
    assert.deepEqual([report.ended, report.removed, fake.killed], [[], [], []])
    assert.deepEqual(report.kept, [`${folder}: its launcher pid is present with a different start, which cannot prove absence. Remove ${file} once no runner is running.`])
    assert.equal(await readFile(file, 'utf8'), original)
    const gone = await sweepOrphanedFirefoxes(root, system([entry(9999, 'unrelated')]))
    assert.deepEqual([gone.ended, gone.removed], [[], [folder]])
    assert.equal(existsSync(folder), false)
  })

  test('a process that no longer has the recorded identity is never ended, and its folder is kept', async () => {
    const { folder, command } = await launchFolder(true)
    const fake = system([entry(5001, command, { startedAt: 'Mon Oct  5 03:00:00 2026' })])
    const report = await sweepOrphanedFirefoxes(root, fake)
    assert.deepEqual([report.ended, fake.killed, report.removed], [[], [], []])
    assert.match(report.kept[0] ?? '', /is no longer the Firefox its launch recorded/)
    assert.equal(existsSync(folder), true)
  })

  test('a recorded Firefox whose command line ps cannot read while it exits is still the one recorded', async () => {
    await launchFolder(true)
    const fake = system([entry(5001, '(firefox)', { state: '?E' })])
    const report = await sweepOrphanedFirefoxes(root, fake)
    assert.deepEqual([report.ended, fake.killed], [[5001], [5001]])
  })

  test('a process with the recorded pid and start but another readable command line is never ended', async () => {
    const { folder } = await launchFolder(true)
    const fake = system([entry(5001, '/usr/bin/some-other-program --profile elsewhere')])
    const report = await sweepOrphanedFirefoxes(root, fake)
    assert.deepEqual([report.ended, fake.killed, report.removed], [[], [], []])
    assert.equal(existsSync(folder), true)
  })

  test('the folder of a recorded Firefox that already ended is removed, with nothing ended', async () => {
    const { folder } = await launchFolder(true)
    const fake = system([entry(9999, 'unrelated')])
    const report = await sweepOrphanedFirefoxes(root, fake)
    assert.deepEqual([report.ended, fake.killed, report.removed], [[], [], [folder]])
  })

  test('a folder with no record is removed only when nothing uses its profile, and a Firefox using it is never ended', async () => {
    const unused = await launchFolder(false, 4100)
    const used = await launchFolder(false, 4200)
    const fake = system([entry(7001, used.command)])
    const report = await sweepOrphanedFirefoxes(root, fake)
    assert.deepEqual(report.removed, [unused.folder])
    assert.deepEqual(fake.killed, [])
    assert.match(report.kept.join(' '), /no record names it/)
  })

  test("a folder that is not a Firefox launch's own is never touched", async () => {
    const other = join(root, 'retest-profile-4001-abcdef')
    await mkdir(other)
    const report = await sweepOrphanedFirefoxes(root, system([entry(9999, 'unrelated')]))
    assert.deepEqual(report.removed, [])
    assert.equal(existsSync(other), true)
  })

  test('a process table that cannot be read sweeps nothing and says so', async () => {
    await launchFolder(true)
    const report = await sweepOrphanedFirefoxes(root, { read: () => { throw new Error('ps failed') }, kill: () => assert.fail('nothing is ended') })
    assert.match(report.problems[0] ?? '', /Could not read the process table, so no Firefox folder was swept: ps failed/)
  })
})

test('the orphan sweep skips 100 dead helper rows and freshly reads only the live root before its signal', async () => {
  const { command } = await launchFolder(true)
  const current = entry(5001, command)
  let table = [current, ...Array.from({ length: 100 }, (_, index) => entry(5100 + index, '/owned/helper', { parentPid: 5001, groupId: 5001, state: 'Z' }))]
  let tables = 0
  const identities: number[] = []
  const killed: number[] = []
  const report = await sweepOrphanedFirefoxes(root, {
    read: () => { tables += 1; return table },
    readProcess: (pid) => { identities.push(pid); return table.find((entry) => entry.pid === pid) },
    kill: (pid) => { killed.push(pid); table = [] },
  })
  assert.deepEqual(report.problems, [])
  assert.deepEqual(identities, [5001])
  assert.deepEqual(killed, [5001])
  assert.equal(tables, 3, 'discovery, live candidate snapshot, and absence confirmation')
})

test('an orphan helper reused between the snapshot and its individual read is never signalled or released', async () => {
  const { folder, command } = await launchFolder(true)
  const current = entry(5001, command)
  const helper = entry(5002, '/owned/helper', { parentPid: 5001, groupId: 5001 })
  const killed: number[] = []
  const report = await sweepOrphanedFirefoxes(root, {
    read: () => [current, helper],
    readProcess: (pid) => pid === helper.pid ? { ...helper, startedAt: 'another birth' } : current,
    kill: (pid) => killed.push(pid),
  })
  assert.deepEqual(killed, [])
  assert.match(report.problems.join(' '), /changed identity/)
  assert.deepEqual(report.removed, [])
  assert.equal(existsSync(folder), true)
})

test('a failed individual orphan reading authorises no signal or folder removal', async () => {
  const { command } = await launchFolder(true)
  const killed: number[] = []
  const report = await sweepOrphanedFirefoxes(root, {
    read: () => [entry(5001, command)],
    readProcess: () => { throw new Error('identity unreadable') },
    kill: (pid) => killed.push(pid),
  })
  assert.deepEqual(killed, [])
  assert.deepEqual(report.removed, [])
  assert.match(report.problems.join(' '), /identity unreadable/)
})

test('a legacy Firefox record names its file while either pid lives and is removed only after whole-table absence', async () => {
  const { folder, command } = await launchFolder(false)
  const file = join(folder, ownerRecordFile)
  const original = JSON.stringify({ version: 1, owner, firefox: { pid: 5001, startedAt: started, command, route: 'spawn' }, profile: join(folder, 'profile') })
  await writeFile(file, original)
  for (const table of [[entry(owner.pid, owner.command)], [entry(5001, command)]]) {
    const fake = system(table)
    const report = await sweepOrphanedFirefoxes(root, fake)
    assert.deepEqual([report.ended, report.removed, fake.killed], [[], [], []])
    assert.deepEqual(report.kept, [`${folder}: cannot confirm the recorded start time zone in ${file}; the folder and processes were left alone. Remove ${file} once no runner is running.`])
    assert.equal(await readFile(file, 'utf8'), original)
  }
  const fake = system([entry(9999, 'unrelated')])
  const report = await sweepOrphanedFirefoxes(root, fake)
  assert.deepEqual([report.ended, report.removed, fake.killed], [[], [folder], []])
  assert.equal(existsSync(folder), false)
})

test('an orphan identity comparison that spends the cleanup deadline authorises no signal', async (t) => {
  const { folder, command } = await launchFolder(true)
  let now = 0
  t.mock.method(performance, 'now', () => now)
  const current = entry(5001, command)
  const fresh = { ...current, get command() { now = 3000; return command } }
  const killed: number[] = []
  const report = await sweepOrphanedFirefoxes(root, {
    read: () => [current],
    readProcess: () => fresh,
    kill: (pid) => killed.push(pid),
  })
  assert.deepEqual(killed, [], 'the deadline is checked after comparison and immediately before the signal')
  assert.deepEqual(report.removed, [])
  assert.match(report.problems.join(' '), /cleanup deadline/)
  assert.equal(existsSync(folder), true)
})


test('a late orphan candidate snapshot authorises no folder release even when it shows the root gone', async (t) => {
  const { folder, command } = await launchFolder(true)
  let now = 0
  t.mock.method(performance, 'now', () => now)
  const current = entry(5001, command)
  let reads = 0
  const report = await sweepOrphanedFirefoxes(root, {
    read: () => { if (++reads === 1) return [current]; now = 3000; return [] },
    kill: () => assert.fail('no signal is authorised'),
  })
  assert.deepEqual(report.removed, [], 'absence read after the deadline is unconfirmed')
  assert.match(report.problems.join(' '), /cleanup deadline/)
  assert.equal(existsSync(folder), true)
})
