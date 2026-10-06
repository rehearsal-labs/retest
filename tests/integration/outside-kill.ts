import assert from 'node:assert/strict'
import { OwnedProcessGroup } from '../../src/shared/process-ownership.ts'

/**
 * Kills a browser's main process alone, as something outside Retest would, so its pipe closes at once and the run loses
 * the browser; its helpers are left to the browser's own cleanup. The pid is read beneath `launchedPid`, a process this
 * test started (the browser itself when the test launched it), and signaled only right after a fresh reading shows it is
 * still the process recorded there. A pid merely reported is never signaled.
 *
 * @example killBrowserFromOutside(started.retest.pid, browser.pid)
 */
export function killBrowserFromOutside(launchedPid: number, browserPid: number): void {
  const reading = new OwnedProcessGroup(launchedPid)
  assert.deepEqual(reading.capture(), [], `the processes beneath ${launchedPid} could be read`)
  assert.ok(reading.verifiedIdentity(browserPid) !== undefined, `process ${browserPid} is not recorded beneath ${launchedPid}, so the test did not signal it`)
  process.kill(browserPid, 'SIGKILL')
}
