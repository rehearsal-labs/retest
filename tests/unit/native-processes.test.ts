import type { TestContext } from 'node:test'
import type { MetadataProcessRequest } from '../../src/shared/metadata-process.ts'
import type { ListedProcess, NativeTools } from '../../src/native/processes.ts'
import type { OwnedProcessIdentity } from '../../src/shared/process-ownership.ts'
import assert from 'node:assert/strict'
import { ChildProcess, execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { openSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { Worker } from 'node:worker_threads'
import { freeOnLoopback, freePort, selectedXcodebuild, watchExecutor, xcodebuildShim } from '../../src/native/executor-process.ts'
import { commandOf, endProblem, endRecorded, killRecordedNow, listProcesses, OwnedProcess, processExists, readProcessTable, runCommand, systemTools, terminationGraceMs } from '../../src/native/processes.ts'
import { makeOwnedFolder, sweepOwnedFolders } from '../../src/native/temporary-folders.ts'
import { metadataComplete, metadataOutputLimit, metadataSuccess, processTableOutputLimit, readMetadataProcess } from '../../src/shared/metadata-process.ts'
import { OwnedProcessGroup } from '../../src/shared/process-ownership.ts'
import { endedPid, processStart } from './native-fake-tools.ts'

// A start reading as `ps` prints it, for stand-in `ps` scripts, and as Retest records it, one-spaced.
const shownStart = 'Mon Oct  5 09:00:00 2026'
const recordedStart = 'Mon Oct 5 09:00:00 2026'

// A metadata fixture changes its command after launch and records any SIGTERM. Only the test ends this child.
async function unansweredMetadata(t: TestContext, overflow: boolean): Promise<{ readonly path: string; readonly folder: string }> {
  const folder = await mkdtemp(join(tmpdir(), 'retest-native-metadata-'))
  const path = join(folder, 'ps.mjs')
  const realKill = process.kill.bind(process)
  await writeFile(path, [
    `#!${process.execPath}`,
    "import { writeFileSync } from 'node:fs'",
    `const folder = ${JSON.stringify(folder)}`,
    "process.title = 'retest-metadata-command-changed'",
    "writeFileSync(folder + '/pid', String(process.pid))",
    "process.on('SIGTERM', () => writeFileSync(folder + '/term', 'received'))",
    "process.stdout.on('error', () => {})",
    "process.stderr.on('error', () => {})",
    "setInterval(() => {}, 1000)",
    overflow
      ? `process.stdout.write('/recorded/process\\n', () => process.stderr.write(Buffer.alloc(${metadataOutputLimit + 1}, 'x')))`
      : "process.stdout.write('/recorded/process\\n')",
  ].join('\n'))
  await chmod(path, 0o700)
  t.after(async () => {
    try {
      const pid = Number(await readFile(join(folder, 'pid'), 'utf8'))
      if (!Number.isSafeInteger(pid) || pid < 2) throw new Error('The metadata fixture did not record its pid.')
      try { realKill(pid, 'SIGKILL') } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error
      }
      // The worker observes close before accepting another query. Wait for this test's child to be reaped.
      for (let tries = 0; tries < 200; tries += 1) {
        try { realKill(pid, 0) } catch (error) {
          if (error instanceof Error && 'code' in error && error.code === 'ESRCH') break
          throw error
        }
        await sleep(25)
      }
      await sleep(25)
    } finally { await rm(folder, { recursive: true, force: true }) }
  })
  return { path, folder }
}

// A `ps` of the test's own: a shell script with `body` as its text, in a folder removed after the test.
async function scriptedPs(t: TestContext, body: string): Promise<{ readonly tools: NativeTools; readonly folder: string }> {
  const folder = await mkdtemp(join(tmpdir(), 'retest-native-ps-'))
  t.after(() => rm(folder, { recursive: true, force: true }))
  const path = join(folder, 'ps')
  await writeFile(path, `#!/bin/sh\n${body.replaceAll('$FOLDER', folder)}\n`)
  await chmod(path, 0o755)
  return { tools: { ...systemTools, ps: path }, folder }
}

// A Node process that ignores SIGTERM, as an app slow to quit does; it ends only with SIGKILL.
function stubbornChild(t: TestContext): { readonly pid: number; readonly signal: Promise<NodeJS.Signals | null> } {
  const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => undefined); setInterval(() => undefined, 1000)"], { stdio: 'ignore' })
  t.after(() => child.kill('SIGKILL'))
  return { pid: child.pid ?? 0, signal: new Promise((resolve) => child.once('exit', (_code, signal) => resolve(signal))) }
}

// A shell that starts a grandchild in its own process group, writes the grandchild's pid, and waits on it forever.
const withGrandchild = (pidFile: string): string[] => ['-c', `sleep 600 & echo $! > '${pidFile}'; wait`]

// This cancellation test exercises actual process exit, without sharing the metadata worker's startup and queue
// with the parallel unit tree. Tables remain whole, and every signal still gets its immediate individual reading.
function cancellationIdentities(pid?: number): OwnedProcessIdentity[] {
  const columns = 'pid=,ppid=,pgid=,stat=,lstart=,args='
  const args = pid === undefined ? ['-ww', '-axo', columns] : ['-ww', '-o', columns, '-p', `${pid},${process.pid}`]
  const text = execFileSync('/bin/ps', args, { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', TZ: 'UTC0' } })
  const lines = text.split('\n').filter(line => line.trim() !== '')
  assert.ok(lines.length > 0, 'an empty reading cannot establish absence')
  return lines.map(line => {
    const fields = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/.exec(line)
    assert.ok(fields !== null, 'every process identity must be readable')
    const [, pid, parentPid, groupId, state, startedAt, command] = fields
    assert.ok(pid !== undefined && parentPid !== undefined && groupId !== undefined && state !== undefined && startedAt !== undefined && command !== undefined)
    return { pid: Number(pid), parentPid: Number(parentPid), groupId: Number(groupId), state, startedAt, command }
  })
}

async function grandchildPid(pidFile: string): Promise<number> {
  for (let tries = 0; tries < 100; tries += 1) {
    const text = await readFile(pidFile, 'utf8').catch(() => '')
    if (/^\d+/.test(text)) return Number.parseInt(text, 10)
    await sleep(20)
  }
  throw new Error('the grandchild never started')
}

test('successful malformed process listings are unreadable rather than empty', async (t) => {
  for (const line of ['not a process', '42', '42   ', `42 ${shownStart}`, '42 /no/start', `9007199254740992 ${shownStart} /unsafe/pid`]) {
    const { tools } = await scriptedPs(t, `printf '%s\\n' '7 ${shownStart} /valid/process' '${line}'`)
    await assert.rejects(listProcesses(tools, 5000), /ps returned an unreadable process entry/)
  }
})

test('a timed out command ends only its launched and recorded processes', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'retest-native-processes-'))
  t.after(() => rm(folder, { recursive: true, force: true }))
  const pidFile = join(folder, 'grandchild')
  const running = runCommand('/bin/sh', withGrandchild(pidFile), { timeoutMs: 400 })
  const grandchild = await grandchildPid(pidFile)
  const result = await running
  assert.equal(result.timedOut, true)
  assert.equal(result.started, true)
  assert.equal(processExists(grandchild), false, 'the grandchild went with the group')
})

