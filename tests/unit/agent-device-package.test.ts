import assert from 'node:assert/strict'
import { test } from 'node:test'
import { agentDeviceVersion, loadAgentDevice, shutdownLeftovers } from '../../src/native/agent-device/package.ts'

// Loading agent-device, the optional peer, and reading what its client answers. The loader is a stand-in, so these run
// whether agent-device is installed or not; a stand-in error carries the code and details agent-device's own errors carry.

class AgentDeviceError extends Error {
  readonly code: string
  readonly details: Record<string, unknown> | undefined
  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message)
    this.code = code
    this.details = details
  }
}

type Received = { readonly method: string; readonly options: Record<string, unknown> }

// A module like agent-device's: `startAgentDevice` gives a host whose client answers each call as `answer` says.
function standIn(answer: (method: string, options: Record<string, unknown>) => Promise<unknown>, received: Received[] = [], report: unknown = { runners: { stopped: [], handedOff: [] }, requests: { drained: 0, abandoned: 0 }, sessions: { closed: 1, failed: 0 }, platformOwners: 'closed', plugins: { disposed: [], failed: [], pending: [] }, providerReleases: { completed: [], pending: [], unknown: [] } }): { readonly module: unknown; readonly started: Record<string, unknown>[] } {
  const started: Record<string, unknown>[] = []
  const group = (name: string, methods: readonly string[]): Record<string, (options: Record<string, unknown>) => Promise<unknown>> =>
    Object.fromEntries(methods.map((method) => [method, (options: Record<string, unknown>) => {
      received.push({ method: `${name}.${method}`, options })
      return answer(`${name}.${method}`, options)
    }]))
  const client = { capture: group('capture', ['snapshot', 'screenshot']), interactions: group('interactions', ['press', 'fill']), apps: group('apps', ['open', 'close']) }
  return {
    started,
    module: {
      startAgentDevice: (options: Record<string, unknown>) => {
        started.push(options)
        return Promise.resolve({ client, clientConfig: {}, close: () => Promise.resolve(report) })
      },
    },
  }
}

test('a missing agent-device fails setup naming the release to install; another version is refused by name', async () => {
  const missing = Object.assign(new Error("Cannot find package 'agent-device'"), { code: 'ERR_MODULE_NOT_FOUND' })
  const absent = await loadAgentDevice(() => Promise.reject(missing))
  assert.ok(!absent.ok)
  assert.equal(absent.failure.class, 'setup_failed')
  assert.match(absent.failure.message, new RegExp(`not installed\\. Install it beside Retest with npm install --save-dev agent-device@${agentDeviceVersion.replaceAll('.', '\\.')}`))
  const other = await loadAgentDevice(() => Promise.resolve({ module: standIn(() => Promise.resolve({})).module, version: '0.22.0' }))
  assert.ok(!other.ok)
  assert.match(other.failure.message, /the installed agent-device is 0\.22\.0\. Retest runs only the release it was checked with/)
  const unread = await loadAgentDevice(() => Promise.resolve({ module: {}, version: undefined }))
  assert.ok(!unread.ok && /of a version Retest cannot read/.test(unread.failure.message))
  const empty = await loadAgentDevice(() => Promise.resolve({ module: {}, version: agentDeviceVersion }))
  assert.ok(!empty.ok && /no startAgentDevice/.test(empty.failure.message))
})

test('the installed agent-device is the checked release', async () => {
  const loaded = await loadAgentDevice()
  assert.ok(loaded.ok, loaded.ok ? '' : loaded.failure.message)
  assert.equal(loaded.version, agentDeviceVersion)
})

test("a started host runs in its own state folder with the given environment, and each call goes to the client's method with its options and a signal", async () => {
  const received: Received[] = []
  const fake = standIn((method) => Promise.resolve(method === 'capture.snapshot' ? { nodes: [] } : {}), received)
  const loaded = await loadAgentDevice(() => Promise.resolve({ module: fake.module, version: agentDeviceVersion }))
  assert.ok(loaded.ok)
  const host = await loaded.start({ stateDir: '/tmp/state', env: { PATH: '/usr/bin' }, cwd: '/tmp/state' })
  assert.deepEqual(fake.started, [{ stateDir: '/tmp/state', host: { env: { PATH: '/usr/bin' }, cwd: '/tmp/state' } }])
  const answer = await host.port.call('capture.snapshot', { session: 's', udid: 'U' }, { timeoutMs: 1000 })
  assert.equal(answer.status, 'answered')
  assert.equal(received[0]?.method, 'capture.snapshot')
  assert.equal(received[0]?.options['session'], 's')
  assert.ok(received[0]?.options['signal'] instanceof AbortSignal)
  const missing = await host.port.call('devices.list', {}, { timeoutMs: 1000 })
  assert.ok(missing.status === 'refused' && missing.code === 'UNSUPPORTED_OPERATION')
  assert.deepEqual(await host.close(1000), { ok: true, leftovers: [] })
})

