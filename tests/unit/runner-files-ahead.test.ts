import type { TestContext } from 'node:test'
import type { Reporter } from '../../src/reporters/reporter.ts'
import type { RunRecord } from '../support/run-harness.ts'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { childLogFile } from '../../src/protocol/run-folder.ts'
import { FileLoad } from '../../src/runner/load-tests.ts'
import { TestFileProcess } from '../../src/runner/test-file-process.ts'
import { unixOnly } from '../support/platform-skip.ts'
import { eventsOfType, isRunning, rootDir, runSupportFiles, supportFile, testNamed } from '../support/run-harness.ts'
import { tempFolder } from '../support/temp-folder.ts'

/**
 * A server the support files talk to: each load of ahead-signals.retest.ts by its process id, a wait for its second
 * load, a mark one file makes and another waits for, and the processes beside a test, as one listed them. The
 * environment holds this process's variables and the server's address, the marker's path and the order log's.
 */
type Signals = { environment: Record<string, string>; loads: number[]; siblings: number[]; order: () => string[] }

async function signals(t: TestContext, extra: Record<string, string> = {}): Promise<Signals> {
  const folder = tempFolder('files-ahead-')
  const mark = join(folder, 'mark')
  const orderLog = join(folder, 'order.log')
  writeFileSync(orderLog, '')
  const loads: number[] = []
  const siblings: number[] = []
  const waitingForLoads: { times: number; answer: () => void }[] = []
  const waitingForMark: (() => void)[] = []
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://signals')
    const times = Number(url.searchParams.get('times'))
    switch (url.pathname) {
      case '/load':
        loads.push(Number(url.searchParams.get('pid')))
        response.end(String(loads.length))
        for (const waiting of waitingForLoads.filter((each) => loads.length >= each.times)) waiting.answer()
        return
      case '/loaded':
        if (loads.length >= times) return void response.end('loaded')
        return void waitingForLoads.push({ times, answer: () => response.end('loaded') })
      case '/mark':
        writeFileSync(mark, '')
        for (const answer of waitingForMark.splice(0)) answer()
        return void response.end('marked')
      case '/marked':
        if (existsSync(mark)) return void response.end('marked')
        return void waitingForMark.push(() => response.end('marked'))
      case '/siblings':
        siblings.push(...(url.searchParams.get('pids') ?? '').split(',').filter((pid) => pid !== '').map(Number))
        return void response.end('listed')
    }
    response.statusCode = 404
    response.end()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => {
    server.closeAllConnections()
    server.close()
  })
  const address = server.address()
  assert.ok(address !== null && typeof address === 'object')
  const inherited = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
  const environment = { ...inherited, SIGNALS_URL: `http://127.0.0.1:${address.port}`, SIGNALS_MARK: mark, SIGNALS_ORDER: orderLog, ...extra }
  return { environment, loads, siblings, order: () => readFileSync(orderLog, 'utf8').split('\n').filter((line) => line !== '') }
}

function startedOf(record: RunRecord, name: string): number {
  return record.events.findIndex((event) => event.type === 'test.started' && event.testId.startsWith(`${supportFile(name)} >`))
}

describe('a load begun ahead of its turn', () => {
  test('is given its budget from when it is waited for, not from when it began', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const child = TestFileProcess.spawn()
    const load = FileLoad.begin(child, { file: supportFile('passing.retest.ts'), rootDir })
    // Far past the budget the load will be given, and nothing counts yet, so nothing is stopped.
    t.mock.timers.tick(60_000)
    const { loaded } = await load.within(5000)
    assert.equal(loaded.ok, true, JSON.stringify(loaded))
    assert.equal(child.killed, false)
    await child.kill()
  })

  test('fails, as one that ended while loading, when its process ended before the file was sent', async () => {
    const child = TestFileProcess.spawn()
    await child.kill()
    const file = supportFile('passing.retest.ts')
    const { loaded } = await FileLoad.begin(child, { file, rootDir, logFile: 'logs/passing.log' }).within(5000)
    assert.deepEqual(loaded, { ok: false, failure: { class: 'collection_failed', message: `The process for ${file} ended while loading it (signal SIGKILL). Its output is in logs/passing.log.` } })
  })
})