test('a short command stopped by its signal is ended, and one stopped before it starts never runs', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'retest-native-processes-'))
  t.after(() => rm(folder, { recursive: true, force: true }))
  const pidFile = join(folder, 'grandchild')
  const stop = new AbortController()
  const running = runCommand('/bin/sh', withGrandchild(pidFile), {
    timeoutMs: 30_000, signal: stop.signal,
    ownershipSystem: {
      read: () => cancellationIdentities(),
      readProcess: pid => cancellationIdentities(pid).find(entry => entry.pid === pid),
      signal: (pid, signal) => { process.kill(pid, signal) },
    },
  })
  const grandchild = await grandchildPid(pidFile)
  const recorded = cancellationIdentities(grandchild).find(entry => entry.pid === grandchild)
  assert.ok(recorded !== undefined)
  t.after(async () => {
    if (processExists(grandchild)) {
      const outcome = await endRecorded(systemTools, recorded, 0)
      assert.ok(outcome === 'ended' || outcome === 'gone', `the recorded grandchild could not be confirmed ended: ${JSON.stringify(outcome)}`)
    }
  })
  stop.abort()
  const result = await running
  assert.deepEqual([result.stopped, result.timedOut], [true, false])
  assert.deepEqual(result.cleanupProblems, [], 'cancellation must confirm clean shutdown')
  assert.equal(processExists(grandchild), false)
  const never = await runCommand('/bin/sh', ['-c', `echo ran > '${join(folder, 'ran')}'`], { timeoutMs: 1000, signal: stop.signal })
  assert.deepEqual([never.started, never.stopped], [false, true])
  assert.equal(await readFile(join(folder, 'ran'), 'utf8').catch(() => 'absent'), 'absent')
})

test('a command that cannot start answers exit 127 and is not started', async () => {
  const result = await runCommand('/nonexistent/tool', [], { timeoutMs: 1000 })
  assert.deepEqual([result.code, result.started], [127, false])
})

test('a long-running process stops its recorded descendants, and its exit hook goes with them', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'retest-native-processes-'))
  t.after(() => rm(folder, { recursive: true, force: true }))
  const pidFile = join(folder, 'grandchild')
  const before = process.listenerCount('exit')
  const owned = await OwnedProcess.start({ command: '/bin/sh', args: withGrandchild(pidFile), logFile: join(folder, 'log', 'process.log') })
  assert.equal(process.listenerCount('exit'), before + 1)
  const grandchild = await grandchildPid(pidFile)
  assert.deepEqual(await owned.stop(0), [])
  assert.notEqual(owned.exit, undefined)
  assert.equal(processExists(grandchild), false)
  assert.equal(process.listenerCount('exit'), before)
})

test('a tool sees neither hidden variables nor an inherited TEST_RUNNER_ variable, and sees what it is given', async (t) => {
  process.env['RETEST_FAKE_JUDGE_KEY'] = 'judge-key-value'
  process.env['TEST_RUNNER_USE_PORT'] = '9999'
  t.after(() => {
    delete process.env['RETEST_FAKE_JUDGE_KEY']
    delete process.env['TEST_RUNNER_USE_PORT']
  })
  const result = await runCommand('/usr/bin/env', [], { timeoutMs: 5000, environment: { TEST_RUNNER_USE_IP: '127.0.0.1' }, hiddenVariables: ['RETEST_FAKE_JUDGE_KEY'] })
  assert.doesNotMatch(result.stdout, /judge-key-value|RETEST_FAKE_JUDGE_KEY/)
  assert.doesNotMatch(result.stdout, /TEST_RUNNER_USE_PORT/)
  assert.match(result.stdout, /^TEST_RUNNER_USE_IP=127\.0\.0\.1$/m)
})

test('a long-running process sees neither hidden variables nor an inherited TEST_RUNNER_ variable', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'retest-native-processes-'))
  process.env['RETEST_FAKE_JUDGE_KEY'] = 'judge-key-value'
  process.env['TEST_RUNNER_MJPEG_SERVER_PORT'] = '9100'
  t.after(async () => {
    delete process.env['RETEST_FAKE_JUDGE_KEY']
    delete process.env['TEST_RUNNER_MJPEG_SERVER_PORT']
    await rm(folder, { recursive: true, force: true })
  })
  const logFile = join(folder, 'env.log')
  const owned = await OwnedProcess.start({ command: '/usr/bin/env', args: [], logFile, environment: { TEST_RUNNER_USE_PORT: '51815' }, hiddenVariables: ['RETEST_FAKE_JUDGE_KEY'] })
  await owned.waitForExit(5000)
  const logged = await readFile(logFile, 'utf8')
  assert.doesNotMatch(logged, /judge-key-value|TEST_RUNNER_MJPEG_SERVER_PORT/)
  assert.match(logged, /^TEST_RUNNER_USE_PORT=51815$/m)
})

test('an inherited SIMCTL_CHILD_ variable never reaches a tool, so simctl passes none to an app on its own', async (t) => {
  process.env['SIMCTL_CHILD_RETEST_FAKE'] = 'leaked'
  t.after(() => {
    delete process.env['SIMCTL_CHILD_RETEST_FAKE']
  })
  const result = await runCommand('/usr/bin/env', [], { timeoutMs: 5000 })
  assert.doesNotMatch(result.stdout, /SIMCTL_CHILD_RETEST_FAKE/)
})

test('an exit-hook kill ends a recorded process with SIGKILL only while its command line is the recorded one', async (t) => {
  const child = spawn('/bin/sleep', ['601'], { stdio: 'ignore' })
  t.after(() => child.kill('SIGKILL'))
  const pid = child.pid ?? 0
  const ended = new Promise<NodeJS.Signals | null>((resolve) => child.once('exit', (_code, signal) => resolve(signal)))
  await sleep(100)
  killRecordedNow([{ pid, command: '/bin/sleep 999' }], systemTools)
  await sleep(100)
  assert.equal(processExists(pid), true, 'a pid whose command line is another is left alone')
  killRecordedNow([{ pid, command: '/bin/sleep 601' }], systemTools)
  const signal = await Promise.race([ended, sleep(5000, 'still running')])
  assert.equal(signal, 'SIGKILL')
  assert.equal(processExists(pid), false)
})

test('the exit-hook kill runs ps without the hidden variables', async (t) => {
  const { tools, folder } = await scriptedPs(t, 'env > "$FOLDER/env.txt"\nexec /bin/ps "$@"')
  process.env['RETEST_FAKE_JUDGE_KEY'] = 'judge-key-value'
  t.after(() => {
    delete process.env['RETEST_FAKE_JUDGE_KEY']
  })
  killRecordedNow([{ pid: process.pid, command: 'not this process' }], { ps: tools.ps, hiddenVariables: ['RETEST_FAKE_JUDGE_KEY'] })
  const seen = await readFile(join(folder, 'env.txt'), 'utf8')
  assert.match(seen, /^PATH=/m, 'ps ran')
  assert.doesNotMatch(seen, /judge-key-value|RETEST_FAKE_JUDGE_KEY/)
  assert.equal(processExists(process.pid), true)
})

