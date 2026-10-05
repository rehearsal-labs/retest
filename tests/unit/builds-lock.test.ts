import type { ChildProcess } from 'node:child_process'
import type { ProcessStart } from '../../src/cli/install/process-start.ts'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, test } from 'node:test'
import { takeInstallLock } from '../../src/cli/install/lock.ts'
import { readMachine, startReader } from '../../src/cli/install/process-start.ts'
import { systemTools } from '../../src/native/processes.ts'
import { tempFolder } from '../support/temp-folder.ts'
import { holdLockInChild, lockHolderScript, lockState, takeWhenFree } from './builds-fixtures.ts'

// The install lock across real processes, each one an installer stand-in started by the test. Every process a test
// starts is waited for, and only those are ever signalled. The lock is a folder of generations: `<n>.json` names the
// process that holds generation n, by machine, pid and start, with a token, and `<n>.<token>.released` says it let go.

const machine = await readMachine({ platform: process.platform })
assert.ok(machine.ok, machine.ok ? '' : machine.problem)
const readStart = startReader({ platform: process.platform, tools: systemTools })

function escape(text: string): string {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// A lock path in a new folder of locks, made beforehand as the installer makes it.
function newLock(): string {
  const lock = join(tempFolder('retest-install-lock-'), 'locks', 'stand-in-1.0.0-mac-arm64.lock')
  mkdirSync(dirname(lock), { recursive: true })
  return lock
}

// The pid of a process that has just ended.
function gonePid(): number {
  return Number(spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout)
}

async function startOf(pid: number): Promise<ProcessStart> {
  const reading = await readStart(pid)
  assert.ok(reading.state === 'present', `the start of pid ${pid} was read`)
  return reading.start
}

// Makes the next generation of a lock as a process with `pid` and `start` on `onMachine` would, and returns its number.
function writeGeneration(lock: string, holder: { readonly pid: number; readonly start: ProcessStart; readonly machine?: string; readonly host?: string }): number {
  mkdirSync(lock, { recursive: true })
  const generation = lockState(lock).generation + 1
  const record = { version: 2, token: randomBytes(16).toString('hex'), machine: holder.machine ?? (machine.ok ? machine.machine.id : ''), host: holder.host ?? 'this machine', pid: holder.pid, start: holder.start, since: '2026-10-05T00:00:00.000Z', command: 'a stand-in installer' }
  writeFileSync(join(lock, `${generation}.json`), JSON.stringify(record))
  return generation
}

// The files of a lock that are not hidden.
function visible(lock: string): string[] {
  return readdirSync(lock).filter((name) => !name.startsWith('.')).sort()
}

// The most installers that held the lock at one moment, from their `enter` and `leave` lines. A leave and an enter at
// the same instant count as one after the other, since each process writes its leave before it lets the lock go.
function mostAtOnce(log: string): { most: number; entered: number } {
  const events = log.split('\n').filter((line) => line.startsWith('enter ') || line.startsWith('leave ')).map((line) => {
    const [kind = '', , time = ''] = line.split(' ')
    return { time: Number(time), step: kind === 'enter' ? 1 : -1 }
  })
  events.sort((first, second) => first.time - second.time || first.step - second.step)
  let holding = 0
  let most = 0
  for (const event of events) {
    holding += event.step
    most = Math.max(most, holding)
  }
  return { most, entered: events.filter((event) => event.step === 1).length }
}

function exited(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve) => child.once('exit', (code) => resolve(code)))
}

// One take of the lock in a process of its own, with `env` added to its environment: `held`, or `refused` and why.
function tryInChild(lock: string, env: Readonly<Record<string, string>>): string {
  const result = spawnSync(process.execPath, ['--conditions=retest-source', lockHolderScript, 'try', lock], { encoding: 'utf8', env: { ...process.env, ...env } })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}

