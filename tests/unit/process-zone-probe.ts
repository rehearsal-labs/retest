import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { readMetadataProcess, readMetadataProcessAsync } from '../../src/shared/metadata-process.ts'
import { OwnedProcessGroup } from '../../src/shared/process-ownership.ts'
import { commandOf, listProcesses, readOwnStart, readProcessTable, systemTools } from '../../src/native/processes.ts'
import { readProcessIdentity, readProcessIdentityAsync, readProcessTable as firefoxTable, readProcessTableAsync as firefoxTableAsync, readProcessLivenessAsync } from '../../src/browser/firefox/process-table.ts'
import { processStartedAt } from '../../src/browser/webkit/process.ts'
import { WebKitProcessTable } from '../../src/browser/webkit/process-table.ts'
import { mediaOwnershipSystem } from '../../src/media/client.ts'
import { ownStartTime } from '../../src/runner/media-leftovers.ts'
import { startReader } from '../../src/cli/install/process-start.ts'

const pid = Number(process.argv[2])
const parent = Number(process.argv[3])
function utcStart(id: number): string {
  const result = spawnSync('/bin/ps', ['-o', 'lstart=', '-p', String(id)], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', TZ: 'UTC0' } })
  if (result.status !== 0) throw new Error('The reference process reading failed.')
  return result.stdout.trim().replace(/\s+/g, ' ')
}
const expected = utcStart(pid)
const ownExpected = utcStart(process.pid)
const readings: Record<string, { actual: string | undefined; expected: string }> = {}
const add = (name: string, start: string | undefined, reference = expected): void => {
  readings[name] = { actual: start?.trim().replace(/\s+/g, ' '), expected: reference }
}
const query = { command: '/bin/ps', args: ['-o', 'lstart=', '-p', String(pid)], environment: { PATH: '/usr/bin:/bin', LC_ALL: 'C', TZ: process.env['TZ'] ?? 'Etc/GMT-14' } }
add('metadata sync', readMetadataProcess(query))
add('metadata async', await readMetadataProcessAsync(query))
const ownership = new OwnedProcessGroup(pid, parent)
ownership.capture()
add('shared table', ownership.verifiedIdentity()?.startedAt)
add('shared individual', ownership.verifiedIdentity()?.startedAt)
await ownership.captureAsync()
add('shared async table', ownership.verifiedIdentity()?.startedAt)
// SIGCONT exercises the asynchronous pre-signal reading of our live child.
const report = await ownership.signalReportAsync('SIGCONT')
if (report.problems.length > 0 || report.identityRefusals.length > 0) throw new Error('The shared asynchronous identity reading failed.')
add('shared async individual', ownership.verifiedIdentity()?.startedAt)
const presence = await commandOf(systemTools, pid)
add('native command', presence.state === 'present' ? presence.startedAt : undefined)
add('native list', (await listProcesses(systemTools, 5000)).find((entry) => entry.pid === pid)?.startedAt)
add('native table', (await readProcessTable()).find((entry) => entry.pid === pid)?.startedAt)
add('native own', await readOwnStart(), ownExpected)
add('firefox table', firefoxTable().find((entry) => entry.pid === pid)?.startedAt)
add('firefox async table', (await firefoxTableAsync()).find((entry) => entry.pid === pid)?.startedAt)
add('firefox liveness', (await readProcessLivenessAsync()).find((entry) => entry.pid === pid)?.startedAt)
add('firefox individual', readProcessIdentity(pid)?.startedAt)
add('firefox async individual', (await readProcessIdentityAsync(pid))?.startedAt)
add('webkit start', processStartedAt(pid))
const webkit = new WebKitProcessTable()
add('webkit table', webkit.read().find((entry) => entry.pid === pid)?.startedAt)
add('webkit async table', (await webkit.readAsync()).find((entry) => entry.pid === pid)?.startedAt)
add('webkit individual', webkit.readProcess(pid)?.startedAt)
add('webkit async individual', (await webkit.readProcessAsync(pid))?.startedAt)
const media = mediaOwnershipSystem(pid)
add('media table', media.read().find((entry) => entry.pid === pid)?.startedAt)
add('media async table', (await media.readAsync?.())?.find((entry) => entry.pid === pid)?.startedAt)
add('media individual', media.readProcess?.(pid)?.startedAt)
add('media async individual', (await media.readProcessAsync?.(pid))?.startedAt)
add('media owner start', await ownStartTime(), ownExpected)
const installed = await startReader({ platform: process.platform, tools: systemTools })(pid)
if (installed.state !== 'present') throw new Error('The install process reading failed.')
if (installed.start.clock === 'utc-seconds') {
  add('install start', String(installed.start.value), String(Date.parse(`${expected} UTC`) / 1000))
} else {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
  const ticks = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)[19]
  if (ticks === undefined) throw new Error('The independent kernel start reference was incomplete.')
  add('install start', String(installed.start.value), ticks)
}
process.stdout.write(JSON.stringify(readings))
