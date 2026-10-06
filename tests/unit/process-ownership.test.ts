import type { OwnedProcessIdentity, ProcessOwnershipSystem } from '../../src/shared/process-ownership.ts'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { describe, test } from 'node:test'
import { Deadline } from '../../src/protocol/deadline.ts'
import { OwnedProcessGroup, sameProcessIdentity } from '../../src/shared/process-ownership.ts'

/** A host snapshot and signal recorder. No system process is read or signaled by these tests. */
class RecordedHost implements ProcessOwnershipSystem {
  processes: OwnedProcessIdentity[]
  failure: string | undefined
  readonly signals: { pid: number; signal: NodeJS.Signals }[] = []

  constructor(processes: OwnedProcessIdentity[]) {
    this.processes = processes
  }

  read(): OwnedProcessIdentity[] {
    if (this.failure !== undefined) throw new Error(this.failure)
    return this.processes.map((entry) => ({ ...entry }))
  }

  signal(pid: number, signal: NodeJS.Signals | 0): void {
    if (!this.processes.some((entry) => entry.pid === pid)) throw Object.assign(new Error('The process is gone.'), { code: 'ESRCH' })
    if (signal === 0) return
    assert.ok(pid > 0, 'cleanup must signal a verified pid, never a numeric group')
    this.signals.push({ pid, signal })
    if (signal === 'SIGKILL') this.processes = this.processes.filter((entry) => entry.pid !== pid)
  }

  replace(pid: number, change: Partial<OwnedProcessIdentity>): void {
    this.processes = this.processes.map((entry) => entry.pid === pid ? { ...entry, ...change } : entry)
  }
}

// Readings `ps -ww -axo pid=,ppid=,pgid=,stat=,lstart=,args=` gave for Chrome for Testing 153 launched as the runner
// launches it and closed as ChromiumBrowser.close closes it; only the cache folder is shortened.
const retest = 28246
const started = 'Mon Oct  5 03:01:49 2026'
const app = '/cache/chrome-mac-arm64/Google Chrome for Testing.app/Contents'
const helperPath = `${app}/Frameworks/Google Chrome for Testing Framework.framework/Versions/153.0.8010.12/Helpers/Google Chrome for Testing Helper.app/Contents/MacOS/Google Chrome for Testing Helper`
const exiting = '(Google Chrome fo)'
const root: OwnedProcessIdentity = {
  pid: 28948, parentPid: retest, groupId: 28948, state: 'Rs', startedAt: started,
  command: `${app}/MacOS/Google Chrome for Testing --remote-debugging-pipe --user-data-dir=/tmp/retest-profile --headless --no-first-run --no-default-browser-check --disable-background-networking --use-mock-keychain about:blank`,
}
const network: OwnedProcessIdentity = { pid: 28955, parentPid: 28948, groupId: 28948, state: 'R', startedAt: started, command: `${helperPath} --type=utility --utility-sub-type=network.mojom.NetworkService --lang=en-US` }
const gpu: OwnedProcessIdentity = { pid: 28956, parentPid: 28948, groupId: 28948, state: 'S', startedAt: started, command: `${helperPath} --type=gpu-process --headless --use-angle=swiftshader-webgl` }

function launched(...processes: OwnedProcessIdentity[]): { host: RecordedHost; group: OwnedProcessGroup } {
  const host = new RecordedHost([root, ...processes])
  const group = new OwnedProcessGroup(root.pid, retest, host)
  assert.deepEqual(group.capture(), [])
  return { host, group }
}

