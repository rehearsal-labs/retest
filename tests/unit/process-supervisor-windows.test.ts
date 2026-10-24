import type { ChildProcess } from 'node:child_process'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { describe, test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { Deadline } from '../../src/protocol/deadline.ts'
import { asOneRun, heldLaunches, holdLaunch, prepareOwnedLaunch, runnerStrayProblems } from '../../src/shared/process-system.ts'
import { windowsOnly } from '../support/platform-skip.ts'
import { isGoneWithin } from '../support/run-harness.ts'

// The promises process-ownership.test.ts makes of the `ps` host, made of real processes held in Windows jobs through the
// real retest-supervisor, which RETEST_SUPERVISOR_BINARY names or `retest install supervisor` installed. This test
// process is held in its runner job like any runner.

const jobs = windowsOnly('Windows jobs exist only on Windows; process-ownership.test.ts reads real processes through ps elsewhere')

// A Node process that starts a helper `afterMs` after it starts, prints the helper's pid, and then either waits or ends.
// The helper starts detached: Node ends an attached child with its parent, through a job of its own, and one that outlives
// its parent is what a launch's job must still hold.
function launch(afterMs: number, then: 'wait' | 'end'): ChildProcess {
  const script = `setTimeout(() => {
    const helper = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore', detached: true })
    process.stdout.write('helper ' + helper.pid + '\\n')
    ${then === 'end' ? "setTimeout(() => process.exit(0), 100)" : 'setTimeout(() => {}, 60000)'}
  }, ${afterMs})`
  prepareOwnedLaunch()
  return spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'ignore'] })
}

async function helperOf(child: ChildProcess): Promise<number> {
  assert.ok(child.stdout !== null)
  let text = ''
  for await (const chunk of child.stdout) {
    text += String(chunk)
    const pid = /helper (\d+)/.exec(text)?.[1]
    if (pid !== undefined) return Number(pid)
  }
  throw new Error('the launch ended before it named its helper')
}

async function printed(child: ChildProcess, word: string, timeoutMs: number): Promise<boolean> {
  assert.ok(child.stdout !== null)
  const end = performance.now() + timeoutMs
  let text = ''
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => { text += chunk })
  while (!text.includes(word)) {
    if (performance.now() > end || child.exitCode !== null) return text.includes(word)
    await delay(25)
  }
  return true
}

async function goneWithin(ownership: ReturnType<typeof holdLaunch>, timeoutMs: number): Promise<boolean> {
  const deadline = new Deadline(timeoutMs)
  while (await ownership.remainsAsync(deadline)) {
    if (deadline.expired) return false
    await delay(25)
  }
  return true
}

