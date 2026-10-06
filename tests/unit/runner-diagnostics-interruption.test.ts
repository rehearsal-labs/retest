import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatSessionId } from '../../src/protocol/evidence.ts'
import { runProject, tempProject } from '../support/project.ts'

for (const capture of [true, false]) {
  test(`interrupted opening names every prepared web session, capture ${capture}`, async () => {
    const root = tempProject({
      'retest.config.ts': `import { chromium, defineConfig } from '@rehearsal-labs/retest'; export default defineConfig({ apps: { web: chromium({baseUrl:'http://127.0.0.1:4173',executablePath:'/fake/chrome'}), admin: chromium({baseUrl:'http://127.0.0.1:4173',executablePath:'/fake/chrome'}) }, diagnostics: { capture: ${capture}, requireComplete: ${capture} } })`,
      'tests/one.retest.ts': `import { expect, test } from '@rehearsal-labs/retest'; test('one', { apps: ['web', 'admin'] }, () => expect(1).toBe(1))`,
    })
    const controller = new AbortController()
    const reason = { class: 'interrupted', message: 'stopped while opening' } as const
    let openings = 0
    const run = await runProject(root, { files: ['tests/one.retest.ts'], signal: controller.signal, fake: { holdOpening: async () => { openings++; controller.abort(reason) } } })
    const stopped = run.result.files[0]?.tests[0] ?? assert.fail('one interrupted test')
    assert.equal(openings, 1, 'no second page is opened after cancellation')
    assert.equal(run.result.exitCode, 130)
    assert.equal(stopped.status, 'error')
    assert.deepEqual(stopped.failure, reason)
    const state = capture ? { state: 'unavailable', reason: 'the run was interrupted before capture started' } : { state: 'disabled' }
    const summaries = ['web', 'admin'].map(app => ({ app, sessionId: formatSessionId(stopped.attemptId, app), console: state, network: state }))
    assert.deepEqual(stopped.diagnostics, summaries)
    assert.deepEqual(run.events.filter(event => event.type === 'diagnostics.started'), [])
    const finished = run.events.filter(event => event.type === 'diagnostics.finished')
    assert.deepEqual(finished.map(event => event.diagnostics), summaries)
    assert.ok(finished.every(event => event.testId === stopped.testId && event.attemptId === stopped.attemptId && event.session === event.diagnostics.app && event.sessionId === event.diagnostics.sessionId))
    assert.ok(run.browsers.every(browser => !browser.connected))
    assert.deepEqual(run.written, run.result)
  })
}
