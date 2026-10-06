import type { ChildProcess } from 'node:child_process'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { signalGroup } from '../../src/browser/chromium-process.ts'

/**
 * Ends a service a test started as the leader of its own process group, on every path: one still running is sent
 * SIGKILL through its own handle, which Node never sends to a pid it has reaped, and the test waits for its exit. Any
 * process of its group still there afterwards fails the test by name, since the test recorded nothing else to end.
 *
 * @example t.after(() => endService(child, 'the cross-platform service'))
 */
export async function endService(child: ChildProcess, what: string, timeoutMs = 10_000): Promise<void> {
  const { pid } = child
  assert.ok(pid !== undefined, `${what} never started`)
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
    child.kill('SIGKILL')
    const ended = await Promise.race([exited.then(() => true), delay(timeoutMs).then(() => false)])
    assert.ok(ended, `${what} (pid ${pid}) did not exit within ${timeoutMs} ms of SIGKILL`)
  }
  const end = performance.now() + timeoutMs
  while (signalGroup(pid, 0) && performance.now() < end) await delay(20)
  if (!signalGroup(pid, 0)) return
  const { stdout } = await promisify(execFile)('/bin/ps', ['-ax', '-o', 'pid=,pgid=,comm='])
  const members = stdout.split('\n').map((line) => line.trim().split(/\s+/)).filter(([, group]) => group === String(pid))
  assert.fail(`The process group ${pid} of ${what} is still there after the test: ${members.map(([member, , ...name]) => `${member} ${name.join(' ')}`).join(', ')}.`)
}
