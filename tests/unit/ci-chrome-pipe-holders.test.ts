import type { PipeQueryRecord } from '../../scripts/ci/chrome-pipe-holders.ts'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import { PIPE_QUERY_MAXIMUM_BYTES, PIPE_QUERY_TIMEOUT_MS, pipeDescriptor, pipeHoldersFromLsof, queryPipeHolders } from '../../scripts/ci/chrome-pipe-holders.ts'

const fields = (...entries: string[]): string => `${entries.join('\0')}\0\n`
const host = fields('p101', 'R1', 'g101', 'cnode', 'f9', 'au', 'tunix', 'd0x000a', 'n->0x000b')
const targets = [{ childPid: 202, fd: 9 }]

test('matches actual Darwin endpoint/peer identities across detached process groups', () => {
  const text = host + fields('p303', 'R1', 'g303', 'cchrome_crashpad_handler', 'f2', 'au', 'tunix', 'd0xb', 'n->0xa') + fields('p404', 'R1', 'g404', 'cnode', 'f2', 'au', 'tunix', 'd0xc', 'n->0xd')
  const snapshot = pipeHoldersFromLsof(text, 101, targets).targets[0]
  assert.equal(snapshot?.endpoint?.device, '0xa')
  assert.deepEqual(snapshot?.holders.map((holder) => [holder.pid, holder.parentPid, holder.groupPid, holder.fd, holder.peer]), [[303, 1, 303, 2, '0xa']])
})

test('matches PIPE descriptors without confusing a different endpoint type', () => {
  const text = host.replace('tunix', 'tPIPE') + fields('p303', 'cnode', 'f2', 'aw', 'tPIPE', 'd0xb', 'n->0xa') + fields('p404', 'cnode', 'f2', 'au', 'tunix', 'd0xb', 'n->0xa')
  assert.deepEqual(pipeHoldersFromLsof(text, 101, targets).targets[0]?.holders.map((holder) => holder.pid), [303])
})

test('refuses paths, arguments, environment-like text and network addresses', () => {
  const secret = 'PRIVATE_FIXTURE_VALUE'
  const text = host + fields('p303', 'R1', 'g303', `c/private/${secret}/node --password=${secret}`, 'f2', 'au', 'tunix', 'd0xb', `n/private/${secret}.sock`) + fields('p404', 'R1', 'g404', `cTOKEN=${secret}`, 'f4', 'au', 'tunix', 'd0xb', `n127.0.0.1:4444->127.0.0.1:5555 ${secret}`)
  const result = pipeHoldersFromLsof(text, 101, targets)
  assert.equal(result.targets[0]?.holders.length, 2)
  assert.ok(result.targets[0]?.holders.every((holder) => holder.command === null && holder.peer === null))
  assert.ok(!JSON.stringify(result).includes(secret))
  assert.ok(!JSON.stringify(result).includes('/private/'))
  assert.ok(!JSON.stringify(result).includes('127.0.0.1'))
})

test('missing, zero, malformed and nonnumeric descriptors cannot identify a holder', () => {
  for (const text of [host.replace('d0x000a', 'd0x0'), host.replace('f9', 'fcwd'), host.replace('p101', 'p-101'), host.replace('d0x000a', 'd/path')]) assert.equal(pipeHoldersFromLsof(text, 101, targets).targets[0]?.endpoint, null)
  assert.equal(pipeHoldersFromLsof(host, 101, [{ childPid: 202, fd: null }]).targets[0]?.endpoint, null)
})

test('bounds retained matching metadata and reports omitted holders', () => {
  const text = host + Array.from({ length: 40 }, (_, index) => fields(`p${300 + index}`, 'cnode', 'f2', 'au', 'tunix', 'd0xb', 'n->0xa')).join('')
  const result = pipeHoldersFromLsof(text, 101, targets).targets[0]
  assert.equal(result?.holders.length, 32)
  assert.equal(result?.omittedHolders, 8)
})

async function query(executable: string, arguments_: readonly string[] | undefined = undefined): Promise<PipeQueryRecord> {
  return new Promise((resolve, reject) => {
    const guard = setTimeout(() => reject(new Error('The bounded query did not settle.')), 2000)
    queryPipeHolders({ executable, ...(arguments_ === undefined ? {} : { arguments: arguments_ }), uid: process.getuid?.() ?? 0, hostPid: process.pid, targets: [], record: (record) => { clearTimeout(guard); resolve(record) } })
  })
}

async function gone(pid: number | null): Promise<void> {
  assert.ok(pid !== null)
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { process.kill(pid, 0) } catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return; throw error }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.fail('The diagnostic subprocess remained alive.')
}

