import type { OwnedProcessIdentity, ProcessOwnershipSystem } from '../../src/shared/process-ownership.ts'
import assert from 'node:assert/strict'
import { ChildProcess, spawn } from 'node:child_process'
import { once } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, test } from 'node:test'
import { ChromiumProcess } from '../../src/browser/chromium-process.ts'
import { Deadline } from '../../src/protocol/deadline.ts'
import { readMetadataProcess, useMetadataWorkerModule } from '../../src/shared/metadata-process.ts'
import { OwnedProcessGroup } from '../../src/shared/process-ownership.ts'

const retest = 41000
const root: OwnedProcessIdentity = { pid: 41100, parentPid: retest, groupId: 41100, state: 'Ss', startedAt: 'Mon Oct 12 21:43:09 2026', command: '/owned/browser --headless' }
const helper: OwnedProcessIdentity = { pid: 41101, parentPid: root.pid, groupId: root.pid, state: 'S', startedAt: 'Mon Oct 12 21:43:09 2026', command: '/owned/helper --type=renderer' }
const lateHelper: OwnedProcessIdentity = { pid: 41102, parentPid: root.pid, groupId: root.pid, state: 'S', startedAt: 'Mon Oct 12 21:43:10 2026', command: '/owned/helper --type=renderer' }

/**
 * A host whose whole-table readings without holding the thread are answered only when the test says, each recorded with
 * the deadline its caller gave and the table as it stood when it began, and failed when that deadline ends, as the
 * metadata worker fails a query. Its readings that hold the thread answer at once from `processes`, and every signal it
 * is sent is recorded.
 */
class HeldHost implements ProcessOwnershipSystem {
  processes: OwnedProcessIdentity[]
  readonly asynchronous: { deadline: Deadline | undefined; began: OwnedProcessIdentity[]; answer: (processes: readonly OwnedProcessIdentity[]) => void; fail: (error: Error) => void }[] = []
  readonly signals: string[] = []

  constructor(processes: OwnedProcessIdentity[]) {
    this.processes = processes
  }

  read(): OwnedProcessIdentity[] {
    return this.processes.map((entry) => ({ ...entry }))
  }

  readAsync(deadline?: Deadline): Promise<readonly OwnedProcessIdentity[]> {
    const { promise, resolve, reject } = Promise.withResolvers<readonly OwnedProcessIdentity[]>()
    this.asynchronous.push({ deadline, began: this.read(), answer: resolve, fail: reject })
    if (deadline !== undefined) {
      const ended = setTimeout(() => reject(new Error('The metadata query was not confirmed before its caller deadline ended or was cancelled.')), deadline.waitToEndMs)
      ended.unref()
      void promise.then(() => clearTimeout(ended), () => clearTimeout(ended))
    }
    return promise
  }

  async readProcessAsync(pid: number): Promise<OwnedProcessIdentity | undefined> {
    return this.read().find((entry) => entry.pid === pid)
  }

  signal(pid: number, signal: NodeJS.Signals | 0): void {
    this.signals.push(`${signal} ${pid}`)
  }

  /** Answers the reading the test started `index`th, with the processes the host shows now. */
  answer(index: number): void {
    const reading = this.asynchronous[index]
    assert.ok(reading !== undefined, `reading ${index} was started`)
    reading.answer(this.read())
  }

  /** Answers the reading the test started `index`th with the table as it stood when that reading began, as `ps` does. */
  answerAsBegun(index: number): void {
    const reading = this.asynchronous[index]
    assert.ok(reading !== undefined, `reading ${index} was started`)
    reading.answer(reading.began)
  }
}

function launched(processes: OwnedProcessIdentity[]): { host: HeldHost; group: OwnedProcessGroup } {
  const host = new HeldHost(processes)
  const group = new OwnedProcessGroup(root.pid, retest, host)
  assert.deepEqual(group.capture(), [])
  return { host, group }
}

// A reading these tests never answer would otherwise hold the file open instead of failing it.
const bounded = { timeout: 10_000 }

// Lets every continuation already queued run, as the reading's callers resume one after another.
async function settled(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
}

