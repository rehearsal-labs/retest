import type { HostEvaluation } from '../../src/protocol/evaluation.ts'
import type { RetestEvent } from '../../src/protocol/events.ts'
import type { RunResult } from '../../src/protocol/result.ts'
import type { ProjectRecord } from '../support/project.ts'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { after, describe, test } from 'node:test'
import { testId } from '../../src/protocol/run-folder.ts'
import { createAgentReporter } from '../../src/reporters/agent.ts'
import { createHumanReporter } from '../../src/reporters/human.ts'
import { rebuildResult } from '../../src/store/rebuild-result.ts'
import { runProject, tempProject } from '../support/project.ts'
import { eventsOfType, testNamed } from '../support/run-harness.ts'
import { capture, plain } from './reporters-fixtures.ts'

// Through the real runner and test file processes, with the fake browser: a check the host requires cannot be waived
// by test code that skips its test, and result.json says the same as a result rebuilt from the events.

const fakeJudge = fileURLToPath(new URL('../support/fake-evaluator.ts', import.meta.url))
const keyVariable = 'RETEST_UNIT_SKIPPED_JUDGE_KEY'
process.env[keyVariable] = 'sk-unit-skipped-7c2d'
after(() => {
  delete process.env[keyVariable]
})

const config = `import { chromium, defineConfig, env } from '@rehearsal-labs/retest'
export default defineConfig({
  apps: { web: chromium({ baseUrl: 'http://127.0.0.1:4173', executablePath: '/fake/chromium' }) },
  evaluation: {
    judges: { fake: { adapter: ${JSON.stringify(fakeJudge)}, credentials: { apiKey: env('${keyVariable}') }, options: { tag: 'skipped' }, accepts: ['text'] } },
    defaultJudge: 'fake',
  },
})
`

const file = 'tests/a.retest.ts'
const tests = `import { expect, test } from '@rehearsal-labs/retest'
test('runs', async () => {
  expect(1).toBe(1)
})
test.skip('skipped by the test', async () => {
  expect(1).toBe(1)
})
`
const runs = testId(file, 'runs')
const skipped = testId(file, 'skipped by the test')

function project(): string {
  return tempProject({ 'retest.config.ts': config, [file]: tests })
}

function reports(record: ProjectRecord): { human: string; agent: string } {
  const human = capture()
  const agent = capture()
  const reporters = [createHumanReporter({ stdout: human, stderr: capture(), color: false, runFolder: 'run' }), createAgentReporter({ stdout: agent, runFolder: 'run' })]
  for (const event of record.events) for (const reporter of reporters) reporter.onEvent(event)
  for (const reporter of reporters) reporter.onRunEnd(record.result)
  return { human: plain(human.text), agent: agent.text }
}

/** Checks the run cannot pass because of the check, and that every record of the run says so. */
function assertRefused(record: ProjectRecord, message: string): void {
  const { result, events } = record
  assert.equal(result.exitCode, 2)
  assert.equal(result.status, 'error')
  assert.equal(result.complete, false)
  assert.equal(result.failure?.class, 'host_check_failed')
  assert.equal(result.failure?.message, message)
  const finished = eventsOfType(events, 'run.finished')[0]
  assert.deepEqual([finished?.exitCode, finished?.failure?.message], [2, message])
  assert.equal(rebuildResult(events).failure?.message.startsWith(message), true, 'a result rebuilt from the events keeps the failure')
  assert.equal(testNamed(result, 'skipped by the test').status, 'skipped', 'the test keeps its own status')
  assert.equal(testNamed(result, 'runs').status, 'passed')
  const { human, agent } = reports(record)
  assert.ok(human.includes(message), human)
  assert.ok(agent.includes(`run failed: host_check_failed ${message}`), agent)
  assert.match(agent, /^retest: 1 passed, 1 skipped \(2\) in [^,]+, exit 2, incomplete/)
}

