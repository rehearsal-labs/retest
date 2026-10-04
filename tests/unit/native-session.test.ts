import type { AppBuild, ResetPolicy } from '../../src/browser/contract.ts'
import type { Failure } from '../../src/protocol/failures.ts'
import type { AppBundle, NativeExecutionIdentity } from '../../src/native/identity.ts'
import type { RecordedProcess } from '../../src/native/processes.ts'
import type { AppProcessReading, CaptureSource, DriverAnswer, LaunchSpec, NativeAppDriver } from '../../src/native/session.ts'
import type { ScopedSource } from '../../src/native/source-scope.ts'
import type { ExecutorAppState, RequestBounds } from '../../src/native/webdriver-client.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatSessionId } from '../../src/protocol/evidence.ts'
import { NativeAppSession, NativeError, SerialLane } from '../../src/native/session.ts'
import { solidPng } from './native-fake-executor.ts'

const bundle: AppBundle = { appPath: '/Apps/TaskDesk.app', bundleId: 'dev.retest.fixtures.taskdesk', version: '1.0', build: '1', executable: 'TaskDesk', platforms: ['MacOSX'], sha256: 'abc' }
const identity: NativeExecutionIdentity = {
  platform: 'macos',
  app: { bundleId: bundle.bundleId, version: '1.0', build: '1', path: bundle.appPath, sha256: 'abc' },
  os: { name: 'macOS', version: '27.0.1', build: '26A434' },
  executor: { name: 'mac2', version: '4.3.6', commit: 'f38257191fa9f273a684f6a9c8c2b16d1272bd09', commitVerified: false, productsSha256: 'def', origin: 'adopted' },
  xcode: { version: '26.5', build: '17F42' },
}
const interrupted: Failure = { class: 'interrupted', message: 'The run was interrupted.' }
type Behaviour = 'answer' | 'hang' | 'refused-connection' | 'invalid-session'

/**
 * A driver held in memory: the app runs when it says so, every call is recorded in order, and a call can be told to
 * hang until its signal stops it or its time runs out, as the client does.
 */
class MemoryDriver implements NativeAppDriver {
  readonly platform = 'macos' as const
  readonly bundle = bundle
  readonly identity = identity
  readonly resetPolicy: ResetPolicy = { appData: 'kept', keychain: 'kept' }
  readonly captureSources: readonly CaptureSource[] = ['window-crop']
  readonly runtimeProcessIds: readonly number[] = [100, 101]
  readonly calls: string[] = []
  readonly behaviour: Record<string, Behaviour> = {}
  running = false
  pid = 4242
  // The command line the operating system shows under the app's pid; another one there is another process that was
  // given the pid after the app ended.
  command = '/Apps/TaskDesk.app/Contents/MacOS/TaskDesk -reset'
  // Copies of the app this session did not launch, which the operating system shows beside its own.
  foreignPids: number[] = []
  processReadFails = false
  // How many readings fail before readings work again: a `ps` that fails for a while.
  failingReadings = 0
  readings = 0
  launchStartsApp = true
  // Readings that wait until they are stopped, as a `ps` or `lsappinfo` that is slow to answer.
  readingsHang = false
  blocker: Failure | undefined
  forceEndLeft: string[] = []
  forceEnded: number[][] = []
  forceEndedProcesses: RecordedProcess[][] = []
  releases = 0
  inFlight = 0
  mostInFlight = 0
  dispatched: (() => void) | undefined