test('reading a pid tells a running process, a free pid and a reading that failed apart', async (t) => {
  const child = spawn('/bin/sleep', ['602'], { stdio: 'ignore' })
  t.after(() => child.kill('SIGKILL'))
  await sleep(100)
  assert.deepEqual(await commandOf(systemTools, child.pid ?? 0), { state: 'present', command: '/bin/sleep 602', startedAt: processStart(child.pid ?? 0) })
  child.kill('SIGKILL')
  await new Promise((resolve) => child.once('exit', resolve))
  assert.deepEqual(await commandOf(systemTools, child.pid ?? 0), { state: 'absent' })
  const failing = await scriptedPs(t, 'echo "ps: sysctl failed" >&2\nexit 1')
  const reading = await commandOf(failing.tools, process.pid)
  assert.equal(reading.state, 'unreadable', 'a ps that fails is not taken for a free pid')
})

test('a recorded process is not sent SIGKILL when its pid runs another command line after the grace period', async (t) => {
  const child = stubbornChild(t)
  await sleep(150)
  const recorded = await commandOf(systemTools, child.pid)
  assert.equal(recorded.state, 'present')
  if (recorded.state !== 'present') return
  // The first reading shows the recorded process; every later one shows another command line under the same pid.
  const { tools, folder } = await scriptedPs(t, `if [ -e "$FOLDER/read" ]; then echo "${recorded.startedAt} /usr/libexec/another-process"; else touch "$FOLDER/read"; cat "$FOLDER/command.txt"; fi`)
  await writeFile(join(folder, 'command.txt'), `${recorded.startedAt} ${recorded.command}\n`)
  const outcome = await endRecorded(tools, { pid: child.pid, command: recorded.command, startedAt: recorded.startedAt }, 300)
  assert.equal(outcome, 'ended', 'the recorded process is no longer under its pid')
  await sleep(200)
  assert.equal(processExists(child.pid), true, 'the process now under the pid was sent no SIGKILL')
})

test('a recorded process that ignores SIGTERM is sent SIGKILL while its command line is still the recorded one', async (t) => {
  const child = stubbornChild(t)
  await sleep(150)
  const recorded = await commandOf(systemTools, child.pid)
  if (recorded.state !== 'present') throw new Error('the child was not read')
  assert.equal(await endRecorded(systemTools, { pid: child.pid, command: recorded.command, startedAt: recorded.startedAt }, 300), 'ended')
  assert.equal(await Promise.race([child.signal, sleep(5000, 'still running')]), 'SIGKILL')
})

test('a process group that ends on its own takes its exit hook with it', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'retest-native-processes-'))
  t.after(() => rm(folder, { recursive: true, force: true }))
  const before = process.listenerCount('exit')
  const owned = await OwnedProcess.start({ command: '/bin/sh', args: ['-c', 'exit 0'], logFile: join(folder, 'process.log') })
  await owned.waitForExit(5000)
  for (let tries = 0; tries < 50 && process.listenerCount('exit') > before; tries += 1) await sleep(20)
  assert.equal(process.listenerCount('exit'), before, 'no hook is left to signal a group id that is gone')
})


test('malformed recorded pids and blank commands permit no reading or destructive signal', async (t) => {
  const kill = t.mock.method(process, 'kill', () => true)
  // If the entry guard is removed, a completed fake matching reading would expose the invalid destructive pid.
  const posted = t.mock.method(Worker.prototype, 'postMessage', (request: MetadataProcessRequest) => {
    const text = request.args.at(-1) === '424242' ? '' : '/recorded/process'
    const bytes = new TextEncoder().encode(text)
    new Uint8Array(request.output).set(bytes)
    const control = new Int32Array(request.control)
    Atomics.store(control, 1, metadataSuccess)
    Atomics.store(control, 2, bytes.length)
    Atomics.store(control, 0, metadataComplete)
    Atomics.notify(control, 0)
  })
  const records = [
    ...[-2, 0, 1, Number.NaN, 1.5, Number.MAX_SAFE_INTEGER + 1].map((pid) => ({ pid, command: '/recorded/process' })),
    { pid: 424242, command: '' },
    { pid: 424243, command: ' \t\n' },
  ]
  for (const record of records) {
    killRecordedNow([record], { ps: '/metadata-fixture-must-not-run' })
    assert.deepEqual(await endRecorded({ ...systemTools, ps: '/metadata-fixture-must-not-run' }, record, 0), {
      unreadable: 'The recorded process needs a valid positive pid and a nonempty command.',
    })
  }
  assert.equal(posted.mock.callCount(), 0, 'malformed ownership never requests host metadata')
  assert.equal(kill.mock.callCount(), 0, 'no malformed pid reaches a process signal, including signal 0')
})

test('exit-hook matching output from a failed ps never authorizes a signal', async (t) => {
  const { tools } = await scriptedPs(t, `echo "${shownStart} /recorded/process"\nexit 1`)
  const kill = t.mock.method(process, 'kill', () => true)
  killRecordedNow([{ pid: 424242, command: '/recorded/process', startedAt: recordedStart }], tools)
  assert.equal(kill.mock.callCount(), 0)
})

test('an unanswered metadata child whose command changed is left running without any timeout signal', async (t) => {
  const fixture = await unansweredMetadata(t, false)
  assert.throws(() => readMetadataProcess({ command: fixture.path, args: [], environment: {}, timeoutMs: 1000 }), /did not answer before its deadline/)
  const pid = Number(await readFile(join(fixture.folder, 'pid'), 'utf8'))
  assert.equal(processExists(pid), true, 'the unanswered metadata child is left alone')
  await assert.rejects(readFile(join(fixture.folder, 'term'), 'utf8'), { code: 'ENOENT' })
  // One unanswered child fails only its own query, so a long-lived host keeps its readings. The bound that stops a
  // backlog of such children growing is shown in metadata-process.test.ts.
  assert.equal(readMetadataProcess({ command: '/bin/echo', args: ['read'], environment: { PATH: '/usr/bin:/bin' }, timeoutMs: 1000 }), 'read\n', 'a later reading is still taken while the unanswered child runs')
})

test('exit-hook matching output from an unanswered ps never authorizes a signal or ends the metadata child', async (t) => {
  const fixture = await unansweredMetadata(t, false)
  const realKill = process.kill.bind(process)
  const signals: { pid: number; signal: NodeJS.Signals | number | undefined }[] = []
  t.mock.method(process, 'kill', (pid: number, signal?: NodeJS.Signals | number) => {
    signals.push({ pid, signal })
    return pid === 424242 ? true : realKill(pid, signal)
  })
  killRecordedNow([{ pid: 424242, command: '/recorded/process' }], { ps: fixture.path })
  const pid = Number(await readFile(join(fixture.folder, 'pid'), 'utf8'))
  assert.equal(realKill(pid, 0), true)
  assert.deepEqual(signals, [], 'neither matching partial output nor timeout permits an application signal')
  await assert.rejects(readFile(join(fixture.folder, 'term'), 'utf8'), { code: 'ENOENT' })
})

