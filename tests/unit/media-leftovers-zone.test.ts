import assert from 'node:assert/strict'
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { tempProject } from '../support/project.ts'
import { newRunFolder } from '../support/run-harness.ts'
import { unpinnedMedia } from '../support/unpinned-host.ts'
import { endedPid } from './native-fake-tools.ts'
import { fakeMediaStarter, recordProject } from './runner-recording-fakes.ts'

test('a media sweep reports an unmarked live owner and leaves its run and outputs alone', { skip: unpinnedMedia }, async () => {
  const root = tempProject({ 'retest.config.ts': `import { chromium, defineConfig } from '@rehearsal-labs/retest'; export default defineConfig({apps:{web:chromium({baseUrl:'http://127.0.0.1:4173',executablePath:'/fake/chrome'})},recording:{record:true}})`, 'tests/one.retest.ts': `import { expect,test } from '@rehearsal-labs/retest'; test('one', async({page})=>{await page.goto('/');await expect(page.getByTestId('save-task')).toBeVisible()})` })
  const previous = await recordProject(root, { files: ['tests/one.retest.ts'], startMedia: fakeMediaStarter().start })
  const current = newRunFolder()
  const old = join(dirname(current), 'legacy')
  renameSync(previous.folder, old)
  rmSync(join(old, 'result.json'))
  const original = previous.events.map(event => JSON.stringify(event.type === 'media.started' ? { ...event, media: { ...event.media, owner: { pid: process.pid, startedAt: 'Thu Jan 1 00:00:00 1970' } } } : event)).join('\n') + '\n'
  writeFileSync(join(old, 'events.jsonl'), original)
  const fake = fakeMediaStarter()
  const run = await recordProject(root, { files: ['tests/one.retest.ts'], startMedia: fake.start, folder: current })
  assert.deepEqual(fake.started[0]?.leftoverRequests, [])
  const notes = run.events.filter(event => event.type === 'media.leftovers')
  assert.equal(notes.length, 1)
  assert.match(JSON.stringify(notes), /cannot confirm.*time zone/)
  assert.ok(JSON.stringify(notes).includes(`Remove ${join(old, 'events.jsonl')} once no runner is running.`))
  assert.equal(readFileSync(join(old, 'events.jsonl'), 'utf8'), original)
  const pid = await endedPid()
  writeFileSync(join(old, 'events.jsonl'), previous.events.map(event => JSON.stringify(event.type === 'media.started' ? { ...event, media: { ...event.media, owner: { pid, startedAt: 'Thu Jan 1 00:00:00 1970' } } } : event)).join('\n') + '\n')
  const recovered = fakeMediaStarter({ leftovers: output => ({ type: 'leftovers', requestId: 'l', status: 'ok', output, files: [{ path: `${output}.mp4.partial`, kind: 'video_partial', byteLength: 512 }], removed: true, skipped: [] }) })
  const swept = Promise.withResolvers<void>()
  const next = await recordProject(root, {
    files: ['tests/one.retest.ts'], startMedia: recovered.start, folder: join(dirname(current), 'after-absence'),
    onEvent: event => { if (event.type === 'media.leftovers' && event.status === 'ok') swept.resolve() },
    fake: { holdAnswer: async command => {
      if (command.kind !== 'goto') return
      const bound = setTimeout(() => swept.reject(new Error('the absent legacy owner never produced a leftover observation')), 1000)
      try { await swept.promise } finally { clearTimeout(bound) }
    } },
  })
  const recording = previous.events.find(event => event.type === 'recording.started')
  assert.ok(recording?.type === 'recording.started')
  assert.deepEqual(recovered.started[0]?.leftoverRequests, [{ output: join(old, recording.path.replace(/\.mp4$/, '')), remove: true }])
  assert.equal(next.result.files[0]?.tests[0]?.status, 'passed')
  assert.equal(next.events.filter(event => event.type === 'media.leftovers' && event.status === 'ok').length, 1)
})
