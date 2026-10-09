import type { Failure } from '../../src/protocol/failures.ts'
import type { ProcessEvent } from '../../src/runner/test-file-process.ts'
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import type { RunRecord } from '../support/run-harness.ts'
import { createAgentReporter } from '../../src/reporters/agent.ts'
import { createHumanReporter } from '../../src/reporters/human.ts'
import { TestFileProcess } from '../../src/runner/test-file-process.ts'
import { runProject, tempProject } from '../support/project.ts'
import { eventsOfType, runSupportFiles, testNamed } from '../support/run-harness.ts'
import { capture } from './reporters-fixtures.ts'

const reason: Failure = { class: 'interrupted', message: 'The host stopped the run: its budget ran out.' }

// The human and agent reports of a finished run, as the command line prints them and inspect replays them.
function reports(record: RunRecord): { human: string; agent: string } {
  const humanOut = capture()
  const agentOut = capture()
  const human = createHumanReporter({ stdout: humanOut, stderr: capture(), color: false, runFolder: 'run' })
  const agent = createAgentReporter({ stdout: agentOut, runFolder: 'run' })
  for (const event of record.events) {
    human.onEvent(event)
    agent.onEvent(event)
  }
  human.onRunEnd(record.result)
  agent.onRunEnd(record.result)
  return { human: humanOut.text, agent: agentOut.text }
}

describe('a run stopped with a Failure as its reason', async () => {
  const controller = new AbortController()
  const record = await runSupportFiles(['slow-click.retest.ts', 'passing.retest.ts'], {
    signal: controller.signal,
    timeouts: { action: 10_000, test: 20_000 },
    fake: {
      hang: 'click',
      onCommand: (command) => {
        if (command.kind === 'click') setTimeout(() => controller.abort(reason), 20)
      },
    },
  })

  test('is interrupted and exits 130, and says why in run.finished and in the result', () => {
    assert.deepEqual([record.result.exitCode, record.result.status, record.result.complete], [130, 'interrupted', false])
    const [finished] = eventsOfType(record.events, 'run.finished')
    assert.deepEqual([finished?.exitCode, finished?.status, finished?.failure], [130, 'interrupted', reason])
    assert.deepEqual(record.result.failure, reason)
    assert.deepEqual(record.written, record.result)
  })

  test('each test it stopped, and each it kept from running, carries that reason', () => {
    const stopped = testNamed(record.result, 'clicks something that never answers')
    assert.deepEqual([stopped.status, stopped.failure], ['error', reason])
    const [click] = eventsOfType(record.events, 'action.failed')
    assert.equal(click?.failure.message, `${reason.message} getByTestId('save-task').click() was stopped before it sent any input.`)
    for (const test of [testNamed(record.result, 'runs next'), ...(record.result.files[1]?.tests ?? [])]) {
      assert.deepEqual([test.status, test.failure], ['not_run', reason], test.name)
    }
    assert.equal(record.browsers[0]?.closed, true)
  })

  test('the human and agent reports say why the run stopped, on the test it stopped and for the run', () => {
    const { human, agent } = reports(record)
    assert.match(human, /\n {2}✗ tests\/support\/files\/slow-click\.retest\.ts › clicks something that never answers {2}\d+ ms\n\n {4}Interrupted\n {4}The host stopped the run: its budget ran out\.\n/)
    assert.match(human, /\n {2}Run failed\n {4}Interrupted\n {4}The host stopped the run: its budget ran out\.\n/)
    // The fake browser collects no diagnostics, so the summary's Diagnostics row sets the label column's width.
    assert.match(human, /\n {2}Exit {9}130 · interrupted, incomplete\n/)
    assert.match(agent, /^retest: 1 error, 4 not run \(5\) in [^,]+, exit 130, interrupted, incomplete\nrun failed: interrupted The host stopped the run: its budget ran out\.\n/)
    assert.match(agent, /\nerror tests\/support\/files\/slow-click\.retest\.ts:5 clicks something that never answers\n {2}interrupted The host stopped the run: its budget ran out\.\n/)
  })
})

// The host's stop kills the file's process at once, but the process can answer the stop first with its own verdict: the
// click's answer, which is the reason at the click's place. The kill is held back here so that answer always comes first.
test('a stopped test whose process answers the stop before it is killed carries the reason as the host gave it', async (t) => {
  const kill = TestFileProcess.prototype.kill
  t.mock.method(TestFileProcess.prototype, 'kill', function (this: TestFileProcess) {
    return delay(200).then(() => kill.call(this))
  })
  const answers: (Failure | undefined)[] = []
  const listen = TestFileProcess.prototype.listen
  t.mock.method(TestFileProcess.prototype, 'listen', function (this: TestFileProcess, listener: ((event: ProcessEvent) => void) | undefined) {
    if (listener === undefined) return listen.call(this, undefined)
    listen.call(this, (event) => {
      if (event.kind === 'message' && event.message.type === 'test-finished') answers.push(event.message.failure)
      listener(event)
    })
  })
  const controller = new AbortController()
  const record = await runSupportFiles(['slow-click.retest.ts', 'passing.retest.ts'], {
    signal: controller.signal,
    timeouts: { action: 10_000, test: 20_000 },
    fake: {
      hang: 'click',
      onCommand: (command) => {
        if (command.kind === 'click') setTimeout(() => controller.abort(reason), 20)
      },
    },
  })
  assert.deepEqual(answers, [{ ...reason, location: { file: 'tests/support/files/slow-click.retest.ts', line: 6, column: 39 } }], 'the process answered the stop first')
  const stopped = testNamed(record.result, 'clicks something that never answers')
  assert.deepEqual([stopped.status, stopped.failure], ['error', reason])
  for (const test of [testNamed(record.result, 'runs next'), ...(record.result.files[1]?.tests ?? [])]) {
    assert.deepEqual([test.status, test.failure], ['not_run', reason], test.name)
  }
  assert.match(reports(record).agent, /\nerror tests\/support\/files\/slow-click\.retest\.ts:5 clicks something that never answers\n {2}interrupted The host stopped the run: its budget ran out\.\n/)
})