test('exit-hook matching stdout with overflowing stderr never authorizes a signal or ends the metadata child', async (t) => {
  const fixture = await unansweredMetadata(t, true)
  const realKill = process.kill.bind(process)
  const signals: { pid: number; signal: NodeJS.Signals | number | undefined }[] = []
  t.mock.method(process, 'kill', (pid: number, signal?: NodeJS.Signals | number) => {
    signals.push({ pid, signal })
    return pid === 424242 ? true : realKill(pid, signal)
  })
  killRecordedNow([{ pid: 424242, command: '/recorded/process' }], { ps: fixture.path })
  const pid = Number(await readFile(join(fixture.folder, 'pid'), 'utf8'))
  assert.equal(realKill(pid, 0), true)
  assert.deepEqual(signals, [], 'a failed bounded reading never exposes matching partial stdout to cleanup')
  await assert.rejects(readFile(join(fixture.folder, 'term'), 'utf8'), { code: 'ENOENT' })
})

for (const refused of ['SIGTERM', 'SIGKILL'] as const) {
  test(`a refused ${refused} is a cleanup failure while the recorded process still exists`, async (t) => {
    const record = { pid: 424242, command: '/recorded/process', startedAt: recordedStart }
    const { tools } = await scriptedPs(t, `echo "${shownStart} /recorded/process"`)
    const realKill = process.kill.bind(process)
    const signals: (NodeJS.Signals | number | undefined)[] = []
    t.mock.method(process, 'kill', (pid: number, signal?: NodeJS.Signals | number) => {
      if (pid !== record.pid) return realKill(pid, signal)
      signals.push(signal)
      if (signal === refused) throw Object.assign(new Error('permission denied'), { code: 'EPERM' })
      return true
    })
    const outcome = await endRecorded(tools, record, 0)
    assert.deepEqual(outcome, { signalFailed: `${refused} failed: permission denied` })
    assert.match(endProblem(record, outcome) ?? '', /could not end pid 424242/)
    assert.deepEqual(signals.filter((signal) => signal !== 0), refused === 'SIGTERM' ? ['SIGTERM'] : ['SIGTERM', 'SIGKILL'])
  })
}


// A fake ChildProcess and host ledger: no process is started and no signal reaches the operating system.
async function fakeOwnedProcess(t: TestContext, options: { initialAbsent?: boolean; initialReadFails?: boolean } = {}) {
  const folder = await mkdtemp(join(tmpdir(), 'retest-native-owned-'))
  const temporary = join(folder, 'temporary')
  await mkdir(temporary)
  await writeFile(join(temporary, 'fixture'), 'retained fixture')
  const child = new ChildProcess()
  const pid = 700001
  Object.defineProperty(child, 'pid', { value: pid })
  Object.defineProperty(child, 'stdout', { value: new PassThrough() })
  Object.defineProperty(child, 'stderr', { value: new PassThrough() })
  const root: OwnedProcessIdentity = { pid, parentPid: process.pid, groupId: pid, startedAt: 'root-birth', command: '/owned/executor' }
  const descendant: OwnedProcessIdentity = { pid: pid + 1, parentPid: pid, groupId: pid, startedAt: 'child-birth', command: '/owned/child' }
  const state = { processes: options.initialAbsent === true || options.initialReadFails === true ? [] : [root, descendant], failRead: false }
  const signals: { pid: number; signal: NodeJS.Signals | 0 }[] = []
  let first = true
  const before = new Set(process.listeners('exit'))
  const logFile = join(folder, 'output.log')
  const owned = new OwnedProcess(child, logFile, openSync(logFile, 'a', 0o600), {
    command: '/owned/executor', args: [], logFile, temporaryFolders: [temporary],
    ownershipSystem: {
      read: () => {
        const initial = first
        first = false
        if (state.failRead || (initial && options.initialReadFails === true)) throw new Error('host reading failed')
        return state.processes.map((entry) => ({ ...entry }))
      },
      signal: (pid, signal) => { signals.push({ pid, signal }) },
    },
  })
  const [hook, removeHook] = process.listeners('exit').filter((listener) => !before.has(listener))
  assert.ok(hook)
  assert.ok(removeHook)
  let closed = false
  const close = (): void => {
    if (closed) return
    closed = true
    Object.defineProperty(child, 'exitCode', { value: 0 })
    child.emit('exit', 0, null)
    child.emit('close', 0, null)
  }
  const waitClosed = async (): Promise<void> => {
    const timer = new AbortController()
    try {
      await Promise.race([owned.exited, sleep(1000, undefined, { signal: timer.signal }).then(() => { throw new Error('the fake native output did not settle') })])
    } finally { timer.abort() }
  }
  t.after(async () => {
    state.failRead = false
    state.processes = []
    close()
    await waitClosed()
    await rm(folder, { recursive: true, force: true })
  })
  return { owned, state, signals, root, descendant, temporary, hook, removeHook, close, waitClosed }
}

test('native exit cleanup reads ownership again and never signals a changed descendant or a numeric group', async (t) => {
  const fake = await fakeOwnedProcess(t)
  fake.state.failRead = true
  fake.hook(0)
  assert.deepEqual<typeof fake.signals>(fake.signals, [], 'a failed host reading authorizes no exit-hook signal')
  fake.state.failRead = false
  fake.state.processes = [fake.root, { ...fake.descendant, startedAt: 'another-birth' }]
  fake.hook(0)
  assert.deepEqual(fake.signals, [{ pid: fake.root.pid, signal: 'SIGKILL' }])
  assert.ok(fake.signals.every((entry) => entry.pid > 0), 'each signal addresses a verified positive pid')
})

test('a missing first snapshot is harmless only after confirmed exit and absence; a failed first reading remains a failure', async (t) => {
  const absent = await fakeOwnedProcess(t, { initialAbsent: true })
  absent.close()
  assert.deepEqual(await absent.owned.stop(0), [])
  assert.deepEqual(absent.signals, [])
  const failed = await fakeOwnedProcess(t, { initialReadFails: true })
  failed.close()
  assert.match((await failed.owned.stop(0)).join(' '), /host reading failed/)
  assert.deepEqual(failed.signals, [], 'a later absent reading never grants ownership')
})

test('a failed liveness reading remains a cleanup failure after confirmed absence and closed output', async (t) => {
  const fake = await fakeOwnedProcess(t)
  fake.state.failRead = true
  assert.equal(await fake.owned.processesRemain(), true, 'the unanswered liveness reading holds ownership')
  fake.state.failRead = false
  fake.state.processes = []
  fake.close()
  const problems = await fake.owned.stop(0)
  assert.match(problems.join(' '), /Could not read ownership of process.*host reading failed/)
  assert.equal(problems.filter((problem) => problem.includes('host reading failed')).length, 1, 'the retained reading failure is deduplicated')
  assert.equal(await fake.owned.processesRemain(), false, 'later absence proves the processes ended but does not erase the failed read')
  assert.deepEqual(fake.signals, [], 'a failed reading never grants signal authority')
  assert.equal(await readFile(join(fake.temporary, 'fixture'), 'utf8').catch(() => 'absent'), 'absent')
})

test('stop waits for Node exit and output settlement even after the host confirms absence', async (t) => {
  const fake = await fakeOwnedProcess(t)
  fake.state.processes = []
  const stopping = fake.owned.stop(0)
  let settled = false
  void stopping.then(() => { settled = true })
  await sleep(25)
  assert.equal(settled, false, 'host absence alone does not finish native cleanup')
  assert.equal(fake.owned.exit, undefined)
  fake.close()
  assert.deepEqual(await stopping, [])
  assert.notEqual(fake.owned.exit, undefined)
  assert.equal(await readFile(join(fake.temporary, 'fixture'), 'utf8').catch(() => 'absent'), 'absent')
})