  async #call<T>(name: string, bounds: RequestBounds, answer: () => T): Promise<DriverAnswer<T>> {
    this.calls.push(name)
    this.inFlight += 1
    this.mostInFlight = Math.max(this.mostInFlight, this.inFlight)
    try {
      const behaviour = this.behaviour[name] ?? 'answer'
      if (behaviour === 'refused-connection') return { status: 'not_sent', reason: 'connection_refused', message: 'nothing listens' }
      if (behaviour === 'invalid-session') return { status: 'refused', error: 'invalid session id', message: 'gone', httpStatus: 404, durationMs: 1 }
      if (behaviour === 'hang') {
        this.dispatched?.()
        return await new Promise((resolve) => {
          const timer = setTimeout(() => resolve({ status: 'unknown', reason: 'timeout', message: 'no answer', durationMs: bounds.timeoutMs }), bounds.timeoutMs)
          bounds.signal?.addEventListener('abort', () => {
            clearTimeout(timer)
            resolve({ status: 'unknown', reason: 'stopped', message: 'stopped', durationMs: 1 })
          })
        })
      }
      await new Promise((resolve) => setTimeout(resolve, 5))
      return { status: 'answered', value: answer(), durationMs: 5 }
    } finally {
      this.inFlight -= 1
    }
  }

  install(_build: AppBuild, bounds: RequestBounds): Promise<DriverAnswer<unknown>> {
    return this.#call('install', bounds, () => null)
  }
  async launchBlocker(bounds: RequestBounds): Promise<Failure | undefined> {
    this.calls.push('launchBlocker')
    if (this.readingsHang) {
      await stopped(bounds)
      return { class: 'not_actionable', message: 'Retest could not read whether a copy runs, so it launched nothing.' }
    }
    return this.blocker
  }
  launch(_launch: LaunchSpec, bounds: RequestBounds): Promise<DriverAnswer<unknown>> {
    return this.#call('launch', bounds, () => {
      if (this.launchStartsApp) this.running = true
      return null
    })
  }
  activate(bounds: RequestBounds): Promise<DriverAnswer<unknown>> {
    return this.#call('activate', bounds, () => null)
  }
  terminate(bounds: RequestBounds): Promise<DriverAnswer<boolean>> {
    return this.#call('terminate', bounds, () => {
      const was = this.running
      this.running = false
      return was
    })
  }
  state(bounds: RequestBounds): Promise<DriverAnswer<ExecutorAppState>> {
    return this.#call('state', bounds, (): ExecutorAppState => (this.running ? 4 : 1))
  }
  async processState(bounds: RequestBounds): Promise<AppProcessReading> {
    this.calls.push('processState')
    this.readings += 1
    if (this.readingsHang && bounds.signal !== undefined) {
      await stopped(bounds)
      return { ok: false, problem: 'ps was stopped' }
    }
    if (this.processReadFails) return { ok: false, problem: 'ps could not run' }
    if (this.failingReadings > 0) {
      this.failingReadings -= 1
      return { ok: false, problem: 'ps could not run' }
    }
    const processes = [...(this.running ? [{ pid: this.pid, command: this.command }] : []), ...this.foreignPids.map((pid) => ({ pid, command: '/Elsewhere/TaskDesk.app/Contents/MacOS/TaskDesk' }))]
    return { ok: true, running: processes.length > 0, pids: processes.map((entry) => entry.pid), processes }
  }
  capture(_source: CaptureSource, bounds: RequestBounds): Promise<DriverAnswer<Uint8Array>> {
    return this.#call('capture', bounds, () => solidPng(8, 6))
  }
  source(bounds: RequestBounds): Promise<DriverAnswer<ScopedSource>> {
    return this.#call('source', bounds, () => ({ xml: '<XCUIElementTypeWindow title="hunter2"/>', elements: 1, hashedMenuElements: 0 }))
  }
  async forceEnd(processes: readonly RecordedProcess[]): Promise<string[]> {
    this.forceEnded.push(processes.map((entry) => entry.pid))
    this.forceEndedProcesses.push([...processes])
    if (this.forceEndLeft.length === 0) this.running = false
    return this.forceEndLeft
  }
  async endExecutorSession(): Promise<string[]> {
    this.calls.push('endExecutorSession')
    return []
  }
  released(): void {
    this.releases += 1
  }
}

function stopped(bounds: RequestBounds): Promise<void> {
  return new Promise((resolve) => {
    if (bounds.signal?.aborted === true) resolve()
    bounds.signal?.addEventListener('abort', () => resolve(), { once: true })
  })
}

async function untilCalled(driver: MemoryDriver, call: string, times: number): Promise<void> {
  while (driver.calls.filter((made) => made === call).length < times) await new Promise((resolve) => setTimeout(resolve, 5))
}

function open(driver: MemoryDriver, attemptId = 'k3v9q0x2mb'): NativeAppSession {
  return new NativeAppSession(driver, { owner: { runId: 'run', testId: 'test', attemptId, app: 'desk' }, launch: { arguments: ['-reset'], environment: {} }, redact: (text) => text.replaceAll('hunter2', '{{password}}') })
}