describe('a check the host requires of a skipped test', () => {
  test('a host check keyed to the test fails the run, exit 2, and the check stays not run', async () => {
    const record = await runProject(project(), {
      files: [file],
      hostChecks: { [skipped]: [{ kind: 'text', name: 'saved banner', text: 'Saved' }], [runs]: [{ kind: 'text', text: 'never read here', absent: true }] },
    })
    const message = `"${skipped}" is skipped, so the host's text check "saved banner" on web was not made. Test code cannot skip a check the host requires, so the run cannot pass.`
    assertRefused(record, message)
    assert.deepEqual(testNamed(record.result, 'skipped by the test').hostChecks?.map((each) => each.status), ['not_run'])
    assert.equal(record.result.failure?.location?.line, 5)
  })

  test('a required AI check the host keys to the test fails the run the same way', async () => {
    const check: HostEvaluation = { id: 'banner-saved', criteria: { pass: 'The banner says the task was saved.' }, evidence: { text: 'Saved' } }
    const record = await runProject(project(), { files: [file], hostEvaluations: { [skipped]: [check] } })
    const message = `"${skipped}" is skipped, so the host's AI check "banner-saved" was not made. Test code cannot skip a check the host requires, so the run cannot pass.`
    assertRefused(record, message)
    assert.deepEqual(testNamed(record.result, 'skipped by the test').evaluations?.map((each) => [each.checkId, each.mode, each.verdict]), [['banner-saved', 'required', 'not_run']])
  })

  test("a file's check whose only chosen test is skipped fails the run, though the file's other test ran elsewhere", async () => {
    const record = await runProject(project(), {
      files: [file],
      selection: { grep: 'skipped' },
      hostChecks: { [file]: [{ kind: 'address', origin: 'http://127.0.0.1:4173', path: '/' }] },
    })
    const message = `"${skipped}" is skipped, so the host's address check on web was not made. Test code cannot skip a check the host requires, so the run cannot pass.`
    assert.equal(record.result.exitCode, 2)
    assert.equal(record.result.failure?.class, 'host_check_failed')
    assert.equal(record.result.failure?.message, message)
    assert.deepEqual(record.result.files.flatMap((each) => each.tests).map((each) => [each.name, each.status]), [['skipped by the test', 'skipped']])
  })

  test('a skipped test the host keys nothing to leaves the run passing', async () => {
    const record = await runProject(project(), { files: [file], hostChecks: { [runs]: [{ kind: 'text', text: 'never read here', absent: true }] } })
    assert.equal(record.result.exitCode, 0, JSON.stringify(record.result.failure))
  })
})

describe('result.json and a result rebuilt from the events', () => {
  const marked = `import { expect, test } from '@rehearsal-labs/retest'
test('ordinary', async () => {
  expect(1).toBe(1)
})
test.skip('skipped', async () => {
  expect(1).toBe(1)
})
test.only('focused', async () => {
  expect(1).toBe(1)
})
test.describe.only('block', (test) => {
  test.skip('skipped inside', async () => {
    expect(1).toBe(1)
  })
  test('runs inside', async () => {
    expect(1).toBe(1)
  })
})
`
  const plain = `import { expect, test } from '@rehearsal-labs/retest'
test('in another file', async () => {
  expect(1).toBe(1)
})
`
  const markedProject = (): string => tempProject({ 'retest.config.ts': config, 'tests/a.retest.ts': marked, 'tests/b.retest.ts': plain })
  const files = ['tests/a.retest.ts', 'tests/b.retest.ts']

  function assertAgree(result: RunResult, events: readonly RetestEvent[]): void {
    const rebuilt = rebuildResult(events)
    assert.deepEqual(rebuilt.files, result.files, 'the rebuilt result lists the same tests, in the same order, the same way')
    assert.deepEqual(rebuilt.counts, result.counts)
    assert.deepEqual(rebuilt.narrowed, result.narrowed)
  }

  test('agree for a run narrowed by test.only, with skipped tests, in declaration order', async () => {
    const { result, events } = await runProject(markedProject(), { files })
    assert.equal(result.exitCode, 0, JSON.stringify(result.failure))
    assert.deepEqual(result.files.map((each) => each.tests.map((test) => [test.name, test.status])), [
      [
        ['focused', 'passed'],
        ['skipped inside', 'skipped'],
        ['runs inside', 'passed'],
      ],
      [],
    ])
    assertAgree(result, events)
  })

  test('agree for a run that refused test.only, which lists every test as not run, each skipped one as skipped', async () => {
    const { result, events } = await runProject(markedProject(), { files, forbidOnly: 'CI is set.' })
    assert.equal(result.exitCode, 2)
    assert.equal(result.narrowed, undefined)
    assert.deepEqual(result.files.map((each) => each.tests.map((test) => [test.name, test.status])), [
      [
        ['ordinary', 'not_run'],
        ['skipped', 'skipped'],
        ['focused', 'not_run'],
        ['skipped inside', 'skipped'],
        ['runs inside', 'not_run'],
      ],
      [['in another file', 'not_run']],
    ])
    assertAgree(result, events)
  })
})