test("only agent-device's own proof that a request never reached the device reads as refused; anything else may have reached it", async () => {
  const errors: Record<string, unknown> = {
    'interactions.press': new AgentDeviceError('COMMAND_FAILED', 'stale ref', { reason: 'ref_generation_mismatch', dispatched: 'no' }),
    'interactions.fill': new AgentDeviceError('COMMAND_FAILED', 'runner gone', { reason: 'runner_lost', dispatched: 'unknown' }),
    'apps.open': new AgentDeviceError('COMMAND_FAILED', 'no word on dispatch'),
    'apps.close': 'a string, not an error of agent-device',
  }
  const fake = standIn((method) => Promise.reject(errors[method]))
  const loaded = await loadAgentDevice(() => Promise.resolve({ module: fake.module, version: agentDeviceVersion }))
  assert.ok(loaded.ok)
  const host = await loaded.start({ stateDir: '/tmp/state', env: {}, cwd: '/tmp' })
  const bounds = { timeoutMs: 1000 }
  assert.deepEqual(await host.port.call('interactions.press', {}, bounds), { status: 'refused', code: 'COMMAND_FAILED', reason: 'ref_generation_mismatch', message: 'stale ref', durationMs: 0 })
  const fill = await host.port.call('interactions.fill', {}, bounds)
  assert.ok(fill.status === 'failed' && fill.reason === 'runner_lost')
  const open = await host.port.call('apps.open', {}, bounds)
  assert.ok(open.status === 'failed' && open.reason === undefined, 'a failure no producer classified may have reached the device')
  const close = await host.port.call('apps.close', {}, bounds)
  assert.equal(close.status, 'lost')
})

test('a call that does not answer in time is a timeout and is cancelled; one stopped before it went never went', async () => {
  let seen: AbortSignal | undefined
  const fake = standIn((_method, options) => {
    const signal = options['signal']
    if (signal instanceof AbortSignal) seen = signal
    return new Promise(() => undefined)
  })
  const loaded = await loadAgentDevice(() => Promise.resolve({ module: fake.module, version: agentDeviceVersion }))
  assert.ok(loaded.ok)
  const host = await loaded.start({ stateDir: '/tmp/state', env: {}, cwd: '/tmp' })
  const late = await host.port.call('interactions.press', {}, { timeoutMs: 30 })
  assert.equal(late.status, 'timeout')
  assert.equal(seen?.aborted, true, 'agent-device is told to cancel the request')
  const stop = new AbortController()
  stop.abort()
  assert.deepEqual(await host.port.call('interactions.press', {}, { timeoutMs: 1000, signal: stop.signal }), { status: 'stopped', dispatched: 'no', durationMs: 0 })
  const inFlight = new AbortController()
  const pending = host.port.call('interactions.press', {}, { timeoutMs: 1000, signal: inFlight.signal })
  inFlight.abort()
  const stopped = await pending
  assert.ok(stopped.status === 'stopped' && stopped.dispatched === 'unknown')
})

test("a daemon's shutdown report is read into what it left behind, in words", () => {
  assert.deepEqual(shutdownLeftovers({ runners: { stopped: ['A'], handedOff: [] }, requests: { drained: 1, abandoned: 0 }, sessions: { closed: 1, failed: 0 }, platformOwners: 'closed', plugins: { pending: [] }, providerReleases: { pending: [], unknown: [] } }), [])
  const left = shutdownLeftovers({ runners: { stopped: [], handedOff: ['SIM-1'] }, requests: { abandoned: 2 }, sessions: { failed: 1 }, platformOwners: 'pending', plugins: { pending: ['browserstack'] }, providerReleases: { pending: ['l1'], unknown: [] } })
  assert.equal(left.length, 6)
  assert.match(left[0] ?? '', /left the runner of SIM-1 running/)
  assert.deepEqual(shutdownLeftovers(undefined), ['agent-device closed its daemon without a report of what it stopped.'])
})
