import type { TestContext } from 'node:test'
import type { OwnedProcessIdentity } from '../../src/shared/process-ownership.ts'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { sweepOrphanedFirefoxes } from '../../src/browser/firefox/orphans.ts'
import { ownerRecordFile } from '../../src/browser/firefox/profile.ts'
import { homeRecordFile } from '../../src/browser/webkit/process.ts'
import { sweepWebKitHomes } from '../../src/browser/webkit/sweep.ts'
import { takeInstallLock } from '../../src/cli/install/lock.ts'
import { readMachine } from '../../src/cli/install/process-start.ts'
import { takeDesktopLock } from '../../src/native/desktop-lock.ts'
import { readProcessTable, systemTools } from '../../src/native/processes.ts'
import { sweepOwnedFolders } from '../../src/native/temporary-folders.ts'
import { processRuns } from '../../src/runner/media-leftovers.ts'
import { tempProject } from '../support/project.ts'
import { newRunFolder } from '../support/run-harness.ts'
import { unpinnedMedia } from '../support/unpinned-host.ts'
import { fakeMediaStarter, recordProject } from './runner-recording-fakes.ts'

const desktopOnly = { skip: process.platform === 'darwin' ? false : 'the desktop kernel lock requires macOS' }

async function fixture(t: TestContext, gone: boolean): Promise<{ root: string; process: OwnedProcessIdentity }> {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'retest-record-recovery-'))
  const child = spawn('/bin/sleep', ['300'], { stdio: 'ignore' })
  const ended = once(child, 'exit')
  assert.ok(child.pid !== undefined)
  const identity = (await readProcessTable()).find(entry => entry.pid === child.pid)
  assert.ok(identity !== undefined)
  const end = async (): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) return
    const current = (await readProcessTable()).find(entry => entry.pid === identity.pid)
    assert.ok(current !== undefined && current.startedAt === identity.startedAt && current.command === identity.command)
    child.kill('SIGTERM')
    await ended
  }
  t.after(async () => { await end(); await rm(root, { recursive: true, force: true }) })
  if (gone) await end()
  return { root, process: identity }
}

for (const marker of [undefined, 1, 2]) {
  test(`desktop record version ${String(marker)} with an absent holder is replaced with a current record`, desktopOnly, async t => {
    const { root, process: identity } = await fixture(t, true)
    const path = join(root, 'desktop.lock')
    const file = join(root, 'desktop.json')
    await writeFile(file, JSON.stringify({ startTimeVersion: marker, pid: identity.pid, startedAt: new Date().toISOString(), holderStartedAt: 'old-zone start', holderCommand: identity.command, runnerApps: [] }))
    const taken = await takeDesktopLock({ path, tools: systemTools })
    try {
      assert.equal(taken.ok, true, taken.ok ? '' : taken.failure.message)
      const record: unknown = JSON.parse(await readFile(file, 'utf8'))
      assert.ok(typeof record === 'object' && record !== null && 'startTimeVersion' in record && record.startTimeVersion === 1 && 'pid' in record && record.pid === globalThis.process.pid)
    } finally { if (taken.ok) await taken.lock.release() }
  })
}

for (const marker of [undefined, 1, 2]) {
  test(`desktop record version ${String(marker)} with a present mismatched holder is refused by file without replacing it`, desktopOnly, async t => {
    const { root, process: identity } = await fixture(t, false)
    const path = join(root, 'desktop.lock')
    const file = join(root, 'desktop.json')
    const original = JSON.stringify({ startTimeVersion: marker, pid: identity.pid, startedAt: new Date().toISOString(), holderStartedAt: 'old-zone start', holderCommand: identity.command, runnerApps: [] })
    await writeFile(file, original)
    const taken = await takeDesktopLock({ path, tools: systemTools })
    try {
      assert.equal(taken.ok, false)
      if (!taken.ok) {
        assert.ok(taken.failure.message.includes(file))
        assert.match(taken.failure.message, /Remove .*once no runner is running/)
        if (marker !== 1) assert.match(taken.failure.message, /cannot confirm.*time zone/)
      }
      assert.equal(await readFile(file, 'utf8'), original)
    } finally { if (taken.ok) await taken.lock.release() }
  })
}

test('a legacy desktop record keeps a present runner even when its holder is absent', desktopOnly, async t => {
  const holder = await fixture(t, true)
  const runner = await fixture(t, false)
  const path = join(holder.root, 'desktop.lock')
  const file = join(holder.root, 'desktop.json')
  const original = JSON.stringify({ pid: holder.process.pid, startedAt: new Date().toISOString(), holderCommand: holder.process.command, holderStartedAt: holder.process.startedAt, runnerApps: [{ pid: runner.process.pid, command: runner.process.command, startedAt: 'old-zone start' }] })
  await writeFile(file, original)
  const taken = await takeDesktopLock({ path, tools: systemTools })
  try {
    assert.equal(taken.ok, false)
    if (!taken.ok) assert.ok(taken.failure.message.includes(file))
    assert.equal(await readFile(file, 'utf8'), original)
  } finally { if (taken.ok) await taken.lock.release() }
})