// A live process that is no installer, which a test starts and ends.
async function withStandIn(run: (pid: number, stop: () => Promise<void>) => Promise<void>): Promise<void> {
  const other = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  const ended = exited(other)
  const stop = async (): Promise<void> => {
    if (other.exitCode === null && other.signalCode === null) other.kill('SIGKILL')
    await ended
  }
  try {
    await run(other.pid ?? assert.fail('the stand-in process started'), stop)
  } finally {
    await stop()
  }
}

describe('the install lock', () => {
  test('lets one installer hold it at a time, across six processes racing over a lock a gone holder left, round after round', { timeout: 90_000 }, async () => {
    const lock = newLock()
    for (let round = 1; round <= 3; round += 1) {
      const log = join(dirname(lock), `round-${round}.log`)
      writeFileSync(log, '')
      // What a holder that died without letting go leaves: the newest generation, naming a pid no process has now.
      const left = writeGeneration(lock, { pid: gonePid(), start: await startOf(process.pid) })
      const racers = Array.from({ length: 6 }, () => spawn(process.execPath, ['--conditions=retest-source', lockHolderScript, 'race', lock, log, '150', '20000'], { stdio: ['ignore', 'ignore', 'inherit'] }))
      const codes = await Promise.all(racers.map(exited))
      assert.deepEqual(codes, [0, 0, 0, 0, 0, 0], `every installer finished in round ${round}`)
      const text = readFileSync(log, 'utf8')
      const { most, entered } = mostAtOnce(text)
      assert.equal(entered, 6, `every installer held the lock once in round ${round}:\n${text}`)
      assert.equal(most, 1, `one installer at a time in round ${round}:\n${text}`)
      const refusals = text.split('\n').filter((line) => line.startsWith('refused '))
      for (const refusal of refusals) assert.match(refusal, new RegExp(`holds the install lock ${escape(lock)}`), 'each refusal names the lock')
      const after = lockState(lock)
      assert.ok(after.generation >= left + 6 && after.released, `the gone holder was passed over, and every generation after it was let go, in round ${round}: ${JSON.stringify(after)}`)
    }
  })

  test('refuses while another process holds it, naming the lock and that process, and is free once that process is killed', async () => {
    const lock = newLock()
    const holder = await holdLockInChild(lock)
    try {
      const refused = await takeInstallLock(lock)
      assert.equal(refused.ok, false)
      assert.match(refused.ok ? '' : refused.message, new RegExp(`^Another Retest process \\(pid ${holder.pid}, started as ".+", since [0-9T:.Z-]+\\) holds the install lock ${escape(lock)} and is installing this build\\. Wait for it to finish, then run the install again\\.$`))
    } finally {
      await holder.kill()
    }
    const taken = await takeWhenFree(lock)
    assert.equal(await taken.release(), undefined, 'the lock was let go')
  })

  // `ps` prints a start in the time zone of whoever runs it, so a holder and a taker in two zones read two starts for
  // one process; a taker that took that for another process would take a live holder's lock.
  test('keeps a holder that took it in one time zone from a taker in another, both real processes', async () => {
    const lock = newLock()
    const holder = await holdLockInChild(lock, { TZ: 'Etc/GMT+12' })
    try {
      const answer = tryInChild(lock, { TZ: 'Etc/GMT-14' })
      assert.match(answer, new RegExp(`^refused Another Retest process \\(pid ${holder.pid}, `), answer)
    } finally {
      await holder.release()
    }
    assert.equal(tryInChild(lock, { TZ: 'Etc/GMT-14' }), 'held', 'once that holder let go, the taker in the other zone takes it')
  })

  // A rule that judged a holder by the age of its generation, or passed over one it cannot read, would let a second
  // installer in beside a live one.
  test('is not taken from a live holder however long it has held it, nor through a generation that cannot be read', async () => {
    const lock = newLock()
    const holder = await holdLockInChild(lock)
    try {
      assert.deepEqual(lockState(lock), { generation: 1, released: false }, 'the holder made the first generation')
      const hoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000)
      utimesSync(join(lock, '1.json'), hoursAgo, hoursAgo)
      const old = await takeInstallLock(lock)
      assert.match(old.ok ? '' : old.message, new RegExp(`^Another Retest process \\(pid ${holder.pid}, `), 'a holder of three hours is still the holder')
      const kept = readFileSync(join(lock, '1.json'), 'utf8')
      writeFileSync(join(lock, '1.json'), '')
      const unreadable = await takeInstallLock(lock)
      assert.match(unreadable.ok ? '' : unreadable.message, new RegExp(`^The install lock ${escape(lock)} is held by ${escape(join(lock, '1.json'))}, which names no holder Retest can read \\(.+\\), so Retest leaves it alone\\. Once no install of this build runs, remove the folder, then run the install again\\.$`))
      assert.deepEqual(visible(lock), ['1.json'], 'no other generation was made')
      writeFileSync(join(lock, '1.json'), kept)
    } finally {
      await holder.release()
    }
    await (await takeWhenFree(lock)).release()
  })

  test('is let go only by its own holder: a second release changes nothing for the next holder', async () => {
    const lock = newLock()
    const first = await takeInstallLock(lock)
    assert.ok(first.ok, first.ok ? '' : first.message)
    const meanwhile = await takeInstallLock(lock)
    assert.equal(meanwhile.ok, false, 'a second take in the same process is refused too')
    assert.match(meanwhile.ok ? '' : meanwhile.message, new RegExp(`^This process already holds the install lock ${escape(lock)}, since `))
    await first.release()
    const next = await takeInstallLock(lock)
    assert.ok(next.ok, next.ok ? '' : next.message)
    await first.release()
    const third = await takeInstallLock(lock)
    assert.equal(third.ok, false, 'the next holder still holds it after the first released twice')
    await next.release()
  })

  // A different start is unconfirmed while the PID is present. Only whole-table absence frees the generation.
  test('refuses a present holder with either start mismatch or an unreadable identity, and takes it only after its pid is absent', async () => {
    const lock = newLock()
    await withStandIn(async (pid) => {
      const real = await startOf(pid)
      writeGeneration(lock, { pid, start: { ...real, value: real.value - 100 } })
      const file = join(lock, '1.json')
      const original = readFileSync(file, 'utf8')
      const mismatched = await takeInstallLock(lock)
      assert.deepEqual(mismatched, { ok: false, message: `The process now under pid ${pid}, which has held the install lock ${lock} since 2026-10-05T00:00:00.000Z, has a different start, which cannot prove absence. Remove ${file} once no install of this build is running.` })
      assert.deepEqual(lockState(lock), { generation: 1, released: false }, 'no live PID mismatch grants a generation')
      assert.equal(readFileSync(file, 'utf8'), original)
      writeGeneration(lock, { pid, start: real })
      const running = await takeInstallLock(lock)
      assert.match(running.ok ? '' : running.message, new RegExp(`^Another Retest process \\(pid ${pid}, started as "a stand-in installer", since 2026-10-05T00:00:00\\.000Z\\) holds the install lock ${escape(lock)}`))
      writeGeneration(lock, { pid, start: { ...real, value: real.value + 100 } })
      const unsure = await takeInstallLock(lock)
      assert.deepEqual(unsure, { ok: false, message: `The process now under pid ${pid}, which has held the install lock ${lock} since 2026-10-05T00:00:00.000Z, has a different start, which cannot prove absence. Remove ${join(lock, '3.json')} once no install of this build is running.` })
      assert.deepEqual(lockState(lock), { generation: 3, released: false })
      if (process.platform === 'darwin') {
        // A `ps` that cannot answer: the holder stays, whatever process its pid has now.
        const ps = join(tempFolder('retest-unreadable-ps-'), 'ps')
        writeFileSync(ps, '#!/bin/sh\necho "ps: the process table cannot be read" >&2\nexit 2\n')
        chmodSync(ps, 0o755)
        writeGeneration(lock, { pid, start: real })
        const own = await startOf(process.pid)
        const failing = startReader({ platform: 'darwin', tools: { ...systemTools, ps } })
        const unknown = await takeInstallLock(lock, { readStart: async (asked) => (asked === process.pid ? { state: 'present', start: own } : failing(asked)) })
        assert.match(unknown.ok ? '' : unknown.message, new RegExp(`^Retest could not read whether the process holding the install lock ${escape(lock)} \\(pid ${pid}, since 2026-10-05T00:00:00\\.000Z\\) still runs \\(.+\\), so it leaves that lock alone\\.`))
      }
    })
    const after = await takeWhenFree(lock)
    assert.equal(lockState(lock).released, false, 'once the stand-in process ended, its generation was passed over')
    await after.release()
  })

  test('names a file where the lock\'s folder belongs, and leaves it there', async () => {
    const lock = newLock()
    writeFileSync(lock, 'left by something else')
    const refused = await takeInstallLock(lock)
    assert.deepEqual(refused, { ok: false, message: `${lock}, where the install lock is kept, is a file, not a folder. Remove it once no install of this build runs, then run the install again.` })
    assert.equal(readFileSync(lock, 'utf8'), 'left by something else')
  })

  // A pid means nothing on another machine or in another container: a cache shared with one is refused, never judged.
  test('refuses a generation of another machine or container by name, whatever its pid is here, and leaves that machine\'s hidden files alone', async () => {
    const lock = newLock()
    const pid = gonePid()
    writeGeneration(lock, { pid, start: { clock: 'boot-ticks', value: 1 }, machine: 'linux boot 00000000-0000-0000-0000-000000000000 pid:[4026531836]', host: 'build-box' })
    const ours = createHash('sha256').update(machine.ok ? machine.machine.id : '').digest('hex').slice(0, 12)
    const theirs = createHash('sha256').update('another machine').digest('hex').slice(0, 12)
    writeFileSync(join(lock, `.${theirs}-${pid}-abcdef.tmp`), 'another machine is writing this')
    writeFileSync(join(lock, `.${ours}-${pid}-abcdef.tmp`), 'a gone writer of this machine left this')
    const refused = await takeInstallLock(lock)
    assert.match(refused.ok ? '' : refused.message, new RegExp(`^The install lock ${escape(lock)} is held from another machine or container \\(build-box, pid ${pid}, since 2026-10-05T00:00:00\\.000Z\\), whose processes Retest cannot see, so it leaves that lock alone\\. Retest keeps one install at a time on one machine, and does not coordinate a cache shared between machines or containers`))
    assert.equal(existsSync(join(lock, `.${theirs}-${pid}-abcdef.tmp`)), true, "another machine's hidden file is left alone")
    assert.equal(existsSync(join(lock, `.${ours}-${pid}-abcdef.tmp`)), false, "this machine's gone writer's hidden file is removed")
  })

  test('a release frees only its own generation: one made again under its number, after the folder was removed, stays held', async () => {
    const lock = newLock()
    const first = await takeInstallLock(lock)
    assert.ok(first.ok, first.ok ? '' : first.message)
    rmSync(lock, { recursive: true })
    const holder = await holdLockInChild(lock)
    try {
      assert.equal(lockState(lock).generation, 1, 'the other process made generation 1 again')
      assert.equal(await first.release(), `The install lock ${lock} no longer holds this process's generation 1, so nothing there was let go.`)
      const refused = await takeInstallLock(lock)
      assert.match(refused.ok ? '' : refused.message, new RegExp(`^Another Retest process \\(pid ${holder.pid}, `), 'the late release freed nothing')
    } finally {
      await holder.release()
    }
  })

  test('a folder that cannot be read, or a gone writer\'s file that cannot be removed, is a refusal by name, not a thrown error', async () => {
    const lock = newLock()
    mkdirSync(lock)
    chmodSync(lock, 0o000)
    try {
      const unreadable = await takeInstallLock(lock)
      assert.match(unreadable.ok ? '' : unreadable.message, new RegExp(`^Retest could not read the install lock ${escape(lock)}: `))
    } finally {
      chmodSync(lock, 0o755)
    }
    const ours = createHash('sha256').update(machine.ok ? machine.machine.id : '').digest('hex').slice(0, 12)
    writeFileSync(join(lock, `.${ours}-${gonePid()}-abcdef.tmp`), 'a gone writer left this')
    chmodSync(lock, 0o555)
    try {
      const stuck = await takeInstallLock(lock)
      assert.match(stuck.ok ? '' : stuck.message, new RegExp(`^Retest could not remove \\.${ours}-\\d+-abcdef\\.tmp, which a gone install left in the install lock ${escape(lock)}: `))
    } finally {
      chmodSync(lock, 0o755)
    }
  })

  test('a stop while a process\'s start is read ends the take at once, as stopped', { skip: process.platform === 'darwin' ? false : 'the slow reading is a stand-in ps, which only the macOS route runs' }, async () => {
    const lock = newLock()
    // This stand-in answers nothing for 30 seconds. Its command stays the same from launch through cancellation;
    // a shell that execs sleep can be captured before exec and correctly refused later as a changed identity.
    const ps = join(tempFolder('retest-slow-ps-'), 'ps')
    writeFileSync(ps, `#!${process.execPath}\nsetTimeout(() => {}, 30_000)\n`)
    chmodSync(ps, 0o755)
    const controller = new AbortController()
    const stop = setTimeout(() => controller.abort(), 300)
    try {
      const began = Date.now()
      const result = await takeInstallLock(lock, { tools: { ...systemTools, ps }, signal: controller.signal })
      assert.deepEqual(result, { ok: false, message: `The install was stopped while it took the install lock ${lock}.`, stopped: true })
      assert.ok(Date.now() - began < 5000, `the take ended at the stop, not when ps would have, after ${Date.now() - began} ms`)
      assert.deepEqual(visible(lock), [], 'nothing was made')
    } finally {
      clearTimeout(stop)
    }
  })

  test('keeps only the newest two generations however many installs there were, and a slow taker never holds a generation made again under an old number', { timeout: 30_000 }, async () => {
    const lock = newLock()
    for (let round = 1; round <= 12; round += 1) {
      const taken = await takeInstallLock(lock)
      assert.ok(taken.ok, taken.ok ? '' : taken.message)
      await taken.release()
    }
    assert.deepEqual(lockState(lock), { generation: 12, released: true })
    assert.deepEqual(visible(lock).map((name) => name.split('.')[0]), ['11', '11', '12', '12'], 'two generations and their marks are left')
    // A taker that read generation 13 as the newest and judged its holder gone, then waited while three installs made
    // and removed generations after it: the name it then makes was removed already, and it must not hold the lock.
    await withStandIn(async (pid, stop) => {
      const goneHolder = writeGeneration(lock, { pid, start: await startOf(pid) })
      let paused = false
      const slow = await takeInstallLock(lock, {
        readStart: async (pid) => {
          if (pid !== process.pid && !paused) {
            paused = true
            await stop()
            for (let round = 1; round <= 3; round += 1) {
              const meanwhile = await takeInstallLock(lock)
              assert.ok(meanwhile.ok, meanwhile.ok ? '' : meanwhile.message)
              await meanwhile.release()
            }
          }
          return readStart(pid)
        },
      })
      assert.equal(paused, true, 'the live holder reading entered the controlled race')
      assert.ok(slow.ok, slow.ok ? '' : slow.message)
      assert.deepEqual(lockState(lock), { generation: goneHolder + 4, released: false }, 'the slow taker stepped back from the old number and holds the newest generation')
      const next = await takeInstallLock(lock)
      assert.equal(next.ok, false, 'nobody else holds it beside the slow taker')
      await slow.release()
    })
  })
})