test('everything a session hands out carries its session id and the launch it belongs to', async () => {
  const session = open(new MemoryDriver())
  assert.equal(session.sessionId, formatSessionId('k3v9q0x2mb', 'desk'))
  assert.equal(session.identity.sessionId, session.sessionId)
  assert.deepEqual((await session.launch(5000)).input, 'sent')
  const capture = await session.capture(5000)
  assert.ok(capture.ok)
  if (!capture.ok) return
  const { instance } = capture.capture.reference
  assert.match(instance, /^[0-9a-f]{12}$/)
  assert.deepEqual(capture.capture.reference, { sessionId: session.sessionId, instance, generation: 1, observationId: 'o1' })
  assert.equal(capture.capture.source, 'window-crop')
  assert.deepEqual([capture.capture.width, capture.capture.height], [8, 6])
  const tree = await session.readSource(5000)
  assert.ok(tree.ok)
  if (!tree.ok) return
  assert.deepEqual(tree.tree.reference, { sessionId: session.sessionId, instance, generation: 1, observationId: 'o2' })
  assert.equal(tree.tree.source.xml, '<XCUIElementTypeWindow title="{{password}}"/>', 'the tree is redacted before it leaves the session')
})

test('a launch reads the state first, asks the operating system what blocks it, launches once and notes its process', async () => {
  const driver = new MemoryDriver()
  const session = open(driver)
  assert.deepEqual(await session.launch(5000), { result: { ok: true }, input: 'sent' })
  assert.deepEqual(driver.calls, ['state', 'launchBlocker', 'launch', 'processState'])
  assert.deepEqual(session.processIds, [4242])
  assert.deepEqual(await session.appState(5000), { ok: true, state: 'foreground' })
  assert.deepEqual(await session.terminate(5000), { result: { ok: true }, input: 'sent' })
  assert.deepEqual(await session.appState(5000), { ok: true, state: 'not_running' })
  assert.deepEqual(session.appStatus, { generation: 1, expectedRunning: false, endedUnexpectedly: false, unexpectedEnds: [] })
})

test('a launch is refused while the app runs, so the executors cannot bring it forward with none of the arguments', async () => {
  const driver = new MemoryDriver()
  driver.running = true
  const launched = await open(driver).launch(5000)
  assert.equal(launched.input, 'not_sent')
  assert.equal(!launched.result.ok && launched.result.failure.class, 'not_actionable')
  assert.equal(driver.calls.includes('launch'), false)
})

test('a running copy the operating system shows blocks the launch, and nothing is sent', async () => {
  const driver = new MemoryDriver()
  driver.blocker = { class: 'not_actionable', message: 'A copy of dev.retest.fixtures.taskdesk is already running (pid 99).' }
  const launched = await open(driver).launch(5000)
  assert.deepEqual(launched, { result: { ok: false, failure: driver.blocker }, input: 'not_sent' })
  assert.equal(driver.calls.includes('launch'), false)
})

test('a reference from an earlier launch, another session or a lost session is refused', async () => {
  const driver = new MemoryDriver()
  const session = open(driver)
  await session.launch(5000)
  const first = await session.capture(5000)
  assert.ok(first.ok)
  if (!first.ok) return
  assert.equal(session.checkReference(first.capture.reference), undefined)
  await session.terminate(5000)
  assert.equal(session.checkReference(first.capture.reference)?.class, 'not_actionable', 'the launch is over')
  await session.launch(5000)
  const stale = session.checkReference(first.capture.reference)
  assert.equal(stale?.class, 'not_actionable')
  assert.match(stale?.message ?? '', /from launch 1; the app is on launch 2/)
  const other = open(new MemoryDriver(), 'p0q1r2s3t4')
  assert.equal(other.checkReference(first.capture.reference)?.class, 'usage')
  session.markLost({ class: 'session_lost', message: 'gone' })
  const current = { ...first.capture.reference, generation: 2 }
  assert.equal(session.checkReference(current)?.class, 'session_lost')
})

test('a cancelled session sends nothing more, and a stop takes its class from the failure it carries', async () => {
  const driver = new MemoryDriver()
  const session = open(driver)
  session.cancel(interrupted)
  const launched = await session.launch(5000)
  assert.equal(launched.input, 'not_sent')
  assert.equal(!launched.result.ok && launched.result.failure.class, 'interrupted')
  assert.deepEqual(driver.calls, [])
})