for (const gone of [true, false]) {
  test(`legacy Firefox record whose recorded PIDs are ${gone ? 'absent is removed' : 'present is retained with its file'}`, async t => {
    const { root, process: identity } = await fixture(t, gone)
    const folder = join(root, `retest-firefox-${identity.pid}-legacy`)
    const file = join(folder, ownerRecordFile)
    await mkdir(join(folder, 'profile'), { recursive: true })
    await writeFile(file, JSON.stringify({ version: 1, owner: { pid: identity.pid, startedAt: 'old-zone start', command: identity.command }, firefox: { pid: identity.pid, startedAt: 'old-zone start', command: identity.command, route: 'spawn' }, profile: join(folder, 'profile') }))
    const signals: number[] = []
    const report = await sweepOrphanedFirefoxes(root, { read: readProcessTable, kill: pid => { signals.push(pid) } })
    assert.deepEqual(signals, [])
    assert.equal(existsSync(folder), !gone)
    if (gone) assert.deepEqual(report.removed, [folder])
    else { assert.ok(report.kept.join(' ').includes(file)); assert.match(report.kept.join(' '), /once no runner is running/) }
  })
  test(`legacy WebKit record whose recorded PIDs are ${gone ? 'absent is removed' : 'present is retained with its file'}`, async t => {
    const { root, process: identity } = await fixture(t, gone)
    const folder = join(root, `retest-webkit-${identity.pid}-legacy`)
    const file = join(folder, homeRecordFile)
    await mkdir(folder)
    await writeFile(file, JSON.stringify({ version: 1, path: folder, launcher: { pid: identity.pid, startedAt: 'old-zone start' }, processes: [] }))
    const notes = await sweepWebKitHomes(root)
    assert.equal(existsSync(folder), !gone)
    if (!gone) { assert.ok(notes.join(' ').includes(file)); assert.match(notes.join(' '), /once no runner is running/) }
  })
  test(`legacy native folder record whose PID is ${gone ? 'absent is removed' : 'present is retained with its file'}`, async t => {
    const { root, process: identity } = await fixture(t, gone)
    const folder = join(root, 'retest-executor-legacy')
    const file = join(folder, 'retest-owner.json')
    await mkdir(folder)
    await writeFile(file, JSON.stringify({ pid: identity.pid, startedAt: 'old-zone start' }))
    const report = await sweepOwnedFolders(systemTools, root)
    assert.equal(existsSync(folder), !gone)
    if (gone) assert.deepEqual(report.removed, [folder])
    else { assert.ok(report.problems.join(' ').includes(file)); assert.match(report.problems.join(' '), /once no runner is running/) }
  })
  test(`legacy media owner whose PID is ${gone ? 'absent is gone' : 'present stays unconfirmed'}`, async t => {
    const { process: identity } = await fixture(t, gone)
    assert.equal(await processRuns({ pid: identity.pid, startedAt: 'old-zone start' }), gone ? false : undefined)
  })
  test(`legacy local install generation whose PID is ${gone ? 'absent is passed over' : 'present is refused by file'}`, async t => {
    const { root, process: identity } = await fixture(t, gone)
    const machine = await readMachine({ platform: process.platform })
    assert.ok(machine.ok)
    const folder = join(root, 'install.lock')
    const file = join(folder, '1.json')
    await mkdir(folder)
    const original = JSON.stringify({ version: 1, token: 'legacy', machine: machine.machine.id, host: machine.machine.host, pid: identity.pid, start: 123456, since: new Date().toISOString(), command: identity.command })
    await writeFile(file, original)
    const taken = await takeInstallLock(folder)
    try {
      assert.equal(taken.ok, gone, taken.ok ? '' : taken.message)
      if (gone) assert.ok(existsSync(join(folder, '2.json')))
      else { assert.ok(!taken.ok && taken.message.includes(file)); assert.equal(await readFile(file, 'utf8'), original) }
    } finally { if (taken.ok) await taken.release() }
  })
}

