import type { NativeTools } from '../../native/processes.ts'
import { readFile, readlink } from 'node:fs/promises'
import { hostname } from 'node:os'
import { describeCommand, runCommand } from '../../native/processes.ts'
import { errorMessage } from '../../protocol/failures.ts'
import { errorCode } from '../../shared/error-code.ts'

// What the install lock knows of a process: when it started, on a clock nothing can move after the fact, and which
// machine, or container, its pid belongs to. A pid means something only among the processes of one machine and one pid
// namespace, and a start only on one clock.

/**
 * When a process started. On Linux, the kernel's clock ticks from boot to its start, as /proc keeps them, which a step
 * of the wall clock does not move; on macOS, the second `ps` prints, read in UTC so it is the same whatever time zone
 * the reader runs in.
 */
export type ProcessStart = { readonly clock: 'boot-ticks' | 'utc-seconds'; readonly value: number }

/** A process's start as read now: there, with its start; no process under that pid; or why it could not be read. */
export type StartReading = { readonly state: 'present'; readonly start: ProcessStart } | { readonly state: 'absent' } | { readonly state: 'unreadable'; readonly problem: string }

/** Reads the start of a pid on this machine. */
export type StartReader = (pid: number) => Promise<StartReading>

/** What reading starts needs: the platform, `ps` on macOS, and a signal that stops a reading under way. */
export type StartReaderOptions = { readonly platform: NodeJS.Platform; readonly tools: Pick<NativeTools, 'ps' | 'hiddenVariables'>; readonly signal?: AbortSignal | undefined }

/**
 * The start reader for this platform: /proc on Linux, `ps` under TZ=UTC0 on macOS. Any other platform reads nothing.
 *
 * @example (await startReader({ platform: process.platform, tools: systemTools })(process.pid)).state // 'present'
 */
export function startReader(options: StartReaderOptions): StartReader {
  if (options.platform === 'linux') return readLinuxStart
  if (options.platform === 'darwin') return (pid) => readMacStart(pid, options)
  return async () => ({ state: 'unreadable', problem: `Retest reads when a process started only on macOS and Linux, and this machine is ${options.platform}.` })
}

async function readLinuxStart(pid: number): Promise<StartReading> {
  let text: string
  try {
    text = await readFile(`/proc/${pid}/stat`, 'utf8')
  } catch (error) {
    const code = errorCode(error)
    if (code === 'ENOENT' || code === 'ESRCH') return { state: 'absent' }
    return { state: 'unreadable', problem: `/proc/${pid}/stat cannot be read: ${errorMessage(error)}` }
  }
  const ticks = parseProcStat(text)
  return ticks === undefined ? { state: 'unreadable', problem: `/proc/${pid}/stat is not in a form Retest can read` } : { state: 'present', start: { clock: 'boot-ticks', value: ticks } }
}

async function readMacStart(pid: number, options: StartReaderOptions): Promise<StartReading> {
  const result = await runCommand(options.tools.ps, ['-o', 'lstart=', '-p', String(pid)], { timeoutMs: 10_000, signal: options.signal, environment: { LC_ALL: 'C', TZ: 'UTC0' }, hiddenVariables: options.tools.hiddenVariables })
  const text = result.stdout.trim()
  if (result.code === 0 && !result.timedOut && !result.stopped && text.length > 0) {
    const seconds = parseUtcStart(text)
    return seconds === undefined ? { state: 'unreadable', problem: `ps showed the start of pid ${pid} in a form Retest cannot read` } : { state: 'present', start: { clock: 'utc-seconds', value: seconds } }
  }
  // ps answers 1 and prints nothing, not even to stderr, when no process has the pid.
  if (result.code === 1 && text.length === 0 && result.stderr.trim().length === 0 && !result.timedOut && !result.stopped) return { state: 'absent' }
  return { state: 'unreadable', problem: describeCommand('ps', result) }
}

/**
 * The start of a process from its /proc/<pid>/stat line: field 22, the clock ticks from boot to its start. The command
 * name in brackets may hold spaces and brackets of its own, so fields are counted from the last closing bracket.
 *
 * @example parseProcStat('4242 (node (x) y) S 1 4242 4242 0 -1 4194560 1 0 0 0 0 0 0 0 20 0 11 0 873421 0 0') // 873421
 */
