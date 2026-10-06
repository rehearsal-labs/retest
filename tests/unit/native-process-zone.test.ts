import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

// A process's start is read by `ps`, which prints it in the time zone of whoever runs it. Records compare a start read
// by one process with a start read later by another, so every reading must come out the same whatever time zone the
// reading process was started in. Two readers in time zones 26 hours apart read the start of one process here.

const probe = fileURLToPath(new URL('./native-process-zone-probe.ts', import.meta.url))

function readAs(zone: string, pid: number): { readonly commandOf: string; readonly table: string } {
  const result = spawnSync(process.execPath, ['--conditions=retest-source', probe, String(pid)], { encoding: 'utf8', env: { ...process.env, TZ: zone } })
  assert.equal(result.status, 0, result.stderr)
  const value: unknown = JSON.parse(result.stdout)
  assert.ok(typeof value === 'object' && value !== null && 'commandOf' in value && 'table' in value && typeof value.commandOf === 'string' && typeof value.table === 'string')
  return { commandOf: value.commandOf, table: value.table }
}

test('a start reads the same whatever time zone the reading process runs in, from commandOf and the process table alike', { skip: process.platform === 'darwin' ? false : 'the native readers run on macOS' }, async () => {
  const other = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  try {
    const pid = other.pid ?? assert.fail('the stand-in process started')
    const west = readAs('Etc/GMT+12', pid)
    const east = readAs('Etc/GMT-14', pid)
    assert.equal(west.commandOf, east.commandOf, 'commandOf read the same start in both time zones')
    assert.equal(west.table, east.table, 'the process table read the same start in both time zones')
    assert.equal(west.commandOf, west.table, 'commandOf and the process table agree')
  } finally {
    other.kill('SIGKILL')
    await new Promise((resolve) => other.once('exit', resolve))
  }
})