test('stop reports unconfirmed output and keeps the same failed cleanup promise', async (t) => {
  const fake = await fakeOwnedProcess(t)
  fake.state.processes = []
  const stopping = fake.owned.stop(0)
  assert.match((await stopping).join(' '), /output pipes remain/)
  assert.equal(fake.owned.exit, undefined)
  assert.equal(fake.owned.stop(0), stopping)
  assert.equal(await readFile(join(fake.temporary, 'fixture'), 'utf8'), 'retained fixture')
})

test('a recorded descendant whose live command changed is never signaled and keeps cleanup held', async (t) => {
  const fake = await fakeOwnedProcess(t)
  const changed = { ...fake.descendant, command: '/owned/child after exec' }
  fake.state.processes = [fake.root, changed]
  const stopping = fake.owned.stop(0)
  for (let tries = 0; tries < 100 && !fake.signals.some((entry) => entry.pid === fake.root.pid && entry.signal === 'SIGTERM'); tries += 1) await sleep(5)
  assert.ok(fake.signals.some((entry) => entry.pid === fake.root.pid && entry.signal === 'SIGTERM'))
  fake.state.processes = [changed]
  fake.close()
  const problems = await stopping
  assert.match(problems.join(' '), /different identity.*command reading changed/)
  assert.equal(fake.signals.some((entry) => entry.pid === changed.pid), false, 'changed commands never gain signal authority')
  assert.equal(await fake.owned.processesRemain(), true)
  // The temporary output goes after a short wait whatever remains, since it can hold what XCTest named its typing by;
  // the remaining process still keeps cleanup failed and the exit hook installed.
  await fake.owned.exited
  assert.equal(await readFile(join(fake.temporary, 'fixture'), 'utf8').catch(() => 'absent'), 'absent')
  assert.equal(await fake.owned.processesRemain(), true)
  assert.match((await fake.owned.finishOutput(1)).join(' '), /different identity/)
})

test('an unsignaled changed descendant may end naturally, but cleanup waits for absence and output proof', async (t) => {
  const fake = await fakeOwnedProcess(t)
  const changed = { ...fake.descendant, command: '/owned/child exiting' }
  fake.state.processes = [fake.root, changed]
  const stopping = fake.owned.stop(0)
  let settled = false
  void stopping.then(() => { settled = true })
  for (let tries = 0; tries < 100 && !fake.signals.some((entry) => entry.pid === fake.root.pid && entry.signal === 'SIGTERM'); tries += 1) await sleep(5)
  assert.ok(fake.signals.some((entry) => entry.pid === fake.root.pid && entry.signal === 'SIGTERM'))
  fake.state.processes = []
  await sleep(30)
  assert.equal(settled, false, 'fresh process absence still needs Node exit and closed output')
  assert.equal(await readFile(join(fake.temporary, 'fixture'), 'utf8'), 'retained fixture')
  fake.close()
  assert.deepEqual(await stopping, [])
  assert.equal(fake.signals.some((entry) => entry.pid === changed.pid), false, 'Retest sent no signal to the changed process')
  assert.equal(await fake.owned.processesRemain(), false)
  assert.equal(await readFile(join(fake.temporary, 'fixture'), 'utf8').catch(() => 'absent'), 'absent')
})

test('an unrecorded orphan retains native process and temporary-output ownership after its leader exits', async (t) => {
  const fake = await fakeOwnedProcess(t)
  fake.state.processes = [{ ...fake.descendant, pid: fake.descendant.pid + 1, parentPid: 1, startedAt: 'unrecorded-birth' }]
  fake.close()
  assert.equal(await fake.owned.processesRemain(), true)
  const problems = await fake.owned.finishOutput(1)
  assert.match(problems.join(' '), /remain|ownership could not be verified/)
  assert.equal(await readFile(join(fake.temporary, 'fixture'), 'utf8'), 'retained fixture')
  fake.hook(0)
  assert.deepEqual(fake.signals, [], 'group membership is never signal authority')
  fake.state.processes = []
  await fake.waitClosed()
  assert.equal(await readFile(join(fake.temporary, 'fixture'), 'utf8').catch(() => 'absent'), 'absent')
})

test('an unexpected liveness error remains unreadable after a recorded SIGTERM', async (t) => {
  const record = { pid: 424242, command: '/recorded/process', startedAt: recordedStart }
  const { tools } = await scriptedPs(t, `echo "${shownStart} /recorded/process"`)
  const realKill = process.kill.bind(process)
  const signals: (NodeJS.Signals | number | undefined)[] = []
  t.mock.method(process, 'kill', (pid: number, signal?: NodeJS.Signals | number) => {
    if (pid !== record.pid) return realKill(pid, signal)
    if (signal === 0) throw Object.assign(new Error('liveness read failed'), { code: 'EIO' })
    signals.push(signal)
    return true
  })
  assert.throws(() => processExists(record.pid), /liveness read failed/)
  assert.deepEqual(await endRecorded(tools, record, 0), { unreadable: 'liveness read failed' })
  assert.deepEqual(signals, ['SIGTERM'], 'the failed read authorizes no SIGKILL or successful cleanup')
})

test('executor watching reports a failed liveness reading without inventing an exit', (t) => {
  const realKill = process.kill.bind(process)
  t.mock.method(process, 'kill', (pid: number, signal?: NodeJS.Signals | number) => {
    if (pid !== 424242) return realKill(pid, signal)
    throw Object.assign(new Error('liveness read failed'), { code: 'EIO' })
  })
  t.mock.timers.enable({ apis: ['setInterval'] })
  const reported: { pid: number; problem?: string }[] = []
  const stop = watchExecutor([424242], (pid, problem) => { reported.push(problem === undefined ? { pid } : { pid, problem }) })
  t.mock.timers.tick(500)
  stop()
  assert.equal(reported.length, 1)
  assert.match(reported[0]?.problem ?? '', /could not read whether runner pid 424242 remains: liveness read failed/)
})

// A process is identified by its pid and start; a command line `ps` can read must agree, and one it cannot read, as
// while the process exits, is neither a match nor a difference.

test('an app ps shows by its short name while it exits is still the recorded process: it is ended, never taken for another', async (t) => {
  const child = stubbornChild(t)
  await sleep(150)
  const start = processStart(child.pid)
  const { tools } = await scriptedPs(t, `echo "${start} (node)"`)
  const outcome = await endRecorded(tools, { pid: child.pid, command: `${process.execPath} -e stubborn`, startedAt: start }, 300)
  assert.equal(outcome, 'ended')
  assert.equal(await Promise.race([child.signal, sleep(5000, 'still running')]), 'SIGKILL', 'the exiting process was the recorded one and was ended')
})

test('a record without a start leaves a process ps shows by its short name undecided, and sends it nothing', async (t) => {
  const record = { pid: 424242, command: '/Applications/TaskDesk.app/Contents/MacOS/TaskDesk' }
  const { tools } = await scriptedPs(t, `echo "${shownStart} (TaskDesk)"`)
  const realKill = process.kill.bind(process)
  const signals: (NodeJS.Signals | number | undefined)[] = []
  t.mock.method(process, 'kill', (pid: number, signal?: NodeJS.Signals | number) => {
    if (pid !== record.pid) return realKill(pid, signal)
    signals.push(signal)
    return true
  })
  const outcome = await endRecorded(tools, record, 0)
  assert.deepEqual(outcome, { unreadable: 'ps showed pid 424242 without its command line, and the record holds no start to tell it by.' })
  assert.match(endProblem(record, outcome) ?? '', /could not read whether pid 424242 is still running/, 'an undecided reading is a problem, never nothing left')
  assert.deepEqual(signals, [])
})

