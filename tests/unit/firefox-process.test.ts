import type { OwnedProcessIdentity, ProcessOwnershipSystem } from '../../src/shared/process-ownership.ts'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { FirefoxProcess, programName } from '../../src/browser/firefox/process.ts'
import { OwnedProcessGroup } from '../../src/shared/process-ownership.ts'
import { unixOnly } from '../support/platform-skip.ts'

test('an awaited asynchronous Firefox ownership reading completes in a standalone process with no other live handle', { skip: unixOnly('this reading is ps, which Windows does not have; process-supervisor.test.ts makes the same promise of a job reading') }, async () => {
  const module = new URL('../../src/browser/firefox/process-table.ts', import.meta.url).href
  const source = `import { readProcessTableAsync } from ${JSON.stringify(module)}; const entries = await readProcessTableAsync(); process.stdout.write(String(entries.length > 0))`
  const result = await promisify(execFile)(process.execPath, ['--conditions=retest-source', '--input-type=module', '-e', source])
  assert.equal(result.stdout, 'true')
  assert.equal(result.stderr, '')
})

// Review F-6: on the Launch Services route a synchronous `ps` of the whole machine ran every 100 ms for the life of
// each Firefox, holding the thread the BiDi connection and every deadline run on for tens of milliseconds each time.
// The process now looks rarely, without holding the thread, and often only once its connection ended.

const firefoxPid = 4242
const startedAt = 'Mon Oct  5 10:00:00 2026'
const firefoxEntry: OwnedProcessIdentity = { pid: firefoxPid, parentPid: 1, groupId: firefoxPid, startedAt, command: '/Applications/Firefox.app/Contents/MacOS/firefox --profile /p', state: 'S' }
const launchd: OwnedProcessIdentity = { pid: 1, parentPid: 0, groupId: 1, startedAt, command: '/sbin/launchd', state: 'Ss' }

test('a deliberate Firefox crash refuses a reused pid after checking its recorded start identity', async () => {
  let current: OwnedProcessIdentity | undefined = firefoxEntry
  const signals: number[] = []
  const entries = (): OwnedProcessIdentity[] => [launchd, ...(current === undefined ? [] : [current])]
  const ownership = new OwnedProcessGroup(firefoxPid, 1, {
    read: entries,
    readProcess: (pid) => current?.pid === pid ? current : undefined,
    signal: (pid) => { signals.push(pid) },
  })
  assert.deepEqual(ownership.capture(), [])
  const folder = await mkdtemp(join(tmpdir(), 'retest-firefox-crash-'))
  const firefox = new FirefoxProcess({ pid: firefoxPid, route: 'launch-services', folder, profile: join(folder, 'profile'), ownership, child: undefined, output: Promise.resolve([]), table: { readAsync: async () => entries() } })
  current = { ...firefoxEntry, startedAt: 'a different recorded start' }
  await assert.rejects(firefox.crash(), /different identity/)
  assert.deepEqual(signals, [], 'a numeric pid alone never grants signal authority')
  current = undefined
  firefox.expectExit()
  await firefox.exited
  assert.deepEqual(await firefox.stop(0), [])
})

test('a deliberate Firefox crash records newly started content before ending the verified browser first', async (t) => {
  const helper = { ...firefoxEntry, pid: firefoxPid + 1, parentPid: firefoxPid, command: 'firefox content process' }
  const alive = new Map([firefoxEntry].map((entry) => [entry.pid, entry]))
  const signals: number[] = []
  let lastRead: number | undefined
  const entries = (): OwnedProcessIdentity[] => [launchd, ...alive.values()]
  const signal = (pid: number, sent: NodeJS.Signals | 0): true => {
    assert.equal(lastRead, pid, 'each signal immediately follows the recorded pid identity check')
    const entry = alive.get(pid)
    if (entry !== undefined && sent === 'SIGSTOP') { alive.set(pid, { ...entry, state: 'T' }); return true }
    if (entry !== undefined && sent === 'SIGCONT') { alive.set(pid, { ...entry, state: 'S' }); return true }
    assert.equal(sent, 'SIGKILL')
    signals.push(pid)
    alive.delete(pid)
    if (pid === firefoxPid) alive.set(helper.pid, { ...helper, parentPid: 1 })
    return true
  }
  const ownership = new OwnedProcessGroup(firefoxPid, 1, {
    read: entries,
    readProcess: (pid) => { lastRead = pid; return alive.get(pid) },
    signal,
  })
  assert.deepEqual(ownership.capture(), [])
  const folder = await mkdtemp(join(tmpdir(), 'retest-firefox-crash-order-'))
  const firefox = new FirefoxProcess({ pid: firefoxPid, route: 'launch-services', folder, profile: join(folder, 'profile'), ownership, child: undefined, output: Promise.resolve([]), table: { readAsync: async () => entries() } })
  t.after(async () => { alive.clear(); firefox.expectExit(); await firefox.exited; await firefox.stop(0) })
  t.mock.method(process, 'kill', (pid: number, sent?: string | number) => {
    assert.equal(sent, 'SIGKILL')
    return signal(pid, sent)
  })
  alive.set(helper.pid, helper)
  await firefox.crash()
  assert.deepEqual(signals, [firefoxPid, helper.pid], 'content cannot answer a lost-input error before the browser is ended')
})

