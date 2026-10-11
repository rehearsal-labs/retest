import type { OwnedProcessIdentity } from '../../src/shared/process-ownership.ts'
import assert from 'node:assert/strict'
import { ChildProcess } from 'node:child_process'
import { channel } from 'node:diagnostics_channel'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { ChromiumProcess } from '../../src/browser/chromium-process.ts'
import { Redactor } from '../../src/runner/redactor.ts'
import { errorCode } from '../../src/shared/error-code.ts'
import { readProcessTable } from '../../src/shared/process-ownership.ts'

function object(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }

async function jsonFile(path: string): Promise<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
  assert.ok(object(parsed), `${path} contains a fixture record`)
  return parsed
}

async function waitForFile(path: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 12000
  while (true) {
    try { return await jsonFile(path) }
    catch { if (Date.now() >= deadline) throw new Error(`Fixture proof did not arrive: ${path}`); await delay(30) }
  }
}

async function within<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  const timer = new AbortController()
  try {
    return await Promise.race([promise, delay(milliseconds, undefined, { signal: timer.signal }).then(() => { throw new Error('The fixture root did not finish its cooperative shutdown.') })])
  } finally { timer.abort() }
}

function identity(record: OwnedProcessIdentity | undefined, fixture: string) {
  return record === undefined ? null : { pid: record.pid, parentPid: record.parentPid, groupId: record.groupId, startedAt: record.startedAt, state: record.state ?? null, commandMatchesFixture: record.command.includes(fixture) }
}

