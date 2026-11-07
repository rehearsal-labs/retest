import type { TestContext } from 'node:test'
import type { PageDownload, PageNavigation } from '../../src/browser/contract.ts'
import type { PopupEnd } from '../../src/browser/popups.ts'
import type { PopupPage } from '../../src/browser/webkit/popups.ts'
import type { ReceivedCommand, ScriptedBuild } from './webkit-scripted-inspector.ts'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { Dispatch } from '../../src/browser/dispatch.ts'
import { WebKitDownloads } from '../../src/browser/webkit/downloads.ts'
import { WebKitFileChoosers } from '../../src/browser/webkit/file-chooser.ts'
import { WebKitPage } from '../../src/browser/webkit/page.ts'
import { WebKitPopups } from '../../src/browser/webkit/popups.ts'
import { WebKitTargetSession } from '../../src/browser/webkit/target-session.ts'
import { Deadline } from '../../src/protocol/deadline.ts'
import { scriptedBuild } from './webkit-scripted-inspector.ts'

// The WebKit driver's file inputs, file pickers, downloads and popups against a scripted build: the messages each sends,
// and how each reads what the build tells. webkit-files.test.ts and webkit-popups.test.ts drive the same on the real build.

function bridgeOn(t: TestContext, build: ScriptedBuild = scriptedBuild(t)): { build: ScriptedBuild; bridge: WebKitTargetSession } {
  const bridge = new WebKitTargetSession({ connection: build.connection, pageProxyId: '7', secret: 'retest-test-secret', worldName: 'retest', onListenerError: () => {} })
  t.after(() => bridge.close('the test ended'))
  bridge.committed('page-8')
  bridge.mainFrame('page-8', 'frame-1')
  build.serve((command) => {
    if (command.method !== 'Runtime.evaluate') return undefined
    if (String(command.params['expression']).includes('retestRelay')) return { result: { type: 'boolean', value: true } }
    if (command.params['expression'] === 'globalThis') return { result: { type: 'object', objectId: `global-${String(command.params['contextId'])}` } }
    return undefined
  })
  bridge.contextCreated('page-8', { context: { id: 4, type: 'user', name: 'retest', frameId: 'frame-1' } })
  return { build, bridge }
}

async function next(build: ScriptedBuild, method: string): Promise<ReceivedCommand> {
  for (;;) {
    const command = await build.nextCommand()
    if (command.method === method) return command
  }
}

test("a call that keeps its result hands it out as Chrome's object, a call onto it goes to its world, and its group lets it go by itself", { timeout: 10_000 }, async (t) => {
  const { build, bridge } = bridgeOn(t)
  const { executionContextId } = (await bridge.session.send('Page.createIsolatedWorld', { frameId: 'frame-1', worldName: 'retest' })) as { executionContextId: number }
  const taking = bridge.session.send('Runtime.callFunctionOn', { functionDeclaration: 'function take() {}', executionContextId, returnByValue: false, objectGroup: 'retest-files-1' })
  const take = await next(build, 'Runtime.callFunctionOn')
  assert.deepEqual([take.targetId, take.params['objectId'], take.params['returnByValue']], ['page-8', 'global-4', false])
  build.reply(take, { result: { type: 'object', subtype: 'node', objectId: 'input-1' } })
  assert.deepEqual(await taking, { result: { type: 'object', objectId: 'input-1' } })
  const reading = bridge.session.send('Runtime.callFunctionOn', { objectId: 'input-1', functionDeclaration: 'function read() { return 1 }', returnByValue: true })
  const read = await next(build, 'Runtime.callFunctionOn')
  assert.deepEqual([read.targetId, read.params['objectId']], ['page-8', 'input-1'])
  build.reply(read, { result: { type: 'number', value: 1 } })
  assert.deepEqual(await reading, { result: { value: 1 } })
  const releasing = bridge.session.send('Runtime.releaseObjectGroup', { objectGroup: 'retest-files-1' })
  const released = await next(build, 'Runtime.releaseObject')
  assert.deepEqual(released.params, { objectId: 'input-1' })
  const group = await next(build, 'Runtime.releaseObjectGroup')
  build.reply(group, {})
  await releasing
  await assert.rejects(bridge.session.send('Runtime.callFunctionOn', { objectId: 'input-1', functionDeclaration: 'function read() {}', returnByValue: true }), /Cannot find context with specified id/)
})

