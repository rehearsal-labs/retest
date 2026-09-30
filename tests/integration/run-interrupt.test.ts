import type { RetestEvent } from '../../src/protocol/events.ts'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { startTaskApp } from '../../fixtures/task-app/server.ts'
import { signalGroup } from '../../src/browser/chromium-process.ts'
import { profilePrefix } from '../../src/browser/profiles.ts'
import { retestEventSchema } from '../../src/protocol/events.ts'
import { childLogFile, eventsFile, resultFile } from '../../src/protocol/run-folder.ts'
import { parse } from '../../src/protocol/schema.ts'
import { isGoneWithin } from '../support/run-harness.ts'
import { browserPath, groupExists, openApp, waitForGroupEnd } from './browser-harness.ts'
import { budgets, childLog, finishRun, onlyEvent, onlyTest, printedPids, profilesIn, resultOf, startRun } from './cli-harness.ts'

const rootDir = fileURLToPath(new URL('../../', import.meta.url))
const cli = fileURLToPath(new URL('../../src/cli/main.ts', import.meta.url))
const testFile = 'tests/support/files/waits-on-task-app.retest.ts'

/** Lines a process writes, and a way to wait for one. */
function lines(stream: NodeJS.ReadableStream): (matches: (line: string) => boolean) => Promise<string> {
  const seen: string[] = []
  const waiting = new Set<() => void>()
  let partial = ''
  stream.setEncoding('utf8')
  stream.on('data', (text: string) => {
    const parts = `${partial}${text}`.split('\n')
    partial = parts.pop() ?? ''
    seen.push(...parts)
    for (const check of waiting) check()
  })
  return (matches) =>
    new Promise((resolve) => {
      const check = (): void => {
        const found = seen.find(matches)
        if (found === undefined) return
        waiting.delete(check)
        resolve(found)
      }
      waiting.add(check)
      check()
    })
}

function readEvent(line: string): RetestEvent | undefined {
  const parsed = parse(retestEventSchema, JSON.parse(line))
  return parsed.ok ? parsed.value : undefined
}

const secondSignals = [
  { signal: 'SIGINT', exitCode: 130, notice: 'Stopping. Press Ctrl+C again' },
  { signal: 'SIGTERM', exitCode: 143, notice: 'Stopping on SIGTERM.' },
] as const

for (const { signal, exitCode, notice } of secondSignals) {
  test(`a second ${signal} during a real run exits at once and still takes the browser group and its profile`, { timeout: 60_000 }, async (t) => {
    const app = await startTaskApp()
    t.after(() => app.close())
    const scratch = await mkdtemp(join(tmpdir(), 'retest-interrupt-'))
    t.after(() => rm(scratch, { recursive: true, force: true }))
    const output = join(scratch, 'run')
    const args = [
      '--conditions=retest-source',
      cli,
      'run',
      testFile,
      '--browser',
      browserPath(),
      '--base-url',
      app.url,
      '--reporter',
      'jsonl',
      '--output',
      output,
      '--timeouts',
      'assertion=60000',
    ]
    const retest = spawn(process.execPath, args, { cwd: rootDir, stdio: ['ignore', 'pipe', 'pipe'] })
    const exited = once(retest, 'exit')
    t.after(() => retest.kill('SIGKILL'))
    const stdout = lines(retest.stdout)
    const stderr = lines(retest.stderr)

    const started = readEvent(await stdout((line) => line.includes('"type":"browser.started"')))
    assert.ok(started?.type === 'browser.started', 'retest printed browser.started')
    const { pid } = started
    t.after(() => {
      if (groupExists(pid)) signalGroup(pid, 'SIGKILL')
    })
    await stdout((line) => line.includes('"type":"action.completed"') && line.includes('"command":"goto"'))
    assert.equal(groupExists(pid), true, 'the browser is running while the test waits')

    retest.kill(signal)
    await stderr((line) => line.startsWith(notice))
    retest.kill(signal)
    const [code, ended] = await exited
    assert.deepEqual([code, ended], [exitCode, null])

    await waitForGroupEnd(pid, 5000)
    const events = (await readFile(join(output, eventsFile), 'utf8')).split('\n').filter((line) => line !== '').map(readEvent)
    assert.ok(
      !events.some((event) => event?.type === 'run.finished'),
      'the run was still stopping when the second signal ended it, so only the exit hook can have ended the browser',
    )
    assert.equal((await readdir(output)).includes(resultFile), false)
    const profiles = (await readdir(tmpdir())).filter((name) => retest.pid !== undefined && name.startsWith(profilePrefix(retest.pid)))
    assert.deepEqual(profiles, [], 'the profile went with the process')
    const log = await readFile(join(output, childLogFile(testFile)), 'utf8')
    const testFilePid = Number(/pid (\d+)/.exec(log)?.[1])
    assert.ok(testFilePid > 0, `the test file printed its process id: ${JSON.stringify(log)}`)
    assert.equal(await isGoneWithin(testFilePid, 2000), true, 'the test file process went with it')
  })
}

test('SIGTERM during a real run stops it like Ctrl+C: the result is written, the browser and profile are gone, and it exits 143', { timeout: 60_000 }, async (t) => {
  const app = await openApp(t)
  const started = await startRun(t, { files: [testFile], baseUrl: app.url, timeouts: budgets({ assertion: 30_000, test: 40_000 }) })
  const browser = await started.retest.waitForEvent('browser.started')
  await started.retest.waitForEvent('action.completed', (event) => event.command === 'goto')
  started.retest.signal('SIGTERM')
  const run = await finishRun(started)

  assert.deepEqual(run.exit, { code: 143, signal: null })
  const result = resultOf(run)
  assert.deepEqual([result.status, result.exitCode, result.complete], ['interrupted', 143, false])
  assert.equal(onlyEvent(run.events, 'run.finished').exitCode, 143)
  const stopped = onlyTest(run)
  assert.deepEqual([stopped.status, stopped.failure?.message], ['error', 'The run was stopped by SIGTERM.'])
  assert.match(run.stderr, /Stopping on SIGTERM\./)
  assert.equal(groupExists(browser.pid), false, 'the browser group is gone')
  assert.deepEqual(profilesIn(started.retest.tmp), [], 'no profile is left')
  const [testFilePid] = printedPids(childLog(run, testFile))
  assert.ok(testFilePid !== undefined && (await isGoneWithin(testFilePid, 2000)), 'the test file process is gone')
})
