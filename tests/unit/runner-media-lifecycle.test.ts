import type { EventBody } from '../../src/protocol/events.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { RunMedia } from '../../src/runner/run-media.ts'
import { newRunFolder } from '../support/run-harness.ts'
import { unpinnedMedia } from '../support/unpinned-host.ts'
import { endedPid } from './native-fake-tools.ts'
import { fakeMediaStarter } from './runner-recording-fakes.ts'

function runner(options: Parameters<typeof fakeMediaStarter>[0] = {}, closeFails = false) {
  const fake = fakeMediaStarter(options)
  const events: EventBody[] = []
  const media = new RunMedia({ location: { executable: '/fake/media' }, start: async (location, timeoutMs) => { const process = await fake.start(location, timeoutMs); if (closeFails) process.close = () => Promise.reject(new Error('ownership could not confirm the encoder gone')); return process }, emit: event => void events.push(event), timeouts: { start: 30, close: 30, leftovers: 30 }, runFolder: newRunFolder() })
  return { media, fake, events }
}

test('an encoder refusal remains a refusal for every later recording', { skip: unpinnedMedia }, async () => {
  const { media, fake } = runner({ encoder: { state: 'failed', message: 'encoder unavailable', probeMs: 0 } })
  assert.equal((await media.acquire()).ok, false)
  assert.equal((await media.acquire()).ok, false)
  assert.equal(fake.started.length, 1)
  assert.equal(await media.close(), undefined)
})

test('a failed close after an encoder refusal survives into run cleanup', { skip: unpinnedMedia }, async () => {
  const { media } = runner({ encoder: { state: 'failed', message: 'encoder unavailable', probeMs: 0 } }, true)
  await media.acquire()
  assert.equal((await media.close())?.class, 'cleanup_failed')
})

test('a finished recording whose file is missing remains unavailable', { skip: unpinnedMedia }, async () => {
  const { rmSync } = await import('node:fs')
  const { tempProject } = await import('../support/project.ts')
  const { recordProject } = await import('./runner-recording-fakes.ts')
  const root = tempProject({ 'retest.config.ts': `import { chromium, defineConfig } from '@rehearsal-labs/retest'; export default defineConfig({apps:{web:chromium({baseUrl:'http://127.0.0.1:4173',executablePath:'/fake/chrome'})},recording:{record:true}})`, 'tests/one.retest.ts': `import { expect,test } from '@rehearsal-labs/retest'; test('one', async({page})=>{await page.goto('/');await expect(page.getByTestId('save-task')).toBeVisible()})` })
  const fake = fakeMediaStarter()
  const run = await recordProject(root, { files: ['tests/one.retest.ts'], startMedia: async (location, timeoutMs) => {
    const process = await fake.start(location, timeoutMs)
    const record = process.record.bind(process)
    process.record = async (start, timeoutMs) => {
      const begun = await record(start, timeoutMs)
      assert.equal(begun.kind, 'started')
      assert.ok(begun.kind === 'started')
      const finish = begun.recording.finish.bind(begun.recording)
      begun.recording.finish = async (timeout, end) => { const ended = await finish(timeout, end); rmSync(begun.recording.started.path, {force:true}); return ended }
      return begun
    }
    return process
  } })
  const result = run.result.files[0]?.tests[0]
  assert.equal(result?.status, 'passed')
  assert.equal(result?.recordings?.[0]?.status, 'unavailable')
  assert.equal(result?.recordings?.[0]?.gaps[0]?.code, 'output_failed')
})

test('an encoder probe that never answers cannot hold startup or shutdown', { skip: unpinnedMedia }, async () => {
  const fake = fakeMediaStarter()
  const media = new RunMedia({ location: { executable: '/fake/media' }, start: async (location, timeoutMs) => { const process = await fake.start(location, timeoutMs); process.ready = () => new Promise(() => undefined); return process }, emit: () => undefined, timeouts: { start: 20, close: 20, leftovers: 20 }, runFolder: newRunFolder() })
  const timer = Promise.withResolvers<'hung'>()
  const handle = setTimeout(() => timer.resolve('hung'), 1000)
  try {
    const acquired = await Promise.race([media.acquire(), timer.promise])
    assert.notEqual(acquired, 'hung')
    assert.ok(typeof acquired !== 'string' && !acquired.ok)
    assert.equal(await media.close(), undefined)
    assert.equal(fake.started[0]?.closes, 1)
  } finally { clearTimeout(handle) }
})

