import type { Transport, TransportHandlers } from '../../src/browser/cdp/transport.ts'
import type { PageDownload } from '../../src/browser/contract.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CdpConnection } from '../../src/browser/cdp/connection.ts'
import { BrowserDownloads } from '../../src/browser/downloads.ts'
import { Deadline } from '../../src/protocol/deadline.ts'
import { scriptedSession } from './browser-fixtures.ts'

// The browser's downloads are routed by what Chrome tells of its targets on the browser's own session, and of a page's
// frames on the page's. These run the routing against a connection whose every command succeeds and whose events the
// test sends; the real routes, a target=_blank link, a frame of another site and a frame of a page the page opened, are
// run on Chrome in `tests/integration/browser-files.test.ts`.

const folder = '/run/artifacts/attempt1/web/downloads'

function scriptedBrowser() {
  let handlers: TransportHandlers | undefined
  const transport: Transport = {
    listen: (given) => {
      handlers = given
    },
    send: (text) => {
      const command: unknown = JSON.parse(text)
      const id = typeof command === 'object' && command !== null && 'id' in command ? command.id : undefined
      queueMicrotask(() => handlers?.message(JSON.stringify({ id, result: {} })))
      return { written: true, withdraw: () => {} }
    },
    close: () => {},
  }
  const connection = new CdpConnection(transport, { timeoutMs: 1000, onDiagnostic: () => {} })
  const emit = (method: string, params: unknown) => handlers?.message(JSON.stringify({ method, params }))
  const downloads = new BrowserDownloads(connection, (error) => {
    throw error
  })
  return { downloads, emit }
}

function target(targetId: string, type: string, related: { openerId?: string; parentId?: string } = {}) {
  return { targetInfo: { targetId, type, browserContextId: 'C1', ...related } }
}

function begin(frameId: string, guid: string) {
  return { frameId, guid, url: 'http://app.test/tasks.csv', suggestedFilename: 'tasks.csv' }
}

async function testPage() {
  const browser = scriptedBrowser()
  await browser.downloads.configure('C1', folder, new Deadline(1000))
  const page = scriptedSession(() => Promise.resolve({}))
  const home = browser.downloads.page({ session: page.session, mainFrame: () => 'F1', browserContextId: 'C1', popup: false })
  const heard: PageDownload[] = []
  home.onDownload((download) => heard.push(download))
  browser.emit('Target.targetCreated', target('F1', 'page'))
  return { ...browser, page, home, heard }
}

test("a download is the page's own from its frames, a popup's from a page it opened or a frame of one, and another page's from any other page of its context", async () => {
  const { emit, page, heard } = await testPage()
  page.emit('Page.frameAttached', { frameId: 'F2', parentFrameId: 'F1' })
  emit('Target.targetCreated', target('P1', 'page', { openerId: 'F1' }))
  emit('Target.targetCreated', target('I1', 'iframe', { parentId: 'P1' }))
  emit('Target.targetCreated', target('P2', 'page'))
  for (const [frameId, guid] of [['F1', 'g1'], ['F2', 'g2'], ['P1', 'g3'], ['I1', 'g4'], ['P2', 'g5']] as const) emit('Browser.downloadWillBegin', begin(frameId, guid))
  assert.deepEqual(heard.map((download) => [download.guid, download.startedIn]), [['g1', undefined], ['g2', undefined], ['g3', 'popup'], ['g4', 'popup'], ['g5', 'other']])
})

test('a download whose frame Retest was told of in no way is placed by the folder it was saved in, as begun in another page', async () => {
  const { emit, heard } = await testPage()
  emit('Browser.downloadWillBegin', begin('X9', 'g6'))
  assert.equal(heard.length, 0, 'nothing is told before the download is saved')
  emit('Browser.downloadProgress', { guid: 'g6', totalBytes: 4, receivedBytes: 4, state: 'completed', filePath: `${folder}/g6` })
  assert.deepEqual(heard.map((download) => [download.guid, download.startedIn]), [['g6', 'other']])
  assert.deepEqual(await heard[0]?.ended, { state: 'completed', filePath: `${folder}/g6`, receivedBytes: 4, totalBytes: 4 })
})

test("the test's page that closes takes its context's targets and folder with it, so nothing of that context is routed afterwards", async () => {
  const { downloads, emit, home } = await testPage()
  emit('Target.targetCreated', target('P1', 'page', { openerId: 'F1' }))
  emit('Browser.downloadWillBegin', begin('F1', 'g7'))
  home.close()
  const page = scriptedSession(() => Promise.resolve({}))
  const later = downloads.page({ session: page.session, mainFrame: () => 'F3', browserContextId: 'C1', popup: false })
  const heard: PageDownload[] = []
  later.onDownload((download) => heard.push(download))
  emit('Browser.downloadProgress', { guid: 'g7', totalBytes: 4, receivedBytes: 4, state: 'completed', filePath: `${folder}/g7` })
  emit('Browser.downloadWillBegin', begin('P1', 'g8'))
  emit('Browser.downloadProgress', { guid: 'g8', totalBytes: 4, receivedBytes: 4, state: 'completed', filePath: `${folder}/g8` })
  assert.deepEqual(heard, [], 'the closed page\'s download, its popup and its folder are forgotten')
})