describe('a process is recognised by fields that cannot change while it lives', () => {
  test('a recorded helper whose arguments ps can no longer read while it exits is the same process, and is ended', () => {
    for (const state of ['R', 'S', 'U', '?E']) {
      const { host, group } = launched(network, gpu)
      host.replace(network.pid, { command: exiting, state })
      host.replace(gpu.pid, { command: exiting, state })
      assert.deepEqual(group.signalReport('SIGKILL'), { problems: [], identityRefusals: [] }, `host state ${state}`)
      assert.deepEqual(host.signals.map((entry) => entry.pid), [gpu.pid, network.pid, root.pid])
      assert.equal(group.remains(), false)
    }
  })

  test('a verified identity read while the process exits keeps the command line Retest recorded', () => {
    const { host, group } = launched(network)
    host.replace(network.pid, { command: exiting, state: '?E' })
    assert.deepEqual(group.verifiedIdentity(network.pid), { ...network, state: '?E' })
    const handedOff = group.groupFor(network.pid)
    assert.ok(handedOff !== undefined, 'an exiting recorded helper can still be handed off')
    host.replace(network.pid, { command: '/usr/bin/another-tool' })
    assert.match(handedOff.signal('SIGKILL').join(' '), /Recorded process 28955 has a different identity/, 'the handed-off record kept the readable command')
    assert.deepEqual(host.signals, [])
  })

  test('an exiting launch root still owns the helpers it started while it began to exit', () => {
    const { host, group } = launched()
    host.replace(root.pid, { command: exiting, state: '?Es' })
    host.processes.push({ ...network, command: exiting, state: 'S' }, { ...gpu, command: exiting, state: '?E' })
    assert.deepEqual(group.capture(), [], 'helpers whose parent is the recorded root are recorded, not left as unknown group members')
    assert.deepEqual(group.signalReport('SIGKILL'), { problems: [], identityRefusals: [] })
    assert.deepEqual(host.signals.map((entry) => entry.pid).sort(), [root.pid, network.pid, gpu.pid].sort())
    assert.equal(group.remains(), false)
  })

  test('a process recorded before ps could read its arguments keeps its first readable command, and a later change is refused', () => {
    const profiles: OwnedProcessIdentity = { pid: 28961, parentPid: root.pid, groupId: root.pid, state: 'R', startedAt: started, command: '(profiles)' }
    const { host, group } = launched(profiles)
    host.replace(profiles.pid, { command: '/usr/bin/profiles status -type enrollment', state: 'S' })
    assert.deepEqual(group.capture(), [])
    assert.equal(group.verifiedIdentity(profiles.pid)?.command, '/usr/bin/profiles status -type enrollment')
    host.replace(profiles.pid, { command: '/usr/bin/another-tool' })
    assert.equal(group.verifiedIdentity(profiles.pid), undefined)
    const report = group.signalReport('SIGKILL')
    assert.match(report.identityRefusals.join(' '), /Recorded process 28961 has a different identity \(recorded descendant; command reading changed;/)
    assert.equal(host.signals.some((entry) => entry.pid === profiles.pid), false)
  })

  test('a parent that exits, or a new process group, leaves a recorded helper the same process', () => {
    const { host, group } = launched(network, gpu)
    host.replace(root.pid, { state: 'Z', command: '<defunct>' })
    host.replace(network.pid, { parentPid: 1 })
    host.replace(gpu.pid, { parentPid: 1, groupId: gpu.pid })
    assert.deepEqual(group.signalReport('SIGKILL'), { problems: [], identityRefusals: [] })
    assert.deepEqual(host.signals.map((entry) => entry.pid), [gpu.pid, network.pid], 'the zombie root needs no signal')
  })

  test('a zombie is neither signaled nor refused, whatever ps shows for its command', () => {
    const { host, group } = launched(network)
    host.replace(network.pid, { state: 'Z', command: '<defunct>' })
    host.replace(root.pid, { state: 'Z', command: exiting })
    assert.deepEqual(group.signalReport('SIGKILL'), { problems: [], identityRefusals: [] })
    assert.deepEqual(host.signals, [])
  })
})

describe('a different process is still refused', () => {
  test('a pid reused by a process started at another moment is refused, whatever its command reads', () => {
    for (const command of [network.command, exiting, '/usr/bin/another-tool']) {
      const { host, group } = launched(network)
      host.replace(network.pid, { startedAt: 'Mon Oct  5 03:01:50 2026', command, parentPid: 1, groupId: network.pid })
      const report = group.signalReport('SIGKILL')
      assert.deepEqual(report.problems, [])
      assert.match(report.identityRefusals.join(' '), /Recorded process 28955 has a different identity \(recorded descendant; start reading changed/, command)
      assert.equal(host.signals.some((entry) => entry.pid === network.pid), false, command)
      assert.equal(group.verifiedIdentity(network.pid), undefined, command)
    }
  })

  test('two readable command lines with the same start are refused, since the start reading has whole seconds', () => {
    const { host, group } = launched(network)
    host.replace(network.pid, { command: '/usr/bin/another-tool --serve' })
    const report = group.signalReport('SIGKILL')
    assert.match(report.identityRefusals.join(' '), /Recorded process 28955 has a different identity \(recorded descendant; command reading changed;/)
    assert.equal(host.signals.some((entry) => entry.pid === network.pid), false)
    assert.equal(group.remains(), true, 'a process with the recorded start still holds cleanup')
  })

  test('a process table that cannot be read in time is a failed verification, never a different identity, and signals nothing', () => {
    const { host, group } = launched(network)
    host.failure = 'The metadata process did not answer before its deadline.'
    const report = group.signalReport('SIGKILL')
    assert.deepEqual(report.identityRefusals, [])
    assert.match(report.problems.join(' '), /Could not read ownership of process 28948: The metadata process did not answer before its deadline/)
    assert.equal(host.signals.length, 0)
    assert.equal(group.remains(), true, 'an unanswered reading cannot prove the browser ended')
    host.failure = undefined
    assert.deepEqual(group.signalReport('SIGKILL'), { problems: [], identityRefusals: [] })
    assert.deepEqual(host.signals.map((entry) => entry.pid), [network.pid, root.pid])
  })
})

/** A host that also reads one pid, and keeps the order of every reading and signal. */
class OnePidHost extends RecordedHost {
  readonly calls: string[] = []
  /** What the next full table reading shows, when it lags behind the host, as a table read before a reuse does. */
  table: OwnedProcessIdentity[] | undefined

  override read(): OwnedProcessIdentity[] {
    this.calls.push('read table')
    return (this.table ?? super.read()).map((entry) => ({ ...entry }))
  }

  readProcess(pid: number): OwnedProcessIdentity | undefined {
    this.calls.push(`read ${pid}`)
    const found = this.processes.find((entry) => entry.pid === pid)
    return found === undefined ? undefined : { ...found }
  }

  override signal(pid: number, signal: NodeJS.Signals | 0): void {
    this.calls.push(`signal ${pid}`)
    super.signal(pid, signal)
  }
}

describe('each signal follows a fresh reading of that one pid', () => {
  test('100 absent historical helpers need only one individual identity reading for the live root', () => {
    const history = Array.from({ length: 100 }, (_, index): OwnedProcessIdentity => ({ ...network, pid: 30000 + index }))
    const host = new OnePidHost([root, ...history])
    const group = new OwnedProcessGroup(root.pid, retest, host)
    assert.deepEqual(group.capture(), [])
    host.processes = [root]
    host.calls.length = 0
    assert.deepEqual(group.signalReport('SIGTERM'), { problems: [], identityRefusals: [] })
    assert.deepEqual(host.signals.map((entry) => entry.pid), [root.pid])
    assert.deepEqual(host.calls, ['read table', `read ${root.pid}`, `signal ${root.pid}`])
  })

  test('a failed snapshot holds ownership and signals nothing even when individual readings would succeed', () => {
    const host = new OnePidHost([root, network])
    const group = new OwnedProcessGroup(root.pid, retest, host)
    assert.deepEqual(group.capture(), [])
    host.failure = 'snapshot failed'
    host.calls.length = 0
    const report = group.signalReport('SIGKILL')
    assert.match(report.problems.join(' '), /snapshot failed/)
    assert.deepEqual(report.identityRefusals, [])
    assert.deepEqual(host.calls, ['read table'])
    assert.equal(host.signals.length, 0)
    assert.equal(group.remains(), true)
    host.failure = undefined
    assert.deepEqual(group.signalReport('SIGKILL'), { problems: [], identityRefusals: [] })
    assert.deepEqual(host.signals.map((entry) => entry.pid), [network.pid, root.pid])
    assert.match(group.readProblems.join(' '), /snapshot failed/)
  })

  test('a helper shown gone is forgotten before that pid returns outside the launch ancestry', () => {
    const host = new OnePidHost([root, network])
    const group = new OwnedProcessGroup(root.pid, retest, host)
    assert.deepEqual(group.capture(), [])
    host.processes = [root]
    assert.deepEqual(group.capture(), [])
    host.processes.push({ ...network, parentPid: 1, groupId: network.pid, startedAt: 'another start' })
    host.calls.length = 0
    assert.deepEqual(group.signalReport('SIGTERM'), { problems: [], identityRefusals: [] })
    assert.deepEqual(host.calls, ['read table', `read ${root.pid}`, `signal ${root.pid}`])
    assert.deepEqual(host.signals.map((entry) => entry.pid), [root.pid])
  })

  test('every recorded pid is read alone right before its own signal', () => {
    const host = new OnePidHost([root, network, gpu])
    const group = new OwnedProcessGroup(root.pid, retest, host)
    assert.deepEqual(group.capture(), [])
    host.calls.length = 0
    assert.deepEqual(group.signalReport('SIGKILL'), { problems: [], identityRefusals: [] })
    assert.deepEqual(host.calls, ['read table', `read ${gpu.pid}`, `signal ${gpu.pid}`, `read ${network.pid}`, `signal ${network.pid}`, `read ${root.pid}`, `signal ${root.pid}`])
  })

  test('a pid reused after the table was read is refused on the one-pid reading, not signaled', () => {
    const host = new OnePidHost([root, network])
    const group = new OwnedProcessGroup(root.pid, retest, host)
    assert.deepEqual(group.capture(), [])
    host.table = [root, network]
    host.replace(network.pid, { startedAt: 'Mon Oct  5 03:01:50 2026', command: '/usr/bin/another-tool', parentPid: 1, groupId: network.pid })
    const report = group.signalReport('SIGKILL')
    assert.match(report.identityRefusals.join(' '), /Recorded process 28955 has a different identity \(recorded descendant; start reading changed/)
    assert.deepEqual(host.signals.map((entry) => entry.pid), [root.pid], 'only the root, which is still the recorded process, is signaled')
  })

  test('a one-pid reading that fails signals nothing further and is kept as a read problem', () => {
    const host = new OnePidHost([root, network])
    const group = new OwnedProcessGroup(root.pid, retest, host)
    assert.deepEqual(group.capture(), [])
    host.readProcess = () => { throw new Error('The metadata process did not answer before its deadline.') }
    const report = group.signalReport('SIGKILL')
    assert.match(report.problems.join(' '), /Could not verify recorded process 28955, so it was not signaled/)
    assert.deepEqual(host.signals, [])
    assert.match(group.readProblems.join(' '), /did not answer before its deadline/)
  })

  test('a deadline ending during identity comparison prevents the signal on both cleanup paths', async () => {
    for (const asynchronous of [false, true]) {
      let now = 0
      const signals: number[] = []
      const current: OwnedProcessIdentity = { ...root, get command() { now = 10; return root.command } }
      const group = new OwnedProcessGroup(root.pid, retest, {
        read: () => [root],
        readAsync: async () => [root],
        readProcess: () => current,
        readProcessAsync: async () => current,
        signal: (pid) => { signals.push(pid) },
      })
      assert.deepEqual(group.capture(), [])
      const deadline = new Deadline(10, { clock: () => now })
      const report = asynchronous ? await group.signalReportAsync('SIGKILL', deadline) : group.signalReport('SIGKILL', deadline)
      assert.deepEqual(signals, [], 'identity comparison used the last of the caller budget')
      assert.match(report.problems.join(' '), /deadline/)
      assert.equal(group.remains(), true)
    }
  })

  test('the host reads one real pid, and an absent pid as absent rather than as a failed reading', async () => {
    const child = spawn('/bin/sleep', ['30'], { detached: true, stdio: 'ignore' })
    try {
      await once(child, 'spawn')
      const pid = child.pid
      assert.ok(pid !== undefined)
      const group = new OwnedProcessGroup(pid)
      assert.deepEqual(group.capture(), [])
      assert.deepEqual(group.signalReport('SIGKILL'), { problems: [], identityRefusals: [] })
      const [, signal] = await once(child, 'exit')
      assert.equal(signal, 'SIGKILL')
      assert.deepEqual(group.signalReport('SIGKILL'), { problems: [], identityRefusals: [] }, 'a pid that is gone is read as gone, with no failed reading')
      assert.deepEqual(group.readProblems, [])
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }
  })
})

describe('a reading taken without holding the thread', () => {
  test('an older background snapshot cannot restore helpers a newer snapshot showed gone', async () => {
    const host = new OnePidHost([root, network])
    const reading = Promise.withResolvers<OwnedProcessIdentity[]>()
    const group = new OwnedProcessGroup(root.pid, retest, Object.assign(host, { readAsync: () => reading.promise }))
    assert.deepEqual(group.capture(), [])
    const pending = group.captureAsync()
    host.processes = [root]
    assert.deepEqual(group.capture(), [])
    reading.resolve([root, network])
    assert.deepEqual(await pending, [])
    host.calls.length = 0
    assert.deepEqual(group.signalReport('SIGTERM'), { problems: [], identityRefusals: [] })
    assert.deepEqual(host.calls, ['read table', `read ${root.pid}`, `signal ${root.pid}`])
  })

  test('records a process that appeared beneath the launch, as a reading taken at once would', async () => {
    const host = new RecordedHost([root])
    const background = Object.assign(host, { readAsync: async () => host.read() })
    const group = new OwnedProcessGroup(root.pid, retest, background)
    assert.deepEqual(group.capture(), [])
    host.processes.push(network)
    assert.deepEqual(await group.captureAsync(), [])
    assert.deepEqual(group.signalReport('SIGKILL'), { problems: [], identityRefusals: [] })
    assert.deepEqual(host.signals.map((entry) => entry.pid), [network.pid, root.pid], 'the helper recorded from the background reading is ended through its record')
  })

  test('a background reading that fails records nothing and is no read problem, since it decides nothing', async () => {
    const host = new RecordedHost([root])
    const failing = Object.assign(host, { readAsync: async (): Promise<OwnedProcessIdentity[]> => { throw new Error('The metadata worker did not answer the query.') } })
    const group = new OwnedProcessGroup(root.pid, retest, failing)
    assert.deepEqual(group.capture(), [])
    host.processes.push(network)
    assert.deepEqual(await group.captureAsync(), [])
    assert.deepEqual(group.readProblems, [])
    assert.equal(group.verifiedIdentity(network.pid), undefined, 'nothing was recorded from the failed reading')
  })

  test('on the host, a background reading records a child started after the launch was recorded', async () => {
    const shell = spawn('/bin/sh', ['-c', 'sleep 30 & echo $!; wait'], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] })
    try {
      await once(shell, 'spawn')
      const pid = shell.pid
      assert.ok(pid !== undefined)
      const group = new OwnedProcessGroup(pid)
      assert.deepEqual(group.capture(), [])
      const [printed] = await once(shell.stdout, 'data')
      const sleeper = Number(String(printed).trim())
      assert.ok(Number.isSafeInteger(sleeper) && sleeper > 1, `the shell printed its child: ${String(printed)}`)
      assert.deepEqual(await group.captureAsync(), [])
      assert.ok(group.verifiedIdentity(sleeper) !== undefined, 'the child is recorded beneath the launch')
      assert.deepEqual(group.signalReport('SIGKILL'), { problems: [], identityRefusals: [] })
      await once(shell, 'exit')
      for (let tries = 0; tries < 100 && group.remains(); tries += 1) await new Promise((resolve) => setTimeout(resolve, 20))
      assert.equal(group.remains(), false, 'the shell and its child are gone')
    } finally {
      if (shell.exitCode === null && shell.signalCode === null) shell.kill('SIGKILL')
    }
  })
})

describe('asynchronous cleanup keeps the immediate identity check and its caller budget', () => {
  function asynchronous(host: OnePidHost): ProcessOwnershipSystem {
    return {
      read: () => host.read(),
      readAsync: async () => host.read(),
      readProcess: () => { throw new Error('cleanup must use the asynchronous one-pid reading') },
      readProcessAsync: async (pid) => host.readProcess(pid),
      signal: (pid, signal) => host.signal(pid, signal),
    }
  }

  test('the host ends a recorded process through asynchronous cleanup while timers can run', async () => {
    const child = spawn('/bin/sleep', ['30'], { detached: true, stdio: 'ignore' })
    let timer: NodeJS.Timeout | undefined
    try {
      await once(child, 'spawn')
      assert.ok(child.pid !== undefined)
      const group = new OwnedProcessGroup(child.pid)
      assert.deepEqual(group.capture(), [])
      const exited = once(child, 'exit')
      let ticks = 0
      timer = setInterval(() => { ticks += 1 }, 1)
      assert.deepEqual(await group.signalReportAsync('SIGKILL', new Deadline(1000)), { problems: [], identityRefusals: [] })
      const [, signal] = await exited
      assert.equal(signal, 'SIGKILL')
      assert.ok(ticks > 0, 'the host timer ran during its asynchronous process readings')
      assert.equal(await group.remainsAsync(new Deadline(1000)), false)
    } finally {
      clearInterval(timer)
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit')
        child.kill('SIGKILL')
        await exited
      }
    }
  })

  test('100 absent historical helpers need only the live root reading on asynchronous cleanup too', async () => {
    const history = Array.from({ length: 100 }, (_, index): OwnedProcessIdentity => ({ ...network, pid: 30000 + index }))
    const host = new OnePidHost([root, ...history])
    const group = new OwnedProcessGroup(root.pid, retest, asynchronous(host))
    assert.deepEqual(group.capture(), [])
    host.processes = [root]
    host.calls.length = 0
    assert.deepEqual(await group.signalReportAsync('SIGTERM', new Deadline(1000)), { problems: [], identityRefusals: [] })
    assert.deepEqual(host.calls, ['read table', `read ${root.pid}`, `signal ${root.pid}`])
    assert.deepEqual(host.signals.map((entry) => entry.pid), [root.pid])
  })

  test('a pid reused between the asynchronous snapshot and its own reading is never signaled', async () => {
    const host = new OnePidHost([root, network])
    const group = new OwnedProcessGroup(root.pid, retest, asynchronous(host))
    assert.deepEqual(group.capture(), [])
    host.table = [root, network]
    host.replace(network.pid, { startedAt: 'another start', parentPid: 1, groupId: network.pid })
    const report = await group.signalReportAsync('SIGKILL', new Deadline(1000))
    assert.deepEqual(report.problems, [])
    assert.match(report.identityRefusals.join(' '), /start reading changed/)
    assert.deepEqual(host.signals.map((entry) => entry.pid), [root.pid])
  })

  test('a failed asynchronous snapshot holds ownership without any individual read or signal', async () => {
    const host = new OnePidHost([root, network])
    const group = new OwnedProcessGroup(root.pid, retest, asynchronous(host))
    assert.deepEqual(group.capture(), [])
    host.failure = 'snapshot failed'
    host.calls.length = 0
    assert.match((await group.signalReportAsync('SIGKILL')).problems.join(' '), /snapshot failed/)
    assert.deepEqual(host.calls, ['read table'])
    assert.equal(host.signals.length, 0)
    assert.equal(await group.remainsAsync(), true)
    host.failure = undefined
    assert.deepEqual(await group.signalReportAsync('SIGKILL'), { problems: [], identityRefusals: [] })
    assert.deepEqual(host.signals.map((entry) => entry.pid), [network.pid, root.pid])
  })

  test('a failed asynchronous one-pid query neither signals nor forgets the candidate, and a later query can succeed', async () => {
    const host = new OnePidHost([root, network])
    const system = asynchronous(host)
    const read = system.readProcessAsync
    system.readProcessAsync = async () => { throw new Error('one-pid failed') }
    const group = new OwnedProcessGroup(root.pid, retest, system)
    assert.deepEqual(group.capture(), [])
    assert.match((await group.signalReportAsync('SIGKILL')).problems.join(' '), /Could not verify recorded process 28955.*one-pid failed/)
    assert.equal(host.signals.length, 0)
    assert.equal(await group.remainsAsync(), true)
    assert.ok(read !== undefined)
    system.readProcessAsync = read
    assert.deepEqual(await group.signalReportAsync('SIGKILL'), { problems: [], identityRefusals: [] })
    assert.deepEqual(host.signals.map((entry) => entry.pid), [network.pid, root.pid])
    assert.match(group.readProblems.join(' '), /one-pid failed/)
  })

  test('a deadline ending during the snapshot dispatches no individual query and does not release ownership', async () => {
    let now = 0
    const deadline = new Deadline(10, { clock: () => now })
    const host = new OnePidHost([root, network])
    const system = asynchronous(host)
    system.readAsync = async () => { now = 10; return host.read() }
    const group = new OwnedProcessGroup(root.pid, retest, system)
    assert.deepEqual(group.capture(), [])
    host.calls.length = 0
    const report = await group.signalReportAsync('SIGKILL', deadline)
    assert.match(report.problems.join(' '), /not confirmed before its deadline/)
    assert.deepEqual(host.calls, ['read table'])
    assert.deepEqual(host.signals, [])
    assert.equal(await group.remainsAsync(deadline), true)
  })

  test('a deadline ending during a one-pid reading prevents its signal and every later query', async () => {
    let now = 0
    const deadline = new Deadline(10, { clock: () => now })
    const host = new OnePidHost([root, network])
    const system = asynchronous(host)
    system.readProcessAsync = async (pid) => { now = 10; return host.readProcess(pid) }
    const group = new OwnedProcessGroup(root.pid, retest, system)
    assert.deepEqual(group.capture(), [])
    host.calls.length = 0
    assert.match((await group.signalReportAsync('SIGKILL', deadline)).problems.join(' '), /Could not verify recorded process 28955.*deadline/)
    assert.deepEqual(host.calls, ['read table', `read ${network.pid}`])
    assert.deepEqual(host.signals, [])
    assert.equal(group.remains(), true)
  })

  test('forgetting a gone launch root does not adopt a different process group reusing its number', () => {
    const host = new OnePidHost([root, network])
    const group = new OwnedProcessGroup(root.pid, retest, host)
    assert.deepEqual(group.capture(), [])
    host.processes = [{ ...network, parentPid: 1 }]
    assert.deepEqual(group.capture(), [])
    host.processes.push({ ...root, startedAt: 'another start' }, { ...gpu, parentPid: root.pid, startedAt: 'another start' })
    assert.deepEqual(group.signalReport('SIGKILL'), { problems: [], identityRefusals: [] })
    assert.deepEqual(host.signals.map((entry) => entry.pid), [network.pid])
    assert.equal(group.remains(), false, 'the unrelated new group does not hold the old launch resource')
  })
})

describe('sameProcessIdentity', () => {
  test('compares pid and start always, and the command only where both readings could read it', () => {
    assert.equal(sameProcessIdentity(network, { ...network, state: 'U' }), true)
    assert.equal(sameProcessIdentity(network, { ...network, command: exiting }), true, 'macOS prints the short name in parentheses')
    assert.equal(sameProcessIdentity({ ...network, command: 'chrome --type=renderer' }, { ...network, command: '[chrome]' }), true, 'procps prints it in brackets')
    assert.equal(sameProcessIdentity({ ...network, command: exiting }, network), true, 'a record taken before the arguments could be read')
    assert.equal(sameProcessIdentity(network, { ...network, pid: network.pid + 1 }), false)
    assert.equal(sameProcessIdentity(network, { ...network, startedAt: 'Mon Oct  5 03:01:48 2026', command: exiting }), false)
    assert.equal(sameProcessIdentity(network, { ...network, command: `${helperPath} --type=renderer` }), false)
    assert.equal(sameProcessIdentity(network, { ...network, command: '(Google Chrome for Testing)' }), false, 'longer than the kernel name, so it is a readable command line')
    assert.equal(sameProcessIdentity(network, { ...network, command: '(Google Chrome fo) --type=renderer' }), false)
  })
})
