import type { HostEvaluation } from '../../src/protocol/evaluation.ts'
import type { RunRecord } from '../support/run-harness.ts'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { after, describe, test } from 'node:test'
import { retestEventSchema } from '../../src/protocol/events.ts'
import { testId } from '../../src/protocol/run-folder.ts'
import { parse } from '../../src/protocol/schema.ts'
import { rebuildRecordedResult } from '../../src/store/rebuild-result.ts'
import { runProject, tempProject } from '../support/project.ts'
import { eventsOfType, runSupportFiles, supportFile, testNamed } from '../support/run-harness.ts'

// Every host check and host AI check a result lists as not run is in the events too, so the result rebuilt from the
// events equals result.json field for field: after a body that failed, for a skipped test, and for a test that never ran.

const fakeJudge = fileURLToPath(new URL('../support/fake-evaluator.ts', import.meta.url))
const keyVariable = 'RETEST_UNIT_NOT_RUN_JUDGE_KEY'
process.env[keyVariable] = 'sk-unit-not-run-4b1e'
after(() => {
  delete process.env[keyVariable]
})

const config = `import { chromium, defineConfig, env } from '@rehearsal-labs/retest'
export default defineConfig({
  apps: { web: chromium({ baseUrl: 'http://127.0.0.1:4173', executablePath: '/fake/chromium' }) },
  evaluation: {
    judges: { fake: { adapter: ${JSON.stringify(fakeJudge)}, credentials: { apiKey: env('${keyVariable}') }, options: { tag: 'not-run' }, accepts: ['text'] } },
    defaultJudge: 'fake',
  },
})
`
const file = 'tests/a.retest.ts'
const source = `import { expect, test } from '@rehearsal-labs/retest'
test.only('runs', async () => {
  expect(1).toBe(1)
})
test('left out', async () => {
  expect(1).toBe(1)
})
test.skip('skipped by the test', async () => {
  expect(1).toBe(1)
})
`
const check: HostEvaluation = { id: 'banner-saved', criteria: { pass: 'The banner says the task was saved.' }, evidence: { text: 'Saved' } }

function equalRebuild(record: RunRecord): void {
  assert.ok(record.written !== undefined, 'result.json was written')
  assert.deepEqual(rebuildRecordedResult(record.events), record.written)
}

describe('a result rebuilt from the events lists the checks that never ran', () => {
  test('a body that failed leaves its host check not run, as result.json lists it', async () => {
    const failsItself = testId(supportFile('host-checks.retest.ts'), 'fails itself')
    const record = await runSupportFiles(['host-checks.retest.ts'], { hostChecks: { [failsItself]: [{ kind: 'text', text: 'Save' }] } })
    assert.deepEqual(record.written?.files[0]?.tests.find((each) => each.name === 'fails itself')?.hostChecks?.map((each) => each.status), ['not_run'])
    const finished = eventsOfType(record.events, 'test.finished').find((event) => event.testId === failsItself)
    assert.deepEqual(finished?.hostChecksNotRun?.map((each) => [each.app, each.check.kind]), [['page', 'text']])
    equalRebuild(record)
  })

  test('a skipped test lists its host check and host AI check as not run, in the events as in result.json', async () => {
    const skipped = testId(file, 'skipped by the test')
    const record = await runProject(tempProject({ 'retest.config.ts': config, [file]: source.replace('test.only', 'test') }), {
      files: [file],
      hostChecks: { [skipped]: [{ kind: 'text', text: 'Saved', app: 'web' }] },
      hostEvaluations: { [skipped]: [check] },
    })
    const result = testNamed(record.result, 'skipped by the test')
    assert.deepEqual([result.status, result.hostChecks?.map((each) => each.status), result.evaluations?.map((each) => each.verdict)], ['skipped', ['not_run'], ['not_run']])
    assert.deepEqual(eventsOfType(record.events, 'evaluation.finished').map((event) => [event.testId, event.evaluation.checkId, event.evaluation.verdict]), [[skipped, 'banner-saved', 'not_run']])
    equalRebuild(record)
  })

  test('a test that never ran lists its host check and host AI check as not run, in the events as in result.json', async () => {
    const leftOut = testId(file, 'left out')
    const record = await runProject(tempProject({ 'retest.config.ts': config, [file]: source }), {
      files: [file],
      forbidOnly: 'CI is set.',
      hostChecks: { [leftOut]: [{ kind: 'text', text: 'Saved', app: 'web' }] },
      hostEvaluations: { [leftOut]: [check] },
    })
    const result = testNamed(record.result, 'left out')
    assert.deepEqual([result.status, result.hostChecks?.map((each) => each.status), result.evaluations?.map((each) => each.verdict)], ['not_run', ['not_run'], ['not_run']])
    equalRebuild(record)
  })

  test('the new field is validated on read: a not-run entry without its app is refused', () => {
    const event = { schemaVersion: 1, runId: 'run', sequence: 1, time: new Date().toISOString(), elapsedMs: 1, origin: 'parent', type: 'test.finished', testId: 't', attemptId: 'a', status: 'skipped', durationMs: 0, assertionCount: 0, hostChecksNotRun: [{ check: { kind: 'text', text: 'Saved' } }] }
    assert.equal(parse(retestEventSchema, event).ok, false)
    assert.equal(parse(retestEventSchema, { ...event, hostChecksNotRun: [{ check: { kind: 'text', text: 'Saved' }, app: 'web' }] }).ok, true)
  })
})