test('a cancel after the launch went leaves its outcome unknown, records it, and reconciliation reads the process', async () => {
  const driver = new MemoryDriver()
  driver.behaviour['launch'] = 'hang'
  const session = open(driver)
  const dispatched = new Promise<void>((resolve) => {
    driver.dispatched = resolve
  })
  const launching = session.launch(10_000)
  await dispatched
  session.cancel(interrupted)
  const launched = await launching
  assert.equal(launched.input, 'unknown')
  assert.equal(!launched.result.ok && launched.result.failure.class, 'interrupted')
  assert.equal(!launched.result.ok && launched.result.failure.details?.['inputSent'], 'unknown')
  assert.equal(session.unknownOutcomes.length, 1)
  assert.equal(session.unknownOutcomes[0]?.kind, 'launch')
  assert.equal((await session.activate(5000)).input, 'not_sent', 'nothing new goes after the cancel')
  // The app turns out to have started after all; reconciliation says where it stood, not what the launch did.
  driver.running = true
  const reconciled = await session.reconcile(5000)
  assert.deepEqual(reconciled[0]?.reconciled, { ok: true, running: true, pids: [4242] })
  assert.equal(driver.calls.filter((call) => call === 'launch').length, 1, 'the launch went once')
})

test('a launch whose answer never came within its time is unknown and is never sent again', async () => {
  const driver = new MemoryDriver()
  driver.behaviour['launch'] = 'hang'
  const session = open(driver)
  const launched = await session.launch(200)
  assert.equal(launched.input, 'unknown')
  assert.equal(!launched.result.ok && launched.result.failure.class, 'timeout')
  assert.equal(session.unknownOutcomes.length, 1)
  assert.equal(session.appStatus.expectedRunning, false, 'no process of the app was seen, so nothing is expected to run')
})

test('a launch that timed out before its app started is not later taken for a crash', async () => {
  const driver = new MemoryDriver()
  driver.behaviour['launch'] = 'hang'
  const session = open(driver)
  await session.launch(200)
  assert.deepEqual(await session.appState(5000), { ok: true, state: 'not_running' })
  assert.deepEqual(session.appStatus.unexpectedEnds, [])
  assert.equal(session.appStatus.endedUnexpectedly, false)
})

test('a caller signal stopped for no failure counts as a timeout', async () => {
  const driver = new MemoryDriver()
  driver.behaviour['activate'] = 'hang'
  driver.running = true
  const session = open(driver)
  const stop = new AbortController()
  setTimeout(() => stop.abort('the caller gave up'), 50)
  const activated = await session.activate(5000, stop.signal)
  assert.equal(!activated.result.ok && activated.result.failure.class, 'timeout')
  assert.equal(activated.input, 'unknown')
})

test('an app found not running after its launch has ended unexpectedly; activate refuses instead of relaunching it', async () => {
  const driver = new MemoryDriver()
  const session = open(driver)
  await session.launch(5000)
  driver.running = false
  const activated = await session.activate(5000)
  assert.equal(activated.input, 'not_sent')
  assert.equal(!activated.result.ok && activated.result.failure.class, 'session_lost')
  assert.equal(!activated.result.ok && activated.result.failure.details?.['appEnded'], true)
  assert.equal(driver.calls.includes('activate'), false, 'XCTest would have launched it again')
  assert.deepEqual(session.appStatus, { generation: 1, expectedRunning: false, endedUnexpectedly: true, unexpectedEnds: [1] })
})

test('a lost executor connection loses the session: nothing more is sent', async () => {
  const driver = new MemoryDriver()
  driver.behaviour['state'] = 'refused-connection'
  const session = open(driver)
  const state = await session.appState(5000)
  assert.equal(!state.ok && state.failure.class, 'session_lost')
  const count = driver.calls.length
  const launched = await session.launch(5000)
  assert.equal(!launched.result.ok && launched.result.failure.class, 'session_lost')
  assert.equal(driver.calls.length, count)
})

test('a session the executor no longer knows is lost', async () => {
  const driver = new MemoryDriver()
  driver.behaviour['state'] = 'invalid-session'
  const session = open(driver)
  const state = await session.appState(5000)
  assert.equal(!state.ok && state.failure.class, 'session_lost')
  assert.equal(!(await session.capture(5000)).ok, true)
})

test('requests run one at a time in the order they came', async () => {
  const driver = new MemoryDriver()
  const session = open(driver)
  await session.launch(5000)
  await Promise.all([session.appState(5000), session.capture(5000), session.readSource(5000), session.activate(5000), session.appState(5000)])
  assert.equal(driver.mostInFlight, 1)
})