test('a crash stops process creation before recording and killing a late Firefox helper', async (t) => {
  const helper = { ...firefoxEntry, pid: firefoxPid + 1, parentPid: firefoxPid, command: 'firefox content process' }
  const alive = new Map([firefoxEntry].map(entry => [entry.pid, entry]))
  const signals: { pid: number; signal: NodeJS.Signals | 0 }[] = []
  let spawned = false
  let lastRead: number | undefined
  const entries = (): OwnedProcessIdentity[] => [launchd, ...alive.values()]
  const signal = (pid: number, sent: NodeJS.Signals | 0): true => {
    assert.equal(lastRead, pid, 'each signal follows a fresh identity check')
    signals.push({ pid, signal: sent })
    const entry = alive.get(pid)
    if (entry !== undefined && sent === 'SIGSTOP') alive.set(pid, { ...entry, state: 'T' })
    if (entry !== undefined && sent === 'SIGCONT') alive.set(pid, { ...entry, state: 'S' })
    if (sent === 'SIGKILL') {
      alive.delete(pid)
      const remaining = alive.get(helper.pid)
      if (pid === firefoxPid && remaining !== undefined) alive.set(helper.pid, { ...remaining, parentPid: 1 })
    }
    return true
  }
  const ownership = new OwnedProcessGroup(firefoxPid, 1, { read: entries, readProcess: pid => {
    lastRead = pid
    if (pid === firefoxPid && !spawned) { spawned = true; alive.set(helper.pid, helper) }
    return alive.get(pid)
  }, signal })
  assert.deepEqual(ownership.capture(), [])
  const folder = await mkdtemp(join(tmpdir(), 'retest-firefox-late-fork-'))
  const firefox = new FirefoxProcess({ pid: firefoxPid, route: 'launch-services', folder, profile: join(folder, 'profile'), ownership, child: undefined, output: Promise.resolve([]), table: { readAsync: async () => entries() } })
  t.after(async () => { alive.clear(); firefox.expectExit(); await firefox.exited; await firefox.stop(0) })
  t.mock.method(process, 'kill', (pid: number, sent?: string | number) => {
    assert.ok(sent === 'SIGKILL' || sent === 'SIGSTOP' || sent === 'SIGCONT')
    return signal(pid, sent)
  })
  await firefox.crash()
  assert.deepEqual(signals.filter(entry => entry.signal === 'SIGKILL').map(entry => entry.pid), [firefoxPid, helper.pid])
  assert.deepEqual([...alive.values()], [])
})

test('a crash whose stopped-state reading fails resumes its verified Firefox without killing it', async (t) => {
  let current: OwnedProcessIdentity | undefined = firefoxEntry
  const sent: (NodeJS.Signals | 0)[] = []
  const entries = (): OwnedProcessIdentity[] => [launchd, ...(current === undefined ? [] : [current])]
  const signal = (pid: number, value: NodeJS.Signals | 0): true => {
    assert.equal(pid, firefoxPid)
    sent.push(value)
    if (current !== undefined) current = { ...current, state: value === 'SIGSTOP' ? 'T' : 'S' }
    return true
  }
  const ownership = new OwnedProcessGroup(firefoxPid, 1, { read: entries, readProcess: pid => current?.pid === pid ? current : undefined, signal })
  assert.deepEqual(ownership.capture(), [])
  const folder = await mkdtemp(join(tmpdir(), 'retest-firefox-crash-read-failed-'))
  const firefox = new FirefoxProcess({ pid: firefoxPid, route: 'launch-services', folder, profile: join(folder, 'profile'), ownership, child: undefined, output: Promise.resolve([]), table: { readAsync: async () => { throw new Error('host state unavailable') }, watchAsync: async () => entries() } })
  t.after(async () => { current = undefined; firefox.expectExit(); await firefox.exited; await firefox.stop(0) })
  t.mock.method(process, 'kill', (pid: number, value?: string | number) => {
    assert.ok(value === 'SIGSTOP' || value === 'SIGCONT' || value === 'SIGKILL')
    return signal(pid, value)
  })
  await assert.rejects(firefox.crash(), /host state unavailable/)
  assert.deepEqual(sent, ['SIGSTOP', 'SIGCONT'])
  assert.equal(current?.state, 'S')
})