test('a source factory failure leaves the test verdict intact and names missing capture', { skip: unpinnedMedia }, async t => {
  const { tempProject } = await import('../support/project.ts')
  const { FramedPage, recordProject } = await import('./runner-recording-fakes.ts')
  t.mock.method(FramedPage.prototype, 'frameSource', () => { throw new Error('target capture refused') })
  const root = tempProject({ 'retest.config.ts': `import { chromium, defineConfig } from '@rehearsal-labs/retest'; export default defineConfig({apps:{web:chromium({baseUrl:'http://127.0.0.1:4173',executablePath:'/fake/chrome'})},recording:{record:true}})`, 'tests/one.retest.ts': `import { expect,test } from '@rehearsal-labs/retest'; test('one', async({page})=>{await page.goto('/');await expect(page.getByTestId('save-task')).toBeVisible()})` })
  const media = fakeMediaStarter()
  const run = await recordProject(root, { files: ['tests/one.retest.ts'], startMedia: media.start })
  assert.equal(run.result.files[0]?.tests[0]?.status, 'passed')
  assert.equal(run.result.files[0]?.tests[0]?.recordings?.[0]?.gaps[0]?.code, 'capture_unavailable')
  assert.equal(media.started[0]?.closes, 1)
})

test('a media worker is restarted once and a second loss refuses later recordings', { skip: unpinnedMedia }, async () => {
  const { media, fake, events } = runner()
  const first = await media.acquire()
  assert.ok(first.ok)
  fake.started[0]?.crash()
  await Promise.resolve()
  const second = await media.acquire()
  assert.ok(second.ok)
  assert.notEqual(first.process.pid, second.process.pid)
  fake.started[1]?.crash()
  await Promise.resolve()
  const third = await media.acquire()
  assert.ok(!third.ok)
  assert.equal(third.code, 'media_process_lost')
  assert.equal(fake.started.length, 2)
  assert.deepEqual(events.flatMap(event => event.type === 'media.lost' ? [event.restart] : []), [true, false])
  assert.equal(await media.close(), undefined)
  assert.deepEqual(fake.started.map(process => process.closes), [1, 1])
})

test('a synchronous encoder probe failure refuses recording and still closes its worker', { skip: unpinnedMedia }, async () => {
  const fake = fakeMediaStarter()
  const media = new RunMedia({ location: { executable: '/fake/media' }, start: async (location, timeoutMs) => { const process = await fake.start(location, timeoutMs); process.ready = () => { throw new Error('probe failed synchronously') }; return process }, emit: () => undefined, timeouts: { start: 20, close: 20, leftovers: 20 }, runFolder: newRunFolder() })
  const acquired = await media.acquire()
  assert.ok(!acquired.ok)
  assert.equal(acquired.code, 'encoder_unavailable')
  assert.equal(await media.close(), undefined)
  assert.equal(fake.started[0]?.closes, 1)
})

test('a synchronous close failure remains a recorded cleanup failure', { skip: unpinnedMedia }, async () => {
  const { media, fake, events } = runner()
  await media.acquire()
  const process = fake.started[0]
  assert.ok(process)
  process.close = () => { throw new Error('owned worker could not close') }
  assert.equal((await media.close())?.class, 'cleanup_failed')
  assert.ok(events.some(event => event.type === 'media.closed' && event.forced && event.problems?.length === 1))
})