describe('callers that read a group at once share one reading', () => {
  test('three waits on one group, as a close runs them, start one reading and all answer from it', bounded, async () => {
    const { host, group } = launched([root, helper])
    host.processes = []
    const answers = Promise.all([group.remainsAsync(new Deadline(5000)), group.remainsAsync(new Deadline(5000)), group.remainsAsync(new Deadline(4000))])
    await settled()
    assert.equal(host.asynchronous.length, 1, 'one reading, not one for each caller')
    host.answer(0)
    assert.deepEqual(await answers, [false, false, false])
    assert.equal(host.asynchronous.length, 1, 'no caller read again once one of them saw the group gone')
    assert.deepEqual(group.readProblems, [])
  })

  test('a snapshot its callers apply one after another does not make a reading begun after it stale', bounded, async () => {
    const { host, group } = launched([root, helper])
    const capturing = group.captureAsync().then(() => group.remainsAsync())
    const remaining = group.remainsAsync()
    await settled()
    assert.equal(host.asynchronous.length, 1)
    host.answer(0)
    assert.equal(await remaining, true)
    await settled()
    assert.equal(host.asynchronous.length, 2, 'the capture asked again once it had applied the first reading')
    host.processes = []
    host.answer(1)
    assert.equal(await capturing, false)
    assert.equal(host.asynchronous.length, 2, 'the second reading was applied, not discarded and started again')
  })

  test('once a newer reading shows the group gone, a caller waiting on an older one stops without reading again', bounded, async () => {
    const { host, group } = launched([root, helper])
    const waiting = [group.remainsAsync(), group.remainsAsync()]
    await settled()
    host.processes = []
    assert.equal(group.remains(), false, 'a reading taken at once shows the group gone')
    host.processes = [root, helper]
    host.answer(0)
    assert.deepEqual(await Promise.all(waiting), [false, false])
    assert.equal(host.asynchronous.length, 1, 'the older snapshot is not applied, and no reading follows it')
  })

  test('an older reading is still never applied over a newer one: it is read again', bounded, async () => {
    const { host, group } = launched([root, helper])
    const waiting = group.remainsAsync()
    await settled()
    host.processes = [root]
    assert.deepEqual(group.capture(), [], 'a reading taken at once is applied first')
    host.answer(0)
    await settled()
    assert.equal(host.asynchronous.length, 2, 'the snapshot that began before it was read again')
    host.processes = []
    host.answer(1)
    assert.equal(await waiting, false)
  })
})

describe('each caller keeps its own deadline on a shared reading', () => {
  test('a caller sharing a reading that fails moves at once to a fresh one, and answers within its own deadline without a read problem', bounded, async () => {
    const { host, group } = launched([root, helper])
    const background = group.captureAsync()
    await settled()
    const joining = group.remainsAsync(new Deadline(2000))
    await settled()
    assert.equal(host.asynchronous.length, 1, 'the caller shares the reading under way')
    host.asynchronous[0]?.fail(new Error('The metadata worker did not answer the query.'))
    assert.deepEqual(await background, [], 'a background capture whose reading failed decides nothing')
    await settled()
    assert.equal(host.asynchronous.length, 2, 'the caller that shared it read again')
    host.processes = []
    host.answer(1)
    assert.equal(await joining, false)
    assert.deepEqual(group.readProblems, [])
  })

  test('a caller sharing a reading still under way waits for it only until its own deadline, and leaves it running for the caller that began it', bounded, async () => {
    const { host, group } = launched([root, helper])
    const starting = group.remainsAsync()
    await settled()
    const joining = group.remainsAsync(new Deadline(20))
    assert.equal(await joining, true, 'a reading not confirmed in time holds the resource')
    assert.match(group.readProblems.join(' '), /not confirmed before its (caller )?deadline/)
    host.processes = []
    host.answer(0)
    assert.equal(await starting, false)
  })

  test("a reading another caller's shorter deadline ended is read again within the joining caller's own", bounded, async () => {
    const { host, group } = launched([root, helper])
    const short = new Deadline(5000)
    const long = new Deadline(10_000)
    const shortWait = group.remainsAsync(short)
    await settled()
    const longWait = group.remainsAsync(long)
    await settled()
    assert.equal(host.asynchronous.length, 1)
    host.asynchronous[0]?.fail(new Error('The metadata query was not confirmed before its caller deadline ended or was cancelled.'))
    assert.equal(await shortWait, true)
    await settled()
    assert.equal(host.asynchronous.length, 2, 'the joining caller read again')
    assert.equal(host.asynchronous[1]?.deadline, long, 'under its own deadline')
    host.processes = []
    host.answer(1)
    assert.equal(await longWait, false)
    assert.equal(group.readProblems.length, 1, "only the caller whose reading failed keeps a read problem")
  })
})