test('a Firefox helper first seen after its parent exited is left alone and its refusal settles once the whole group is confirmed absent', async () => {
  const { ChildProcess } = await import('node:child_process')
  const child = new ChildProcess()
  Object.defineProperty(child, 'pid', { value: firefoxPid })
  let entries: OwnedProcessIdentity[] = [firefoxEntry]
  const signals: number[] = []
  const ownership = new OwnedProcessGroup(firefoxPid, 1, {
    read: () => entries,
    readAsync: async () => entries,
    signal: (pid) => { signals.push(pid) },
  })
  assert.deepEqual(ownership.capture(), [])
  const folder = await mkdtemp(join(tmpdir(), 'retest-firefox-orphan-ended-'))
  const firefox = new FirefoxProcess({ pid: firefoxPid, route: 'spawn', folder, profile: join(folder, 'profile'), ownership, child, output: Promise.resolve([]) })
  entries = [{ ...firefoxEntry, pid: firefoxPid + 1, parentPid: 1, command: 'unrecorded Firefox helper' }]
  child.emit('exit', null, 'SIGKILL')
  await firefox.recordDescendants()
  entries = []
  assert.deepEqual(await firefox.stop(0), [], 'a fresh empty group settles the earlier unverified-member refusal')
  assert.deepEqual(signals, [], 'no signal was sent to the helper whose launch could not be traced')
})

// The output's bound follows the launch's confirmed end, as a Chromium browser's does: on a busy host the output of a
// Firefox shown ended can still be open past its close bound, held by a process outside the launch, or still being
// written to the log by Retest itself.
for (const [held, name] of [[true, 'a process outside it still holds its output open, which Retest then reads no further'], [false, "Retest's own writing of its output outlasts the output's close bound"]] as const) {
  test(`a Firefox shown ended stops clean when ${name}`, async () => {
    const { ChildProcess } = await import('node:child_process')
    const child = new ChildProcess()
    Object.defineProperty(child, 'pid', { value: firefoxPid })
    let entries: OwnedProcessIdentity[] = [firefoxEntry]
    const ownership = new OwnedProcessGroup(firefoxPid, 1, { read: () => entries, readAsync: async () => entries, signal: () => {} })
    assert.deepEqual(ownership.capture(), [])
    const folder = await mkdtemp(join(tmpdir(), 'retest-firefox-output-'))
    const output = Promise.withResolvers<string[]>()
    let finished = 0
    const finishOutput = (): void => {
      finished += 1
      output.resolve([])
    }
    const firefox = new FirefoxProcess({ pid: firefoxPid, route: 'spawn', folder, profile: join(folder, 'profile'), ownership, child, output: output.promise, cancelOutput: () => output.resolve(['cancelled']), finishOutput, outputWritersRemain: () => held })
    entries = []
    child.emit('exit', 0, null)
    if (!held) setTimeout(() => output.resolve([]), 1500)
    assert.deepEqual(await firefox.stop(0), [])
    assert.equal(finished, held ? 1 : 0, held ? 'the output is read no further once nothing of the launch is left' : 'the output closed by itself')
  })
}

test('a process left running is named by its program: the image a Windows reading gives, spaces and all, or the first part of a command line', () => {
  assert.equal(programName('C:\\Program Files\\Mozilla Firefox\\firefox.exe'), 'firefox.exe')
  assert.equal(programName('C:\\PROGRA~1\\MOZILL~1\\firefox.exe'), 'firefox.exe')
  assert.equal(programName('\\\\?\\C:\\Program Files\\Mozilla Firefox\\plugin-container.exe'), 'plugin-container.exe')
  assert.equal(programName('/Applications/Firefox.app/Contents/MacOS/plugin-container -contentproc 7 tab'), 'plugin-container')
  assert.equal(programName('"C:\\Program Files\\Mozilla Firefox\\firefox.exe" -contentproc 7 tab'), 'firefox.exe')
  assert.equal(programName('(unreadable)'), '(unreadable)')
})