// The order the cancelled run of participants-session-limits.test.ts met under load: the file was collected and its first
// test held what it needed, but its browser was still launching when the host stopped the run. That test never started,
// so it is not run, with the host's reason, as the tests after it are; only a test whose body ran ends as an error.
test('a run stopped while the browser its test waits for still launches records that test as not run, with the reason', async () => {
  const controller = new AbortController()
  const collected = Promise.withResolvers<void>()
  const record = await runSupportFiles(['passing.retest.ts'], {
    signal: controller.signal,
    // The run starts its browser as it begins; the launch is still out when the stop comes, after the first test has had
    // time to wait for it, and the browser comes up after the stop.
    fake: {
      holdLaunch: async () => {
        await collected.promise
        await delay(30)
        controller.abort(reason)
        await delay(50)
      },
    },
    reporters: [{ name: 'collected', onEvent: (event) => { if (event.type === 'collection.completed') collected.resolve() }, onRunEnd: () => undefined }],
  })
  assert.deepEqual([record.result.exitCode, record.result.status], [130, 'interrupted'])
  assert.deepEqual(eventsOfType(record.events, 'test.started'), [], 'no test started')
  const tests = record.result.files.flatMap((file) => file.tests)
  assert.ok(tests.length > 0)
  for (const test of tests) assert.deepEqual([test.status, test.failure], ['not_run', reason], test.name)
  assert.ok(record.browsers.every((browser) => browser.closed), 'the browser that came up after the stop was closed')
})

describe('a run stopped with a Failure before it starts', async () => {
  const record = await runSupportFiles(['passing.retest.ts'], { signal: AbortSignal.abort({ class: 'setup_failed', message: 'The host had no room for this run.' }) })

  test('loads nothing, names the reason on each file it did not load, and exits 130', () => {
    assert.deepEqual([record.result.exitCode, record.result.status], [130, 'interrupted'])
    assert.deepEqual(record.result.failure, { class: 'setup_failed', message: 'The host had no room for this run.' })
    assert.deepEqual(record.result.files[0]?.failure, { class: 'setup_failed', message: 'Not loaded: The host had no room for this run.' })
    assert.equal(record.browsers.length, 0)
  })
})

describe('a run stopped with a Failure while a file is collected', async () => {
  const controller = new AbortController()
  // The file never finishes loading, so it is still being collected when the host stops the run.
  setTimeout(() => controller.abort(reason), 300)
  const record = await runSupportFiles(['top-level-loop.retest.ts', 'passing.retest.ts'], { signal: controller.signal, timeouts: { collection: 10_000 } })

  test('the file it stopped carries the reason, and the reports still say that the run was stopped and why', () => {
    assert.deepEqual([record.result.exitCode, record.result.failure, record.result.files[0]?.failure], [130, reason, reason])
    const { human, agent } = reports(record)
    assert.match(human, /\n {2}Run failed\n {4}Interrupted\n {4}The host stopped the run: its budget ran out\.\n/)
    assert.match(agent, /\nrun failed: interrupted The host stopped the run: its budget ran out\.\n/)
  })
})

describe('a run stopped while a secret function waits for its value', async () => {
  const stopKey = 'retestUnitStopRun'
  const signalKey = 'retestUnitSecretSignal'
  const config = `import { chromium, defineConfig } from '@rehearsal-labs/retest'

export default defineConfig({
  apps: { web: chromium({ baseUrl: 'http://127.0.0.1:4173', executablePath: '/fake/chromium' }) },
  secrets: {
    code: ({ signal }) => {
      Reflect.set(globalThis, '${signalKey}', signal)
      Reflect.get(globalThis, '${stopKey}')()
      return new Promise(() => {})
    },
  },
})
`
  const tests = `import { secret, test } from '@rehearsal-labs/retest'

test('types the code', async ({ page }) => {
  await page.goto('/login')
  await page.getByTestId('password').fill(secret('code'))
})
`
  const controller = new AbortController()
  Reflect.set(globalThis, stopKey, () => setTimeout(() => controller.abort(reason), 20))
  const record = await runProject(tempProject({ 'retest.config.ts': config, 'tests/code.retest.ts': tests }), {
    files: ['tests/code.retest.ts'],
    signal: controller.signal,
    timeouts: { action: 10_000, test: 20_000 },
  })
  const signal: unknown = Reflect.get(globalThis, signalKey)
  Reflect.deleteProperty(globalThis, stopKey)
  Reflect.deleteProperty(globalThis, signalKey)

  test('tells the function through its signal, types nothing, and records the reason', () => {
    assert.ok(signal instanceof AbortSignal && signal.aborted, 'the function was told Retest stopped waiting')
    assert.deepEqual(record.browsers[0]?.pages[0]?.typed, [])
    const [fill] = eventsOfType(record.events, 'action.failed')
    assert.deepEqual(fill?.failure, {
      class: 'interrupted',
      message: `${reason.message} Retest stopped reading the secret "code", and typed nothing.`,
      details: { inputSent: false },
      location: { file: 'tests/code.retest.ts', line: 5, column: 38 },
    })
    assert.deepEqual([record.result.exitCode, record.result.failure], [130, reason])
  })
})