describe('a capture or a signal pass reads the host as it is when asked', () => {
  test('a signal pass asked while a background capture reads does not take that reading, so a helper born between is recorded and ended', bounded, async () => {
    const { host, group } = launched([root, helper])
    const background = group.captureAsync()
    await settled()
    host.processes = [root, helper, lateHelper]
    const killing = group.signalReportAsync('SIGKILL', new Deadline(5000))
    await settled()
    assert.equal(host.asynchronous.length, 2, 'the signal pass began a reading of its own')
    host.answerAsBegun(0)
    host.answerAsBegun(1)
    assert.deepEqual(await killing, { problems: [], identityRefusals: [] })
    await background
    assert.deepEqual(host.signals, [`SIGKILL ${lateHelper.pid}`, `SIGKILL ${helper.pid}`, `SIGKILL ${root.pid}`])
  })

  test('a capture asked while another reads begins its own, and a wait for the group asked later shares it', bounded, async () => {
    const { host, group } = launched([root])
    const first = group.captureAsync()
    await settled()
    host.processes = [root, helper]
    const second = group.captureAsync()
    const waiting = group.remainsAsync()
    await settled()
    assert.equal(host.asynchronous.length, 2, 'two captures, and the wait shares the later one')
    host.answerAsBegun(0)
    host.answerAsBegun(1)
    assert.deepEqual(await first, [])
    assert.deepEqual(await second, [])
    assert.equal(await waiting, true)
    assert.ok(group.verifiedIdentity(helper.pid) !== undefined, 'the helper born before the second capture was asked is recorded')
  })
})

describe('a reading on a worker ended for another query', () => {
  test('is asked again of a fresh worker, so a caller waiting with it answers within its deadline without a read problem', bounded, async (t) => {
    const sleeper = spawn('/bin/sleep', ['30'], { detached: true, stdio: 'ignore' })
    t.after(() => { if (sleeper.exitCode === null && sleeper.signalCode === null) sleeper.kill('SIGKILL') })
    await once(sleeper, 'spawn')
    assert.ok(sleeper.pid !== undefined)
    const group = new OwnedProcessGroup(sleeper.pid)
    assert.deepEqual(group.capture(), [])
    const restore = useMetadataWorkerModule(new URL('./metadata-slow-worker.ts', import.meta.url))
    t.after(restore)
    let settledMs: number | undefined
    const background = group.captureAsync().then((problems) => { settledMs = performance.now() - asked; return problems })
    // Another query stuck past its caller's deadline: giving it up ends the worker the background reading is on.
    assert.throws(() => readMetadataProcess({ command: '/bin/sleep', args: ['1'], environment: { PATH: '/usr/bin:/bin' }, deadline: new Deadline(50) }), /caller deadline|did not answer/)
    const asked = performance.now()
    assert.equal(await group.remainsAsync(new Deadline(2000)), true, 'the process is still there')
    const ms = performance.now() - asked
    assert.ok(ms < 1500, `the caller answered from a fresh reading, not at its deadline: ${Math.round(ms)} ms`)
    assert.deepEqual(group.readProblems, [])
    assert.deepEqual(await background, [], 'the background capture was answered too')
    assert.ok(settledMs !== undefined && settledMs < 1500, `the background reading was asked again at once, not left to its own bound: ${Math.round(settledMs ?? -1)} ms`)
  })
})

describe('a launch hands over the owner it has read', () => {
  function process(pid: number): ChildProcess {
    const child = new ChildProcess()
    Object.defineProperty(child, 'pid', { value: pid })
    return child
  }

  function withoutExitHooks<T>(work: () => T): T {
    const before = new Set(globalThis.process.listeners('exit'))
    try {
      return work()
    } finally {
      for (const listener of globalThis.process.listeners('exit')) if (!before.has(listener)) globalThis.process.off('exit', listener)
    }
  }

  test('an owner already read is not read again as the browser process is made', bounded, () => {
    const { host, group } = launched([root])
    let readings = 0
    host.read = () => { readings += 1; return [root] }
    withoutExitHooks(() => new ChromiumProcess(process(root.pid), undefined, { readable: new PassThrough(), writable: new PassThrough() }, undefined, group))
    assert.equal(readings, 0)
    assert.equal(group.captured, true)
  })

  test('an owner not yet read is read once as the browser process is made', bounded, () => {
    const host = new HeldHost([root])
    let readings = 0
    host.read = () => { readings += 1; return [root] }
    const group = new OwnedProcessGroup(root.pid, retest, host)
    assert.equal(group.captured, false)
    withoutExitHooks(() => new ChromiumProcess(process(root.pid), undefined, { readable: new PassThrough(), writable: new PassThrough() }, undefined, group))
    assert.equal(readings, 1)
    assert.equal(group.captured, true)
  })

  test('a first reading that failed still counts as read', bounded, () => {
    const host = new HeldHost([root])
    host.read = () => { throw new Error('The metadata worker did not answer the query.') }
    const group = new OwnedProcessGroup(root.pid, retest, host)
    assert.match(group.capture().join(' '), /did not answer/)
    assert.equal(group.captured, true)
  })
})