test('what Firefox leaves after its main process exited is waited for a bounded time, then named, never waited for without end', async () => {
  const { ChildProcess } = await import('node:child_process')
  const child = new ChildProcess()
  Object.defineProperty(child, 'pid', { value: firefoxPid })
  const helper: OwnedProcessIdentity = { ...firefoxEntry, pid: firefoxPid + 1, parentPid: firefoxPid, command: '/Applications/Firefox.app/Contents/MacOS/plugin-container -contentproc 7 tab' }
  let entries: OwnedProcessIdentity[] = [firefoxEntry, helper]
  const ownership = new OwnedProcessGroup(firefoxPid, 1, { read: () => entries, readAsync: async () => entries, signal: () => {} })
  assert.deepEqual(ownership.capture(), [])
  const folder = await mkdtemp(join(tmpdir(), 'retest-firefox-left-'))
  const firefox = new FirefoxProcess({ pid: firefoxPid, route: 'spawn', folder, profile: join(folder, 'profile'), ownership, child, output: Promise.resolve([]) })
  entries = [helper]
  const started = performance.now()
  child.emit('exit', null, 'SIGKILL')
  await assert.rejects(firefox.gone(), { message: `Firefox process ${helper.pid} (plugin-container) is still running 5 seconds after Firefox ${firefoxPid} exited.` })
  const waited = performance.now() - started
  assert.ok(waited >= 4900 && waited < 8000, `the bound is the one Chromium's group gets: ${Math.round(waited)} ms`)
  entries = []
})

// Once the main process exits, a look either shows what is left or fails; a process is named as still running only once
// a look showed it, and looks that all failed say only that Retest could not look. After the exit, the first
// reading records what the main process left and the waiting ones follow; `succeed` readings show the helper.
test('what Firefox leaves is named only from a reading that showed it, and readings that failed say so', async () => {
  const { ChildProcess } = await import('node:child_process')
  const helper: OwnedProcessIdentity = { ...firefoxEntry, pid: firefoxPid + 1, parentPid: firefoxPid, command: '/Applications/Firefox.app/Contents/MacOS/plugin-container -contentproc 7 tab' }
  const said = await Promise.all([0, 2].map(async (succeed) => {
    const child = new ChildProcess()
    Object.defineProperty(child, 'pid', { value: firefoxPid })
    let exited = false
    let readings = 0
    const read = (): OwnedProcessIdentity[] => {
      if (!exited) return [firefoxEntry, helper]
      readings += 1
      if (readings <= succeed) return [helper]
      throw new Error('The metadata process could not run (ENOENT).')
    }
    const ownership = new OwnedProcessGroup(firefoxPid, 1, { read, readAsync: async () => read(), signal: () => {} })
    assert.deepEqual(ownership.capture(), [])
    const folder = await mkdtemp(join(tmpdir(), 'retest-firefox-unread-'))
    const firefox = new FirefoxProcess({ pid: firefoxPid, route: 'spawn', folder, profile: join(folder, 'profile'), ownership, child, output: Promise.resolve([]) })
    exited = true
    child.emit('exit', null, 'SIGKILL')
    return firefox.gone().then(() => 'settled', (error: unknown) => (error instanceof Error ? error.message : String(error)))
  }))
  assert.deepEqual(said, [
    `Retest could not look for what Firefox ${firefoxPid} left running after it exited.`,
    `Firefox process ${helper.pid} (plugin-container) was still running when Retest could last look.`,
  ])
})

/** A machine whose Firefox is alive until `end()`, counting how often each kind of reading was taken. */
function machine() {
  let alive = true
  const counts = { synchronous: 0, asynchronous: 0 }
  const entries = (): OwnedProcessIdentity[] => (alive ? [launchd, firefoxEntry] : [launchd])
  const system: ProcessOwnershipSystem = {
    read: () => {
      counts.synchronous += 1
      return entries()
    },
    signal: () => {},
  }
  const table = {
    readAsync: async () => {
      counts.asynchronous += 1
      return entries()
    },
  }
  return { system, table, counts, end: () => (alive = false), get alive() { return alive } }
}

