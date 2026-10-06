import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { ChildProcess, spawn } from 'node:child_process'
import { once } from 'node:events'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { DesktopLock, takeDesktopLock } from '../../src/native/desktop-lock.ts'
import { systemTools } from '../../src/native/processes.ts'
import { NativeError } from '../../src/native/session.ts'
import { isPlainObject } from '../../src/protocol/schema.ts'
import { alive } from './native-fake-executor.ts'
import { endedPid, fakeTools, processStart } from './native-fake-tools.ts'

// The desktop lock stands on the kernel lock `lockf` takes, which only macOS and the BSDs ship at /usr/bin/lockf.
const darwinOnly = { skip: process.platform === 'darwin' ? false : 'the desktop lock runs only on macOS' }

const lockModule = fileURLToPath(new URL('../../src/native/desktop-lock.ts', import.meta.url))
const toolsModule = fileURLToPath(new URL('../../src/native/processes.ts', import.meta.url))

async function folder(t: TestContext): Promise<string> {
  const made = await mkdtemp(join(tmpdir(), 'retest-native-lock-'))
  t.after(() => rm(made, { recursive: true, force: true }))
  return made
}

type Racer = { readonly said: Promise<{ readonly took: boolean; readonly message: string }>; readonly pid: number; readonly exited: Promise<void>; end(): void; noteAfterTakeover(): Promise<string> }

// A process that waits for a shared moment, tries to take the lock, says how it went, and stays alive holding it
// until told to go. Told `note`, it tries to write the record and says whether that worked.
async function racer(t: TestContext, root: string, lock: string, at: number): Promise<Racer> {
  const script = join(root, `racer-${Math.random().toString(36).slice(2)}.ts`)
  await writeFile(script, [
    `import { takeDesktopLock } from ${JSON.stringify(lockModule)}`,
    `import { systemTools } from ${JSON.stringify(toolsModule)}`,
    `while (Date.now() < ${at}) {}`,
    `const taken = await takeDesktopLock({ path: ${JSON.stringify(lock)}, tools: systemTools })`,
    "process.stdout.write(JSON.stringify({ took: taken.ok, message: taken.ok ? '' : taken.failure.message }) + '\\n')",
    "process.stdin.setEncoding('utf8').on('data', (line) => {",
    "  if (line.startsWith('note') && taken.ok) {",
    "    try { taken.lock.note({ runnerApps: [] }); process.stdout.write('noted\\n') } catch (error) { process.stdout.write(`refused: ${error.message}\\n`) }",
    '    return',
    '  }',
    '  process.exit(0)',
    '})',
  ].join('\n'))
  const child = spawn(process.execPath, ['--conditions=retest-source', script], { stdio: ['pipe', 'pipe', 'inherit'] })
  t.after(() => child.kill('SIGKILL'))
  const lines: string[] = []
  const waiting: ((line: string) => void)[] = []
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    for (const line of chunk.split('\n').filter((part) => part.length > 0)) {
      const next = waiting.shift()
      if (next === undefined) lines.push(line)
      else next(line)
    }
  })
  const nextLine = (): Promise<string> => {
    const ready = lines.shift()
    if (ready !== undefined) return Promise.resolve(ready)
    return new Promise((resolve) => waiting.push(resolve))
  }
  const said = nextLine().then((line) => {
    const value: unknown = JSON.parse(line)
    return isPlainObject(value) ? { took: value['took'] === true, message: typeof value['message'] === 'string' ? value['message'] : '' } : { took: false, message: line }
  })
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  return {
    said,
    pid: child.pid ?? 0,
    exited,
    end: () => child.stdin.write('go\n'),
    noteAfterTakeover: () => {
      child.stdin.write('note\n')
      return nextLine()
    },
  }
}

async function recordOf(lock: string): Promise<Record<string, unknown> | undefined> {
  const text = await readFile(lock.replace(/\.lock$/, '.json'), 'utf8').catch(() => '')
  if (text.length === 0) return undefined
  const value: unknown = JSON.parse(text)
  return isPlainObject(value) ? value : undefined
}