test("Chrome's file input command grants the page read access to the files before it gives them, and an empty list grants nothing", { timeout: 10_000 }, async (t) => {
  const { build, bridge } = bridgeOn(t)
  const { executionContextId } = (await bridge.session.send('Page.createIsolatedWorld', { frameId: 'frame-1', worldName: 'retest' })) as { executionContextId: number }
  const taking = bridge.session.send('Runtime.callFunctionOn', { functionDeclaration: 'function take() {}', executionContextId, returnByValue: false })
  build.reply(await next(build, 'Runtime.callFunctionOn'), { result: { type: 'object', objectId: 'input-1' } })
  await taking
  const giving = bridge.session.send('DOM.setFileInputFiles', { files: ['/tmp/report.pdf'], objectId: 'input-1' })
  const grant = await next(build, 'Playwright.grantFileReadAccess')
  assert.deepEqual([grant.targetId, grant.pageProxyId, grant.params], [undefined, undefined, { pageProxyId: '7', paths: ['/tmp/report.pdf'] }])
  assert.equal(build.received.some((command) => command.method === 'DOM.setInputFiles'), false, 'nothing is given before the access is granted')
  build.reply(grant, {})
  const set = await next(build, 'DOM.setInputFiles')
  assert.deepEqual([set.targetId, set.params], ['page-8', { objectId: 'input-1', paths: ['/tmp/report.pdf'] }])
  build.reply(set, {})
  assert.deepEqual(await giving, {})
  const clearing = bridge.session.send('DOM.setFileInputFiles', { files: [], objectId: 'input-1' })
  const cleared = await next(build, 'DOM.setInputFiles')
  build.reply(cleared, {})
  await clearing
  assert.equal(build.received.filter((command) => command.method === 'Playwright.grantFileReadAccess').length, 1)
})

test("a picker's input is made an object of Retest's world of its frame; one whose frame has no world gives nothing", { timeout: 10_000 }, async (t) => {
  const { build, bridge } = bridgeOn(t)
  const adopting = bridge.adopt('page-input', 'frame-1', 'retest-chooser-1', { timeoutMs: 1000 })
  const resolve = await next(build, 'DOM.resolveNode')
  assert.deepEqual(resolve.params, { objectId: 'page-input', executionContextId: 4, objectGroup: 'retest-chooser-1' })
  build.reply(resolve, { object: { type: 'object', subtype: 'node', objectId: 'world-input' } })
  assert.equal(await adopting, 'world-input')
  assert.equal(await bridge.adopt('page-input', 'frame-gone', 'retest-chooser-2', { timeoutMs: 1000 }), undefined)
})

test('a picker nobody armed for fails the action that opened it, or the next one before it sends, and an armed one is handed over with what its input takes', { timeout: 10_000 }, async (t) => {
  const { build, bridge } = bridgeOn(t)
  const choosers = new WebKitFileChoosers(bridge, 1000)
  const opened = { frameId: 'frame-1', element: { type: 'object', objectId: 'page-input' } }
  const during = await choosers.around(true, () => "click getByTestId('upload')", async () => {
    choosers.opened(opened)
    return { ok: true, kind: 'click' }
  })
  assert.deepEqual(during, { ok: false, failure: { class: 'not_actionable', message: "The page opened a file picker as Retest went to click getByTestId('upload'), and nothing was waiting for one. WebKit did not show it, and tells the page nothing of it, not even cancel.", details: { picker: 'file', inputSent: true } } })
  assert.deepEqual((await next(build, 'Runtime.releaseObject')).params, { objectId: 'page-input' })
  choosers.opened(opened)
  let ran = false
  const before = await choosers.around(true, () => "click getByTestId('next')", async () => {
    ran = true
    return { ok: true, kind: 'click' }
  })
  assert.equal(ran, false)
  assert.equal(before.ok ? undefined : before.failure.details?.['inputSent'], false)
  const arm = choosers.armFileChooser()
  choosers.opened(opened)
  build.reply(await next(build, 'DOM.resolveNode'), { object: { type: 'object', objectId: 'world-input' } })
  const multiple = await next(build, 'Runtime.callFunctionOn')
  assert.equal(multiple.params['objectId'], 'world-input')
  build.reply(multiple, { result: { type: 'boolean', value: true } })
  assert.deepEqual(await arm.opened, { id: 'chooser-1', multiple: true })
  const unknown = await choosers.setFiles({ kind: 'setChooserFiles', chooser: 'chooser-9', files: [], paths: [], mimeTypes: [] }, new Deadline(1000), new Dispatch())
  assert.deepEqual(unknown, { ok: false, failure: { class: 'usage', message: 'Could not give the file picker files: it is not a picker this page caught, so Retest gave it nothing.', details: { inputSent: false } } })
})

