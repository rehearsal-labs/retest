import assert from 'node:assert/strict'
import fsPromises from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { test } from 'node:test'
import { locateMedia } from '../../src/media/locate.ts'
import { RunMedia } from '../../src/runner/run-media.ts'
import { newRunFolder } from '../support/run-harness.ts'
import { tempProject } from '../support/project.ts'
import { unpinnedMedia } from '../support/unpinned-host.ts'
import { fakeMediaStarter, recordProject } from './runner-recording-fakes.ts'

// How long discovery may take to reach its inspection of the cache before the case fails rather than waits forever.
const inspectionStartMs = 5000

for (const mode of ['deadline', 'cancellation'] as const) {
  // A machine with no pinned media target refuses discovery before it inspects anything, so there is nothing to bound.
  test(`media discovery bounds inspection by the caller's ${mode}`, { skip: unpinnedMedia }, async t => {
    const original = fsPromises.lstat
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const finished = Promise.withResolvers<void>()
    let completed = false
    t.mock.method(fsPromises, 'lstat', async (...args: Parameters<typeof original>) => {
      entered.resolve()
      await release.promise
      try { return await original(...args) } finally { completed = true; finished.resolve() }
    })
    syncBuiltinESMExports()
    t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
    const controller = new AbortController()
    const options = { env: { HOME: '/nonexistent-bounded-media-home', PATH: '' }, mode: 'discover' as const, timeoutMs: 10, signal: controller.signal }
    const pending = locateMedia(options)
    const entering = setTimeout(() => entered.reject(new Error(`media discovery never inspected the cache: fs.promises.lstat was not called within ${inspectionStartMs} ms`)), inspectionStartMs)
    try { await entered.promise } finally { clearTimeout(entering) }
    if (mode === 'cancellation') controller.abort()
    // Keeps the pre-change reproduction finite; success must arrive before this fixture releases inspection.
    const fallback = setTimeout(() => release.resolve(), 100)
    try {
      const found = await pending
      assert.ok(!found.ok)
      assert.match(found.message, mode === 'deadline' ? /deadline|budget|timed out/ : /stopped|cancel/)
      assert.equal(completed, false)
    } finally {
      clearTimeout(fallback)
      release.resolve()
      await finished.promise
    }
  })
}

test('runner shutdown cancels media discovery in progress and starts no process', async () => {
  const entered = Promise.withResolvers<void>()
  let cancelled = false
  let starts = 0
  let fallback: ReturnType<typeof setTimeout> | undefined
  const media = new RunMedia({ location: (signal?: AbortSignal) => new Promise(resolve => {
    entered.resolve()
    const stop = (): void => { cancelled = true; clearTimeout(fallback); resolve('Discovery was stopped.') }
    signal?.addEventListener('abort', stop, { once: true })
    fallback = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve('Discovery was not cancelled.') }, 100)
  }), start: () => { starts++; return Promise.reject(new Error('no process may start')) }, emit: () => undefined, timeouts: { start: 1000, close: 100, leftovers: 100 }, runFolder: newRunFolder() })
  const acquired = media.acquire()
  await entered.promise
  try {
    assert.equal(await media.close(), undefined)
    assert.equal(cancelled, true)
    assert.ok(!(await acquired).ok)
    assert.equal(starts, 0)
  } finally { clearTimeout(fallback) }
})

test('a run interruption cancels its in-progress discovery before a media process or capture starts', async () => {
  const root = tempProject({
    'retest.config.ts': `import {chromium,defineConfig} from '@rehearsal-labs/retest';export default defineConfig({apps:{web:chromium({baseUrl:'http://127.0.0.1:4173',executablePath:'/fake/chrome'})},recording:{record:true}})`,
    'tests/one.retest.ts': `import {test} from '@rehearsal-labs/retest';test('one',async({page})=>{await page.goto('/')})`,
  })
  const controller = new AbortController()
  const fake = fakeMediaStarter()
  let cancelled = false
  let fallback: ReturnType<typeof setTimeout> | undefined
  try {
    const run = await recordProject(root, { files: ['tests/one.retest.ts'], signal: controller.signal, startMedia: fake.start,
      discoverMedia: (_given, _env, _timeoutMs, signal) => new Promise(resolve => {
        const stop = (): void => { cancelled = true; clearTimeout(fallback); resolve('Discovery was stopped.') }
        signal?.addEventListener('abort', stop, { once: true })
        fallback = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve('Discovery was not cancelled.') }, 100)
        controller.abort('SIGINT')
      }),
    })
    assert.equal(cancelled, true)
    assert.equal(run.result.exitCode, 130)
    assert.equal(fake.started.length, 0)
    assert.equal(run.browsers.flatMap(browser => browser.framed.flatMap(page => page.sources)).length, 0)
    assert.equal(run.result.files[0]?.tests[0]?.recordings?.[0]?.status, 'unavailable')
  } finally { clearTimeout(fallback) }
})
