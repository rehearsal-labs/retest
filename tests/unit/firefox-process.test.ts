import type { OwnedProcessIdentity, ProcessOwnershipSystem } from '../../src/shared/process-ownership.ts'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { FirefoxProcess } from '../../src/browser/firefox/process.ts'
import { OwnedProcessGroup } from '../../src/shared/process-ownership.ts'

test('an awaited asynchronous Firefox ownership reading completes in a standalone process with no other live handle', async () => {
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
  assert.throws(() => firefox.crash(), /different identity/)
  assert.deepEqual(signals, [], 'a numeric pid alone never grants signal authority')
  current = undefined
  firefox.expectExit()
  await firefox.exited
  assert.deepEqual(await firefox.stop(0), [])
})

test('a deliberate Firefox crash ends the verified browser before its recorded content processes', async (t) => {
  const helper = { ...firefoxEntry, pid: firefoxPid + 1, parentPid: firefoxPid, command: 'firefox content process' }
  const alive = new Map([firefoxEntry, helper].map((entry) => [entry.pid, entry]))
  const signals: number[] = []
  let lastRead: number | undefined
  const entries = (): OwnedProcessIdentity[] => [launchd, ...alive.values()]
  const signal = (pid: number): true => {
    assert.equal(lastRead, pid, 'each signal immediately follows the recorded pid identity check')
    signals.push(pid)
    alive.delete(pid)
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
    return signal(pid)
  })
  firefox.crash()
  assert.deepEqual(signals, [firefoxPid, helper.pid], 'content cannot answer a lost-input error before the browser is ended')
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
