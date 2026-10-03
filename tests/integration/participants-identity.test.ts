import type { TestContext } from 'node:test'
import type { ExecutionRecord } from '../../src/protocol/execution.ts'
import type { FinishedRun, HostRun } from './cli-harness.ts'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { openApp } from './browser-harness.ts'
import { browserVersion, budgets, configSource, eventsOf, hostScript, runHost, runProject, secondBrowserPath, testNamed, writeProject } from './cli-harness.ts'

// Release 1, the identity of an executed test on real Chrome: the bundle the test file's process loaded and the
// configuration it ran under, each with its fingerprint, in `test.started` of events.jsonl and in result.json; and a
// host's requirement, whose checks keep their ids, through a fixed test that passes on a correct app, fails at the
// intended check on a broken one and passes again once the app is repaired.

const fakeJudge = fileURLToPath(new URL('../support/fake-evaluator.ts', import.meta.url))
const file = 'tests/saves.retest.ts'
const name = 'saves a task'

const tests = `import { expect, test } from '@rehearsal-labs/retest'
import { taskTitle } from './helpers/titles.ts'

test('${name}', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('task-title').fill(taskTitle)
  await page.getByTestId('save-task').click()
  await expect(page.getByTestId('saved-task')).toContainText('Release')
})
`

function config(url: string, target: string, options: string): string {
  return configSource(`{
  apps: { web: ${target}({ baseUrl: ${JSON.stringify(url)} }) },
  evaluation: { judges: { fake: { adapter: ${JSON.stringify(fakeJudge)}, options: ${options}, accepts: ['text', 'images'] } } },
}`)
}

function executionOf(run: FinishedRun): ExecutionRecord {
  const result = testNamed(run, name)
  const started = eventsOf(run.events, 'test.started').find((event) => event.attemptId === result.attemptId)
  assert.ok(started?.execution !== undefined, 'test.started in events.jsonl carries the execution record')
  assert.deepEqual(result.execution, started.execution, 'result.json carries the same record')
  return started.execution
}

async function cliRun(t: TestContext, root: string, timeouts = budgets(), env: Readonly<Record<string, string>> = {}): Promise<FinishedRun> {
  const run = await runProject(t, root, { timeouts, env })
  assert.equal(run.exit.code, 0, run.stderr)
  return run
}

test('the bundle and configuration fingerprints change with a helper, a budget or a target, and not with an unrelated file or a judge the test never uses', async (t) => {
  const app = await openApp(t)
  const root = await writeProject(t, {
    'retest.config.ts': config(app.url, 'chrome', `{ tag: 'first' }`),
    [file]: tests,
    'tests/helpers/titles.ts': `export const taskTitle = 'Release checklist'\n`,
    'tests/helpers/unrelated.ts': `export const other = 'never imported'\n`,
  })
  const first = executionOf(await cliRun(t, root))
  assert.deepEqual(first.bundle?.modules.map((module) => module.path), ['tests/helpers/titles.ts', file], 'the test file and the helper it imports, nothing else')
  assert.equal(first.sessions[0]?.product, 'Chrome')
  assert.equal(first.sessions[0]?.version, browserVersion('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'), 'the browser as it reported itself')
  assert.equal(first.runtime.node, process.version)
  assert.deepEqual(first.unavailable, ['app-build:web'], 'the command line names no app build, and the record says so')

  writeFileSync(join(root, 'tests/helpers/unrelated.ts'), `export const other = 'changed, and still never imported'\n`)
  const unrelated = executionOf(await cliRun(t, root))
  assert.equal(unrelated.bundle?.sha256, first.bundle?.sha256, 'a file the test never loaded changes nothing')
  assert.equal(unrelated.configuration.sha256, first.configuration.sha256)

  writeFileSync(join(root, 'tests/helpers/titles.ts'), `export const taskTitle = 'Release checklist v2'\n`)
  const helper = executionOf(await cliRun(t, root))
  assert.notEqual(helper.bundle?.sha256, first.bundle?.sha256, 'a changed helper changes the bundle')
  assert.equal(helper.configuration.sha256, first.configuration.sha256, 'and not the configuration')

  const budget = executionOf(await cliRun(t, root, budgets({ assertion: 2500 })))
  assert.notEqual(budget.configuration.sha256, first.configuration.sha256, 'a changed budget changes the configuration')
  assert.equal(budget.bundle?.sha256, helper.bundle?.sha256)

  writeFileSync(join(root, 'retest.config.ts'), config(app.url, 'chrome', `{ tag: 'second' }`))
  const option = executionOf(await cliRun(t, root))
  assert.equal(option.configuration.sha256, helper.configuration.sha256, 'a judge this test never uses is not part of its configuration')

  writeFileSync(join(root, 'retest.config.ts'), config(app.url, 'chromium', `{ tag: 'second' }`))
  const target = executionOf(await cliRun(t, root, budgets(), { RETEST_CHROMIUM: secondBrowserPath() }))
  assert.notEqual(target.configuration.sha256, option.configuration.sha256, 'a changed target changes the configuration')
  assert.equal(target.sessions[0]?.version, browserVersion(secondBrowserPath()))
})

// A host program whose app, app build, frozen requirement and check text come from its environment, so one program
// runs the same test against each app.
function replayHost(): string {
  const configText = `{
  apps: { web: chrome({ baseUrl: process.env['APP_URL'] ?? '' }) },
  evaluation: { judges: { fake: { adapter: './judges/fake.ts', accepts: ['text', 'images'] } } },
}`
  const options = `appBuilds: { web: process.env['APP_BUILD'] ?? '' },
    requirement: { version: 'saves-v1', ...(process.env['FROZEN'] === undefined ? {} : { checks: JSON.parse(process.env['FROZEN']) }) },
    hostChecks: { ${JSON.stringify(file)}: [{ kind: 'text', id: 'saved-title', text: process.env['CHECK_TEXT'] ?? 'Release checklist' }] },
    hostEvaluations: { ${JSON.stringify(file)}: [{ id: 'saved-reads-well', criteria: { pass: 'The saved task shows its title.' }, evidence: { capture: 'screenshot' } }] },`
  return hostScript({ config: configText, files: [file], options })
}