test('dispose terminates what the session launched, ends the executor session and lets the next session open', async () => {
  const driver = new MemoryDriver()
  const session = open(driver)
  await session.launch(5000)
  await session.dispose(5000)
  assert.equal(driver.running, false)
  assert.deepEqual(driver.calls.slice(-3), ['terminate', 'processState', 'endExecutorSession'])
  assert.equal(driver.releases, 1)
  const after = await session.appState(5000)
  assert.equal(!after.ok && after.failure.class, 'session_lost')
  await session.dispose(5000)
  assert.equal(driver.releases, 1, 'a second dispose waits for the first')
})

test('dispose ends only the processes of its own launch by the operating system when the executor cannot', async () => {
  const driver = new MemoryDriver()
  const session = open(driver)
  await session.launch(5000)
  driver.behaviour['terminate'] = 'refused-connection'
  driver.forceEndLeft = ['pid 4242 of dev.retest.fixtures.taskdesk is still running.']
  await assert.rejects(session.dispose(5000), (error: unknown) => error instanceof NativeError && error.failure.class === 'cleanup_failed' && /4242/.test(error.message))
  assert.deepEqual(driver.forceEnded, [[4242]])
})

test('a timeout outside 1 ms to the longest budget is a usage failure and sends nothing', async () => {
  const driver = new MemoryDriver()
  const launched = await open(driver).launch(0)
  assert.equal(!launched.result.ok && launched.result.failure.class, 'usage')
  assert.deepEqual(driver.calls, [])
})

test('a capture source the platform does not offer is unsupported', async () => {
  const capture = await open(new MemoryDriver()).capture(5000, { source: 'simulator-display' })
  assert.equal(!capture.ok && capture.failure.class, 'unsupported')
})

test('a serial lane lets one holder through at a time, and a wait stops with its signal or its time', async () => {
  const lane = new SerialLane()
  const first = await lane.acquire(undefined, 1000)
  assert.ok(first.ok)
  const timedOut = await lane.acquire(undefined, 30)
  assert.deepEqual(timedOut, { ok: false, reason: 'timed_out' })
  const stop = new AbortController()
  const stopped = lane.acquire(stop.signal, 1000)
  stop.abort()
  assert.deepEqual(await stopped, { ok: false, reason: 'stopped' })
  const waiting = lane.acquire(undefined, 1000)
  if (first.ok) first.release()
  const second = await waiting
  assert.ok(second.ok)
})

test('a launch that never went starts no new generation and leaves nothing to clean up', async () => {
  const driver = new MemoryDriver()
  driver.behaviour['launch'] = 'refused-connection'
  const session = open(driver)
  const launched = await session.launch(5000)
  assert.equal(launched.input, 'not_sent')
  assert.deepEqual(session.appStatus, { generation: 0, expectedRunning: false, endedUnexpectedly: false, unexpectedEnds: [] })
  assert.deepEqual(session.unknownOutcomes, [])
})

test('a launch whose state read never answered sends nothing, records no launch, and dispose ends nothing', async () => {
  const driver = new MemoryDriver()
  driver.behaviour['state'] = 'hang'
  const session = open(driver)
  const dispatched = new Promise<void>((resolve) => {
    driver.dispatched = resolve
  })
  const launching = session.launch(10_000)
  await dispatched
  session.cancel(interrupted)
  const launched = await launching
  assert.equal(launched.input, 'not_sent')
  assert.deepEqual(session.unknownOutcomes, [])
  assert.equal(session.appStatus.generation, 0)
  await session.dispose(5000)
  assert.deepEqual(driver.calls, ['state', 'endExecutorSession'], 'no launch, no terminate and no process was ended')
  assert.deepEqual(driver.forceEnded, [])
})

test('an activate whose state read never answered sends nothing', async () => {
  const driver = new MemoryDriver()
  driver.running = true
  driver.behaviour['state'] = 'hang'
  const activated = await open(driver).activate(200)
  assert.equal(activated.input, 'not_sent')
  assert.equal(!activated.result.ok && activated.result.failure.class, 'timeout')
  assert.equal(driver.calls.includes('activate'), false)
})

test('a crash nobody saw before a relaunch is kept after the relaunch', async () => {
  const driver = new MemoryDriver()
  const session = open(driver)
  await session.launch(5000)
  driver.running = false
  assert.deepEqual(await session.launch(5000), { result: { ok: true }, input: 'sent' })
  assert.deepEqual(session.appStatus, { generation: 2, expectedRunning: true, endedUnexpectedly: true, unexpectedEnds: [1] })
})