test('a WebKit target whose user world its web process already holds is set up all the same, and one whose setup failed is still let run', { timeout: 10_000 }, async (t) => {
  const build = scriptedBuild(t)
  const page = new WebKitPage({
    connection: build.connection,
    pageProxyId: '7',
    browserContextId: 'context-1',
    setup: { baseUrl: undefined, screen: { viewport: { width: 640, height: 480 }, deviceScaleFactor: 1 }, restoredOrigins: [] },
    openSidePage: async () => assert.fail('no side page is opened'),
    onListenerError: (error) => assert.fail(String(error)),
  })
  t.after(() => page.markClosed('the test ended'))
  build.serve((command) => {
    if (command.method === 'Page.createUserWorld') return new Error('World with the given name already exists')
    if (command.method === 'Page.getResourceTree') return { frameTree: { frame: { id: 'frame-1', url: 'about:blank' } } }
    if (command.method === 'Runtime.enable' && command.targetId === 'page-9') return new Error('Runtime is broken')
    return {}
  })
  build.proxyEvent('7', 'Target.targetCreated', { targetInfo: { targetId: 'page-8', type: 'page', isPaused: true } })
  await page.ready
  assert.ok(build.received.some((command) => command.method === 'Page.setInterceptFileChooserDialog' && command.targetId === 'page-8' && command.params['enabled'] === true))
  build.proxyEvent('7', 'Target.targetCreated', { targetInfo: { targetId: 'page-9', type: 'page', isProvisional: true, isPaused: true } })
  for (let turn = 0; turn < 50 && !build.received.some((command) => command.method === 'Target.resume' && command.params['targetId'] === 'page-9'); turn += 1) await new Promise((resolve) => setTimeout(resolve, 10))
  assert.ok(build.received.some((command) => command.method === 'Target.resume' && command.params['targetId'] === 'page-9'), 'a target whose setup failed is resumed, so no page that shares its process is held with it')
})