test('four processes taking the desktop at once: exactly one holds it, every time, and the record names it', darwinOnly, async (t) => {
  const root = await folder(t)
  for (let round = 0; round < 6; round += 1) {
    const lock = join(root, `desktop-${round}.lock`)
    const at = Date.now() + 1500
    const racers = await Promise.all([0, 1, 2, 3].map(() => racer(t, root, lock, at)))
    const said = await Promise.all(racers.map((entry) => entry.said))
    assert.equal(said.filter((entry) => entry.took).length, 1, `round ${round}: ${JSON.stringify(said)}`)
    const winner = racers[said.findIndex((entry) => entry.took)]
    assert.equal((await recordOf(lock))?.['pid'], winner?.pid, 'the record names the process that holds the lock')
    for (const [index, entry] of said.entries()) if (!entry.took) assert.match(entry.message, /Another (Retest )?process/, `racer ${index}`)
    for (const entry of racers) entry.end()
    await Promise.all(racers.map((entry) => entry.exited))
  }
})

test('a refusal names the live holder by pid, how it was started and when it took the desktop', darwinOnly, async (t) => {
  const root = await folder(t)
  const lock = join(root, 'desktop.lock')
  const holder = await racer(t, root, lock, Date.now())
  assert.equal((await holder.said).took, true)
  const refused = await takeDesktopLock({ path: lock, tools: systemTools })
  assert.equal(refused.ok, false)
  const message = !refused.ok ? refused.failure.message : ''
  assert.match(message, new RegExp(`Another Retest process \\(pid ${holder.pid}, started as ".*racer-.*\\.ts" at \\d{4}-\\d\\d-\\d\\dT`))
  holder.end()
  await holder.exited
})

test('a desktop this process holds says so, and a mismatched record with its live pid is refused by name', darwinOnly, async (t) => {
  const root = await folder(t)
  const lock = join(root, 'desktop.lock')
  const first = await takeDesktopLock({ path: lock, tools: systemTools })
  assert.ok(first.ok)
  if (!first.ok) return
  t.after(() => first.lock.release())
  const second = await takeDesktopLock({ path: lock, tools: systemTools })
  assert.match(!second.ok ? second.failure.message : '', /This process already holds the desktop lock/)
  await first.lock.release()
  // Presence wins over a mismatched or missing start, for both current and legacy records.
  const file = join(root, 'desktop.json')
  for (const startTimeVersion of [1, undefined]) {
    const original = JSON.stringify({ ...(startTimeVersion === undefined ? {} : { startTimeVersion }), pid: process.pid, startedAt: '2026-10-03T00:00:00.000Z', holderCommand: 'node earlier', runnerApps: [] })
    await writeFile(file, original)
    const third = await takeDesktopLock({ path: lock, tools: systemTools })
    try {
      assert.equal(third.ok, false)
      assert.equal(!third.ok && third.idle, true)
      assert.equal(third.ok ? '' : third.failure.message, startTimeVersion === 1
        ? `The Retest process recorded as the previous desktop holder (pid ${process.pid}) is present. A start-time mismatch cannot confirm it is gone. The record ${file} is kept. Remove ${file} once no runner is running.`
        : `Retest cannot confirm the recorded start time zone in the desktop record ${file}; recorded pid(s) ${process.pid} are present. The record and processes were left alone. Remove ${file} once no runner is running.`)
      assert.equal(await readFile(file, 'utf8'), original)
    } finally { if (third.ok) await third.lock.release() }
    await writeFile(file, JSON.stringify({ ...(startTimeVersion === undefined ? {} : { startTimeVersion }), pid: await endedPid(), startedAt: '2026-10-03T00:00:00.000Z', holderCommand: 'node gone', runnerApps: [] }))
    const gone = await takeDesktopLock({ path: lock, tools: systemTools })
    assert.ok(gone.ok, !gone.ok ? gone.failure.message : '')
    if (gone.ok) {
      assert.deepEqual(gone.recovered, [])
      await gone.lock.release()
    }
  }
})

