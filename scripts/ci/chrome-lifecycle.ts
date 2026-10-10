import type { Readable } from 'node:stream'
import { ChildProcess } from 'node:child_process'
import { channel } from 'node:diagnostics_channel'
import { closeSync, openSync, writeSync } from 'node:fs'
import { basename, isAbsolute } from 'node:path'
import { performance } from 'node:perf_hooks'

type PipeState = { ended: boolean; destroyed: boolean; closed: boolean; bufferedBytes: number } | null
type OutputState = { stdout: PipeState; stderr: PipeState }
type LifecycleEvent = 'spawn' | 'exit' | 'close' | 'stdout.end' | 'stdout.close' | 'stderr.end' | 'stderr.close'

// The workflow prints this separate append log after integration, since the CLI's stdout and stderr are test inputs.
const logPath = process.env['RETEST_CI_CHROME_LIFECYCLE_LOG']
if (process.platform === 'darwin' && logPath !== undefined && isAbsolute(logPath)) observeChrome(logPath)

function observeChrome(path: string): void {
  const active = new Map<number, ChildProcess>()
  let launched = 0
  let closed = 0
  let log: number | undefined
  let available = true
  let exitObserved = false
  const write = (record: object): void => {
    if (!available) return
    try {
      log ??= openSync(path, 'a', 0o600)
      writeSync(log, `# retest.chrome.lifecycle ${JSON.stringify({ version: 1, hostPid: process.pid, atMs: performance.now(), ...record })}\n`)
    } catch {
      // Observation must not change a test's output, process lifetime or exit code if CI storage is unavailable.
      available = false
    }
  }
  const pipeState = (stream: Readable | null): PipeState => stream === null ? null : {
    ended: stream.readableEnded,
    destroyed: stream.destroyed,
    closed: stream.closed,
    bufferedBytes: stream.readableLength,
  }
  const outputState = (child: ChildProcess): OutputState => ({ stdout: pipeState(child.stdout), stderr: pipeState(child.stderr) })
  const observeExit = (): void => {
    if (exitObserved) return
    exitObserved = true
    process.once('exit', (exitCode) => {
      write({ event: 'host.exit', exitCode, launched, closed, active: [...active].map(([childPid, child]) => ({ childPid, ...outputState(child) })) })
      if (log !== undefined) {
        try {
          closeSync(log)
        } catch {
          // CI diagnostics cannot replace the integration exit code.
        }
      }
    })
  }
  channel('child_process').subscribe((message) => {
    if (typeof message !== 'object' || message === null || !('process' in message) || !(message.process instanceof ChildProcess)) return
    const child = message.process
    // Node publishes at construction, before pid, spawn arguments and stdio exist. These are ready on 'spawn'.
    child.once('spawn', () => {
      if (child.pid === undefined || !['Google Chrome', 'Google Chrome for Testing', 'chrome', 'chromium'].includes(basename(child.spawnfile)) || !child.spawnargs.includes('--remote-debugging-pipe')) return
      const childPid = child.pid
      active.set(childPid, child)
      launched += 1
      observeExit()
      const record = (event: LifecycleEvent, extra: object = {}): void => write({ event, childPid, ...outputState(child), ...extra })
      record('spawn')
      child.once('exit', (exitCode, signal) => record('exit', { exitCode, signal }))
      child.once('close', (exitCode, signal) => {
        record('close', { exitCode, signal })
        active.delete(childPid)
        closed += 1
      })
      child.stdout?.once('end', () => record('stdout.end'))
      child.stdout?.once('close', () => record('stdout.close'))
      child.stderr?.once('end', () => record('stderr.end'))
      child.stderr?.once('close', () => record('stderr.close'))
    })
  })
}
