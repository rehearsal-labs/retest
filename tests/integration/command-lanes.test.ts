import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { formatSessionId } from '../../src/protocol/evidence.ts'
import { openApp } from './browser-harness.ts'
import { budgets, childLog, configSource, eventsOf, onlyEvent, onlyTest, runProject, writeProject } from './cli-harness.ts'

// A real test file process on real Chrome that speaks the protocol itself: it asks for an AI check on a screenshot of
// its app and, while the judge holds the check, clicks on that app. The parent refuses the click as the test runtime's
// own lanes would have. The fake judge stands in for a model and holds its answer for a moment.

const fakeJudge = fileURLToPath(new URL('../support/fake-evaluator.ts', import.meta.url))

const forged = `import { expect, test } from '@rehearsal-labs/retest'

let scope
const answers = new Map()

process.on('message', (message) => {
  if (typeof message !== 'object' || message === null) return
  if (message.type === 'run') scope = { testId: message.testId, attemptId: message.attemptId }
  if (message.type === 'command-result' || message.type === 'evaluation-result') answers.get(message.id)?.(message)
})

function ask(id, message) {
  return new Promise((resolve) => {
    answers.set(id, resolve)
    process.send?.({ ...message, ...scope, id })
  })
}

test('clicks while its AI check looks at the page', async ({ page }) => {
  await page.goto('/')
  const call = { criteria: [{ id: 'slow', requirement: 'The page shows the task form.' }], evidence: [{ kind: 'screenshot' }], mode: 'required' }
  const judged = ask(9201, { type: 'evaluate', call })
  await new Promise((resolve) => setTimeout(resolve, 300))
  const clicked = await ask(9202, { type: 'command', app: 'web', command: { kind: 'click', locator: { by: 'testId', value: 'save-task' } }, timeoutMs: 2000 })
  const answered = await judged
  console.log('click ' + JSON.stringify({ ok: clicked.result.ok, class: clicked.result.failure?.class }) + ' check ' + answered.answer.verdict)
  expect(1).toBe(1)
})
`

test('a click on an app while an AI check captures it is refused by the parent and fails the test', async (t) => {
  const app = await openApp(t)
  const root = await writeProject(t, {
    'retest.config.ts': configSource(`{
  apps: { web: chrome({ baseUrl: ${JSON.stringify(app.url)} }) },
  evaluation: { judges: { fake: { adapter: ${JSON.stringify(fakeJudge)}, accepts: ['text', 'images'], options: { delayMs: 1500 } } }, timeoutMs: 10000 },
}`),
    'tests/forged.retest.ts': forged,
  })
  const run = await runProject(t, root, { timeouts: budgets({ test: 30_000 }) })
  assert.equal(run.exit.code, 1, `${run.stdout}\n${run.stderr}`)
  const result = onlyTest(run)
  assert.deepEqual([result.status, result.failure?.class], ['failed', 'concurrent_commands'])
  assert.match(result.failure?.message ?? '', /sent getByTestId\('save-task'\)\.click\(\) to web while test\.evaluate\(\) was still running there, so Retest did not send it/)
  const refused = onlyEvent(run.events, 'action.failed')
  assert.deepEqual([refused.command, refused.sessionId, refused.failure.class], ['click', formatSessionId(result.attemptId, 'web'), 'concurrent_commands'])
  assert.equal(eventsOf(run.events, 'action.completed').filter((event) => event.command === 'click').length, 0, 'the click never reached the page')
  assert.equal(onlyEvent(run.events, 'evaluation.finished').evaluation.verdict, 'pass', 'the check itself ran and passed')
  assert.match(childLog(run, 'tests/forged.retest.ts'), /click \{"ok":false,"class":"concurrent_commands"\} check pass/)
})
