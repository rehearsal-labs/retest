import type { TestContext } from 'node:test'
import type { ReceivedCommand, ScriptedBuild } from './webkit-scripted-inspector.ts'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { WebKitBrowser } from '../../src/browser/webkit/browser.ts'
import { WebKitProcess } from '../../src/browser/webkit/process.ts'
import { defaultScreen } from '../../src/browser/webkit/screen.ts'
import { OwnedProcessGroup } from '../../src/shared/process-ownership.ts'
import { scriptedBuild } from './webkit-scripted-inspector.ts'

// How a WebKit browser hands each page its own setup, against a scripted build on the far end of the connection. The
// process is a stand-in this test starts, which waits on its inspector pipe and ends when the test closes it.

async function browserOn(t: TestContext, build: ScriptedBuild): Promise<WebKitBrowser> {
  const folder = await realpath(await mkdtemp(join(tmpdir(), 'retest-webkit-browser-test-')))
  t.after(() => rm(folder, { recursive: true, force: true }))
  const child = spawn('/bin/sh', ['-c', 'read message <&3'], { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] })
  const [, , , writable, readable] = child.stdio
  // Ends the stand-in however the test ends: it reads its pipe until the end.
  t.after(() => {
    if (writable instanceof Writable) writable.end()
  })
  await once(child, 'spawn')
  const ownership = new OwnedProcessGroup(child.pid ?? 0, process.pid)
  ownership.capture()
  assert.ok(writable instanceof Writable && readable instanceof Readable)
  const webkitBuild = { directory: folder, executable: '/bin/sh', protocolSha256: '', revision: undefined, version: 'test' }
  const output = { closed: once(child, 'exit').then((): string[] => []), cancel: () => undefined, writersRemain: () => false }
  const stand = new WebKitProcess(child, { build: webkitBuild, home: join(folder, 'home'), pipe: { readable, writable }, ownership, launcher: { pid: 1, startedAt: 'test' }, output, listServices: () => 'services = {\n}\n' })
  const browser = new WebKitBrowser({ process: stand, connection: build.connection, build: webkitBuild, onListenerError: (error) => assert.fail(String(error)), log: () => undefined })
  t.after(async () => {
    writable.end()
    await stand.stop(1000)
  })
  return browser
}

/** Answers what a page's setup sends, and the frame tree a page reads once its target runs. */
function answerPages(build: ScriptedBuild): void {
  build.serve((command) => {
    if (command.method === 'Playwright.createPage') return undefined
    if (command.method === 'Playwright.createContext') return { browserContextId: 'context-1' }
    if (command.method === 'Page.getResourceTree') return { frameTree: { frame: { id: `frame-${command.targetId ?? ''}`, url: 'about:blank', loaderId: 'L0', securityOrigin: '', mimeType: 'text/html' }, resources: [] } }
    if (command.method === 'Runtime.evaluate') return { result: { type: 'boolean', value: true } }
    return {}
  })
}

async function nextCreatePage(build: ScriptedBuild): Promise<ReceivedCommand> {
  for (;;) {
    const command = await build.nextCommand()
    if (command.method === 'Playwright.createPage') return command
  }
}

// W-9: a page announced while a createPage of its context was on its way once took the next queued setup, whichever
// page it was: a popup could take a side page's empty-document setup, or a test page's viewport.
test("each page takes the setup of the createPage that named it, a popup announced first takes the default screen, and a page's first target stays paused until its setup is there", { timeout: 10_000 }, async (t) => {
  const build = scriptedBuild(t, { timeoutMs: 3000 })
  answerPages(build)
  const browser = await browserOn(t, build)
  const opening = browser.newPage({ emulation: { viewport: { width: 640, height: 480 }, deviceScaleFactor: 2, touch: false, isMobile: false } }, 5000)
  const create = await nextCreatePage(build)
  // The page the test page opened on its own is announced first, then the page createPage made; each target is paused.
  build.event('Playwright.pageProxyCreated', { pageProxyId: '9', browserContextId: 'context-1' })
  build.event('Playwright.pageProxyCreated', { pageProxyId: '7', browserContextId: 'context-1' })
  build.proxyEvent('9', 'Target.targetCreated', { targetInfo: { targetId: 'page-90', type: 'page', isPaused: true } })
  build.proxyEvent('7', 'Target.targetCreated', { targetInfo: { targetId: 'page-70', type: 'page', isPaused: true } })
  await delay(50)
  assert.deepEqual(build.received.filter((command) => command.pageProxyId !== undefined).map((command) => `${command.pageProxyId} ${command.targetId ?? 'proxy'} ${command.method}`), [], 'no page is set up, or let run, before the answer says which page is which')
  build.reply(create, { pageProxyId: '7' })
  const page = await opening
  const metrics = (pageProxyId: string) => build.received.find((command) => command.pageProxyId === pageProxyId && command.targetId === undefined && command.method === 'Emulation.setDeviceMetricsOverride')?.params
  assert.deepEqual(metrics('7'), { width: 640, height: 480, fixedLayout: false, deviceScaleFactor: 2 })
  const end = performance.now() + 2000
  while (metrics('9') === undefined && performance.now() < end) await delay(10)
  assert.deepEqual(metrics('9'), { width: defaultScreen.viewport.width, height: defaultScreen.viewport.height, fixedLayout: false, deviceScaleFactor: 1 }, 'the popup runs with the default screen')
  const resumed = build.received.filter((command) => command.method === 'Target.resume').map((command) => command.pageProxyId)
  assert.ok(resumed.includes('7') && resumed.includes('9'), `both targets run once set up: ${resumed.join(', ')}`)
  assert.equal('pageProxyId' in page ? page.pageProxyId : undefined, '7')
})
