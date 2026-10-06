import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { sweepOrphanedFirefoxes } from '../../src/browser/firefox/orphans.ts'
import { readProcessTableAsync } from '../../src/browser/firefox/process-table.ts'
import { ownerRecordFile } from '../../src/browser/firefox/profile.ts'
import { sweepWebKitHomes } from '../../src/browser/webkit/sweep.ts'
import { homeRecordFile } from '../../src/browser/webkit/process.ts'
import { takeInstallLock } from '../../src/cli/install/lock.ts'
import { takeDesktopLock } from '../../src/native/desktop-lock.ts'
import { systemTools } from '../../src/native/processes.ts'
import { sweepOwnedFolders } from '../../src/native/temporary-folders.ts'
import { processRuns } from '../../src/runner/media-leftovers.ts'

async function fixture(t: TestContext): Promise<{ root: string; pid: number; localStart: string; stop: () => Promise<void> }> {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'retest-zone-record-'))
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { env: { PATH: process.env['PATH'], TZ: 'Etc/GMT+12' }, stdio: 'ignore' })
  const ended = once(child, 'exit')
  const stop = async (): Promise<void> => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await ended
  }
  t.after(async () => {
    await stop()
    await rm(root, { recursive: true, force: true })
  })
  assert.ok(child.pid !== undefined)
  const reading = spawnSync('/bin/ps', ['-o', 'lstart=', '-p', String(child.pid)], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', TZ: 'Etc/GMT+12' } })
  assert.equal(reading.status, 0)
  return { root, pid: child.pid, stop, localStart: reading.stdout.trim().replace(/\s+/g, ' ') }
}

test('a pre-change Firefox record cannot confirm a live launcher and never ends its recorded process', async (t) => {
  const { root, pid, localStart } = await fixture(t)
  const folder = join(root, `retest-firefox-${pid}-legacy`)
  await mkdir(join(folder, 'profile'), { recursive: true })
  const table = await readProcessTableAsync()
  const actual = table.find((entry) => entry.pid === pid)
  assert.ok(actual !== undefined)
  await writeFile(join(folder, ownerRecordFile), JSON.stringify({ version: 1, owner: { pid, startedAt: localStart, command: actual.command }, firefox: { pid, startedAt: actual.startedAt, command: actual.command, route: 'spawn' }, profile: join(folder, 'profile') }))
  const signals: number[] = []
  const report = await sweepOrphanedFirefoxes(root, { read: () => table, kill: (ended) => { signals.push(ended) } })
  assert.equal(signals.length, 0, 'no signal is issued for an unmarked start')
  assert.deepEqual(report.ended, [])
  assert.deepEqual(report.removed, [])
  assert.match(report.kept.join(' '), /cannot confirm.*time zone/)
  assert.ok(existsSync(folder))
  process.kill(pid, 0)
})

test('a complete pre-change Firefox record with both live identities in local time is unconfirmed', async (t) => {
  const launcher = await fixture(t)
  const firefox = await fixture(t)
  const folder = join(launcher.root, `retest-firefox-${launcher.pid}-local`)
  await mkdir(join(folder, 'profile'), { recursive: true })
  const table = await readProcessTableAsync()
  const owner = table.find(entry => entry.pid === launcher.pid)
  const browser = table.find(entry => entry.pid === firefox.pid)
  assert.ok(owner !== undefined && browser !== undefined)
  await writeFile(join(folder, ownerRecordFile), JSON.stringify({ version: 1, owner: { pid: launcher.pid, startedAt: launcher.localStart, command: owner.command }, firefox: { pid: firefox.pid, startedAt: firefox.localStart, command: browser.command, route: 'launch-services' }, profile: join(folder, 'profile') }))
  const signals: number[] = []
  const report = await sweepOrphanedFirefoxes(launcher.root, { read: () => table, kill: (pid) => { signals.push(pid) } })
  assert.deepEqual([signals, report.ended, report.removed], [[], [], []])
  assert.match(report.kept.join(' '), /cannot confirm.*time zone/)
  assert.ok(existsSync(folder))
  process.kill(launcher.pid, 0)
  process.kill(firefox.pid, 0)
})

