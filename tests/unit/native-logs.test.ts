import type { DiagnosticIdentity } from '../../src/protocol/diagnostics.ts'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { AttemptBudget } from '../../src/diagnostics/session-capture.ts'
import { launchLoggedNativeApp, NativeLogSource } from '../../src/native/logs.ts'
import { commandOf, endRecorded, processExists, systemTools } from '../../src/native/processes.ts'
import { defaultDiagnosticLimits } from '../../src/protocol/diagnostics.ts'
import { Redactor } from '../../src/runner/redactor.ts'

// The launch that keeps an app's standard output: the processes it starts are Retest's own, and they are ended on
// every path that leaves them, or by an exit hook.

const identity: DiagnosticIdentity = { testId: 'native > logs', attemptId: 'attempt', app: 'desk', sessionId: 'attempt:desk' }

function source(): NativeLogSource {
  return new NativeLogSource({ identity, budget: new AttemptBudget(defaultDiagnosticLimits), redactor: new Redactor() })
}

function groupOf(pid: number): number {
  return Number(spawnSync('/bin/ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim())
}

test('a logged macOS app runs in a process group of its own, and an exit hook ends it until it is stopped', async (t) => {
  const before = new Set(process.listeners('exit'))
  const launched = await launchLoggedNativeApp({ source: source(), tools: systemTools, launch: { arguments: ['600'], environment: {} }, timeoutMs: 5000, target: { platform: 'macos', executable: '/bin/sleep' } })
  t.after(() => launched.stop().catch(() => undefined))
  const pid = launched.process.pid
  assert.equal(launched.process.command, '/bin/sleep 600')
  assert.equal(typeof launched.process.startedAt, 'string', 'the app is recorded by its start too')
  assert.equal(groupOf(pid), pid, 'a stop meant for the Retest process group never reaches the app')
  const hooks = process.listeners('exit').filter((listener) => !before.has(listener))
  assert.equal(hooks.length, 1, 'an exit hook stands for the app while it runs')
  hooks[0]?.(0)
  for (let tries = 0; tries < 100 && processExists(pid); tries += 1) await sleep(20)
  assert.equal(processExists(pid), false, 'the exit hook ended the recorded app')
  await launched.stop()
  assert.equal(process.listeners('exit').filter((listener) => !before.has(listener)).length, 0, 'the hook goes once the app is confirmed ended')
})

test('a logged iOS launch that cannot be reconciled ends the console launcher Retest started, and nothing else', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'retest-log-launch-unit-'))
  t.after(() => rm(folder, { recursive: true, force: true }))
  // The stand-in launcher writes its pid and stays, as `simctl launch --console` stays while the app runs.
  const launcher = join(folder, 'xcrun')
  await writeFile(launcher, `#!${process.execPath}\nimport { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(join(folder, 'launcher.pid'))}, String(process.pid)); setInterval(() => {}, 1000)\n`)
  await chmod(launcher, 0o700)
  const udid = '12345678-1234-1234-1234-123456789012'
  let readings = 0
  const processes = async (): Promise<{ readonly ok: true; readonly running: boolean; readonly pids: number[]; readonly processes: { readonly pid: number; readonly command: string }[] }> => {
    readings += 1
    // Before the launch nothing runs; after it, once the launcher is up, two copies show, so the launch cannot be tied
    // to one of them.
    if (readings === 1) return { ok: true, running: false, pids: [], processes: [] }
    for (let tries = 0; tries < 250 && (await readFile(join(folder, 'launcher.pid'), 'utf8').catch(() => '')) === ''; tries += 1) await sleep(20)
    return { ok: true, running: true, pids: [424242, 424243], processes: [{ pid: 424242, command: `/x/Devices/${udid}/TaskPhone` }, { pid: 424243, command: `/x/Devices/${udid}/TaskPhone` }] }
  }
  const failed = await launchLoggedNativeApp({ source: source(), tools: { ...systemTools, xcrun: launcher }, launch: { arguments: [], environment: {} }, timeoutMs: 5000, processes, target: { platform: 'ios-simulator', udid, bundleId: 'dev.test.phone', executable: 'TaskPhone' } }).then(() => undefined, (error: unknown) => error)
  assert.match(failed instanceof Error ? failed.message : '', /could not be reconciled to one owned app process/)
  const pid = Number(await readFile(join(folder, 'launcher.pid'), 'utf8'))
  // A launcher left running is ended after the test, as the process this test started, by its pid, start and command.
  const left = await commandOf(systemTools, pid)
  if (left.state === 'present') t.after(() => endRecorded(systemTools, { pid, command: left.command, startedAt: left.startedAt }, 1000))
  assert.equal(left.state, 'absent', 'the launcher Retest started was ended')
})
