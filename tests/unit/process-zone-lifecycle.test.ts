import type { MetadataProcessRequest } from '../../src/shared/metadata-process.ts'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { TextDecoder } from 'node:util'
import { Worker } from 'node:worker_threads'
import { ChromiumProcess } from '../../src/browser/chromium-process.ts'
import { killRecordedNow, OwnedProcess, systemTools } from '../../src/native/processes.ts'
import { metadataComplete, metadataSuccess } from '../../src/shared/metadata-process.ts'
import { unixOnly } from '../support/platform-skip.ts'

const zones = unixOnly('a start read through ps in a time zone exists only on Unix; Windows keeps each process start as UTC ticks')

test('the native ownership table and immediate async identity both read their real child in UTC0', { skip: zones }, async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'retest-native-zone-'))
  const requests = new Map<ArrayBufferLike, MetadataProcessRequest>()
  const readings: { readonly args: readonly string[]; readonly text: string }[] = []
  const post = Worker.prototype.postMessage
  t.mock.method(Worker.prototype, 'postMessage', function (this: Worker, request: MetadataProcessRequest) {
    requests.set(request.output, request)
    return post.call(this, request)
  })
  const decode = TextDecoder.prototype.decode
  t.mock.method(TextDecoder.prototype, 'decode', function (this: TextDecoder, ...args: Parameters<TextDecoder['decode']>) {
    const text = decode.call(this, ...args)
    const input = args[0]
    const request = input !== undefined && ArrayBuffer.isView(input) ? requests.get(input.buffer) : undefined
    if (request !== undefined) {
      const control = new Int32Array(request.control)
      if (Atomics.load(control, 0) === metadataComplete && Atomics.load(control, 1) === metadataSuccess) readings.push({ args: request.args, text })
    }
    return text
  })
  const zone = process.env['TZ']
  let owned: OwnedProcess | undefined
  try {
    process.env['TZ'] = 'Etc/GMT+12'
    owned = await OwnedProcess.start({ command: '/bin/sleep', args: ['60'], logFile: join(folder, 'sleep.log'), environment: { TZ: 'Etc/GMT+12' } })
    const reference = spawnSync('/bin/ps', ['-o', 'lstart=', '-p', String(owned.pid)], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', TZ: 'UTC0' } })
    assert.equal(reference.status, 0)
    const expected = reference.stdout.trim().replace(/\s+/g, ' ')
    process.env['TZ'] = 'Etc/GMT-14'
    assert.deepEqual(await owned.stop(0), [])
    const kinds = new Set<string>()
    // The output buffer may serve another query after its answer is consumed. Keep the text at consumption, so the
    // proof checks each completed reading rather than whatever a later reading left in the same working buffer.
    for (const reading of readings) {
      if (!reading.args.some(argument => argument.includes('lstart'))) continue
      const row = reading.text.split('\n').find(line => line.trim().startsWith(`${owned?.pid} `))
      if (row === undefined) continue
      const fields = row.trim().split(/\s+/)
      assert.equal(fields.slice(4, 9).join(' '), expected)
      kinds.add(reading.args.includes('-p') ? 'individual' : 'table')
    }
    assert.deepEqual([...kinds].sort(), ['individual', 'table'])
  } finally {
    if (zone === undefined) delete process.env['TZ']
    else process.env['TZ'] = zone
    if (owned !== undefined) await owned.stop(0)
    await rm(folder, { recursive: true, force: true })
  }
})

test('the native exit reader ends only its recorded real child using the UTC0 start', { skip: zones }, async () => {
  const child = spawn('/bin/sleep', ['60'], { detached: true, stdio: 'ignore', env: { TZ: 'Etc/GMT+12' } })
  const ended = once(child, 'exit')
  const zone = process.env['TZ']
  try {
    assert.ok(child.pid !== undefined)
    const read = spawnSync('/bin/ps', ['-o', 'lstart=', '-p', String(child.pid)], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', TZ: 'UTC0' } })
    assert.equal(read.status, 0)
    process.env['TZ'] = 'Etc/GMT-14'
    killRecordedNow([{ pid: child.pid, command: '/bin/sleep 60', startedAt: read.stdout.trim().replace(/\s+/g, ' ') }], systemTools)
    assert.equal(await Promise.race([ended.then(() => true), sleep(1000).then(() => false)]), true, 'the verified exit-hook signal ends its child')
    assert.equal(child.signalCode, 'SIGKILL')
  } finally {
    if (zone === undefined) delete process.env['TZ']
    else process.env['TZ'] = zone
    child.kill('SIGKILL')
    await ended
  }
})

test('Chromium ownership closes its recorded real process across a caller TZ change', { skip: zones }, async () => {
  const child = spawn('/bin/sleep', ['60'], { detached: true, stdio: 'ignore', env: { TZ: 'Etc/GMT+12' } })
  const ended = once(child, 'exit')
  const zone = process.env['TZ']
  let browser: ChromiumProcess | undefined
  try {
    process.env['TZ'] = 'Etc/GMT+12'
    browser = new ChromiumProcess(child, undefined, { readable: new PassThrough(), writable: new PassThrough() })
    process.env['TZ'] = 'Etc/GMT-14'
    assert.deepEqual(await browser.stop(0), [])
    await browser.gone()
    assert.equal(child.signalCode, 'SIGKILL')
  } finally {
    if (zone === undefined) delete process.env['TZ']
    else process.env['TZ'] = zone
    child.kill('SIGKILL')
    await ended
    if (browser !== undefined) await browser.stop(0)
  }
})