test('a hung diagnostic is killed at its own limit, without its output being logged', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'retest-ci-pipe-timeout-'))
  try {
    const executable = join(folder, 'query')
    await writeFile(executable, `#!${process.execPath}\nsetInterval(() => {}, 1000)\n`, { mode: 0o700 })
    const result = await query(executable)
    assert.equal(result.status, 'timeout')
    assert.ok(result.queryMs >= PIPE_QUERY_TIMEOUT_MS)
    assert.ok(result.queryMs < 1000)
    assert.equal(result.bytes, 0)
    await gone(result.queryPid)
  } finally { await rm(folder, { recursive: true, force: true }) }
})

test('an overlarge diagnostic is killed at its byte limit', async () => {
  // A direct native writer avoids script-startup latency consuming the diagnostic's unchanged 200 ms budget.
  const result = await query('/usr/bin/yes', ['PRIVATE_FIXTURE_VALUE'])
  assert.equal(result.status, 'bytes-limit', JSON.stringify(result))
  assert.equal(result.bytes, PIPE_QUERY_MAXIMUM_BYTES)
  assert.ok(!JSON.stringify(result).includes('PRIVATE_FIXTURE_VALUE'))
  await gone(result.queryPid)
})

test('a pending diagnostic cannot keep its parent open and is killed on parent exit', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'retest-ci-pipe-exit-'))
  try {
    const executable = join(folder, 'query')
    const recordPath = join(folder, 'record.json')
    const script = join(folder, 'parent.mjs')
    const helper = new URL('../../scripts/ci/chrome-pipe-holders.ts', import.meta.url).href
    await writeFile(executable, `#!${process.execPath}\nsetInterval(() => {}, 1000)\n`, { mode: 0o700 })
    await writeFile(script, `import { writeFileSync } from 'node:fs'; import { queryPipeHolders } from ${JSON.stringify(helper)}; queryPipeHolders({executable:${JSON.stringify(executable)}, uid:process.getuid(),hostPid:process.pid,targets:[],record:r=>writeFileSync(${JSON.stringify(recordPath)},JSON.stringify(r))});`)
    const began = performance.now()
    const child = spawn(process.execPath, [script], { stdio: ['ignore', 'ignore', 'pipe'] })
    let errors = ''
    child.stderr.on('data', (chunk: Buffer) => { errors += chunk.toString() })
    const exitCode = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
    assert.equal(exitCode, 0, errors)
    assert.ok(performance.now() - began < 1000)
    const result: PipeQueryRecord = JSON.parse(await readFile(recordPath, 'utf8'))
    assert.equal(result.status, 'host.exit')
    assert.ok(result.queryMs < PIPE_QUERY_TIMEOUT_MS)
    await gone(result.queryPid)
  } finally { await rm(folder, { recursive: true, force: true }) }
})


test('throwing descriptor access is unavailable and cannot escape the observer', () => {
  const stream = new PassThrough()
  try {
    Object.defineProperty(stream, '_handle', { configurable: true, get: () => { throw new Error('PRIVATE_FIXTURE_VALUE') } })
    assert.equal(pipeDescriptor(stream), null)
    Object.defineProperty(stream, '_handle', { value: Object.defineProperty({}, 'fd', { get: () => { throw new Error('PRIVATE_FIXTURE_VALUE') } }) })
    assert.equal(pipeDescriptor(stream), null)
  } finally { stream.destroy() }
})

test('missing executables and synchronous spawn errors emit no error text', async () => {
  const missing = await query('/no/such/PRIVATE_FIXTURE_VALUE/query')
  assert.equal(missing.status, 'failed')
  assert.equal(missing.queryPid, null)
  assert.ok(!JSON.stringify(missing).includes('PRIVATE_FIXTURE_VALUE'))
  const invalid = await query('PRIVATE_FIXTURE_VALUE\0')
  assert.equal(invalid.status, 'failed')
  assert.equal(invalid.queryPid, null)
  assert.ok(!JSON.stringify(invalid).includes('PRIVATE_FIXTURE_VALUE'))
  assert.doesNotThrow(() => queryPipeHolders({ executable: '\0', uid: 0, hostPid: process.pid, targets: [], record: () => { throw new Error('PRIVATE_FIXTURE_VALUE') } }))
})


test('a major/minor D field cannot stand in for the Darwin endpoint d field', () => {
  const wrongField = host.replace('d0x000a', 'D0x000a') + fields('p303', 'cnode', 'f2', 'au', 'tunix', 'D0xb', 'n->0xa')
  assert.equal(pipeHoldersFromLsof(wrongField, 101, targets).targets[0]?.endpoint, null)
})