test('a pid another process took under the identical command line is left alone, by its start', async (t) => {
  const child = stubbornChild(t)
  await sleep(150)
  const recorded = await commandOf(systemTools, child.pid)
  if (recorded.state !== 'present') throw new Error('the child was not read')
  assert.equal(await endRecorded(systemTools, { pid: child.pid, command: recorded.command, startedAt: 'Thu Jan 1 00:00:00 1970' }, 0), 'other')
  await sleep(200)
  assert.equal(processExists(child.pid), true, 'a process of another start under the recorded pid is sent nothing')
})

test('an exit-hook kill leaves a pid another process took under the identical command line, and kills the recorded one', async (t) => {
  const child = spawn('/bin/sleep', ['603'], { stdio: 'ignore' })
  t.after(() => child.kill('SIGKILL'))
  const pid = child.pid ?? 0
  const ended = new Promise<NodeJS.Signals | null>((resolve) => child.once('exit', (_code, signal) => resolve(signal)))
  await sleep(100)
  killRecordedNow([{ pid, command: '/bin/sleep 603', startedAt: 'Thu Jan 1 00:00:00 1970' }], systemTools)
  await sleep(100)
  assert.equal(processExists(pid), true, 'the same command line under another start is not the recorded process')
  killRecordedNow([{ pid, command: '/bin/sleep 603', startedAt: processStart(pid) }], systemTools)
  assert.equal(await Promise.race([ended, sleep(5000, 'still running')]), 'SIGKILL')
})

test('every process listed carries its start', async (t) => {
  const child = spawn('/bin/sleep', ['604'], { stdio: 'ignore' })
  t.after(() => child.kill('SIGKILL'))
  await sleep(100)
  const listed = (await listProcesses(systemTools, 10_000)).find((entry) => entry.pid === child.pid)
  assert.deepEqual(listed, { pid: child.pid, command: '/bin/sleep 604', startedAt: processStart(child.pid ?? 0) })
})

// A process name of about 200 KB, which `ps -ww` prints whole as the first word of the command line. Linux refuses any
// one argument past 128 KiB (MAX_ARG_STRLEN) with E2BIG, so there the name is 100 KB and more sleeps make up the table.
const wideName = `retest-wide-table-${'w'.repeat((process.platform === 'linux' ? 100 : 200) * 1024)}`

// Sleeps of the test's own under `wideName`, enough that the whole table `ps -ww` prints passes a short reading's 4 MiB
// by at least 1 MiB, as a busy Mac's table did. Each is ended after the test through the handle that started it.
async function widenTable(t: TestContext): Promise<readonly ChildProcess[]> {
  const tableBytes = (): number => execFileSync('/bin/ps', ['-ww', '-axo', 'pid=,ppid=,pgid=,stat=,lstart=,args='], { maxBuffer: processTableOutputLimit, env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', TZ: 'UTC0' } }).length
  const count = Math.max(1, Math.ceil((metadataOutputLimit + 1024 * 1024 - tableBytes()) / wideName.length))
  const children = Array.from({ length: count }, () => spawn('/bin/sleep', ['60'], { stdio: 'ignore', argv0: wideName }))
  t.after(() => { for (const child of children) child.kill('SIGKILL') })
  await Promise.all(children.map((child) => once(child, 'spawn')))
  assert.ok(tableBytes() > metadataOutputLimit + 512 * 1024, 'the whole table is larger than a short reading may print')
  return children
}

// `ps` prints a process by its kernel name in parentheses when it could not read that process's arguments at that
// moment, which Retest's identity rule takes as unreadable, never as another command. On a hosted macOS runner one
// listing showed a running wide sleep as `(sleep)` while the table read just before held it whole. Such a reading says
// nothing of whether Retest cuts a large table, so both are read again, three times at most, while each process shown
// that way is still running; the readings returned are the last.
async function wideReadings(children: readonly ChildProcess[]): Promise<{ readonly table: readonly OwnedProcessIdentity[]; readonly listed: readonly ListedProcess[] }> {
  for (let reading = 1; ; reading += 1) {
    const table = await readProcessTable()
    const listed = await listProcesses(systemTools, 10_000)
    const unread = children.filter((child) => [table, listed].some((entries) => entries.find((entry) => entry.pid === child.pid)?.command === '(sleep)'))
    if (unread.length === 0 || reading === 3) return { table, listed }
    for (const child of unread) assert.ok(child.exitCode === null && child.signalCode === null && child.pid !== undefined && processExists(child.pid), `wide process ${child.pid} shown without its arguments has ended`)
  }
}

test('ownership readings take a whole process table larger than 4 MiB, and still read a pid again before signalling it', async (t) => {
  const children = await widenTable(t)
  const { table, listed } = await wideReadings(children)
  for (const child of children) {
    assert.equal(table.find((entry) => entry.pid === child.pid)?.command, `${wideName} 60`, 'the ownership table holds each wide process whole')
    assert.equal(listed.find((entry) => entry.pid === child.pid)?.command, `${wideName} 60`, 'the process list holds each wide process whole')
  }
  const [first] = children
  if (first?.pid === undefined) throw new Error('no wide process started')
  // The shared rule on its own host: the launch is recorded from a whole table, and its one pid is read again right
  // before the signal.
  const group = new OwnedProcessGroup(first.pid)
  assert.deepEqual(group.capture(), [], 'the launch is recorded from the whole table')
  const ended = once(first, 'exit')
  assert.deepEqual(group.signalReport('SIGKILL'), { problems: [], identityRefusals: [] })
  assert.equal((await ended)[1], 'SIGKILL')
  assert.equal(group.remains(), false, 'a whole table later shows it gone')
  assert.deepEqual(group.readProblems, [])
})

test('a process list longer than a command\'s output limit is refused, never read as a shorter command', async (t) => {
  const { tools } = await scriptedPs(t, `printf '7 ${shownStart} /valid/process\\n9 ${shownStart} /cut/'; head -c 17000000 /dev/zero | tr '\\0' x; printf '\\n'`)
  await assert.rejects(listProcesses(tools, 30_000), /ps listed more than the 16777216 characters Retest reads of one command, so the list may be cut/)
})

// The shared reader's blocking readings, counted: each waits for its worker's answer with `Atomics.wait`, which holds
// the thread; the asynchronous reading waits with `Atomics.waitAsync` and is not counted.
function blockingReadings(t: TestContext): { count(): number; callers(): readonly string[] } {
  const original = Atomics.wait
  const callers: string[] = []
  t.mock.method(Atomics, 'wait', (...args: Parameters<typeof Atomics.wait>): ReturnType<typeof Atomics.wait> => {
    callers.push(new Error('blocking reading').stack ?? '')
    return original(...args)
  })
  return { count: () => callers.length, callers: () => [...callers] }
}

test('a short command takes its ownership readings without blocking the main thread', async (t) => {
  const readings = blockingReadings(t)
  const result = await runCommand('/bin/echo', ['ready'], { timeoutMs: 5000 })
  assert.equal(result.stdout, 'ready\n')
  assert.deepEqual(result.cleanupProblems, [])
  assert.equal(readings.count(), 0, 'no reading waited on the main thread')
})

test('a long-running process takes no blocking ownership reading while it runs', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'retest-native-processes-'))
  t.after(() => rm(folder, { recursive: true, force: true }))
  const readings = blockingReadings(t)
  const activity: { kind: 'reading' | 'signal'; pid?: number; individual?: boolean; signal?: NodeJS.Signals | number }[] = []
  const postMessage = Worker.prototype.postMessage
  t.mock.method(Worker.prototype, 'postMessage', function (this: Worker, request: MetadataProcessRequest) {
    const selected = request.args.indexOf('-p')
    activity.push({ kind: 'reading', individual: selected !== -1, ...(selected === -1 ? {} : { pid: Number(request.args[selected + 1]?.split(',')[0]) }) })
    return postMessage.call(this, request)
  })
  const kill = process.kill.bind(process)
  t.mock.method(process, 'kill', (pid: number, signal?: NodeJS.Signals | number) => {
    if (signal !== undefined && signal !== 0) activity.push({ kind: 'signal', pid, signal })
    return kill(pid, signal)
  })
  const owned = await OwnedProcess.start({ command: '/bin/sleep', args: ['30'], logFile: join(folder, 'sleep.log') })
  t.after(() => owned.stop(0))
  await sleep(1000)
  assert.equal(readings.count(), 0, 'the descendant watch reads without blocking')
  assert.deepEqual(await owned.stop(0), [])
  const signalled = activity.filter(entry => entry.kind === 'signal')
  assert.equal(signalled.length, 1, 'the stop sends exactly one signal')
  const signal = signalled[0]
  assert.ok(signal)
  const signalIndex = activity.indexOf(signal)
  assert.deepEqual(activity.filter(entry => entry.individual === true), [{ kind: 'reading', individual: true, pid: signal.pid }], 'the stop makes exactly one individual reading of the pid it signals')
  assert.deepEqual(activity[signalIndex - 1], { kind: 'reading', individual: true, pid: signal.pid }, 'the individual reading is immediately before the signal, with no intervening host operation')
  assert.equal(readings.count(), 0, 'no ownership reading during start, watch or stop blocks the main thread')
})

