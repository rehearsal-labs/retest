import type { Readable } from 'node:stream'
import { ChildProcess, spawn } from 'node:child_process'
import { Socket } from 'node:net'
import { performance } from 'node:perf_hooks'

export const PIPE_QUERY_WAIT_MS = 700
export const PIPE_QUERY_TIMEOUT_MS = 200
export const PIPE_QUERY_MAXIMUM_BYTES: number = 1024 * 1024
const maximumHolders = 32

export type PipeTarget = { childPid: number; fd: number | null }
export type PipeDescriptor = {
  pid: number; parentPid: number | null; groupPid: number | null; command: string | null
  fd: number; access: string | null; type: 'PIPE' | 'unix'; device: string; peer: string | null
}
export type PipeSnapshot = {
  targets: { childPid: number; fd: number | null; endpoint: PipeDescriptor | null; holders: PipeDescriptor[]; omittedHolders: number }[]
}
export type PipeQueryRecord = PipeSnapshot & {
  event: 'pipe.holders'; status: 'complete' | 'failed' | 'timeout' | 'bytes-limit' | 'cancelled' | 'host.exit'
  queryMs: number; bytes: number; exitCode: number | null; queryPid: number | null
}

// Node's public Readable API has no descriptor accessor. This CI-only inspection does not change the handle.
export function pipeDescriptor(stream: Readable | null): number | null {
  try {
    if (stream === null || !('_handle' in stream)) return null
    const handle = stream._handle
    if (typeof handle !== 'object' || handle === null || !('fd' in handle)) return null
    const fd = handle.fd
    return typeof fd === 'number' && Number.isSafeInteger(fd) && fd >= 0 ? fd : null
  } catch {
    return null
  }
}

function decimal(value: string): number | null {
  if (!/^\d+$/.test(value)) return null
  const number = Number(value)
  return Number.isSafeInteger(number) ? number : null
}

function address(value: string): string | null {
  if (!/^0x[\da-f]+$/i.test(value)) return null
  const digits = value.slice(2).replace(/^0+/, '').toLowerCase()
  return digits.length === 0 ? null : `0x${digits}`
}

export function pipeHoldersFromLsof(text: string, hostPid: number, targets: readonly PipeTarget[]): PipeSnapshot {
  const descriptors: PipeDescriptor[] = []
  let pid: number | null = null
  let parentPid: number | null = null
  let groupPid: number | null = null
  let command: string | null = null
  let fd: number | null = null
  let access: string | null = null
  let type: string | null = null
  let device: string | null = null
  let peer: string | null = null
  const save = (): void => {
    if (pid !== null && fd !== null && (type === 'PIPE' || type === 'unix') && device !== null) descriptors.push({ pid, parentPid, groupPid, command, fd, access, type, device, peer })
    fd = null; access = null; type = null; device = null; peer = null
  }
  for (const raw of text.split('\0')) {
    const field = raw.replace(/^\n/, '')
    const value = field.slice(1)
    switch (field[0]) {
      case 'p': save(); pid = decimal(value); parentPid = null; groupPid = null; command = null; break
      case 'R': parentPid = decimal(value); break
      case 'g': groupPid = decimal(value); break
      // lsof's command field is a process name, not argv. Refuse paths and other free-form text.
      case 'c': command = /^[A-Za-z0-9 ._()+-]{1,80}$/.test(value) ? value : null; break
      case 'f': save(); fd = decimal(value); break
      case 'a': access = ['r', 'w', 'u'].includes(value) ? value : null; break
      case 't': type = value; break
      case 'd': device = address(value); break
      // Darwin socket/pipe peers are kernel addresses. Never retain names, paths or network addresses.
      case 'n': peer = value.startsWith('->') ? address(value.slice(2)) : null; break
    }
  }
  save()
  return { targets: targets.map(({ childPid, fd: targetFd }) => {
    const endpoint = descriptors.find((entry) => entry.pid === hostPid && entry.fd === targetFd) ?? null
    const holders = endpoint === null ? [] : descriptors.filter((entry) => {
      if (entry === endpoint || entry.type !== endpoint.type) return false
      return entry.device === endpoint.device || entry.device === endpoint.peer || entry.peer === endpoint.device
    })
    return { childPid, fd: targetFd, endpoint, holders: holders.slice(0, maximumHolders), omittedHolders: Math.max(0, holders.length - maximumHolders) }
  }) }
}

// Darwin Node stdio uses Unix socket pairs. -U avoids querying unrelated file descriptors.
// Executable injection is only for focused deadline/byte/lifetime controls; CI always selects /usr/sbin/lsof.
export function queryPipeHolders(options: {
  executable: string; arguments?: readonly string[]; uid: number; hostPid: number; targets: readonly PipeTarget[]; record: (record: PipeQueryRecord) => void
}): (reason: 'cancelled' | 'host.exit') => void {
  const began = performance.now()
  const chunks: Buffer[] = []
  let bytes = 0
  let settled = false
  let timer: NodeJS.Timeout | undefined
  const record = (status: PipeQueryRecord['status'], exitCode: number | null, queryPid: number | null): void => {
    try {
      options.record({ event: 'pipe.holders', status, queryMs: performance.now() - began, bytes, exitCode, queryPid, ...pipeHoldersFromLsof(Buffer.concat(chunks, bytes).toString('utf8'), options.hostPid, options.targets) })
    } catch {
      // A failed diagnostic sink must not change the observed CLI's cleanup or exit.
    }
  }
  let diagnostic: ChildProcess
  try {
    diagnostic = spawn(options.executable, options.arguments ?? ['-b', '-nP', '-X', '+c', '0', '-a', '-u', String(options.uid), '-U', '-F0pcRgatdn'], { stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    record('failed', null, null)
    return (): void => {}
  }
  const onHostExit = (): void => finish('host.exit', null)
  const finish = (status: PipeQueryRecord['status'], exitCode: number | null): void => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    process.removeListener('exit', onHostExit)
    try { if (status !== 'complete' && status !== 'failed') diagnostic.kill('SIGKILL') } catch {}
    try { diagnostic.stdout?.destroy() } catch {}
    record(status, exitCode, diagnostic.pid ?? null)
  }
  diagnostic.unref()
  if (diagnostic.stdout instanceof Socket) diagnostic.stdout.unref()
  diagnostic.stdout?.on('data', (chunk: Buffer) => {
    if (settled) return
    const kept = chunk.subarray(0, PIPE_QUERY_MAXIMUM_BYTES - bytes)
    chunks.push(kept)
    bytes += kept.length
    if (kept.length < chunk.length || bytes === PIPE_QUERY_MAXIMUM_BYTES) finish('bytes-limit', null)
  })
  diagnostic.once('error', () => finish('failed', null))
  diagnostic.once('close', (exitCode) => finish(exitCode === 0 ? 'complete' : 'failed', exitCode))
  timer = setTimeout(() => finish('timeout', null), PIPE_QUERY_TIMEOUT_MS)
  timer.unref()
  process.once('exit', onHostExit)
  return (reason): void => finish(reason, null)
}
