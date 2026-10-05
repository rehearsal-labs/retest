import type { Generation } from '../../src/cli/install/lock.ts'
import type { ProcessStart } from '../../src/cli/install/process-start.ts'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { describe, test } from 'node:test'
import { decideGeneration } from '../../src/cli/install/lock.ts'
import { compareStarts, parseProcStat, parseUtcStart, readMachine, startReader } from '../../src/cli/install/process-start.ts'
import { systemTools } from '../../src/native/processes.ts'

// How the install lock reads a process's start and judges a holder from it. Platform-neutral cases use fixed text
// and fake readings. The live-process case reads /proc on Linux and ps on macOS.

describe('reading a start', () => {
  test('takes field 22 of a /proc stat line, counting from the last bracket so a name with spaces and brackets reads right', () => {
    assert.equal(parseProcStat('4242 (node) S 1 4242 4242 0 -1 4194560 1 0 0 0 0 0 0 0 20 0 11 0 873421 0 0'), 873421)
    assert.equal(parseProcStat('77 (a) b (c) d) R 1 77 77 0 -1 4194560 1 0 0 0 0 0 0 0 20 0 1 0 5 0 0'), 5)
    assert.equal(parseProcStat('77 (cut short) R 1 77'), undefined)
    assert.equal(parseProcStat('no brackets at all'), undefined)
    assert.equal(parseProcStat('77 (x) R 1 77 77 0 -1 4194560 1 0 0 0 0 0 0 0 20 0 1 0 -5 0 0'), undefined)
  })

  test('reads the start ps prints in UTC as seconds since 1970, and nothing else', () => {
    assert.equal(parseUtcStart('Mon Oct  5 20:03:49 2026'), Date.UTC(2026, 9, 5, 20, 3, 49) / 1000)
    assert.equal(parseUtcStart('Thu Jan  1 00:00:00 1970  '), 0)
    assert.equal(parseUtcStart('Mon Okt  5 20:03:49 2026'), undefined)
    assert.equal(parseUtcStart('5 Oct 2026 20:03:49'), undefined)
  })

  test('reads this process on this machine, and a pid nobody has as absent', { skip: process.platform === 'darwin' || process.platform === 'linux' ? false : 'only macOS and Linux are read' }, async () => {
    const read = startReader({ platform: process.platform, tools: systemTools })
    const own = await read(process.pid)
    assert.equal(own.state, 'present')
    assert.equal(own.state === 'present' ? own.start.clock : undefined, process.platform === 'linux' ? 'boot-ticks' : 'utc-seconds')
    const ended = Number(spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout)
    assert.deepEqual(await read(ended), { state: 'absent' }, 'a process that has just ended')
    const machine = await readMachine({ platform: process.platform })
    assert.ok(machine.ok, machine.ok ? '' : machine.problem)
    assert.match(machine.ok ? machine.machine.id : '', process.platform === 'linux' ? /^linux boot [0-9a-f-]{36} pid:\[\d+\]$/ : /^macos boot [0-9A-F-]{36}$/)
  })
})

describe('judging a holder from its start', () => {
  const ticks = (value: number): ProcessStart => ({ clock: 'boot-ticks', value })
  const seconds = (value: number): ProcessStart => ({ clock: 'utc-seconds', value })
  const holder = (start: ProcessStart, machine = 'linux boot b pid:[1]'): Generation => ({ version: 2, token: 't', machine, host: 'here', pid: 4242, start, since: '2026-10-05T00:00:00.000Z', command: 'retest' })
  const judge = (generation: Generation, current: Parameters<typeof decideGeneration>[1]['current'], released = false) => decideGeneration(generation, { machine: 'linux boot b pid:[1]', ownPid: 7, ownStart: ticks(900), released, current })

  test('compares two starts on one clock only: the same, a later one, or nothing proven', () => {
    assert.equal(compareStarts(ticks(100), ticks(100)), 'same')
    assert.equal(compareStarts(ticks(100), ticks(250)), 'later')
    assert.equal(compareStarts(ticks(250), ticks(100)), 'unsure')
    assert.equal(compareStarts(ticks(100), seconds(250)), 'unsure')
  })

  test('passes over an absent holder and refuses every present start mismatch on the Linux clock and the macOS one', () => {
    for (const start of [ticks(500), seconds(1_791_230_629)]) {
      const generation = holder(start)
      assert.equal(judge(generation, { state: 'absent' }), 'free')
      assert.deepEqual(judge(generation, { state: 'present', start: { ...start, value: start.value + 1 } }), { kind: 'unsure', generation }, 'a later start alone cannot prove PID absence')
      assert.deepEqual(judge(generation, { state: 'present', start }), { kind: 'running', generation })
      // An earlier start is what a stepped clock or a reading in another zone gives; it proves nothing, so the lock stays.
      assert.deepEqual(judge(generation, { state: 'present', start: { ...start, value: start.value - 3600 } }), { kind: 'unsure', generation })
      assert.deepEqual(judge(generation, { state: 'unreadable', problem: 'ps ended with exit code 2' }), { kind: 'unknown', generation, problem: 'ps ended with exit code 2' })
    }
    const onTicks = holder(ticks(500))
    assert.deepEqual(judge(onTicks, { state: 'present', start: seconds(10_000_000_000) }), { kind: 'unsure', generation: onTicks }, 'a start on another clock proves nothing')
  })

  test('never judges another machine\'s holder, and takes a let-go generation as free from anywhere', () => {
    const elsewhere = holder(ticks(500), 'linux boot other pid:[2]')
    assert.deepEqual(judge(elsewhere, { state: 'absent' }), { kind: 'foreign', generation: elsewhere })
    assert.equal(judge(elsewhere, undefined, true), 'free')
  })

  test('knows this process\'s own generation and refuses either start mismatch under its live pid', () => {
    const own = { ...holder(ticks(900)), pid: 7 }
    assert.deepEqual(judge(own, undefined), { kind: 'self', generation: own })
    assert.deepEqual(judge({ ...own, start: ticks(100) }, undefined), { kind: 'unsure', generation: { ...own, start: ticks(100) } })
    assert.deepEqual(judge({ ...own, start: ticks(2000) }, undefined), { kind: 'unsure', generation: { ...own, start: ticks(2000) } })
  })
})