test('a copy the session did not launch is never terminated or ended, on any path', async () => {
  const driver = new MemoryDriver()
  const session = open(driver)
  await session.launch(5000)
  driver.foreignPids = [777]
  const terminated = await session.terminate(5000)
  assert.equal(terminated.input, 'not_sent')
  assert.match(!terminated.result.ok ? terminated.result.failure.message : '', /did not launch runs \(pid 777\)/)
  assert.equal(driver.calls.includes('terminate'), false, 'the executor terminates by bundle id or path, so it was not asked')
  await session.dispose(5000)
  assert.equal(driver.calls.includes('terminate'), false)
  assert.deepEqual(driver.forceEnded, [[4242]], 'only the session\'s own process was ended')
})

test('a copy that comes up after the launch\'s window is never the session\'s: terminate refuses it, dispose names it and ends nothing', async () => {
  const driver = new MemoryDriver()
  driver.behaviour['launch'] = 'hang'
  const session = open(driver)
  const launched = await session.launch(200)
  assert.equal(launched.input, 'unknown')
  // A copy comes up only after the launch's window closed: perhaps this launch's, perhaps one someone else started.
  driver.running = true
  driver.behaviour['terminate'] = 'refused-connection'
  const terminated = await session.terminate(5000)
  assert.equal(terminated.input, 'not_sent')
  assert.match(!terminated.result.ok ? terminated.result.failure.message : '', /did not launch runs \(pid 4242\)/)
  await assert.rejects(session.dispose(5000), (error: unknown) => error instanceof NativeError && error.failure.class === 'cleanup_failed' && /runs \(pid 4242\) after a launch of this session whose process the session never saw; it was not ended/.test(error.message))
  assert.deepEqual(driver.forceEnded, [], 'a copy seen after the window was not ended')
  assert.equal(driver.calls.includes('terminate'), false, 'nor terminated through the executor')
  assert.equal(driver.running, true)
})

test('the window that claims a launch\'s process never runs past the launch\'s own time', async () => {
  const driver = new MemoryDriver()
  // The executor answers the launch, and no process of the app ever shows.
  driver.launchStartsApp = false
  const session = open(driver)
  const started = performance.now()
  const launched = await session.launch(400)
  const took = performance.now() - started
  assert.equal(!launched.result.ok && launched.result.failure.class, 'session_lost')
  assert.ok(took < 1500, `the launch took ${Math.round(took)} ms, past its 400 ms`)
})

