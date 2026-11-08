import type { Failure } from '../../protocol/failures.ts'
import type { RequestBounds } from '../webdriver-client.ts'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { errorMessage } from '../../protocol/failures.ts'

// agent-device, by Callstack, under the MIT licence: an optional peer of Retest, loaded here, from where Retest is
// installed, only when a run starts a target that drives its app through it. Retest calls a few methods of its typed
// Node client and reads every answer as data it checks itself; it copies none of agent-device's code. Written against
// agent-device 0.21.36, the only release a run accepts.
//
// The client runs its daemon inside this process, through `startAgentDevice`, so a run's end closes it and no daemon of
// agent-device's outlives Retest. Every call is bounded: it carries an `AbortSignal`, and Retest stops waiting at its
// deadline whatever agent-device does. agent-device says, on a failure, whether the request reached the device:
// `dispatched: 'no'` proves it did not. Anything else, a failure without that proof, a timeout, a stop while the
// request was out, or an error that is not agent-device's own, may have reached the device.

/** The agent-device release Retest was checked with, and the only one a run accepts. */
export const agentDeviceVersion = '0.21.36'

/** The methods of agent-device's client Retest calls, by their path on the client. */
export type AgentDeviceMethod =
  | 'apps.install'
  | 'apps.reinstall'
  | 'apps.open'
  | 'apps.close'
  | 'capture.snapshot'
  | 'capture.screenshot'
  | 'interactions.press'
  | 'interactions.fill'
  | 'interactions.scroll'
  | 'interactions.type'
  | 'command.keyboard'
  | 'command.appState'
  | 'devices.list'
  | 'devices.boot'
  | 'devices.shutdown'
  | 'sessions.close'

/**
 * What one call answered, as Retest reads it. `answered` holds agent-device's value, unchecked. `refused` is a failure
 * agent-device proved never reached the device. `failed` is a failure without that proof, `lost` an error that is not
 * agent-device's own, such as its runtime having gone, `timeout` a call Retest stopped waiting for at its deadline, and
 * `stopped` a call the caller stopped: each of these may have reached the device, except a `stopped` call that had not
 * gone, which says `dispatched: 'no'`.
 */
export type AgentDeviceAnswer =
  | { readonly status: 'answered'; readonly value: unknown; readonly durationMs: number }
  | { readonly status: 'refused'; readonly code: string; readonly reason?: string; readonly message: string; readonly durationMs: number }
  | { readonly status: 'failed'; readonly code: string; readonly reason?: string; readonly message: string; readonly durationMs: number }
  | { readonly status: 'lost'; readonly message: string; readonly durationMs: number }
  | { readonly status: 'timeout'; readonly message: string; readonly durationMs: number }
  | { readonly status: 'stopped'; readonly dispatched: 'no' | 'unknown'; readonly durationMs: number }

/** agent-device's client as Retest calls it: one method by its path, with its options, within its bounds. */
export type AgentDevicePort = {
  call(method: AgentDeviceMethod, options: Readonly<Record<string, unknown>>, bounds: RequestBounds): Promise<AgentDeviceAnswer>
}

/** What closing the in-process daemon left behind, in words; empty when it reported nothing left. */
export type AgentDeviceShutdown = { readonly ok: true; readonly leftovers: readonly string[] } | { readonly ok: false; readonly problem: string }

/** A daemon of agent-device's running inside this process, and its client. */
export type AgentDeviceHost = {
  readonly port: AgentDevicePort
  /** Closes the daemon within `timeoutMs`, and says what it reported left behind. Never rejects. */
  close(timeoutMs: number): Promise<AgentDeviceShutdown>
}

/** Starts a daemon in a state folder of its own, with the environment and working folder its tools run with. */
export type AgentDeviceStarter = (options: { readonly stateDir: string; readonly env: Readonly<Record<string, string>>; readonly cwd: string }) => Promise<AgentDeviceHost>

/** Loads the installed agent-device: its module and the version its package states. */
export type AgentDeviceLoader = () => Promise<{ readonly module: unknown; readonly version: string | undefined }>

/**
 * Loads agent-device from where Retest is installed and checks it is the release Retest was checked with. A package
 * that is missing, of another version, or without the client Retest calls fails setup by name, with what to install.
 *
 * @example const loaded = await loadAgentDevice(); if (loaded.ok) await loaded.start({ stateDir, env, cwd })
 */