test('a holder killed outright lets the desktop go at once, and the next taker recovers what its record names', darwinOnly, async (t) => {
  const fake = await fakeTools(t)
  const lock = join(fake.root, 'desktop.lock')
  const holder = await racer(t, fake.root, lock, Date.now())
  assert.equal((await holder.said).took, true)
  // The holder recorded a runner app, then died by SIGKILL, so nothing of it ran on the way out.
  const runner = spawn('sleep', ['600'], { detached: true, stdio: 'ignore' })
  t.after(() => runner.kill('SIGKILL'))
  const runnerCommand = '/Products/Debug/WebDriverAgentRunner-Runner.app/Contents/MacOS/WebDriverAgentRunner-Runner'
  await writeFile(join(fake.root, 'processes.json'), JSON.stringify([{ pid: runner.pid, command: runnerCommand }]))
  const record = await recordOf(lock)
  await writeFile(join(fake.root, 'desktop.json'), JSON.stringify({ ...record, runnerApps: [{ pid: runner.pid, command: runnerCommand, startedAt: processStart(runner.pid ?? 0) }] }))
  process.kill(holder.pid, 'SIGKILL')
  await holder.exited
  const taken = await takeDesktopLock({ path: lock, tools: fake.tools })
  assert.ok(taken.ok, !taken.ok ? taken.failure.message : '')
  if (!taken.ok) return
  t.after(() => taken.lock.release())
  assert.deepEqual(taken.recovered, [runner.pid])
  assert.equal(alive(runner.pid), false)
  assert.equal((await recordOf(lock))?.['pid'], process.pid, 'the record now names the new holder')
})

test('stale recovery ends recorded pids but refuses a group with unrecorded members', darwinOnly, async (t) => {
  const fake = await fakeTools(t)
  const lock = join(fake.root, 'desktop.lock')
  const runner = spawn('sleep', ['600'], { detached: true, stdio: 'ignore' })
  const xcodebuild = spawn('/bin/sh', ['-c', 'sleep 600 & wait'], { detached: true, stdio: 'ignore' })
  const stranger = spawn('sleep', ['600'], { detached: true, stdio: 'ignore' })
  t.after(() => {
    for (const child of [runner, stranger]) child.kill('SIGKILL')
    try {
      if (xcodebuild.pid !== undefined) process.kill(-xcodebuild.pid, 'SIGKILL')
    } catch {
      // The group is gone already, which is what the test wants.
    }
  })
  const listed = [
    { pid: runner.pid, command: '/Products/Debug/WebDriverAgentRunner-Runner.app/Contents/MacOS/WebDriverAgentRunner-Runner' },
    { pid: xcodebuild.pid, command: 'xcodebuild test-without-building -xctestrun /a.xctestrun -destination platform=macOS' },
    // Another start's runner of the same build: the gone holder recorded its pid, yet its command line differs now.
    { pid: stranger.pid, command: '/Products/Debug/WebDriverAgentRunner-Runner.app/Contents/MacOS/WebDriverAgentRunner-Runner -other' },
  ]
  await writeFile(join(fake.root, 'processes.json'), JSON.stringify(listed))
  const started = (pid: number | undefined): string => processStart(pid ?? 0)
  const holder = await endedPid()
  await writeFile(join(fake.root, 'desktop.json'), JSON.stringify({ startTimeVersion: 1, pid: holder, startedAt: '2026-10-03T00:00:00.000Z', holderCommand: 'node gone', holderStartedAt: 'Sat Oct 3 00:00:00 2026', xcodebuild: { ...listed[1], startedAt: started(xcodebuild.pid) }, runnerApps: [{ ...listed[0], startedAt: started(runner.pid) }, { pid: stranger.pid, command: listed[0]?.command, startedAt: started(stranger.pid) }] }))
  const refused = await takeDesktopLock({ path: lock, tools: fake.tools })
  assert.equal(refused.ok, false)
  assert.match(!refused.ok ? refused.failure.message : '', /still has members whose launch ownership was not recorded; Retest left them alone/)
  assert.equal(alive(runner.pid), false)
  assert.equal(alive(xcodebuild.pid), false, 'only the persisted leader pid was ended')
  assert.equal(alive(stranger.pid), true, 'a process whose command line is not the recorded one is left alone')
  assert.equal((await recordOf(lock))?.['pid'], holder, 'the old record stays until its unrecorded members are gone')
})