test('a child the executor starts after its own start is still found and ended at the stop', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'retest-native-processes-'))
  t.after(() => rm(folder, { recursive: true, force: true }))
  const pidFile = join(folder, 'grandchild')
  const owned = await OwnedProcess.start({ command: '/bin/sh', args: ['-c', `sleep 0.3; sleep 600 & echo $! > '${pidFile}'; wait`], logFile: join(folder, 'process.log') })
  const grandchild = await grandchildPid(pidFile)
  assert.equal(processExists(grandchild), true)
  assert.deepEqual(await owned.stop(0), [])
  assert.equal(processExists(grandchild), false, 'the child started later was recorded through its ancestry and ended')
})

test('the temporary output is deleted once the process closed, even while an unowned member of its group remains', async (t) => {
  const fake = await fakeOwnedProcess(t)
  fake.state.processes = [{ ...fake.descendant, pid: fake.descendant.pid + 1, parentPid: 1, startedAt: 'unrecorded-birth' }]
  fake.close()
  const settled = await Promise.race([fake.owned.exited.then(() => 'settled'), sleep(8000, 'still waiting')])
  assert.equal(settled, 'settled', 'deletion does not wait for a process Retest may not end')
  assert.equal(await readFile(join(fake.temporary, 'fixture'), 'utf8').catch(() => 'absent'), 'absent')
  assert.equal(await fake.owned.processesRemain(), true, 'the unowned member still holds cleanup')
  assert.match((await fake.owned.finishOutput(1)).join(' '), /ownership could not be verified/)
  assert.deepEqual(fake.signals, [], 'it is never signaled')
})

test('the exit hook deletes the temporary output even while members of the group remain', async (t) => {
  const fake = await fakeOwnedProcess(t)
  fake.state.processes = [fake.root, fake.descendant, { ...fake.descendant, pid: fake.descendant.pid + 1, parentPid: 1, startedAt: 'unrecorded-birth' }]
  fake.removeHook(0)
  assert.equal(await readFile(join(fake.temporary, 'fixture'), 'utf8').catch(() => 'absent'), 'absent')
})

test('a new run folder names this process as its maker, by pid and start, readable by its owner alone', async (t) => {
  const folder = await makeOwnedFolder('retest-executor-', systemTools)
  t.after(() => rm(folder, { recursive: true, force: true }))
  assert.deepEqual(JSON.parse(await readFile(join(folder, 'retest-owner.json'), 'utf8')), { startTimeVersion: 1, pid: process.pid, startedAt: processStart(process.pid) })
  assert.equal((await stat(join(folder, 'retest-owner.json'))).mode & 0o777, 0o600)
})

test('a sweep deletes only absent makers\' folders and retains live makers with matching or mismatched starts', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'retest-native-sweep-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const live = spawn('/bin/sleep', ['605'], { stdio: 'ignore' })
  t.after(() => live.kill('SIGKILL'))
  await sleep(100)
  const ended = await endedPid()
  const folder = async (name: string, owner?: string): Promise<string> => {
    const path = join(root, name)
    await mkdir(path)
    await writeFile(join(path, 'result.txt'), 'staged')
    if (owner !== undefined) await writeFile(join(path, 'retest-owner.json'), owner)
    return path
  }
  const gone = await folder('retest-executor-gone', JSON.stringify({ startTimeVersion: 1, pid: ended, startedAt: recordedStart }))
  const taken = await folder('retest-macos-taken', JSON.stringify({ startTimeVersion: 1, pid: live.pid, startedAt: 'Thu Jan 1 00:00:00 1970' }))
  const running = await folder('retest-ios-running', JSON.stringify({ startTimeVersion: 1, pid: live.pid, startedAt: processStart(live.pid ?? 0) }))
  const unrecorded = await folder('retest-executor-unrecorded')
  const unreadable = await folder('retest-executor-unreadable', 'not a record')
  const other = await folder('another-tool-gone', JSON.stringify({ startTimeVersion: 1, pid: ended, startedAt: recordedStart }))
  const target = await folder('linked-target', JSON.stringify({ startTimeVersion: 1, pid: ended, startedAt: recordedStart }))
  await symlink(target, join(root, 'retest-executor-link'))
  const swept = await sweepOwnedFolders(systemTools, root)
  assert.deepEqual([...swept.removed].sort(), [gone])
  assert.equal(swept.kept, 4)
  assert.deepEqual(swept.problems, [])
  for (const kept of [taken, running, unrecorded, unreadable, other, target]) assert.equal((await stat(kept)).isDirectory(), true, `${kept} is kept`)
  assert.equal((await stat(join(root, 'retest-executor-link'))).isDirectory(), true, 'a link is never followed or deleted')
})