for (const reader of ['native', 'firefox', 'webkit', 'media', 'install'] as const) {
  test(`current ${reader} record with a present PID and mismatched start cannot free anything`, async t => {
    const { root, process: identity } = await fixture(t, false)
    if (reader === 'media') {
      assert.equal(await processRuns({ startTimeVersion: 1, pid: identity.pid, startedAt: 'mismatched start' }), undefined)
      return
    }
    if (reader === 'install') {
      const machine = await readMachine({ platform: process.platform })
      assert.ok(machine.ok)
      const path = join(root, 'install.lock')
      await mkdir(path)
      await writeFile(join(path, '1.json'), JSON.stringify({ version: 2, token: 'current', machine: machine.machine.id, host: machine.machine.host, pid: identity.pid, start: { clock: 'utc-seconds', value: 1 }, since: new Date().toISOString(), command: identity.command }))
      const taken = await takeInstallLock(path)
      try { assert.equal(taken.ok, false) } finally { if (taken.ok) await taken.release() }
      assert.ok(!existsSync(join(path, '2.json')))
      return
    }
    const path = join(root, reader === 'native' ? 'retest-executor-current' : `retest-${reader}-${identity.pid}-current`)
    await mkdir(path)
    if (reader === 'native') {
      await writeFile(join(path, 'retest-owner.json'), JSON.stringify({ startTimeVersion: 1, pid: identity.pid, startedAt: 'mismatched start' }))
      assert.deepEqual((await sweepOwnedFolders(systemTools, root)).removed, [])
    } else if (reader === 'firefox') {
      const signals: number[] = []
      await writeFile(join(path, ownerRecordFile), JSON.stringify({ version: 1, startTimeVersion: 1, owner: { pid: identity.pid, startedAt: 'mismatched start', command: identity.command }, firefox: { pid: identity.pid, startedAt: identity.startedAt, command: identity.command, route: 'spawn' }, profile: join(path, 'profile') }))
      const report = await sweepOrphanedFirefoxes(root, { read: readProcessTable, kill: pid => { signals.push(pid); throw new Error('no fixture signal is permitted') } })
      assert.deepEqual(signals, [])
      assert.deepEqual(report.removed, [])
    } else {
      await writeFile(join(path, homeRecordFile), JSON.stringify({ version: 1, startTimeVersion: 1, path, launcher: { pid: identity.pid, startedAt: 'mismatched start' }, processes: [] }))
      await sweepWebKitHomes(root)
    }
    assert.ok(existsSync(path))
  })
}

for (const gone of [true, false]) {
  test(`pre-machine-tag local install generation with a string start and ${gone ? 'absent' : 'present'} PID follows the absence rule`, async t => {
    const { root, process: identity } = await fixture(t, gone)
    const folder = join(root, 'install.lock')
    const file = join(folder, '1.json')
    await mkdir(folder)
    await writeFile(file, JSON.stringify({ version: 1, token: 'legacy-local', pid: identity.pid, startedAt: 'old-zone start', command: identity.command }))
    const taken = await takeInstallLock(folder)
    try {
      assert.equal(taken.ok, gone)
      if (!gone) assert.ok(!taken.ok && taken.message.includes(file))
      else assert.ok(existsSync(join(folder, '2.json')))
    } finally { if (taken.ok) await taken.release() }
  })
}

test('an absent foreign install holder is never treated as a gone local holder', async t => {
  const { root, process: identity } = await fixture(t, true)
  const folder = join(root, 'install.lock')
  await mkdir(folder)
  await writeFile(join(folder, '1.json'), JSON.stringify({ version: 1, token: 'foreign', machine: 'another boot namespace', host: 'another host', pid: identity.pid, start: 'old-zone start', command: identity.command }))
  const taken = await takeInstallLock(folder)
  try { assert.equal(taken.ok, false) } finally { if (taken.ok) await taken.release() }
  assert.ok(!existsSync(join(folder, '2.json')))
})

test('a media sweep refuses a present legacy owner by its exact events file and safe removal condition', { skip: unpinnedMedia }, async () => {
  const root = tempProject({
    'retest.config.ts': `import { chromium, defineConfig } from '@rehearsal-labs/retest'; export default defineConfig({apps:{web:chromium({baseUrl:'http://127.0.0.1:4173',executablePath:'/fake/chrome'})},recording:{record:true}})`,
    'tests/one.retest.ts': `import { expect,test } from '@rehearsal-labs/retest'; test('one', async({page})=>{await page.goto('/');await expect(page.getByTestId('save-task')).toBeVisible()})`,
  })
  const previous = await recordProject(root, { files: ['tests/one.retest.ts'], startMedia: fakeMediaStarter().start })
  const current = newRunFolder()
  const old = join(dirname(current), 'legacy')
  renameSync(previous.folder, old)
  rmSync(join(old, 'result.json'))
  const original = previous.events.map(event => JSON.stringify(event.type === 'media.started' ? { ...event, media: { ...event.media, owner: { pid: process.pid, startedAt: 'old-zone start' } } } : event)).join('\n') + '\n'
  const file = join(old, 'events.jsonl')
  writeFileSync(file, original)
  const fake = fakeMediaStarter()
  const run = await recordProject(root, { files: ['tests/one.retest.ts'], startMedia: fake.start, folder: current })
  assert.deepEqual(fake.started[0]?.leftoverRequests, [])
  const notes = run.events.filter(event => event.type === 'media.leftovers')
  assert.equal(notes.length, 1)
  assert.equal(notes[0]?.status, 'unconfirmed')
  assert.ok(notes[0]?.problem?.includes(file))
  assert.match(notes[0]?.problem ?? '', /Remove .*once no runner is running/)
  assert.equal(readFileSync(file, 'utf8'), original)
})