test('a launch whose process reading fails within its window fails, and the session owns nothing of it', async () => {
  const driver = new MemoryDriver()
  const session = open(driver)
  driver.failingReadings = 1000
  const launched = await session.launch(800)
  assert.equal(launched.input, 'sent')
  assert.equal(!launched.result.ok && launched.result.failure.class, 'outcome_unknown')
  assert.match(!launched.result.ok ? launched.result.failure.message : '', /could not read the app's processes \(ps could not run\), so the session owns none of them/)
  assert.deepEqual(session.processIds, [])
  driver.failingReadings = 0
  driver.behaviour['terminate'] = 'refused-connection'
  // The copy that runs now is not one the session saw within the window, so it is named and left.
  await assert.rejects(session.dispose(5000), (error: unknown) => error instanceof NativeError && /never saw; it was not ended/.test(error.message))
  assert.deepEqual(driver.forceEnded, [])
})

test('a process the session recorded is ended only while its pid still runs the recorded command line', async () => {
  const driver = new MemoryDriver()
  const session = open(driver)
  await session.launch(5000)
  // The app ended and its pid went to another process.
  driver.command = '/usr/libexec/something-else'
  driver.behaviour['terminate'] = 'refused-connection'
  const terminated = await session.terminate(5000)
  assert.equal(terminated.input, 'not_sent', 'the process under the pid is not the session\'s, so nothing was terminated')
  await session.dispose(5000)
  assert.deepEqual(driver.forceEnded, [], 'the process now under the pid was not ended')
})

test('dispose ends the session\'s process under the command line it recorded at the launch', async () => {
  const driver = new MemoryDriver()
  const session = open(driver)
  await session.launch(5000)
  driver.behaviour['terminate'] = 'refused-connection'
  await session.dispose(5000)
  assert.deepEqual(driver.forceEndedProcesses, [[{ pid: 4242, command: '/Apps/TaskDesk.app/Contents/MacOS/TaskDesk -reset' }]])
})

test('a session whose launch never showed a process ends nothing at dispose, and says nothing is left', async () => {
  const driver = new MemoryDriver()
  driver.behaviour['launch'] = 'hang'
  const session = open(driver)
  await session.launch(200)
  await session.dispose(5000)
  assert.deepEqual(driver.forceEnded, [])
  assert.equal(driver.calls.includes('terminate'), false)
})

test('an app the session cannot read after a launch that may have gone makes dispose fail by name, never pass', async () => {
  const driver = new MemoryDriver()
  driver.behaviour['launch'] = 'hang'
  const session = open(driver)
  await session.launch(200)
  driver.processReadFails = true
  await assert.rejects(session.dispose(5000), (error: unknown) => error instanceof NativeError && error.failure.class === 'cleanup_failed' && /could not be read/.test(error.message))
})

test('a stop during the readings before a launch or a terminate takes its class from the stop', async () => {
  const driver = new MemoryDriver()
  driver.readingsHang = true
  const session = open(driver)
  const launchStop = new AbortController()
  const launching = session.launch(5000, launchStop.signal)
  await untilCalled(driver, 'launchBlocker', 1)
  launchStop.abort(interrupted)
  const launched = await launching
  assert.equal(launched.input, 'not_sent')
  assert.equal(!launched.result.ok && launched.result.failure.class, 'interrupted')
  driver.readingsHang = false
  await session.launch(5000)
  driver.readingsHang = true
  const terminateStop = new AbortController()
  const before = driver.calls.filter((made) => made === 'processState').length
  const terminating = session.terminate(5000, terminateStop.signal)
  await untilCalled(driver, 'processState', before + 1)
  terminateStop.abort(interrupted)
  const terminated = await terminating
  assert.equal(!terminated.result.ok && terminated.result.failure.class, 'interrupted')
  driver.readingsHang = false
})

test('an unknown launch attributes to itself only the processes shown right after it, and dispose ends those', async () => {
  const driver = new MemoryDriver()
  driver.behaviour['launch'] = 'hang'
  const session = open(driver)
  const dispatched = new Promise<void>((resolve) => {
    driver.dispatched = resolve
  })
  const launching = session.launch(10_000)
  await dispatched
  driver.running = true
  session.cancel(interrupted)
  const launched = await launching
  assert.equal(launched.input, 'unknown')
  assert.deepEqual(session.unknownOutcomes[0]?.processesAfter, { ok: true, running: true, pids: [4242] })
  driver.behaviour['terminate'] = 'refused-connection'
  await session.dispose(5000)
  assert.deepEqual(driver.forceEnded, [[4242]])
})

test('a failed process reading refuses the terminate by name', async () => {
  const driver = new MemoryDriver()
  const session = open(driver)
  await session.launch(5000)
  driver.processReadFails = true
  const terminated = await session.terminate(5000)
  assert.equal(terminated.input, 'not_sent')
  assert.match(!terminated.result.ok ? terminated.result.failure.message : '', /could not read which copies/)
})

test('a session reopened for the same attempt and app refuses the references of the one before', async () => {
  const first = open(new MemoryDriver())
  await first.launch(5000)
  const capture = await first.capture(5000)
  if (!capture.ok) throw new Error(capture.failure.message)
  await first.dispose(5000)
  const second = open(new MemoryDriver())
  await second.launch(5000)
  assert.equal(second.sessionId, first.sessionId)
  const refused = second.checkReference(capture.capture.reference)
  assert.equal(refused?.class, 'usage')
  assert.match(refused?.message ?? '', /earlier session/)
})


test('disposal never resends an unanswered terminate and ends only its retained launch record', async () => {
  const driver = new MemoryDriver()
  const session = open(driver)
  await session.launch(5000)
  driver.behaviour['terminate'] = 'hang'
  const terminated = await session.terminate(50)
  assert.equal(terminated.input, 'unknown')
  assert.equal(session.unknownOutcomes[0]?.kind, 'terminate')
  await session.dispose(5000)
  assert.equal(driver.calls.filter((call) => call === 'terminate').length, 1)
  assert.deepEqual(driver.forceEndedProcesses, [[{ pid: driver.pid, command: driver.command }]])
  assert.equal(driver.running, false)
  assert.equal(session.unknownOutcomes[0]?.kind, 'terminate', 'the unanswered request stays unknown after cleanup')
})
