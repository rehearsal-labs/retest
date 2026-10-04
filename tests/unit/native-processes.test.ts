import type { TestContext } from 'node:test'
import type { MetadataProcessRequest } from '../../src/shared/metadata-process.ts'
import type { NativeTools } from '../../src/native/processes.ts'
import type { OwnedProcessIdentity } from '../../src/shared/process-ownership.ts'
import assert from 'node:assert/strict'
import { ChildProcess, spawn } from 'node:child_process'
import { openSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { Worker } from 'node:worker_threads'
import { watchExecutor } from '../../src/native/executor-process.ts'
import { commandOf, endProblem, endRecorded, killRecordedNow, listProcesses, OwnedProcess, processExists, runCommand, systemTools } from '../../src/native/processes.ts'
import { metadataComplete, metadataOutputLimit, metadataSuccess, readMetadataProcess } from '../../src/shared/metadata-process.ts'

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

async function grandchildPid(pidFile: string): Promise<number> {
  for (let tries = 0; tries < 100; tries += 1) {
    const text = await readFile(pidFile, 'utf8').catch(() => '')
    if (/^\d+/.test(text)) return Number.parseInt(text, 10)
    await sleep(20)
  }
  throw new Error('the grandchild never started')
}

test('successful malformed process listings are unreadable rather than empty', async (t) => {
  for (const line of ['not a process', '42', '42   ', '9007199254740992 /unsafe/pid']) {
    const { tools } = await scriptedPs(t, `printf '%s\\n' '7 /valid/process' '${line}'`)
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
  const running = runCommand('/bin/sh', withGrandchild(pidFile), { timeoutMs: 30_000, signal: stop.signal })
  const grandchild = await grandchildPid(pidFile)
  stop.abort()
  const result = await running
  assert.deepEqual([result.stopped, result.timedOut], [true, false])
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
  assert.deepEqual(await commandOf(systemTools, child.pid ?? 0), { state: 'present', command: '/bin/sleep 602' })
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
  // The first reading shows the recorded process; every later one shows another process under the same pid.
  const { tools, folder } = await scriptedPs(t, 'if [ -e "$FOLDER/read" ]; then echo "/usr/libexec/another-process"; else touch "$FOLDER/read"; cat "$FOLDER/command.txt"; fi')
  await writeFile(join(folder, 'command.txt'), `${recorded.command}\n`)
  const outcome = await endRecorded(tools, { pid: child.pid, command: recorded.command }, 300)
  assert.equal(outcome, 'ended', 'the recorded process is no longer under its pid')
  await sleep(200)
  assert.equal(processExists(child.pid), true, 'the process now under the pid was sent no SIGKILL')
})

test('a recorded process that ignores SIGTERM is sent SIGKILL while its command line is still the recorded one', async (t) => {
  const child = stubbornChild(t)
  await sleep(150)
  const recorded = await commandOf(systemTools, child.pid)
  if (recorded.state !== 'present') throw new Error('the child was not read')
  assert.equal(await endRecorded(systemTools, { pid: child.pid, command: recorded.command }, 300), 'ended')
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
  const { tools } = await scriptedPs(t, 'echo "/recorded/process"\nexit 1')
  const kill = t.mock.method(process, 'kill', () => true)
  killRecordedNow([{ pid: 424242, command: '/recorded/process' }], tools)
  assert.equal(kill.mock.callCount(), 0)
})

test('an unanswered metadata child whose command changed is left running without any timeout signal', async (t) => {
  const fixture = await unansweredMetadata(t, false)
  assert.throws(() => readMetadataProcess({ command: fixture.path, args: [], environment: {}, timeoutMs: 1000 }), /did not answer before its deadline/)
  const pid = Number(await readFile(join(fixture.folder, 'pid'), 'utf8'))
  assert.equal(processExists(pid), true, 'the unanswered metadata child is left alone')
  await assert.rejects(readFile(join(fixture.folder, 'term'), 'utf8'), { code: 'ENOENT' })
  assert.throws(() => readMetadataProcess({ command: '/bin/ps', args: [], environment: {}, timeoutMs: 1000 }), /earlier metadata process/, 'an unresolved child prevents an accumulating metadata-process backlog')
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
    const record = { pid: 424242, command: '/recorded/process' }
    const { tools } = await scriptedPs(t, 'echo "/recorded/process"')
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
  const hook = process.listeners('exit').find((listener) => !before.has(listener))
  assert.ok(hook)
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
  return { owned, state, signals, root, descendant, temporary, hook, close, waitClosed }
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
  assert.equal(fake.owned.processesRemain, true, 'the unanswered liveness reading holds ownership')
  fake.state.failRead = false
  fake.state.processes = []
  fake.close()
  const problems = await fake.owned.stop(0)
  assert.match(problems.join(' '), /Could not read ownership of process.*host reading failed/)
  assert.equal(problems.filter((problem) => problem.includes('host reading failed')).length, 1, 'the retained reading failure is deduplicated')
  assert.equal(fake.owned.processesRemain, false, 'later absence proves the processes ended but does not erase the failed read')
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
  assert.equal(fake.owned.processesRemain, true)
  assert.equal(await readFile(join(fake.temporary, 'fixture'), 'utf8'), 'retained fixture')
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
  assert.equal(fake.owned.processesRemain, false)
  assert.equal(await readFile(join(fake.temporary, 'fixture'), 'utf8').catch(() => 'absent'), 'absent')
})

test('an unrecorded orphan retains native process and temporary-output ownership after its leader exits', async (t) => {
  const fake = await fakeOwnedProcess(t)
  fake.state.processes = [{ ...fake.descendant, pid: fake.descendant.pid + 1, parentPid: 1, startedAt: 'unrecorded-birth' }]
  fake.close()
  assert.equal(fake.owned.processesRemain, true)
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
  const record = { pid: 424242, command: '/recorded/process' }
  const { tools } = await scriptedPs(t, 'echo "/recorded/process"')
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