export async function loadAgentDevice(load: AgentDeviceLoader = loadInstalled): Promise<{ readonly ok: true; readonly start: AgentDeviceStarter; readonly version: string } | { readonly ok: false; readonly failure: Failure }> {
  const install = `Install it beside Retest with npm install --save-dev agent-device@${agentDeviceVersion}.`
  let loaded: Awaited<ReturnType<AgentDeviceLoader>>
  try {
    loaded = await load()
  } catch (error) {
    const missing = error instanceof Error && 'code' in error && (error.code === 'ERR_MODULE_NOT_FOUND' || error.code === 'MODULE_NOT_FOUND')
    return refused(missing ? `This target drives its app through agent-device, which is not installed. ${install}` : `Retest could not load agent-device: ${errorMessage(error)}. ${install}`)
  }
  if (loaded.version !== agentDeviceVersion) return refused(`This target drives its app through agent-device ${agentDeviceVersion}, and the installed agent-device is ${loaded.version === undefined ? 'of a version Retest cannot read' : loaded.version}. Retest runs only the release it was checked with. ${install}`)
  const startAgentDevice = typeof loaded.module === 'object' && loaded.module !== null ? Reflect.get(loaded.module, 'startAgentDevice') : undefined
  if (typeof startAgentDevice !== 'function') return refused(`The installed agent-device has no startAgentDevice. ${install}`)
  const start: AgentDeviceStarter = async (options) => {
    const host: unknown = await Reflect.apply(startAgentDevice, loaded.module, [{ stateDir: options.stateDir, host: { env: options.env, cwd: options.cwd } }])
    return hostOf(host)
  }
  return { ok: true, start, version: loaded.version }
}

// The package as Node resolves it from this module, and the version beside its entry, read from its package.json:
// agent-device exports no package.json of its own, so the file is found from the entry upwards.
async function loadInstalled(): Promise<{ readonly module: unknown; readonly version: string | undefined }> {
  const specifier = 'agent-device'
  const module: unknown = await import(specifier)
  const entry = fileURLToPath(import.meta.resolve(specifier))
  return { module, version: await packageVersion(entry) }
}

async function packageVersion(entry: string): Promise<string | undefined> {
  for (let folder = dirname(entry); ; folder = dirname(folder)) {
    const text = await readFile(join(folder, 'package.json'), 'utf8').catch(() => undefined)
    if (text !== undefined) {
      const manifest: unknown = JSON.parse(text)
      if (typeof manifest === 'object' && manifest !== null && Reflect.get(manifest, 'name') === 'agent-device') {
        const version: unknown = Reflect.get(manifest, 'version')
        return typeof version === 'string' ? version : undefined
      }
    }
    if (dirname(folder) === folder) return undefined
  }
}

// The host startAgentDevice gave, checked for the client methods Retest calls before any is called.
function hostOf(host: unknown): AgentDeviceHost {
  const client = typeof host === 'object' && host !== null ? Reflect.get(host, 'client') : undefined
  const close = typeof host === 'object' && host !== null ? Reflect.get(host, 'close') : undefined
  if (typeof client !== 'object' || client === null || typeof close !== 'function') throw new Error('agent-device started a daemon with no client or close.')
  return {
    port: { call: (method, options, bounds) => callClient(client, method, options, bounds) },
    close: async (timeoutMs) => {
      const settled = await within(Promise.resolve().then((): unknown => Reflect.apply(close, host, [])), timeoutMs)
      if (settled.status === 'done') return { ok: true, leftovers: shutdownLeftovers(settled.value) }
      if (settled.status === 'failed') return { ok: false, problem: `Closing agent-device's daemon failed: ${errorMessage(settled.error)}` }
      return { ok: false, problem: `agent-device's daemon did not close within ${timeoutMs} ms.` }
    },
  }
}

/**
 * What a daemon's shutdown report says it left: requests that ignored their cancel, runners left running, sessions that
 * failed to close, platform owners and plugins still shutting down. Each in words; nothing when it left nothing.
 *
 * @example shutdownLeftovers({ runners: { stopped: [], handedOff: ['B7AF…'] } }) // ['agent-device left the runner of B7AF… running for its next daemon.']
 */
export function shutdownLeftovers(report: unknown): string[] {
  if (typeof report !== 'object' || report === null) return ['agent-device closed its daemon without a report of what it stopped.']
  const leftovers: string[] = []
  const field = (owner: unknown, key: string): unknown => (typeof owner === 'object' && owner !== null ? Reflect.get(owner, key) : undefined)
  const list = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [])
  for (const device of list(field(field(report, 'runners'), 'handedOff'))) leftovers.push(`agent-device left the runner of ${device} running for its next daemon.`)
  const abandoned = field(field(report, 'requests'), 'abandoned')
  if (typeof abandoned === 'number' && abandoned > 0) leftovers.push(`agent-device closed with ${abandoned} request(s) that ignored their cancel and may still run.`)
  const failed = field(field(report, 'sessions'), 'failed')
  if (typeof failed === 'number' && failed > 0) leftovers.push(`agent-device could not close ${failed} of its session(s).`)
  const owners = field(report, 'platformOwners')
  if (owners !== undefined && owners !== 'closed') leftovers.push(`agent-device's platform owners were ${String(owners)} when it closed.`)
  for (const plugin of list(field(field(report, 'plugins'), 'pending'))) leftovers.push(`agent-device's plugin ${plugin} was still shutting down.`)
  const pending = list(field(field(report, 'providerReleases'), 'pending'))
  const unknown = list(field(field(report, 'providerReleases'), 'unknown'))
  if (pending.length + unknown.length > 0) leftovers.push(`agent-device had ${pending.length + unknown.length} device lease release(s) unsettled.`)
  return leftovers
}