test('a pre-change WebKit home stays whole even if its launcher is reported absent', async (t) => {
  const { root, pid, localStart } = await fixture(t)
  const path = join(root, `retest-webkit-${pid}-legacy`)
  await mkdir(path)
  const original = JSON.stringify({ version: 1, path, launcher: { pid, startedAt: localStart }, processes: [] })
  await writeFile(join(path, homeRecordFile), original)
  const notes = await sweepWebKitHomes(root, { startedAt: () => undefined })
  assert.match(notes.join(' '), /cannot confirm.*time zone/)
  assert.equal(await readFile(join(path, homeRecordFile), 'utf8'), original)
  process.kill(pid, 0)
})

test('a pre-change native folder owner cannot be mistaken for a gone live process', async (t) => {
  const { root, pid, localStart } = await fixture(t)
  const folder = join(root, 'retest-ios-legacy')
  await mkdir(folder)
  const original = JSON.stringify({ pid, startedAt: localStart })
  await writeFile(join(folder, 'retest-owner.json'), original)
  const report = await sweepOwnedFolders(systemTools, root)
  assert.deepEqual(report.removed, [])
  assert.equal(report.kept, 1)
  assert.match(report.problems.join(' '), /cannot confirm.*time zone/)
  assert.equal(await readFile(join(folder, 'retest-owner.json'), 'utf8'), original)
  process.kill(pid, 0)
})

test('a pre-change desktop record is refused and preserved before any start comparison', { skip: process.platform === 'darwin' ? false : 'the desktop kernel lock requires macOS' }, async (t) => {
  const { root, pid, localStart } = await fixture(t)
  const path = join(root, 'desktop.lock')
  const recordPath = join(root, 'desktop.json')
  const original = JSON.stringify({ pid, startedAt: new Date().toISOString(), holderStartedAt: localStart, holderCommand: 'node legacy-holder', runnerApps: [] })
  await writeFile(recordPath, original)
  const taken = await takeDesktopLock({ path, tools: systemTools })
  try {
    assert.equal(taken.ok, false)
    assert.match(taken.ok ? '' : taken.failure.message, /cannot confirm.*time zone/)
    assert.equal(await readFile(recordPath, 'utf8'), original)
    process.kill(pid, 0)
  } finally {
    if (taken.ok) await taken.lock.release()
  }
})

test('a pre-change media owner mark is unconfirmed even when its pid is live', async (t) => {
  const { pid, localStart } = await fixture(t)
  assert.equal(await processRuns({ pid, startedAt: localStart }), undefined)
  process.kill(pid, 0)
})

test('a live legacy install generation is refused by file and kept byte for byte, then replaced after whole-table absence', async (t) => {
  const { root, pid, localStart, stop } = await fixture(t)
  const path = join(root, 'install.lock')
  await mkdir(path)
  const original = JSON.stringify({ version: 1, token: 'legacy', pid, startedAt: localStart, command: 'node legacy-installer' })
  await writeFile(join(path, '1.json'), original)
  const taken = await takeInstallLock(path)
  try {
    assert.equal(taken.ok, false)
    const file = join(path, '1.json')
    assert.deepEqual(taken, { ok: false, message: `Retest cannot confirm the recorded start time zone in the install generation ${file}; pid ${pid} is present. Remove ${file} once no install of this build is running.` })
    assert.equal(await readFile(join(path, '1.json'), 'utf8'), original)
    process.kill(pid, 0)
  } finally {
    if (taken.ok) await taken.release()
  }
  await stop()
  const gone = await takeInstallLock(path)
  assert.ok(gone.ok, gone.ok ? '' : gone.message)
  if (gone.ok) await gone.release()
  assert.equal(await readFile(join(path, '1.json'), 'utf8'), original, 'the legacy generation stays while a new one replaces its ownership')
  assert.match(await readFile(join(path, '2.json'), 'utf8'), /"version":2/)
})