test('a leftover request that never answers cannot hold media shutdown', { skip: unpinnedMedia }, async () => {
  const { dirname, join } = await import('node:path')
  const { renameSync, rmSync, writeFileSync } = await import('node:fs')
  const { tempProject } = await import('../support/project.ts')
  const { recordProject } = await import('./runner-recording-fakes.ts')
  const root = tempProject({ 'retest.config.ts': `import { chromium, defineConfig } from '@rehearsal-labs/retest'; export default defineConfig({apps:{web:chromium({baseUrl:'http://127.0.0.1:4173',executablePath:'/fake/chrome'})},recording:{record:true}})`, 'tests/one.retest.ts': `import { expect,test } from '@rehearsal-labs/retest'; test('one', async({page})=>{await page.goto('/');await expect(page.getByTestId('save-task')).toBeVisible()})` })
  const previous = await recordProject(root, { files: ['tests/one.retest.ts'], startMedia: fakeMediaStarter().start })
  const current = newRunFolder()
  const old = join(dirname(current), 'old')
  renameSync(previous.folder, old)
  rmSync(join(old, 'result.json'))
  const goneOwner = await endedPid()
  writeFileSync(join(old, 'events.jsonl'), previous.events.map(event => JSON.stringify(event.type === 'media.started' ? { ...event, media: { ...event.media, owner: { startTimeVersion: 1, pid: goneOwner, startedAt: 'Thu Jan 1 00:00:00 1970' } } } : event)).join('\n') + '\n')
  const requested = Promise.withResolvers<void>()
  const fake = fakeMediaStarter()
  const media = new RunMedia({ location: { executable: '/fake/media' }, start: async (location, budget) => {
    const process = await fake.start(location, budget)
    process.leftovers = () => { requested.resolve(); return new Promise(() => undefined) }
    return process
  }, emit: () => undefined, timeouts: { start: 1000, close: 20, leftovers: 20 }, runFolder: current })
  await media.acquire()
  const timer = setTimeout(() => requested.reject(new Error('the owned leftover request never started')), 1000)
  try { await requested.promise } finally { clearTimeout(timer) }
  const finished = Promise.withResolvers<'hung'>()
  const bound = setTimeout(() => finished.resolve('hung'), 1500)
  try { assert.equal(await Promise.race([media.close(), finished.promise]), undefined) }
  finally { clearTimeout(bound) }
  assert.equal(fake.started[0]?.closes, 1)
})

test('recording start retains the actual capture mode when availability changes after start', { skip: unpinnedMedia }, async t => {
  const { tempProject } = await import('../support/project.ts')
  const { FakeFrameSource, FramedPage, recordProject } = await import('./runner-recording-fakes.ts')
  t.mock.method(FramedPage.prototype, 'frameSource', (identity: Parameters<typeof FramedPage.prototype.frameSource>[0]) => {
    const source = new FakeFrameSource(identity, 20)
    let reads = 0
    source.availability = () => ++reads === 1 ? { available: true, mode: 'screenshot-loop' } : { available: false, reason: 'availability changed' }
    const start = source.start.bind(source)
    source.start = async capture => { await start(capture); return { ok: true, mode: 'screenshot-loop' } }
    const stop = source.stop.bind(source)
    source.stop = async () => ({ ...await stop(), mode: 'screenshot-loop' })
    return source
  })
  const root = tempProject({ 'retest.config.ts': `import { chromium, defineConfig } from '@rehearsal-labs/retest'; export default defineConfig({apps:{web:chromium({baseUrl:'http://127.0.0.1:4173',executablePath:'/fake/chrome'})},recording:{record:true}})`, 'tests/one.retest.ts': `import { expect,test } from '@rehearsal-labs/retest'; test('one', async({page})=>{await page.goto('/');await expect(page.getByTestId('save-task')).toBeVisible()})` })
  const run = await recordProject(root, { files: ['tests/one.retest.ts'], startMedia: fakeMediaStarter().start })
  const began = run.events.find(event => event.type === 'recording.started')
  assert.ok(began?.type === 'recording.started')
  assert.equal(began.mode, 'screenshot-loop')
  assert.equal(run.result.files[0]?.tests[0]?.recordings?.[0]?.mode, 'screenshot-loop')
})

test('cancellation while media readiness is pending starts no recording or UI capture afterwards', { skip: unpinnedMedia }, async () => {
  const { tempProject } = await import('../support/project.ts')
  const { recordProject } = await import('./runner-recording-fakes.ts')
  const root = tempProject({ 'retest.config.ts': `import { chromium, defineConfig } from '@rehearsal-labs/retest'; export default defineConfig({apps:{web:chromium({baseUrl:'http://127.0.0.1:4173',executablePath:'/fake/chrome'})},recording:{record:true}})`, 'tests/one.retest.ts': `import {test} from '@rehearsal-labs/retest'; test('one',async({page})=>{await page.goto('/')})` })
  const fake = fakeMediaStarter()
  const controller = new AbortController()
  const run = await recordProject(root, { files: ['tests/one.retest.ts'], signal: controller.signal, startMedia: async (location, budget) => {
    const process = await fake.start(location, budget)
    const ready = process.ready.bind(process)
    process.ready = async () => { controller.abort('SIGINT'); return ready(budget) }
    return process
  } })
  assert.equal(run.result.exitCode, 130)
  assert.equal(fake.started[0]?.recordings.length, 0)
  assert.equal(run.browsers.flatMap(browser => browser.framed.flatMap(page => page.sources)).length, 0)
  assert.equal(fake.started[0]?.closes, 1)
  assert.equal(run.result.files[0]?.tests[0]?.evidenceStatus?.state, 'unavailable')
})