test('a sweep keeps a folder whose maker cannot be read', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'retest-native-sweep-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'retest-executor-held'))
  await writeFile(join(root, 'retest-executor-held', 'retest-owner.json'), JSON.stringify({ startTimeVersion: 1, pid: process.pid, startedAt: recordedStart }))
  const failing = await scriptedPs(t, 'echo "ps: sysctl failed" >&2\nexit 1')
  const swept = await sweepOwnedFolders(failing.tools, root)
  assert.deepEqual([swept.removed, swept.kept], [[], 1])
  assert.equal((await stat(join(root, 'retest-executor-held'))).isDirectory(), true)
})

test('a start runs the selected Xcode\'s own xcodebuild, never the shim that execs it under the same pid', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'retest-native-xcrun-'))
  t.after(() => rm(folder, { recursive: true, force: true }))
  const xcrun = join(folder, 'xcrun')
  await writeFile(xcrun, '#!/bin/sh\nif [ "$1 $2" = "--find xcodebuild" ]; then echo /Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild; exit 0; fi\nexit 64\n')
  await chmod(xcrun, 0o755)
  assert.equal(await selectedXcodebuild({ ...systemTools, xcrun, xcodebuild: xcodebuildShim }), '/Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild')
  assert.equal(await selectedXcodebuild({ ...systemTools, xcrun, xcodebuild: '/Fakes/bin/xcodebuild' }), '/Fakes/bin/xcodebuild', 'any other path is run as given')
  const failing = join(folder, 'failing-xcrun')
  await writeFile(failing, '#!/bin/sh\necho "xcrun: error: unable to find utility" >&2\nexit 72\n')
  await chmod(failing, 0o755)
  const refused = await selectedXcodebuild({ ...systemTools, xcrun: failing, xcodebuild: xcodebuildShim })
  assert.match(typeof refused === 'string' ? refused : refused.problem, /could not find the selected Xcode's xcodebuild: xcrun --find xcodebuild ended with exit code 72/)
})

test('native cleanup clears 100 dead helpers from one signal snapshot and individually reads only the live root asynchronously', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'retest-native-history-'))
  t.after(() => rm(folder, { recursive: true, force: true }))
  const child = new ChildProcess()
  const pid = 700101
  Object.defineProperty(child, 'pid', { value: pid })
  Object.defineProperty(child, 'stdout', { value: new PassThrough() })
  Object.defineProperty(child, 'stderr', { value: new PassThrough() })
  const root = { pid, parentPid: process.pid, groupId: pid, startedAt: 'birth', command: '/owned/executor' }
  let entries = [root, ...Array.from({ length: 100 }, (_, index) => ({ ...root, pid: pid + 1 + index, parentPid: pid, command: `/owned/helper-${index}` }))]
  const calls: string[] = []
  let cleaning = false
  const logFile = join(folder, 'output.log')
  const before = new Set(process.listeners('exit'))
  const owned = new OwnedProcess(child, logFile, openSync(logFile, 'a', 0o600), {
    command: '/owned/executor', args: [], logFile,
    ownershipSystem: {
      read: () => { if (cleaning) throw new Error('cleanup used a synchronous table'); return entries },
      readAsync: async () => { calls.push('table'); return entries },
      readProcess: () => { throw new Error('cleanup used a synchronous identity') },
      readProcessAsync: async (pid) => { calls.push(`identity ${pid}`); return entries.find((entry) => entry.pid === pid) },
      signal: (pid) => {
        calls.push(`signal ${pid}`); entries = []
        Object.defineProperty(child, 'exitCode', { value: 0, configurable: true })
        child.emit('exit', 0, null); child.emit('close', 0, null)
      },
    },
  })
  entries = [root]
  cleaning = true
  try {
    assert.deepEqual(await owned.stop(0), [])
    assert.deepEqual(calls.filter((call) => call.startsWith('identity')), [`identity ${pid}`])
    assert.deepEqual(calls.filter((call) => call.startsWith('signal')), [`signal ${pid}`])
    const signalAt = calls.indexOf(`signal ${pid}`)
    assert.deepEqual(calls.slice(signalAt - 2, signalAt + 1), ['table', `identity ${pid}`, `signal ${pid}`])
  } finally {
    cleaning = false; entries = []
    if (child.exitCode === null) { Object.defineProperty(child, 'exitCode', { value: 0, configurable: true }); child.emit('exit', 0, null); child.emit('close', 0, null) }
    for (const hook of process.listeners('exit')) if (!before.has(hook)) process.off('exit', hook)
    await owned.finishOutput(1000)
  }
})

// Takes `port` on `host` and keeps it, or answers undefined when something there holds it or the host lacks the address.
async function hold(t: TestContext, host: string, port: number): Promise<number | undefined> {
  const server = createServer()
  const held = await new Promise<boolean>((resolve) => {
    server.once('error', () => resolve(false))
    server.listen({ port, host }, () => resolve(true))
  })
  if (!held) return undefined
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())))
  const address = server.address()
  return typeof address === 'object' && address !== null ? address.port : undefined
}

test('a port held on ::1 alone is not free, and the executor\'s port is drawn past it from below the ephemeral range', async (t) => {
  // A port from below the ephemeral range that a listener holds on ::1 only, as a server bound to localhost may.
  let held: number | undefined
  for (let port = 31_000; held === undefined && port < 31_200; port += 1) held = await hold(t, '::1', port)
  if (held === undefined) {
    t.skip('this host has no ::1, or no port from 31000 to 31199 was free on it')
    return
  }
  assert.equal(await freeOnLoopback(held), false, 'the listener on ::1 holds the port though 127.0.0.1 is free')
  const free = held + 200
  assert.equal(await freeOnLoopback(free), true, `port ${free} is free on both addresses`)
  // The draw lands on the held port first and on the free one next.
  const draws = [held, free].map((port) => (port - 20_000 + 0.5) / (49_152 - 20_000))
  t.mock.method(Math, 'random', () => draws.shift() ?? 0.5)
  assert.equal(await freePort(), free)
  assert.deepEqual(draws, [], 'the held port was drawn and passed over')
  const probe = await hold(t, '127.0.0.1', held)
  assert.equal(probe, held, '127.0.0.1 alone shows the port free')
})

// A tool that ignores SIGTERM, as do the processes it starts, so only SIGKILL ends it.
async function stubbornTool(t: TestContext): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), 'retest-native-stubborn-'))
  t.after(() => rm(folder, { recursive: true, force: true }))
  const script = join(folder, 'stubborn')
  await writeFile(script, "#!/bin/sh\ntrap '' TERM\nsleep 30\n")
  await chmod(script, 0o755)
  return script
}

test('a command that ignores SIGTERM is killed once the grace it is given has passed, the default one unless it is given another', async (t) => {
  const script = await stubbornTool(t)
  // The timeout leaves the shell time to set its trap before SIGTERM comes, even on a loaded machine.
  const timeoutMs = 500
  const timed = async (graceMs: number | undefined): Promise<number> => {
    const began = performance.now()
    const result = await runCommand(script, [], { timeoutMs, ...(graceMs === undefined ? {} : { graceMs }) })
    assert.equal(result.timedOut, true)
    assert.deepEqual(result.cleanupProblems, [])
    return performance.now() - began
  }
  const short = await timed(300)
  assert.ok(short >= timeoutMs + 300 && short < timeoutMs + terminationGraceMs, `a 300 ms grace ended the command after ${short} ms`)
  const standard = await timed(undefined)
  assert.ok(standard >= timeoutMs + terminationGraceMs, `the default grace ended the command after ${standard} ms`)
})
