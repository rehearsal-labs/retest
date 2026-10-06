import type { MetadataProcessOptions } from '../../src/shared/metadata-process.ts'
import type { OwnedProcessIdentity } from '../../src/shared/process-ownership.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mediaOwnershipSystem } from '../../src/media/client.ts'
import { Deadline } from '../../src/protocol/deadline.ts'
import { OwnedProcessGroup } from '../../src/shared/process-ownership.ts'

function machine() {
  const root: OwnedProcessIdentity = { pid: 8101, parentPid: process.pid, groupId: 8101, state: 'S', startedAt: 'Mon Oct  5 01:00:00 2026', command: '/owned/media' }
  let entries = [root, ...Array.from({ length: 100 }, (_, index) => ({ ...root, pid: 8200 + index, parentPid: root.pid, command: `/owned/helper-${index}` }))]
  let cleaning = false
  let fail: 'table' | 'identity' | undefined
  let reused = false
  let tableNext = false
  const calls: string[] = []
  const row = (entry: OwnedProcessIdentity): string => `${entry.pid} ${entry.parentPid} ${entry.groupId} ${entry.state} ${entry.startedAt} ${entry.command}`
  const sentinel = { ...root, pid: process.pid, command: '/reader' }
  const answer = (query: MetadataProcessOptions): string => {
    const list = query.args[1] === 'pid=,ppid=,pgid='
    if (list) { tableNext = true; calls.push('links'); return [...entries, sentinel].map((entry) => `${entry.pid} ${entry.parentPid} ${entry.groupId}`).join('\n') }
    const requested = (query.args[query.args.length - 1] ?? '').split(',').map(Number)
    const individual = !tableNext
    tableNext = false
    calls.push(individual ? `identity ${root.pid}` : 'table')
    if (fail === (individual ? 'identity' : 'table')) throw new Error('metadata reading failed')
    return [...entries.map((entry) => individual && reused && entry.pid === root.pid ? { ...entry, startedAt: 'Mon Oct  5 02:00:00 2026' } : entry), sentinel].filter((entry) => requested.includes(entry.pid)).map(row).join('\n')
  }
  const host = mediaOwnershipSystem(root.pid, {
    read: (query) => { if (cleaning) throw new Error('cleanup used synchronous metadata'); return answer(query) },
    readAsync: async (query) => answer(query),
  })
  const owner = new OwnedProcessGroup(root.pid, process.pid, { ...host, signal: (pid) => { calls.push(`signal ${pid}`) } })
  assert.deepEqual(owner.capture(), [])
  return { root, owner, calls, clean: () => { entries = [root]; cleaning = true; calls.length = 0 }, fail: (where: typeof fail) => { fail = where }, reuse: () => { reused = true } }
}

test('media cleanup prunes 100 dead helpers with one table snapshot and one asynchronous live-root identity reading', async () => {
  const host = machine()
  host.clean()
  const report = await host.owner.signalReportAsync('SIGKILL', new Deadline(1000))
  assert.deepEqual(report.problems, [])
  assert.deepEqual(report.identityRefusals, [])
  assert.deepEqual(host.calls, ['links', 'table', `identity ${host.root.pid}`, `signal ${host.root.pid}`], 'one selected table query and one fresh per-PID query, with no historical helper query')
})

test('a failed media snapshot authorises neither an individual reading nor a signal or release', async () => {
  const host = machine(); host.clean(); host.fail('table')
  assert.match((await host.owner.signalReportAsync('SIGKILL', new Deadline(1000))).problems.join(' '), /metadata reading failed/)
  assert.equal(host.calls.some((call) => call.startsWith('signal')), false)
  assert.equal(await host.owner.remainsAsync(new Deadline(1000)), true)
})

test('a media PID reused at the immediate identity reading is refused', async () => {
  const host = machine(); host.clean(); host.reuse()
  const report = await host.owner.signalReportAsync('SIGKILL', new Deadline(1000))
  assert.equal(host.calls.some((call) => call.startsWith('signal')), false)
  assert.match(report.identityRefusals.join(' '), /different identity/)
})