export function parseProcStat(text: string): number | undefined {
  const close = text.lastIndexOf(')')
  if (close < 0) return undefined
  const fields = text.slice(close + 1).trim().split(/\s+/)
  // Fields after the name start at field 3, the state, so field 22 is the twentieth.
  const value = fields[19]
  if (value === undefined || !/^\d+$/.test(value)) return undefined
  const ticks = Number(value)
  return Number.isSafeInteger(ticks) ? ticks : undefined
}

const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * The start `ps -o lstart=` printed in the C locale under TZ=UTC0, as seconds since 1970.
 *
 * @example parseUtcStart('Mon Oct  5 20:03:49 2026') // 1791230629
 */
export function parseUtcStart(text: string): number | undefined {
  const fields = /^[A-Za-z]{3}\s+([A-Za-z]{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})$/.exec(text.trim())
  if (fields === null) return undefined
  const [, month = '', day = '', hours = '', minutes = '', seconds = '', year = ''] = fields
  const index = months.indexOf(month)
  if (index < 0) return undefined
  return Date.UTC(Number(year), index, Number(day), Number(hours), Number(minutes), Number(seconds)) / 1000
}

/**
 * How a start read now stands to the start a holder recorded: the same process; one that started later, so the
 * recorded one ended and its pid went to another; or neither, which proves nothing either way.
 *
 * @example compareStarts({ clock: 'boot-ticks', value: 100 }, { clock: 'boot-ticks', value: 250 }) // 'later'
 */
export function compareStarts(recorded: ProcessStart, current: ProcessStart): 'same' | 'later' | 'unsure' {
  if (recorded.clock !== current.clock) return 'unsure'
  if (current.value === recorded.value) return 'same'
  // Two processes never hold one pid at once, so one that started after the holder did can only have come after it.
  return current.value > recorded.value ? 'later' : 'unsure'
}

/** Which machine and pid namespace this process's pids belong to, with the host's name for people to read. */
export type Machine = { readonly id: string; readonly host: string }

/** What reading the machine needs: the platform, `sysctl` on macOS, and a signal that stops a reading under way. */
export type MachineOptions = { readonly platform: NodeJS.Platform; readonly sysctl?: string; readonly signal?: AbortSignal | undefined }

/**
 * This machine as the install lock tells machines apart. On Linux, the kernel's boot id with the pid namespace this
 * process is in, so two containers on one host differ; on macOS, the boot session's id. Both are new at every boot, so
 * pids of an earlier boot are never mistaken for this one's. The host's name is kept for messages only, since it can
 * change while the machine runs.
 *
 * @example (await readMachine({ platform: process.platform })).ok // true
 */
export function readMachine(options: MachineOptions): Promise<MachineReading> {
  // The boot and the pid namespace cannot change while this process runs, so each platform is read once; a reading that
  // failed is read again next time.
  const key = `${options.platform}\u0000${options.sysctl ?? ''}`
  const known = machines.get(key)
  if (known !== undefined) return known
  const reading = readMachineOnce(options)
  machines.set(key, reading)
  void reading.then((result) => { if (!result.ok && machines.get(key) === reading) machines.delete(key) })
  return reading
}

/** This machine as `readMachine` read it, or why it could not. */
export type MachineReading = { readonly ok: true; readonly machine: Machine } | { readonly ok: false; readonly problem: string }

const machines = new Map<string, Promise<MachineReading>>()

async function readMachineOnce(options: MachineOptions): Promise<MachineReading> {
  const host = hostname()
  try {
    if (options.platform === 'linux') {
      const boot = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim()
      const namespace = await readlink('/proc/self/ns/pid')
      return { ok: true, machine: { id: `linux boot ${boot} ${namespace}`, host } }
    }
    if (options.platform === 'darwin') {
      const result = await runCommand(options.sysctl ?? '/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'], { timeoutMs: 10_000, signal: options.signal })
      const session = result.stdout.trim()
      if (result.code !== 0 || !/^[0-9A-F-]{36}$/i.test(session)) return { ok: false, problem: `Retest could not read this Mac's boot session: ${describeCommand('sysctl', result)}.` }
      return { ok: true, machine: { id: `macos boot ${session}`, host } }
    }
  } catch (error) {
    return { ok: false, problem: `Retest could not read which machine this is: ${errorMessage(error)}.` }
  }
  return { ok: false, problem: `Retest tells machines apart only on macOS and Linux, and this machine is ${options.platform}.` }
}