test('a gone holder\'s record is kept, and the desktop refused, until what it names is confirmed ended', darwinOnly, async (t) => {
  const fake = await fakeTools(t)
  await fake.configure({ psFails: true })
  const lock = join(fake.root, 'desktop.lock')
  const left = { startTimeVersion: 1, pid: await endedPid(), startedAt: '2026-10-03T00:00:00.000Z', holderCommand: 'node gone', runnerApps: [{ pid: 1234, command: 'x' }] }
  await writeFile(join(fake.root, 'desktop.json'), JSON.stringify(left))
  const refused = await takeDesktopLock({ path: lock, tools: fake.tools })
  assert.match(!refused.ok ? refused.failure.message : '', new RegExp(`could not read whether the Retest process that held the desktop before \\(pid ${left.pid}\\) still runs.*The record`))
  assert.deepEqual(await recordOf(lock), left, 'a failed holder identity reading does not release the record')
  await fake.configure({})
  const ps = join(fake.root, 'runner-reading-ps')
  await writeFile(ps, `#!/bin/sh\nif [ \"$5\" = \"1234\" ]; then echo \"ps: could not run\" >&2; exit 1; fi\nexec \"${fake.tools.ps}\" \"$@\"\n`)
  await chmod(ps, 0o755)
  const runnerRefused = await takeDesktopLock({ path: lock, tools: { ...fake.tools, ps } })
  assert.match(!runnerRefused.ok ? runnerRefused.failure.message : '', /could not read whether pid 1234 is still running.*is kept, so a later start can try again/)
  assert.deepEqual(await recordOf(lock), left, 'the record still names what is left')
  // Once the processes can be read, a later start finds pid 1234 gone and takes the desktop.
  await fake.configure({})
  const taken = await takeDesktopLock({ path: lock, tools: fake.tools })
  assert.ok(taken.ok, !taken.ok ? taken.failure.message : '')
  if (taken.ok) await taken.lock.release()
})

test('a runner app the gone holder never tied to its start is named and never ended, and its record kept until it is gone', darwinOnly, async (t) => {
  const fake = await fakeTools(t)
  const lock = join(fake.root, 'desktop.lock')
  const untied = spawn('sleep', ['600'], { detached: true, stdio: 'ignore' })
  t.after(() => untied.kill('SIGKILL'))
  const command = '/Products/Debug/WebDriverAgentRunner-Runner.app/Contents/MacOS/WebDriverAgentRunner-Runner'
  await writeFile(join(fake.root, 'processes.json'), JSON.stringify([{ pid: untied.pid, command }]))
  await writeFile(join(fake.root, 'desktop.json'), JSON.stringify({ startTimeVersion: 1, pid: await endedPid(), startedAt: '2026-10-03T00:00:00.000Z', holderCommand: 'node gone', runnerApps: [], untied: [{ pid: untied.pid, command, startedAt: processStart(untied.pid ?? 0) }] }))
  const refused = await takeDesktopLock({ path: lock, tools: fake.tools })
  assert.match(!refused.ok ? refused.failure.message : '', new RegExp(`A runner app \\(pid ${untied.pid}\\) appeared during that process's start, which ended before tying it to the start, so Retest did not end it`))
  assert.equal(alive(untied.pid), true)
  untied.kill('SIGKILL')
  await new Promise((resolve) => untied.once('exit', resolve))
  const taken = await takeDesktopLock({ path: lock, tools: fake.tools })
  assert.ok(taken.ok, !taken.ok ? taken.failure.message : '')
  if (taken.ok) await taken.lock.release()
})

test('a record Retest cannot read is never overwritten, and the desktop is refused by name', darwinOnly, async (t) => {
  const root = await folder(t)
  const lock = join(root, 'desktop.lock')
  await writeFile(join(root, 'desktop.json'), '{"pid": "not a number"')
  const refused = await takeDesktopLock({ path: lock, tools: systemTools })
  assert.match(!refused.ok ? refused.failure.message : '', /is not one Retest can read/)
  assert.equal(await readFile(join(root, 'desktop.json'), 'utf8'), '{"pid": "not a number"')
  // The lock was let go with the refusal: another taker is refused for the same reason, not for a held lock.
  const again = await takeDesktopLock({ path: lock, tools: systemTools })
  assert.match(!again.ok ? again.failure.message : '', /is not one Retest can read/)
})

