import assert from 'node:assert/strict'
import { test } from 'node:test'
import { unpinnedMedia } from '../support/unpinned-host.ts'
import { worker } from './media-client-fixtures.ts'


const start = { recordingId: 'requested-recording', identity: { runId: 'run', attemptId: 'attempt', testId: 'test', app: 'web', sessionId: 'session' }, output: '/requested/video', width: 8, height: 8, fps: 10, deadlineMs: 1000 }
for (const mode of ['ended-identity', 'ended-path', 'ended-id', 'started-identity', 'started-path', 'started-id']) {
  test(`a ${mode} reply is a protocol failure rather than foreign evidence`, async t => {
    const media = await worker(t, mode)
    await assert.rejects(media.record(start, 2000), /media protocol|identity|path|never (asked|started)/i)
  })
}
test('a frames reply for another recording fails the requested job', async t => {
  const media = await worker(t, 'frames-id')
  await assert.rejects(media.frames(start.recordingId, { fromUs: 1, toUs: 2, maxFrames: 1, maxWidth: 8, maxHeight: 8 }, 2000), /recording|protocol/i)
})


test("the hostile ended reply cannot attach another attempt's existing video inside the same run folder", async t => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const folder = await mkdtemp(join(tmpdir(), 'retest-hostile-ended-'))
  t.after(() => rm(folder, { recursive: true, force: true }))
  await writeFile(join(folder, 'foreign.mp4'), 'foreign nonempty video')
  const media = await worker(t, 'ended-hostile')
  await assert.rejects(media.record({ ...start, output: join(folder, 'requested') }, 2000), /requested identity|requested output/)
})

test("a hostile ended reply leaves the runner's passed test intact with unavailable recording evidence", { skip: unpinnedMedia }, async t => {
  const { tempProject } = await import('../support/project.ts')
  const { recordProject } = await import('./runner-recording-fakes.ts')
  const root = tempProject({ 'retest.config.ts': `import {chromium,defineConfig} from '@rehearsal-labs/retest';export default defineConfig({apps:{web:chromium({baseUrl:'http://127.0.0.1:4173',executablePath:'/fake/chrome'})},recording:{record:true}})`, 'tests/one.retest.ts': `import {test,expect} from '@rehearsal-labs/retest';test('one',async({page})=>{await page.goto('/');await expect(page.getByTestId('save-task')).toBeVisible()})` })
  const run = await recordProject(root, { files: ['tests/one.retest.ts'], startMedia: () => worker(t, 'running-hostile') })
  const result = run.result.files[0]?.tests[0]
  assert.equal(result?.status, 'passed')
  assert.equal(result?.recordings?.[0]?.status, 'unavailable')
  assert.equal(result?.recordings?.[0]?.path, undefined)
  assert.match(result?.recordings?.[0]?.gaps.map(gap => gap.message).join(' ') ?? '', /requested identity/)
})