test('a fixed test passes on a correct app, fails at its intended required check on a broken one and passes after the repair, its identities unchanged and the app build recorded', async (t) => {
  const correct = await openApp(t)
  const broken = await openApp(t, { mode: 'broken' })
  const repaired = await openApp(t)
  const root = await writeProject(t, {
    'package.json': '{ "type": "module" }\n',
    'host.ts': replayHost(),
    'judges/fake.ts': `export { default } from ${JSON.stringify(fakeJudge)}\n`,
    [file]: tests,
    'tests/helpers/titles.ts': `export const taskTitle = 'Release checklist'\n`,
  })
  const host = (env: Record<string, string>): Promise<HostRun> => runHost(t, { cwd: root, command: [process.execPath, '--conditions=retest-source', 'host.ts'], env })

  const first = await host({ APP_URL: correct.url, APP_BUILD: 'build-1-correct' })
  assert.equal(first.exit.code, 0, first.stderr)
  const requirement = eventsOf(first.events, 'run.started')[0]?.options.requirement
  assert.deepEqual(requirement?.checks.map((check) => [check.id, check.kind]), [
    ['saved-reads-well', 'evaluation'],
    ['saved-title', 'page'],
  ])
  const frozen = JSON.stringify(Object.fromEntries((requirement?.checks ?? []).map((check) => [check.id, check.sha256])))

  const defect = await host({ APP_URL: broken.url, APP_BUILD: 'build-2-broken', FROZEN: frozen })
  assert.equal(defect.exit.code, 1, 'a reproduced defect is an ordinary failed test with a nonzero exit')
  const failed = testNamed(defect, name)
  assert.equal(failed.status, 'failed')
  assert.deepEqual(failed.ending, { kind: 'required_check_failed', checkId: 'saved-title', notRun: ['saved-reads-well'] }, 'it failed at the intended check, and the check after it never ran')
  assert.equal(failed.failure?.details?.['checkId'], 'saved-title')
  assert.deepEqual(failed.hostChecks?.map((check) => [check.check.id, check.status]), [['saved-title', 'failed']])
  assert.deepEqual(failed.evaluations?.map((record) => [record.checkId, record.verdict]), [['saved-reads-well', 'not_run']])
  const shot = failed.evidence[0]
  assert.equal(shot?.sessionId, `${failed.attemptId}:web`, 'the failure screenshot belongs to this attempt and its session')

  const fixed = await host({ APP_URL: repaired.url, APP_BUILD: 'build-3-repaired', FROZEN: frozen })
  assert.equal(fixed.exit.code, 0, fixed.stderr)
  const passed = testNamed(fixed, name)
  assert.deepEqual(passed.ending, { kind: 'passed' })
  assert.deepEqual(passed.evaluations?.map((record) => [record.checkId, record.verdict]), [['saved-reads-well', 'pass']])

  const records = [testNamed(first, name), failed, passed].map((result) => result.execution)
  for (const record of records) assert.ok(record !== undefined)
  const [one, two, three] = records
  assert.equal(two?.bundle?.sha256, one?.bundle?.sha256, 'the same test source and helpers')
  assert.equal(three?.bundle?.sha256, one?.bundle?.sha256)
  assert.equal(two?.configuration.sha256, one?.configuration.sha256, 'the same configuration, though the app moved')
  assert.equal(three?.configuration.sha256, one?.configuration.sha256)
  assert.equal(two?.requirement?.sha256, one?.requirement?.sha256, 'the same requirement')
  assert.equal(three?.requirement?.sha256, one?.requirement?.sha256)
  assert.deepEqual(records.map((record) => record?.appBuilds?.['web']), ['build-1-correct', 'build-2-broken', 'build-3-repaired'], 'only the app build changed')

  const weakened = await host({ APP_URL: repaired.url, APP_BUILD: 'build-3-repaired', FROZEN: frozen, CHECK_TEXT: 'Release' })
  assert.equal(weakened.exit.code, 2, 'a changed check under its frozen id is refused')
  assert.match(weakened.returned.failure?.message ?? '', /"saved-title" changed since the requirement "saves-v1" froze it/)
  assert.deepEqual(eventsOf(weakened.events, 'browser.started'), [], 'and nothing started')

  // The evaluator's own code changes: the judge's adapter is edited.
  writeFileSync(join(root, 'judges/fake.ts'), `// A new revision of the judge.\nexport { default } from ${JSON.stringify(fakeJudge)}\n`)
  const newJudge = await host({ APP_URL: repaired.url, APP_BUILD: 'build-3-repaired' })
  assert.equal(newJudge.exit.code, 0, newJudge.stderr)
  const judged = testNamed(newJudge, name).execution
  assert.notEqual(judged?.configuration.sha256, three?.configuration.sha256, "an edited judge adapter changes the configuration")
  assert.notEqual(judged?.configuration.settings.evaluation?.judges[0]?.moduleSha256, three?.configuration.settings.evaluation?.judges[0]?.moduleSha256)
  const refused = await host({ APP_URL: repaired.url, APP_BUILD: 'build-3-repaired', FROZEN: frozen })
  assert.equal(refused.exit.code, 2, 'and the AI check it judges is no longer the frozen one')
  assert.match(refused.returned.failure?.message ?? '', /"saved-reads-well" changed since the requirement "saves-v1" froze it/)
})
