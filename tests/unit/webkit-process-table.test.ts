import assert from 'node:assert/strict'
import { test } from 'node:test'
import { WebKitProcessTable } from '../../src/browser/webkit/process-table.ts'
import { Deadline } from '../../src/protocol/deadline.ts'
import { OwnedProcessGroup } from '../../src/shared/process-ownership.ts'

test('one successful WebKit table snapshot clears 100 dead helper owners and only the live root receives an individual check', async () => {
  const root = { pid: 6101, parentPid: 1, groupId: 6101, startedAt: 'birth', command: '/owned/browser' }
  const helpers = Array.from({ length: 100 }, (_, index) => ({ ...root, pid: 7000 + index, groupId: 7000 + index }))
  let entries = [root, ...helpers]
  let tables = 0
  const identities: number[] = []
  const signals: number[] = []
  const host = new WebKitProcessTable({
    read: () => entries,
    readAsync: async () => { tables += 1; return entries },
    readProcessAsync: async (pid) => { identities.push(pid); return entries.find((entry) => entry.pid === pid) },
    signal: (pid) => signals.push(pid),
  })
  const owners = entries.map((entry) => new OwnedProcessGroup(entry.pid, 1, host))
  for (const owner of owners) assert.deepEqual(owner.capture(), [])
  entries = [root]
  const live = await host.during(() => owners.filter((owner) => owner.remains()))
  assert.equal(tables, 1)
  assert.equal(live.length, 1)
  assert.deepEqual(identities, [])
  assert.deepEqual(await live[0]?.signalReportAsync('SIGKILL', new Deadline(1000)), { problems: [], identityRefusals: [] })
  assert.deepEqual(identities, [root.pid])
  assert.deepEqual(signals, [root.pid])
})

test('a failed shared WebKit helper snapshot keeps every owner held and grants no signal', async () => {
  const root = { pid: 6101, parentPid: 1, groupId: 6101, startedAt: 'birth', command: '/owned/browser' }
  let failed = false
  const host = new WebKitProcessTable({ read: () => [root], readAsync: async () => { if (failed) throw new Error('table unreadable'); return [root] }, signal: () => assert.fail('no signal is authorised') })
  const owner = new OwnedProcessGroup(root.pid, 1, host)
  assert.deepEqual(owner.capture(), [])
  failed = true
  assert.equal(await host.during(() => owner.remains()), true)
  assert.match((await owner.signalReportAsync('SIGKILL', new Deadline(1000))).problems.join(' '), /table unreadable/)
  assert.match(owner.readProblems.join(' '), /table unreadable/)
})