test('real inherited stderr: a detached writer ends itself, and reader shutdown preserves ownership and redaction', { timeout: 30000 }, async (context) => {
  const retainedProof = process.env['RETEST_READER_PROOF_OUT']
  const proofRoot = retainedProof ?? tmpdir()
  await mkdir(proofRoot, { recursive: true })
  const folder = await mkdtemp(join(proofRoot, 'reader-finish-'))
  const fixture = fileURLToPath(new URL('../support/inherited-stderr-fixture.ts', import.meta.url))
  const logFile = join(folder, 'browser.log')
  const redactor = new Redactor()
  redactor.learn('password', 'hunter2')
  const signals: { pid: number; signal: NodeJS.Signals | number | undefined }[] = []
  const originalKill = process.kill
  context.mock.method(process, 'kill', (pid: number, signal?: NodeJS.Signals | number): boolean => {
    if (signal === 0) return originalKill(pid, signal)
    signals.push({ pid, signal })
    throw new Error('This fixture must end through its own lifetime, without a destructive signal.')
  })
  let browser: ChromiumProcess | undefined
  let rootChild: ChildProcess | undefined
  let rootBefore: OwnedProcessIdentity | undefined
  let helperBefore: OwnedProcessIdentity | undefined
  let helperAfter: OwnedProcessIdentity | undefined
  let helperPid: number | undefined
  let problems: string[] = []
  const rootEnded = Promise.withResolvers<void>()
  const teardownSignals: { pid: number; signal: NodeJS.Signals | number | undefined }[] = []
  let teardownProblems: string[] = []
  const lifecycle: { event: string; childPid: number; stderrEnded: boolean | null; stderrDestroyed: boolean | null; atMs: number }[] = []
  context.after(async () => {
    try {
      await writeFile(join(folder, 'release-helper'), 'end\n')
      const commands = rootChild?.stdio[3]
      if (commands instanceof Writable && !commands.writableEnded) commands.end()
      if (rootChild !== undefined) {
        try { await within(rootEnded.promise, 4000) }
        catch (error) {
          if (browser === undefined) throw error
          context.mock.restoreAll()
          context.mock.method(process, 'kill', (pid: number, signal?: NodeJS.Signals | number): boolean => {
            if (signal !== 0) teardownSignals.push({ pid, signal })
            return originalKill(pid, signal)
          })
          teardownProblems = await browser.stop(0)
          await within(rootEnded.promise, 4000)
        }
        if (browser !== undefined) teardownProblems = await browser.stop(0)
      }
      let ready: Record<string, unknown> | undefined
      try { ready = await jsonFile(join(folder, 'helper-ready.json')) }
      catch (error) { if (errorCode(error) !== 'ENOENT') throw error }
      const recordedPid = ready?.['pid']
      if (recordedPid !== undefined) {
        assert.ok(typeof recordedPid === 'number' && Number.isSafeInteger(recordedPid))
        helperPid = recordedPid
      }
      let ended: Record<string, unknown> | undefined
      let remaining: OwnedProcessIdentity | undefined
      if (helperPid !== undefined) {
        ended = await waitForFile(join(folder, 'helper-ended.json'))
        assert.equal(ended['pid'], helperPid)
        assert.equal(ended['reason'], 'fixture released')
        const deadline = Date.now() + 4000
        remaining = readProcessTable().find((record) => record.pid === helperPid)
        while (remaining !== undefined && !remaining.state?.startsWith('Z')) {
          if (Date.now() >= deadline) throw new Error('The fixture release did not lead to natural helper exit.')
          await delay(30)
          remaining = readProcessTable().find((record) => record.pid === helperPid)
        }
        assert.equal(teardownSignals.some((signal) => signal.pid === helperPid), false, 'owned-root teardown did not signal the detached helper')
      }
      await writeFile(join(folder, 'receipt.json'), `${JSON.stringify({ nodeVersion: process.version, platform: process.platform, rootBefore: identity(rootBefore, fixture), rootExitCode: rootChild?.exitCode ?? null, rootSignalCode: rootChild?.signalCode ?? null, helperBefore: identity(helperBefore, fixture), helperAfterReaderClose: identity(helperAfter, fixture), naturalHelperEnd: ended ?? null, helperFinally: identity(remaining, fixture), problems, signals, teardownSignals, teardownProblems, lifecycle, logFile, scope: 'known synthetic fixture only; no later helper output guarantee' }, null, 2)}\n`)
      context.diagnostic(`Fixture proof: ${folder}`)
    } finally {
      if (retainedProof === undefined) await rm(folder, { recursive: true, force: true })
    }
  })
  const observe = (message: unknown): void => {
    if (!object(message) || !(message['process'] instanceof ChildProcess)) return
    const child = message['process']
    child.once('spawn', () => {
      if (!child.spawnargs.includes(fixture) || !child.spawnargs.includes('root') || child.pid === undefined) return
      rootChild = child
      const childPid = child.pid
      const record = (event: string): void => { lifecycle.push({ event, childPid, stderrEnded: child.stderr?.readableEnded ?? null, stderrDestroyed: child.stderr?.destroyed ?? null, atMs: Date.now() }) }
      record('spawn')
      child.once('exit', () => { record('exit'); rootEnded.resolve() })
      child.once('close', () => record('close'))
      child.stderr?.once('end', () => record('stderr.end'))
      child.stderr?.once('close', () => record('stderr.close'))
    })
  }
  channel('child_process').subscribe(observe)
  context.after(() => channel('child_process').unsubscribe(observe))
  const launched = await ChromiumProcess.start({ executable: process.execPath, args: [fixture, 'root', folder], logFile, redact: (text) => redactor.redact(text), redactStream: () => redactor.stream() })
  browser = launched
  launched.pipe.readable.resume()
  rootBefore = readProcessTable().find((record) => record.pid === launched.pid)
  assert.ok(rootBefore !== undefined)
  launched.pipe.writable.end('start\n')
  const helperReady = await waitForFile(join(folder, 'helper-ready.json'))
  const observedHelperPid = helperReady['pid']
  assert.ok(typeof observedHelperPid === 'number' && Number.isSafeInteger(observedHelperPid))
  helperPid = observedHelperPid
  const exit = await launched.exited
  assert.deepEqual(exit, { code: 0, signal: null })
  const table = readProcessTable()
  helperBefore = table.find((record) => record.pid === helperPid)
  assert.ok(helperBefore !== undefined, 'the detached writer is still live at root exit')
  assert.notEqual(helperBefore.parentPid, launched.pid, 'the writer detached from the root before root exit')
  assert.notEqual(helperBefore.groupId, launched.pid)
  assert.equal(table.some((record) => record.pid === launched.pid && !record.state?.startsWith('Z')), false)
  problems = await launched.stop(0)
  await launched.outputSettled
  await launched.gone()
  helperAfter = readProcessTable().find((record) => record.pid === helperPid)
  assert.ok(helperAfter !== undefined && !helperAfter.state?.startsWith('Z'), 'reader cleanup completes while the inherited writer is still alive')
  assert.equal(helperAfter.startedAt, helperBefore.startedAt)
  assert.deepEqual(signals, [], 'the unrecorded writer was never signaled')
  const logged = await readFile(logFile, 'utf8')
  assert.ok(logged.includes('root complete {{password}}\n'))
  assert.ok(logged.includes('helper accepted {{password}}\n'))
  assert.equal(logged.includes('hunter2'), false)
  assert.equal(logged.includes('hunt'), false)
  assert.deepEqual(problems, [])
  assert.ok(logged.includes('root safe partial '))
  assert.ok(logged.includes('later inherited output was not collected'))
  const close = lifecycle.find((record) => record.event === 'stderr.close')
  assert.ok(close !== undefined)
  assert.equal(close.stderrEnded, false, 'this is local closure, not remote EOF')
  assert.equal(close.stderrDestroyed, true)
  assert.equal(lifecycle.some((record) => record.event === 'stderr.end'), false)
})