test("each download is told to the context's test page, placed by the page that began it, and ended by what the build says", { timeout: 10_000 }, async (t) => {
  const build = scriptedBuild(t)
  build.serve(() => ({}))
  const folder = mkdtempSync(join(tmpdir(), 'retest-webkit-downloads-'))
  t.after(() => rmSync(folder, { recursive: true, force: true }))
  const places = new Map([['7', { context: 'context-1', startedIn: undefined }], ['9', { context: 'context-1', startedIn: 'popup' as const }]])
  const downloads = new WebKitDownloads(build.connection, (pageProxyId) => places.get(pageProxyId), (error) => assert.fail(String(error)))
  const home = await downloads.save('context-1', folder, new Deadline(1000))
  const behavior = build.received.find((command) => command.method === 'Playwright.setDownloadBehavior')
  assert.deepEqual(behavior?.params, { behavior: 'allow', downloadPath: folder, browserContextId: 'context-1' })
  const told: PageDownload[] = []
  home.onDownload((download) => told.push(download))
  build.event('Playwright.downloadCreated', { pageProxyId: '9', frameId: 'frame-2', uuid: 'saved', url: 'http://app.test/tasks.csv' })
  build.event('Playwright.downloadFilenameSuggested', { uuid: 'saved', suggestedFilename: 'tasks.csv' })
  build.event('Playwright.downloadCreated', { pageProxyId: '7', frameId: 'frame-1', uuid: 'broken', url: 'http://app.test/broken.csv' })
  build.event('Playwright.downloadFilenameSuggested', { uuid: 'broken', suggestedFilename: 'broken.csv' })
  for (let turn = 0; turn < 50 && told.length < 2; turn += 1) await nextTurn()
  assert.deepEqual(told.map(({ guid, url, suggestedFilename, startedIn }) => [guid, url, suggestedFilename, startedIn]), [['saved', 'http://app.test/tasks.csv', 'tasks.csv', 'popup'], ['broken', 'http://app.test/broken.csv', 'broken.csv', undefined]])
  writeFileSync(join(folder, 'saved'), 'title,done\n')
  writeFileSync(join(folder, 'broken'), 'tit')
  assert.deepEqual(told[1]?.progress(), { receivedBytes: 3, totalBytes: 0 })
  build.event('Playwright.downloadFinished', { uuid: 'saved', error: '' })
  build.event('Playwright.downloadFinished', { uuid: 'broken', error: 'The network connection was lost.' })
  assert.deepEqual(await told[0]?.ended, { state: 'completed', filePath: join(folder, 'saved'), receivedBytes: 11, totalBytes: 11 })
  assert.deepEqual(await told[1]?.ended, { state: 'canceled', receivedBytes: 3, totalBytes: 0, reason: 'The network connection was lost.' })
  assert.equal(existsSync(join(folder, 'broken')), false, 'what arrived of a stopped download is removed')
  build.event('Playwright.downloadCreated', { pageProxyId: '7', frameId: 'frame-1', uuid: 'slow', url: 'http://app.test/slow.csv' })
  build.event('Playwright.downloadFilenameSuggested', { uuid: 'slow', suggestedFilename: 'slow.csv' })
  for (let turn = 0; turn < 50 && told.length < 3; turn += 1) await nextTurn()
  writeFileSync(join(folder, 'slow'), 'ti')
  home.close()
  for (let turn = 0; turn < 50 && !build.received.some((command) => command.method === 'Playwright.cancelDownload'); turn += 1) await nextTurn()
  assert.deepEqual(build.received.filter((command) => command.method === 'Playwright.cancelDownload').map((command) => command.params), [{ uuid: 'slow' }])
  assert.equal(existsSync(join(folder, 'slow')), false, 'a download still on its way as its page goes is stopped and removed')
})

test("a page armed for a popup is handed the next page it opens once that page is set up, its navigations kept from the first, and any other is kept until it goes", { timeout: 10_000 }, async () => {
  const popups = new WebKitPopups((error) => assert.fail(String(error)))
  const unwaited = stubPage()
  popups.opened(unwaited.page)
  const arming = popups.arm({ timeoutMs: 1000, setupMs: 1000 })
  assert.ok(arming.ok)
  const waited = stubPage()
  popups.opened(waited.page)
  waited.navigate({ url: 'http://app.test/help', title: Promise.resolve('Help'), cause: 'page', document: 'new' })
  waited.ready()
  const wait = await arming.opened
  assert.ok(wait.ok)
  assert.equal(wait.popup.page, waited.page)
  assert.equal((await wait.popup.first(100))?.url, 'http://app.test/help')
  await popups.disposeUnwaited(new Deadline(1000))
  assert.deepEqual([unwaited.disposed(), waited.disposed()], [true, false])
  const lost = popups.arm({ timeoutMs: 1000, setupMs: 1000 })
  assert.ok(lost.ok)
  popups.lost('the page crashed')
  assert.deepEqual(await lost.opened, { ok: false, failure: { class: 'session_lost', message: 'The page went away before it opened another page: the page crashed.' } })
})

// A page a page opened, as the popups see it, which a test sets up, navigates and ends.
function stubPage(): { page: PopupPage; ready: () => void; navigate: (navigation: PageNavigation) => void; disposed: () => boolean } {
  const ready = Promise.withResolvers<void>()
  const gone = Promise.withResolvers<PopupEnd>()
  const listeners: ((navigation: PageNavigation) => void)[] = []
  let disposed = false
  const page = {
    ready: ready.promise,
    gone: gone.promise,
    closedInBrowser: false,
    url: undefined,
    onNavigation: (listener: (navigation: PageNavigation) => void) => {
      listeners.push(listener)
      return () => undefined
    },
    dispose: async () => {
      disposed = true
      gone.resolve({ kind: 'closed' })
    },
  } as unknown as PopupPage
  return { page, ready: () => ready.resolve(), navigate: (navigation) => listeners.forEach((listener) => listener(navigation)), disposed: () => disposed }
}