describe('a launch held in its own Windows job', { skip: jobs }, () => {
  test('is read from its job and ended by it, and once ended is read as gone, not as a failed reading', async () => {
    const child = launch(60_000, 'wait')
    await once(child, 'spawn')
    const ownership = holdLaunch(child)
    assert.deepEqual(ownership.capture(), [])
    assert.ok(ownership.heldByJob)
    assert.ok(ownership.verifiedIdentity()?.command.toLowerCase().endsWith('node.exe'), 'the launch is named by its executable')
    const exited = once(child, 'exit')
    assert.deepEqual(ownership.signalReport('SIGKILL'), { problems: [], identityRefusals: [] })
    await exited
    assert.equal(await goneWithin(ownership, 5000), true)
    assert.deepEqual(ownership.signalReport('SIGKILL'), { problems: [], identityRefusals: [] }, 'a launch that is gone is read as gone')
    assert.deepEqual(ownership.readProblems, [])
  })

  test('a reading taken without holding the thread records a helper the launch started after it was held', async () => {
    const child = launch(300, 'wait')
    await once(child, 'spawn')
    const ownership = holdLaunch(child)
    assert.deepEqual(ownership.capture(), [])
    const helper = await helperOf(child)
    assert.deepEqual(await ownership.captureAsync(), [])
    assert.ok(ownership.verifiedIdentity(helper) !== undefined, 'the helper is in the job, so it is the launch own')
    assert.deepEqual(await ownership.signalReportAsync('SIGKILL', new Deadline(5000)), { problems: [], identityRefusals: [] })
    assert.equal(await goneWithin(ownership, 5000), true)
    assert.equal(await isGoneWithin(helper, 2000), true, 'the helper ended with its job')
  })

  test('a helper born before the launch was held is held with it', async () => {
    const child = launch(0, 'wait')
    await once(child, 'spawn')
    const helper = await helperOf(child)
    const ownership = holdLaunch(child)
    assert.deepEqual(ownership.capture(), [])
    assert.ok(ownership.verifiedIdentity(helper) !== undefined, 'the helper was found beneath the launch and put in its job')
    assert.deepEqual(ownership.signalReport('SIGKILL'), { problems: [], identityRefusals: [] })
    assert.equal(await goneWithin(ownership, 5000), true)
    assert.equal(await isGoneWithin(helper, 2000), true)
  })

  test('a helper whose launch has ended is still owned by being in its job, never left alone, and ends with it', async () => {
    const child = launch(300, 'end')
    await once(child, 'spawn')
    const ownership = holdLaunch(child)
    assert.deepEqual(ownership.capture(), [])
    const helper = await helperOf(child)
    await once(child, 'exit')
    assert.deepEqual(ownership.capture(), [], 'a member whose parent is gone is no unverified process')
    assert.ok(ownership.verifiedIdentity(helper) !== undefined)
    assert.ok(ownership.remains(), 'the helper keeps the launch there')
    let ticks = 0
    const timer = setInterval(() => { ticks += 1 }, 1)
    try {
      assert.deepEqual(await ownership.signalReportAsync('SIGKILL', new Deadline(5000)), { problems: [], identityRefusals: [] })
      assert.equal(await goneWithin(ownership, 5000), true)
    } finally {
      clearInterval(timer)
    }
    assert.ok(ticks > 0, 'timers ran while the job was ended and read')
    assert.equal(await isGoneWithin(helper, 2000), true)
  })

  // A console program on a console of its own, as an app server is started, is asked to stop by Ctrl+C there. A process
  // started from a service, as an SSH session or a CI step is, inherits Ctrl+C turned off, so a PowerShell turns it on
  // for itself before it runs Node, which inherits that.
  test('SIGINT is Ctrl+C on a console of its own, which a console program stops on', async () => {
    const node = `process.on('SIGINT', () => { process.stdout.write('stopped\\n'); process.exit(0) }); process.stdout.write('ready\\n'); setInterval(() => {}, 1000)`
    const script = `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class RetestCtrlC { [DllImport("kernel32.dll")] public static extern bool SetConsoleCtrlHandler(IntPtr handler, bool add); }'
[RetestCtrlC]::SetConsoleCtrlHandler([IntPtr]::Zero, $false) | Out-Null
& '${process.execPath.replaceAll("'", "''")}' -e "${node}"`
    prepareOwnedLaunch()
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
    await once(child, 'spawn')
    const ownership = holdLaunch(child)
    assert.deepEqual(ownership.capture(), [])
    assert.equal(await printed(child, 'ready', 30_000), true, 'Node started on the console')
    const exited = once(child, 'exit')
    assert.deepEqual(ownership.signal('SIGINT'), [])
    assert.equal(await printed(child, 'stopped', 5000), true, 'Node stopped on Ctrl+C')
    await exited
    assert.equal(await goneWithin(ownership, 5000), true)
    assert.deepEqual(ownership.readProblems, [])
  })

  test("Ctrl+C is never sent to a console Retest itself is on", async () => {
    prepareOwnedLaunch()
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    await once(child, 'spawn')
    const ownership = holdLaunch(child)
    assert.deepEqual(ownership.capture(), [])
    await delay(500)
    const supervisor = heldLaunches()?.supervisor
    const job = heldLaunches()?.launchOf(child.pid ?? 0)?.job
    assert.ok(supervisor !== undefined && job !== undefined)
    // Where this test runs with a console, the child shares it and is refused; without one, the child made its own.
    try {
      const sent = supervisor.interrupt(job)
      assert.ok(!sent.reached.includes(process.pid), 'Ctrl+C reached no console this process is on')
    } catch (error) {
      assert.match(String(error), /share Retest's console, so Ctrl\+C was not sent/)
    }
    const exited = once(child, 'exit')
    assert.deepEqual(ownership.signal('SIGKILL'), [])
    await exited
    assert.equal(await goneWithin(ownership, 5000), true)
  })

  // Two runs in one host, as a host's program holds them: each launch ends and leaves its helper, and the end of each run
  // names its own helper and not the other's, which the other's end names.
  test("two runs at once in one process each name at their end only the processes they started", async (t) => {
    const helpers: number[] = []
    t.after(() => { for (const pid of helpers) try { process.kill(pid) } catch { /* it had ended */ } })
    const ended = { first: Promise.withResolvers<void>(), second: Promise.withResolvers<void>() }
    const oneRun = async (name: 'first' | 'second', waitFor: Promise<void> | undefined): Promise<{ helper: number; atEnd: string[] }> => {
      const child = launch(200, 'end')
      const ownership = holdLaunch(child)
      assert.deepEqual(ownership.capture(), [])
      const helper = await helperOf(child)
      helpers.push(helper)
      await once(child, 'exit')
      ended[name].resolve()
      if (waitFor !== undefined) await waitFor
      return { helper, atEnd: await runnerStrayProblems() }
    }
    // Each run's end is read once both launches have ended, while the other run is still going.
    const [first, second] = await Promise.all([asOneRun(() => oneRun('first', ended.second.promise)), asOneRun(() => oneRun('second', ended.first.promise))])
    const names = (problems: readonly string[]): string[] => problems.flatMap((problem) => /^Process (\d+) /.exec(problem)?.[1] ?? [])
    assert.ok(names(first.atEnd).includes(String(first.helper)), `the first run names its own helper: ${first.atEnd.join(' ')}`)
    assert.ok(!names(first.atEnd).includes(String(second.helper)), `the first run does not name the second run's helper: ${first.atEnd.join(' ')}`)
    assert.ok(names(second.atEnd).includes(String(second.helper)), `the second run names its own helper: ${second.atEnd.join(' ')}`)
  })

  // The adoption window: a shell starts a second shell, which starts a ping and ends before the first is held. Nothing
  // ties that ping to the launch, so the launch's job is read empty while it runs; the runner's job still holds it, and
  // the launch's cleanup names it as running after the process that started it ended, blaming no launch. The first shell runs a ping of its own meanwhile, so it is
  // still running when it is held, as a launch is.
  test('a process orphaned before its launch was held leaves the launch cleanup unconfirmed, naming it', async (t) => {
    prepareOwnedLaunch()
    const child = spawn('cmd.exe', ['/d', '/c', 'cmd /d /c start /b ping -n 60 127.0.0.1 >nul & ping -n 30 127.0.0.1 >nul'], { stdio: 'ignore' })
    await once(child, 'spawn')
    await delay(1000)
    const ownership = holdLaunch(child)
    assert.deepEqual(ownership.capture(), [])
    assert.deepEqual(ownership.signal('SIGKILL'), [])
    assert.equal(await goneWithin(ownership, 5000), true, "the launch's own job is empty")
    const named = ownership.readProblems.map((problem) => /^Process (\d+) \(PING\.EXE\) is still running after the process that started it ended\. Retest ends it when Retest exits\.$/i.exec(problem)?.[1]).filter((pid) => pid !== undefined)
    t.after(() => { for (const pid of named) try { process.kill(Number(pid)) } catch { /* it had ended */ } })
    assert.equal(named.length, 1, `the orphaned ping is named: ${ownership.readProblems.join(' ')}`)
  })

  // A launch whose process starts a Node that starts another and ends before the launch is held: the last one is held
  // by nothing, and carries the launch's marker in its command line as a folder of a path, as a browser's processes
  // carry their profile folder. It is named once in the host, by whichever reads it first: the launch's reading once its
  // job is empty, or the run's end, which ties it to the run by the marker.
  function markedOrphan(marker: string): ChildProcess {
    const grandchild = `require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)', 'C:/Temp/${marker}/profile'], { stdio: 'ignore', detached: true }).unref()`
    const script = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'ignore' }); setTimeout(() => {}, 30000)`
    prepareOwnedLaunch()
    return spawn(process.execPath, ['-e', script], { stdio: 'ignore' })
  }

  for (const first of ['the launch', 'the run'] as const) {
    test(`a stray that carries a run's marker is named once in the host, first by ${first}`, async (t) => {
      const marker = `retest-marker-${process.pid}-${first === 'the launch' ? 'a' : 'b'}`
      const atEnd = await asOneRun(async () => {
        const child = markedOrphan(marker)
        await once(child, 'spawn')
        await delay(1500)
        const ownership = holdLaunch(child, { marker })
        assert.deepEqual(ownership.capture(), [])
        const exited = once(child, 'exit')
        assert.deepEqual(ownership.signal('SIGKILL'), [])
        await exited
        if (first === 'the launch') assert.equal(await goneWithin(ownership, 5000), true)
        const runEnd = await runnerStrayProblems()
        if (first === 'the run') assert.equal(await goneWithin(ownership, 5000), true)
        return { runEnd, launch: ownership.readProblems }
      })
      const pids = (problems: readonly string[]): string[] => problems.flatMap((problem) => /^Process (\d+) \(node\.exe\) is still running/i.exec(problem)?.[1] ?? [])
      const orphan = [...pids(atEnd.launch), ...pids(atEnd.runEnd)]
      t.after(() => { for (const pid of orphan) try { process.kill(Number(pid)) } catch { /* it had ended */ } })
      assert.equal(orphan.length, 1, `named once in the host: launch ${atEnd.launch.join(' ')} run ${atEnd.runEnd.join(' ')}`)
      if (first === 'the launch') assert.deepEqual([pids(atEnd.launch).length, pids(atEnd.runEnd).length], [1, 0], 'the launch named it, so the run end does not')
      else assert.deepEqual([pids(atEnd.runEnd).length, pids(atEnd.launch).length], [1, 0], 'the run end named it by its marker, so the launch does not')
    })
  }
})