// One call through the client, bounded. The signal goes with the call, so agent-device cancels it, and the deadline
// stands whatever it does: a call that has not answered by then is a timeout, its effect unknown.
async function callClient(client: object, method: AgentDeviceMethod, options: Readonly<Record<string, unknown>>, bounds: RequestBounds): Promise<AgentDeviceAnswer> {
  const startedAt = performance.now()
  const durationMs = (): number => Math.round(performance.now() - startedAt)
  if (bounds.signal?.aborted === true) return { status: 'stopped', dispatched: 'no', durationMs: 0 }
  const [group, name] = method.split('.')
  const owner = group === undefined ? undefined : Reflect.get(client, group)
  const call = typeof owner === 'object' && owner !== null && name !== undefined ? Reflect.get(owner, name) : undefined
  if (typeof call !== 'function') return { status: 'refused', code: 'UNSUPPORTED_OPERATION', message: `The installed agent-device has no ${method}.`, durationMs: 0 }
  const timer = new AbortController()
  const signal = bounds.signal === undefined ? timer.signal : AbortSignal.any([bounds.signal, timer.signal])
  const settled = await within(Promise.resolve().then((): unknown => Reflect.apply(call, owner, [{ ...options, signal }])), bounds.timeoutMs, bounds.signal)
  timer.abort()
  if (settled.status === 'done') return { status: 'answered', value: settled.value, durationMs: durationMs() }
  if (settled.status === 'timeout') return { status: 'timeout', message: `agent-device did not answer ${method} within ${bounds.timeoutMs} ms.`, durationMs: durationMs() }
  if (settled.status === 'stopped') return { status: 'stopped', dispatched: 'unknown', durationMs: durationMs() }
  return readError(settled.error, method, bounds.signal, durationMs())
}

// agent-device's own errors carry a code, a message and details; `details.dispatched` is 'no' only when the request
// provably never reached the device. A cancel the caller made is a stop; any other error is not agent-device's own.
function readError(error: unknown, method: AgentDeviceMethod, signal: AbortSignal | undefined, durationMs: number): AgentDeviceAnswer {
  const code: unknown = error instanceof Error ? Reflect.get(error, 'code') : undefined
  const details: unknown = error instanceof Error ? Reflect.get(error, 'details') : undefined
  const read = (key: string): unknown => (typeof details === 'object' && details !== null ? Reflect.get(details, key) : undefined)
  const dispatched = read('dispatched')
  const reasonValue = read('reason')
  if (signal?.aborted === true) return { status: 'stopped', dispatched: dispatched === 'no' ? 'no' : 'unknown', durationMs }
  if (!(error instanceof Error) || typeof code !== 'string') return { status: 'lost', message: `agent-device's ${method} failed outside agent-device: ${errorMessage(error)}`, durationMs }
  const reason = typeof reasonValue === 'string' ? { reason: reasonValue } : {}
  return { status: dispatched === 'no' ? 'refused' : 'failed', code, ...reason, message: error.message, durationMs }
}

type Within<T> = { readonly status: 'done'; readonly value: T } | { readonly status: 'failed'; readonly error: unknown } | { readonly status: 'timeout' } | { readonly status: 'stopped' }

// Waits for work until `timeoutMs` passes or `signal` aborts. The work keeps running; its later result is dropped.
function within<T>(work: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<Within<T>> {
  const { promise, resolve } = Promise.withResolvers<Within<T>>()
  const timer = setTimeout(() => resolve({ status: 'timeout' }), Math.max(1, Math.floor(timeoutMs)))
  const onAbort = (): void => resolve({ status: 'stopped' })
  signal?.addEventListener('abort', onAbort, { once: true })
  work.then((value) => resolve({ status: 'done', value }), (error: unknown) => resolve({ status: 'failed', error }))
  return promise.finally(() => {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  })
}

function refused(message: string): { readonly ok: false; readonly failure: Failure } {
  return { ok: false, failure: { class: 'setup_failed', message } }
}