test('a discovery refusal is a named setup failure, starts no media and preserves the test outcome', { skip: unpinnedMedia }, async t => {
  const { tempProject } = await import('../support/project.ts')
  const { recordProject } = await import('./runner-recording-fakes.ts')
  const root = tempProject({ 'retest.config.ts': `import { chromium, defineConfig } from '@rehearsal-labs/retest'; export default defineConfig({apps:{web:chromium({baseUrl:'http://127.0.0.1:4173',executablePath:'/fake/chrome'})},recording:{record:true}})`, 'tests/one.retest.ts': `import { expect,test } from '@rehearsal-labs/retest'; test('one', async({page})=>{await page.goto('/');await expect(page.getByTestId('save-task')).toBeVisible()})` })
  const { mkdtemp, mkdir, rm, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { mediaFolder } = await import('../../src/cli/install/media-record.ts')
  const { mediaTarget } = await import('../../src/cli/install/media-pins.ts')
  const { discoverMediaLocation } = await import('../../src/runner/run-media.ts')
  const home = await mkdtemp(join(tmpdir(), 'retest-run-damaged-cache-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const env = { HOME: home, PATH: '' }
  const folder = mediaFolder(env, mediaTarget() ?? assert.fail('host target')) ?? assert.fail('cache folder')
  await mkdir(folder, { recursive: true })
  await writeFile(join(folder, 'build.json'), '{')
  const fake = fakeMediaStarter()
  let discoveries = 0
  const run = await recordProject(root, { files: ['tests/one.retest.ts'], startMedia: fake.start, discoverMedia: async (_given, _env, timeoutMs) => { discoveries++; return discoverMediaLocation(undefined, env, timeoutMs) } })
  assert.equal(discoveries, 1)
  assert.equal(fake.started.length, 0)
  assert.equal(run.result.files[0]?.tests[0]?.status, 'passed')
  assert.equal(run.result.files[0]?.tests[0]?.recordings?.[0]?.status, 'unavailable')
  assert.equal(run.result.files[0]?.tests[0]?.recordings?.[0]?.gaps[0]?.code, 'media_unavailable')
  assert.match(run.result.files[0]?.tests[0]?.recordings?.[0]?.gaps[0]?.message ?? '', /not JSON/)
  assert.ok((run.result.files[0]?.tests[0]?.recordings?.[0]?.gaps[0]?.message ?? '').includes(folder))
  assert.ok(run.events.some(event => event.type === 'media.failed' && event.code === 'media_unavailable'))
})

test('recording off never calls media discovery', async () => {
  const { tempProject } = await import('../support/project.ts')
  const { recordProject } = await import('./runner-recording-fakes.ts')
  const root = tempProject({ 'retest.config.ts': `import { chromium, defineConfig } from '@rehearsal-labs/retest'; export default defineConfig({apps:{web:chromium({baseUrl:'http://127.0.0.1:4173',executablePath:'/fake/chrome'})}})`, 'tests/one.retest.ts': `import { expect,test } from '@rehearsal-labs/retest'; test('one', async({page})=>{await page.goto('/');await expect(page.getByTestId('save-task')).toBeVisible()})` })
  let discoveries = 0
  const run = await recordProject(root, { files: ['tests/one.retest.ts'], discoverMedia: async () => { discoveries++; return 'must not be called' } })
  assert.equal(discoveries, 0)
  assert.equal(run.result.files[0]?.tests[0]?.status, 'passed')
})

test('a never-settling discovery is abandoned with unavailable evidence and close proceeds', async () => {
  const events: EventBody[] = []
  const media = new RunMedia({ location: () => new Promise(() => undefined), start: fakeMediaStarter().start, emit: event => void events.push(event), timeouts: { start: 10, close: 10, leftovers: 10 }, runFolder: newRunFolder() })
  const timer = Promise.withResolvers<'hung'>()
  const handle = setTimeout(() => timer.resolve('hung'), 100)
  try {
    const acquired = await Promise.race([media.acquire(), timer.promise])
    assert.ok(acquired !== 'hung' && !acquired.ok)
    assert.match(acquired.message, /discovery.*(deadline|budget)/i)
    assert.equal(await Promise.race([media.close(), timer.promise]), undefined)
    assert.ok(events.some(event => event.type === 'media.failed' && /discovery/i.test(event.message)))
  } finally { clearTimeout(handle) }
})

test('a never-settling starter cannot hold startup or shutdown', async () => {
  const media = new RunMedia({ location: { executable: '/fake/media' }, start: () => new Promise(() => undefined), emit: () => undefined, timeouts: { start: 10, close: 10, leftovers: 10 }, runFolder: newRunFolder() })
  const timer = Promise.withResolvers<'hung'>()
  const handle = setTimeout(() => timer.resolve('hung'), 100)
  try {
    const acquisition = media.acquire()
    await Promise.resolve()
    const closed = media.close()
    assert.ok(await Promise.race([acquisition, timer.promise]) !== 'hung', 'startup ignored cancellation and its budget')
    assert.notEqual(await Promise.race([closed, timer.promise]), 'hung', 'close awaited the starter without a bound')
  } finally { clearTimeout(handle) }
})

test('discovery and starter share the setup budget rather than restarting it', async () => {
  const fake = fakeMediaStarter()
  let passedBudget = 0
  const media = new RunMedia({ location: async () => { await new Promise(resolve => setTimeout(resolve, 20)); return { executable: '/fake/media' } }, start: async (location, budget) => { passedBudget = budget; return fake.start(location, budget) }, emit: () => undefined, timeouts: { start: 80, close: 20, leftovers: 20 }, runFolder: newRunFolder() })
  try {
    await media.acquire()
    assert.ok(passedBudget > 0 && passedBudget < 80, `starter received a fresh budget of ${passedBudget}`)
  } finally { await media.close() }
})

test('a run abort interrupts an uncooperative starter and a late process is closed', async () => {
  const fake = fakeMediaStarter()
  const started = Promise.withResolvers<Awaited<ReturnType<typeof fake.start>>>()
  const signal = new AbortController()
  const media = new RunMedia({ location: { executable: '/fake/media' }, start: () => started.promise, signal: signal.signal, emit: () => undefined, timeouts: { start: 1000, close: 20, leftovers: 20 }, runFolder: newRunFolder() })
  const acquisition = media.acquire()
  await Promise.resolve()
  signal.abort()
  const bound = Promise.withResolvers<'hung'>()
  const handle = setTimeout(() => bound.resolve('hung'), 100)
  try {
    assert.notEqual(await Promise.race([acquisition, bound.promise]), 'hung')
  } finally {
    started.resolve(await fake.start({ executable: '/fake/media' }, 20))
    await media.close()
    clearTimeout(handle)
  }
  assert.equal(fake.started[0]?.closes, 1)
})

test('a stuck media close reports uncertainty within the cleanup budget', { skip: unpinnedMedia }, async () => {
  const fake = fakeMediaStarter({ closeHangs: true })
  const media = new RunMedia({ location: { executable: '/fake/media' }, start: fake.start, emit: () => undefined, timeouts: { start: 1000, close: 10, leftovers: 10 }, runFolder: newRunFolder() })
  assert.equal((await media.acquire()).ok, true)
  const bound = Promise.withResolvers<'hung'>()
  const handle = setTimeout(() => bound.resolve('hung'), 100)
  try {
    const closed = await Promise.race([media.close(), bound.promise])
    assert.ok(closed !== 'hung' && closed?.class === 'cleanup_failed')
    assert.match(closed.message, /cleanup budget|unknown/i)
  } finally { clearTimeout(handle) }
})

test('run cancellation also interrupts a media close already waiting', { skip: unpinnedMedia }, async () => {
  const fake = fakeMediaStarter()
  const signal = new AbortController()
  const closing = Promise.withResolvers<void>()
  const media = new RunMedia({ location: { executable: '/fake/media' }, start: async (location, budget) => {
    const process = await fake.start(location, budget)
    process.close = () => { closing.resolve(); return new Promise(() => undefined) }
    return process
  }, signal: signal.signal, emit: () => undefined, timeouts: { start: 1000, close: 1000, leftovers: 10 }, runFolder: newRunFolder() })
  assert.equal((await media.acquire()).ok, true)
  const close = media.close()
  await closing.promise
  signal.abort()
  const bound = Promise.withResolvers<'hung'>()
  const handle = setTimeout(() => bound.resolve('hung'), 100)
  try {
    const closed = await Promise.race([close, bound.promise])
    assert.ok(closed !== 'hung' && closed?.class === 'cleanup_failed')
    assert.match(closed.message, /cancelled|unknown/i)
  } finally { clearTimeout(handle) }
})