test('a holder writes the record only while it holds the lock and the record is its own', darwinOnly, async (t) => {
  const root = await folder(t)
  const lock = join(root, 'desktop.lock')
  const taken = await takeDesktopLock({ path: lock, tools: systemTools })
  assert.ok(taken.ok)
  if (!taken.ok) return
  taken.lock.note({ runnerApps: [{ pid: 4242, command: 'runner' }] })
  assert.deepEqual((await recordOf(lock))?.['runnerApps'], [{ pid: 4242, command: 'runner' }])
  // Something replaced the record: this holder no longer writes it.
  await writeFile(join(root, 'desktop.json'), JSON.stringify({ startTimeVersion: 1, pid: 99, startedAt: '2026-10-04T00:00:00.000Z', holderCommand: 'other', runnerApps: [] }))
  assert.throws(() => taken.lock.note({ runnerApps: [] }), /is not this process's/)
  await taken.lock.release()
  assert.equal((await recordOf(lock))?.['pid'], 99, 'a record that is not this holder\'s is not removed on release')
  assert.throws(() => taken.lock.note({ runnerApps: [] }), /already let go/)
})

test('a racer that took over keeps writing its own record while the others stay refused', darwinOnly, async (t) => {
  const root = await folder(t)
  const lock = join(root, 'desktop.lock')
  await writeFile(join(root, 'desktop.json'), JSON.stringify({ startTimeVersion: 1, pid: await endedPid(), startedAt: '2026-10-03T00:00:00.000Z', holderCommand: 'node gone', runnerApps: [] }))
  const at = Date.now() + 1500
  const racers = await Promise.all([0, 1, 2].map(() => racer(t, root, lock, at)))
  const said = await Promise.all(racers.map((entry) => entry.said))
  assert.equal(said.filter((entry) => entry.took).length, 1, JSON.stringify(said))
  const winner = racers[said.findIndex((entry) => entry.took)]
  assert.equal(await winner?.noteAfterTakeover(), 'noted')
  await sleep(50)
  assert.equal((await recordOf(lock))?.['pid'], winner?.pid)
  for (const entry of racers) entry.end()
  await Promise.all(racers.map((entry) => entry.exited))
})

// No process or kernel lock is started: the fake only supplies the pipe and exit events of a holder.
async function fakeDesktopLock(t: TestContext) {
  const root = await folder(t)
  const holder = new ChildProcess()
  Object.defineProperty(holder, 'pid', { value: 6001 })
  const input = new PassThrough()
  Object.defineProperty(holder, 'stdin', { value: input })
  const signaled = t.mock.method(holder, 'kill', () => true)
  const lock = new DesktopLock(join(root, 'desktop.lock'), holder, { pid: process.pid, startedAt: '2026-10-04T00:00:00.000Z', holderCommand: 'node fake-owner', runnerApps: [] })
  await writeFile(lock.recordPath, JSON.stringify(lock.record))
  return { holder, input, signaled, lock }
}

test('release waits for the holder exit and leaves its record for the next kernel holder', async (t) => {
  const { holder, input, signaled, lock } = await fakeDesktopLock(t)
  const releasing = lock.release()
  assert.strictEqual(lock.release(), releasing, 'concurrent callers share the same cleanup')
  assert.equal(input.destroyed, true, 'closing the pipe asks the holder to exit')
  assert.deepEqual(await recordOf(lock.path), lock.record, 'the pending cleanup keeps its record')
  Object.defineProperty(holder, 'exitCode', { value: 0 })
  holder.emit('exit', 0, null)
  await releasing
  assert.deepEqual(await recordOf(lock.path), lock.record, 'the next kernel holder recovers the stale record')
  assert.equal(signaled.mock.callCount(), 0, 'cooperative cleanup sends no signal')
})

test('an unanswered holder exit is cleanup_failed, retains its record, and remains failed on repeated release', async (t) => {
  const { holder, signaled, lock } = await fakeDesktopLock(t)
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const releasing = lock.release()
  const failure = assert.rejects(releasing, (error: unknown) => {
    assert.ok(error instanceof NativeError)
    assert.equal(error.failure.class, 'cleanup_failed')
    assert.match(error.message, /did not confirm its exit.*record .* is kept/)
    return true
  })
  t.mock.timers.tick(5000)
  await failure
  assert.deepEqual(await recordOf(lock.path), lock.record)
  assert.equal(signaled.mock.callCount(), 0, 'the deadline does not authorize a SIGKILL')
  assert.strictEqual(lock.release(), releasing, 'a failed cleanup never becomes a silent success')
  Object.defineProperty(holder, 'exitCode', { value: 0 })
  holder.emit('exit', 0, null)
  await assert.rejects(lock.release(), /did not confirm its exit/)
  assert.deepEqual(await recordOf(lock.path), lock.record, 'a late exit leaves recovery to the next holder')
})

test('a failed pipe close reports cleanup_failed without signaling or removing the record', async (t) => {
  const { input, signaled, lock } = await fakeDesktopLock(t)
  t.mock.method(input, 'destroy', () => { throw new Error('pipe close failed') })
  const releasing = lock.release()
  await assert.rejects(releasing, (error: unknown) => {
    assert.ok(error instanceof NativeError)
    assert.equal(error.failure.class, 'cleanup_failed')
    assert.match(error.message, /pipe close failed.*record .* is kept/)
    return true
  })
  assert.strictEqual(lock.release(), releasing)
  assert.deepEqual(await recordOf(lock.path), lock.record)
  assert.equal(signaled.mock.callCount(), 0)
})

test('an exit hook leaves both unconfirmed and exited holder records for the next kernel holder', async (t) => {
  const pending = await fakeDesktopLock(t)
  pending.lock.releaseNow()
  assert.equal(pending.input.destroyed, true)
  assert.deepEqual(await recordOf(pending.lock.path), pending.lock.record)
  assert.equal(pending.signaled.mock.callCount(), 0)
  const ended = await fakeDesktopLock(t)
  Object.defineProperty(ended.holder, 'exitCode', { value: 0 })
  ended.holder.emit('exit', 0, null)
  ended.lock.releaseNow()
  assert.deepEqual(await recordOf(ended.lock.path), ended.lock.record)
  assert.equal(ended.signaled.mock.callCount(), 0)
})

test('a holder clears its record once everything it named ended, and keeps naming itself', darwinOnly, async (t) => {
  const root = await folder(t)
  const lock = join(root, 'desktop.lock')
  const taken = await takeDesktopLock({ path: lock, tools: systemTools })
  assert.ok(taken.ok, !taken.ok ? taken.failure.message : '')
  if (!taken.ok) return
  t.after(() => taken.lock.release())
  taken.lock.note({ xcodebuild: { pid: 4241, command: 'xcodebuild test-without-building', startedAt: 'Mon Oct 5 09:00:00 2026' }, runnerApps: [{ pid: 4242, command: 'runner', startedAt: 'Mon Oct 5 09:00:01 2026' }], untied: [] })
  taken.lock.clear()
  const record = await recordOf(lock)
  assert.equal(record?.['pid'], process.pid)
  assert.equal(record?.['holderStartedAt'], processStart(process.pid), 'the holder names itself by pid and start')
  assert.deepEqual([record?.['xcodebuild'], record?.['runnerApps'], record?.['untied']], [undefined, [], []], 'no pid of the runner is left for a later start to read')
  await taken.lock.release()
  // A process group under the pid xcodebuild had no longer refuses the next start: the record names nothing.
  const leader = spawn('/bin/sleep', ['600'], { detached: true, stdio: 'ignore' })
  t.after(() => leader.kill('SIGKILL'))
  const next = await takeDesktopLock({ path: lock, tools: systemTools })
  assert.ok(next.ok, !next.ok ? next.failure.message : '')
  if (next.ok) await next.lock.release()
})

test('a record whose holder still runs is refused whole: nothing it names is ended or its group read', darwinOnly, async (t) => {
  const fake = await fakeTools(t)
  const lock = join(fake.root, 'desktop.lock')
  const runner = spawn('sleep', ['600'], { detached: true, stdio: 'ignore' })
  t.after(() => runner.kill('SIGKILL'))
  const command = '/Products/Debug/WebDriverAgentRunner-Runner.app/Contents/MacOS/WebDriverAgentRunner-Runner'
  // The holder runs, and its lock is free, as when its lock holder was ended by someone else.
  const holder = spawn('sleep', ['600'], { stdio: 'ignore' })
  t.after(() => holder.kill('SIGKILL'))
  await writeFile(join(fake.root, 'processes.json'), JSON.stringify([{ pid: runner.pid, command }, { pid: holder.pid, command: 'node holder' }]))
  const record = { startTimeVersion: 1, pid: holder.pid, startedAt: '2026-10-03T00:00:00.000Z', holderCommand: 'node holder', holderStartedAt: processStart(holder.pid ?? 0), xcodebuild: { pid: runner.pid, command, startedAt: processStart(runner.pid ?? 0) }, runnerApps: [{ pid: runner.pid, command, startedAt: processStart(runner.pid ?? 0) }] }
  await writeFile(join(fake.root, 'desktop.json'), JSON.stringify(record))
  const refused = await takeDesktopLock({ path: lock, tools: fake.tools })
  assert.equal(!refused.ok ? refused.failure.message : '', `The Retest process recorded as the previous desktop holder (pid ${holder.pid}) is present. A start-time mismatch cannot confirm it is gone. The record ${join(fake.root, 'desktop.json')} is kept. Remove ${join(fake.root, 'desktop.json')} once no runner is running.`)
  assert.equal((await fake.calls()).some(call => call.tool === 'ps' && (call.args.includes(String(runner.pid)) || call.args.includes('-g'))), false, 'no runner identity or group read follows a live-holder refusal')
  assert.equal(!refused.ok && refused.idle, true, 'the refusal let the lock go and started nothing')
  assert.equal(alive(runner.pid), true, 'a running holder\'s runner is not ended')
  assert.deepEqual(await recordOf(lock), record)
})

test('a process a record names without a start is never ended: recovery refuses while its command runs', darwinOnly, async (t) => {
  const fake = await fakeTools(t)
  const lock = join(fake.root, 'desktop.lock')
  const runner = spawn('sleep', ['600'], { detached: true, stdio: 'ignore' })
  t.after(() => runner.kill('SIGKILL'))
  const command = '/Products/Debug/WebDriverAgentRunner-Runner.app/Contents/MacOS/WebDriverAgentRunner-Runner'
  await writeFile(join(fake.root, 'processes.json'), JSON.stringify([{ pid: runner.pid, command }]))
  await writeFile(join(fake.root, 'desktop.json'), JSON.stringify({ startTimeVersion: 1, pid: await endedPid(), startedAt: '2026-10-03T00:00:00.000Z', holderCommand: 'node gone', runnerApps: [{ pid: runner.pid, command }] }))
  const refused = await takeDesktopLock({ path: lock, tools: fake.tools })
  assert.match(!refused.ok ? refused.failure.message : '', new RegExp(`pid ${runner.pid} runs the command line the record names, which was written before records kept a start, so Retest did not end it`))
  assert.equal(alive(runner.pid), true)
})

test('a recorded runner with a mismatched start is left alive and its record kept until its pid is absent', darwinOnly, async (t) => {
  const fake = await fakeTools(t)
  const lock = join(fake.root, 'desktop.lock')
  const runner = spawn('sleep', ['600'], { detached: true, stdio: 'ignore' })
  t.after(() => runner.kill('SIGKILL'))
  const command = '/Products/Debug/WebDriverAgentRunner-Runner.app/Contents/MacOS/WebDriverAgentRunner-Runner'
  await writeFile(join(fake.root, 'processes.json'), JSON.stringify([{ pid: runner.pid, command }]))
  const file = join(fake.root, 'desktop.json')
  const original = JSON.stringify({ startTimeVersion: 1, pid: await endedPid(), startedAt: '2026-10-03T00:00:00.000Z', holderCommand: 'node gone', runnerApps: [{ pid: runner.pid, command, startedAt: 'Thu Jan 1 00:00:00 1970' }] })
  await writeFile(file, original)
  const refused = await takeDesktopLock({ path: lock, tools: fake.tools })
  assert.equal(refused.ok, false)
  assert.equal(!refused.ok && refused.idle, true)
  assert.ok((!refused.ok ? refused.failure.message : '').includes(`pid ${runner.pid} is present with a different identity; Retest left it alone. Remove ${file} once no runner is running.`))
  assert.equal(await readFile(file, 'utf8'), original)
  assert.equal(alive(runner.pid), true, 'the same command line under another start is not the recorded runner app')
  const ended = once(runner, 'exit')
  runner.kill('SIGKILL')
  await ended
  const gone = await takeDesktopLock({ path: lock, tools: fake.tools })
  assert.ok(gone.ok, !gone.ok ? gone.failure.message : '')
  if (gone.ok) await gone.lock.release()
})

test('a refusal because another process holds the desktop says it left nothing behind', darwinOnly, async (t) => {
  const root = await folder(t)
  const lock = join(root, 'desktop.lock')
  const holder = await racer(t, root, lock, Date.now())
  assert.equal((await holder.said).took, true)
  const refused = await takeDesktopLock({ path: lock, tools: systemTools })
  assert.deepEqual(!refused.ok && [refused.failure.class, refused.idle], ['setup_failed', true])
  holder.end()
  await holder.exited
})
