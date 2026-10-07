import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { FakePage } from '../support/fake-browser.ts'
import { fakeCalls } from '../support/fake-evaluator.ts'
import { runProject, tempProject } from '../support/project.ts'
import { eventsOfType } from '../support/run-harness.ts'

const fakeJudge = fileURLToPath(new URL('../support/fake-evaluator.ts', import.meta.url))
const png = readFileSync(new URL('../../fixtures/evaluation-corpus/captures/screenshots/chromium-saved.png', import.meta.url))

test('a run without recording applies the secret pixel policy before an evaluation screenshot', async (t) => {
  let screenshots = 0
  const screenshot = FakePage.prototype.screenshot
  FakePage.prototype.screenshot = async () => { screenshots++; return png.slice() }
  t.after(() => { FakePage.prototype.screenshot = screenshot })
  const tag = 'closeout-secret-policy'
  const root = tempProject({
    'retest.config.ts': `import { chromium, defineConfig, env } from '@rehearsal-labs/retest'
      export default defineConfig({
        apps: { web: chromium({ baseUrl: 'http://127.0.0.1:4173', executablePath: '/fake/chromium' }) },
        secrets: { password: env('RETEST_CLOSEOUT_PASSWORD') },
        evaluation: { judges: { fake: { adapter: ${JSON.stringify(fakeJudge)}, options: { tag: '${tag}' }, accepts: ['images'] } } },
      })`,
    'tests/secret.retest.ts': `import { secret, test } from '@rehearsal-labs/retest'
      test('secret screenshot', async ({ page }) => {
        await page.goto('/')
        await page.getByTestId('task-title').fill(secret('password'))
        await test.evaluate({ requirement: { pass: 'The page shows a saved state.' }, evidence: { capture: 'screenshot' } })
      })`,
  })
  const run = await runProject(root, { files: ['tests/secret.retest.ts'], env: { RETEST_CLOSEOUT_PASSWORD: randomUUID() } })
  const result = run.result.files[0]?.tests[0]
  const evaluation = result?.evaluations?.[0]
  assert.ok(evaluation !== undefined, `${result?.failure?.class}: ${result?.failure?.message}`)
  assert.equal(evaluation.verdict, 'error')
  assert.match(result?.evaluations?.[0]?.failure?.message ?? '', /withheld|secret/i)
  assert.equal(run.result.exitCode, 2)
  assert.equal(screenshots, 0, 'neither evaluation nor failure capture reads pixels while withheld')
  assert.equal(fakeCalls.filter((call) => call.tag === tag).length, 0)
  assert.equal(eventsOfType(run.events, 'capture.withheld').length, 1)
  assert.equal(eventsOfType(run.events, 'recording.started').length, 0)
})