describe('files on two workers', () => {
  test('the next file loads while every worker runs a file, before a worker takes it', async (t) => {
    const signalled = await signals(t)
    // Both workers wait for the third file to load a second time: only a load ahead of its turn lets them go on.
    const record = await runSupportFiles(['waits-for-ahead.retest.ts', 'waits-for-ahead-too.retest.ts', 'ahead-signals.retest.ts'], { workers: 2, testEnvironment: signalled.environment })
    assert.deepEqual(record.result.counts, { passed: 5, failed: 0, error: 0, notRun: 0, inconclusive: 0 }, JSON.stringify(record.result.files.map((file) => file.tests.map((each) => each.failure?.message))))
    assert.equal(signalled.loads.length, 2, 'collected once and loaded once to run')
    // Its test ran in its turn, once a worker was free.
    const waited = record.events.findIndex((event) => event.type === 'test.finished' && event.testId.endsWith('waits for the next file to load'))
    assert.ok(startedOf(record, 'ahead-signals.retest.ts') > waited)
    // What it printed while it loaded ahead is in its log, as it would be had it loaded in its turn.
    const log = readFileSync(join(record.folder, childLogFile(supportFile('ahead-signals.retest.ts'))), 'utf8')
    assert.equal(log, `loading ahead-signals in ${signalled.loads[1]}\n`)
    assert.deepEqual(record.output.filter((chunk) => chunk.file === supportFile('ahead-signals.retest.ts')).map((chunk) => chunk.text).join(''), log)
    assert.equal(record.result.exitCode, 0)
  })

  test("a file that fails to load ahead fails as it would have loading in its turn, with the same failure and log", async (t) => {
    const ahead = await signals(t, { SIGNALS_FAIL_LATER: '1' })
    const aheadRecord = await runSupportFiles(['waits-for-ahead.retest.ts', 'waits-for-ahead-too.retest.ts', 'ahead-signals.retest.ts'], { workers: 2, testEnvironment: ahead.environment })
    const inTurn = await signals(t, { SIGNALS_FAIL_LATER: '1' })
    const inTurnRecord = await runSupportFiles(['ahead-signals.retest.ts'], { workers: 1, testEnvironment: inTurn.environment })
    const failed = testNamed(aheadRecord.result, 'was loaded to run')
    const expected = testNamed(inTurnRecord.result, 'was loaded to run')
    assert.equal(failed.status, 'not_run')
    assert.match(failed.failure?.message ?? '', /This file fails each time it loads after the first\./)
    assert.deepEqual(failed.failure, expected.failure)
    const file = (record: RunRecord): unknown => record.result.files.find((each) => each.file === supportFile('ahead-signals.retest.ts'))?.failure
    assert.deepEqual(file(aheadRecord), file(inTurnRecord))
    assert.deepEqual(eventsOfType(aheadRecord.events, 'file.failed'), [])
    assert.equal(testNamed(aheadRecord.result, 'waits for the next file to load').status, 'passed')
    const log = (record: RunRecord, signalled: Signals): string => readFileSync(join(record.folder, childLogFile(supportFile('ahead-signals.retest.ts'))), 'utf8').replace(String(signalled.loads[1]), '<pid>')
    assert.equal(log(aheadRecord, ahead), log(inTurnRecord, inTurn))
  })

  test('a file whose process throws after its last test still fails, though its worker went on, and says so before the run ends', async () => {
    const name = 'late-error.retest.ts'
    const record = await runSupportFiles([name, 'passing.retest.ts', 'passing-too.retest.ts'], { workers: 2, fake: { disposeDelayMs: 200 } })
    const failure = record.result.files.find((each) => each.file === supportFile(name))?.failure
    assert.match(failure?.message ?? '', /threw an error while no test was running: Error: thrown after the last test ended/)
    assert.deepEqual(eventsOfType(record.events, 'file.failed').map((event) => [event.file, event.failure]), [[supportFile(name), failure]])
    assert.ok(record.events.findIndex((event) => event.type === 'file.failed') < record.events.findIndex((event) => event.type === 'run.finished'))
    assert.deepEqual(record.result.counts, { passed: 6, failed: 0, error: 0, notRun: 0, inconclusive: 0 })
    assert.deepEqual([record.result.exitCode, record.result.complete], [2, false])
    assert.deepEqual(record.written, record.result)
  })

  test('a worker goes on to its next file while its last file closes, and that file is judged once it has closed', async (t) => {
    const signalled = await signals(t)
    // The first file's process cannot close until the third file's test runs; the second holds the other worker until
    // then. A worker that waited for the close would end the first process as one that did not close.
    const record = await runSupportFiles(['closes-after-mark.retest.ts', 'waits-for-mark.retest.ts', 'marks.retest.ts'], {
      workers: 2,
      testEnvironment: signalled.environment,
      fake: { disposeDelayMs: 200 },
    })
    assert.deepEqual(record.result.files.map((file) => [file.file, file.failure]), [
      [supportFile('closes-after-mark.retest.ts'), undefined],
      [supportFile('waits-for-mark.retest.ts'), undefined],
      [supportFile('marks.retest.ts'), undefined],
    ])
    assert.deepEqual(eventsOfType(record.events, 'file.failed'), [])
    assert.deepEqual(record.result.counts, { passed: 3, failed: 0, error: 0, notRun: 0, inconclusive: 0 })
    assert.equal(record.result.exitCode, 0)
  })

  test('a stopped run closes the processes it started ahead, and keeps nothing of them', async (t) => {
    const signalled = await signals(t)
    const broken: Reporter = {
      name: 'terminal',
      onEvent: (event) => {
        // The first of the two waits to end stops the run, once the third file has loaded ahead.
        if (event.type === 'test.finished' && event.testId.endsWith('waits for the next file to load')) throw new Error('The terminal went away.')
      },
      onRunEnd: () => undefined,
    }
    const names = ['waits-for-ahead.retest.ts', 'waits-for-ahead-too.retest.ts', 'ahead-signals.retest.ts', 'passing-too.retest.ts']
    const record = await runSupportFiles(names, { workers: 2, testEnvironment: signalled.environment, reporters: [broken] })
    assert.equal(signalled.loads.length, 2, 'the third file had loaded ahead when the run stopped')
    const lost = { class: 'reporting_failed', message: 'The terminal reporter failed on test.finished: The terminal went away.' }
    assert.deepEqual(record.result.failure, lost)
    for (const name of ['ahead-signals.retest.ts', 'passing-too.retest.ts']) {
      const file = record.result.files.find((each) => each.file === supportFile(name))
      assert.deepEqual(file?.tests.map((each) => [each.status, each.failure]), file?.tests.map(() => ['not_run', lost]))
      assert.equal(file?.failure, undefined)
      assert.equal(existsSync(join(record.folder, childLogFile(supportFile(name)))), false, `${name} has no log`)
      assert.deepEqual(record.output.filter((chunk) => chunk.file === supportFile(name)), [])
    }
    assert.deepEqual(eventsOfType(record.events, 'file.failed'), [])
    const [, aheadPid] = signalled.loads
    assert.ok(aheadPid !== undefined && !isRunning(aheadPid), 'the process loaded ahead is gone')
  })
})

describe('files on one worker', () => {
  test("the next file's process starts while the file before it runs, and is sent its file only once that file's process has exited", { skip: unixOnly('pgrep lists child processes on macOS and Linux') }, async (t) => {
    const signalled = await signals(t)
    const record = await runSupportFiles(['lists-siblings.retest.ts', 'ahead-signals.retest.ts'], { workers: 1, testEnvironment: signalled.environment })
    assert.deepEqual(record.result.counts, { passed: 3, failed: 0, error: 0, notRun: 0, inconclusive: 0 })
    const [, runPid] = signalled.loads
    assert.ok(runPid !== undefined && signalled.siblings.includes(runPid), `the process that ran the second file, ${runPid}, was there during the first file's test: ${signalled.siblings.join(', ')}`)
    // Collection loaded the second file first; the load that ran it came after the first file's process had exited.
    const order = signalled.order()
    assert.equal(order.length, 3, order.join('\n'))
    assert.match(order[1] ?? '', /^exited \d+$/)
    assert.equal(order[2], `loaded ${runPid}`)
  })
})