test('a Firefox started through Launch Services is watched without holding the thread, rarely while its connection stands and at once when it ends', async (t) => {
  const host = machine()
  const ownership = new OwnedProcessGroup(firefoxPid, 1, host.system)
  assert.deepEqual(ownership.capture(), [], 'the launch claims the process, which is the one reading a launch takes')
  const claimed = host.counts.synchronous
  const folder = await mkdtemp(join(tmpdir(), 'retest-firefox-process-'))
  const firefox = new FirefoxProcess({ pid: firefoxPid, route: 'launch-services', folder, profile: join(folder, 'profile'), ownership, child: undefined, output: Promise.resolve([]), table: host.table })
  let exited = false
  void firefox.exited.then(() => (exited = true))
  await new Promise((resolve) => setTimeout(resolve, 600))
  assert.equal(exited, false, 'a Firefox the table shows is not taken for gone')
  assert.equal(host.counts.synchronous, claimed, 'no synchronous reading while Firefox is alive')
  assert.ok(host.counts.asynchronous <= 1, `one look in the first 600 ms, not one every 100 ms: ${host.counts.asynchronous}`)

  host.end()
  const endedAt = performance.now()
  firefox.expectExit()
  await firefox.exited
  assert.ok(performance.now() - endedAt < 300, 'the end of the connection has the process looked for at once')
  assert.equal(firefox.mainGone, true)
  await firefox.gone()
  t.diagnostic(`readings: ${JSON.stringify(host.counts)}`)
  assert.deepEqual(await firefox.stop(0), [], 'a Firefox that went leaves nothing to clean up')
})

test('a Launch Services Firefox whose pid the system gave to another process is seen gone, by its recorded start time', async () => {
  let entries: OwnedProcessIdentity[] = [launchd, firefoxEntry]
  const ownership = new OwnedProcessGroup(firefoxPid, 1, { read: () => entries, signal: () => {} })
  assert.deepEqual(ownership.capture(), [])
  const folder = await mkdtemp(join(tmpdir(), 'retest-firefox-reused-'))
  const firefox = new FirefoxProcess({ pid: firefoxPid, route: 'launch-services', folder, profile: join(folder, 'profile'), ownership, child: undefined, output: Promise.resolve([]), table: { readAsync: async () => entries, watchAsync: async () => entries }, startedAt })
  // Firefox exits, and the system starts another process under the same pid.
  entries = [launchd, { ...firefoxEntry, startedAt: 'Mon Oct  5 10:05:00 2026', command: '/usr/bin/other' }]
  firefox.expectExit()
  const seen = await Promise.race([firefox.exited.then(() => 'gone'), new Promise((resolve) => setTimeout(() => resolve('still watched'), 1000))])
  assert.equal(seen, 'gone')
})

test('Firefox cleanup prunes 100 dead helpers with an asynchronous table and reads only the live root before its signal', async () => {
  const { ChildProcess } = await import('node:child_process')
  const child = new ChildProcess()
  Object.defineProperty(child, 'pid', { value: firefoxPid })
  let entries: OwnedProcessIdentity[] = [firefoxEntry, ...Array.from({ length: 100 }, (_, index) => ({ ...firefoxEntry, pid: 5000 + index, parentPid: firefoxPid, command: `/owned/helper-${index}` }))]
  const calls: string[] = []
  let cleaning = false
  const ownership = new OwnedProcessGroup(firefoxPid, 1, {
    read: () => { if (cleaning) throw new Error('cleanup used a synchronous table'); return entries },
    readAsync: async () => { calls.push('table'); return entries },
    readProcess: () => { throw new Error('cleanup used a synchronous identity') },
    readProcessAsync: async (pid) => { calls.push(`identity ${pid}`); return entries.find((entry) => entry.pid === pid) },
    signal: (pid) => { calls.push(`signal ${pid}`); entries = []; child.emit('exit', null, 'SIGKILL') },
  })
  assert.deepEqual(ownership.capture(), [])
  const folder = await mkdtemp(join(tmpdir(), 'retest-firefox-history-'))
  const before = new Set(process.listeners('exit'))
  const firefox = new FirefoxProcess({ pid: firefoxPid, route: 'spawn', folder, profile: join(folder, 'profile'), ownership, child, output: Promise.resolve([]) })
  entries = [firefoxEntry]
  cleaning = true
  try {
    assert.deepEqual(await firefox.stop(0), [])
    assert.deepEqual(calls.filter((call) => call.startsWith('identity')), [`identity ${firefoxPid}`])
    assert.deepEqual(calls.filter((call) => call.startsWith('signal')), [`signal ${firefoxPid}`])
    const signalAt = calls.indexOf(`signal ${firefoxPid}`)
    assert.equal(calls[signalAt - 1], `identity ${firefoxPid}`)
    assert.deepEqual(calls.slice(signalAt - 2, signalAt + 1), ['table', `identity ${firefoxPid}`, `signal ${firefoxPid}`])
  } finally {
    cleaning = false
    entries = []
    for (const hook of process.listeners('exit')) if (!before.has(hook)) process.off('exit', hook)
    const { rm } = await import('node:fs/promises')
    await rm(folder, { recursive: true, force: true })
  }
})
