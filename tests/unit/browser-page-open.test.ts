import type { Transport } from '../../src/browser/cdp/transport.ts'
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { CdpConnection } from '../../src/browser/cdp/connection.ts'
import { ChromiumPage } from '../../src/browser/page.ts'
import { Deadline } from '../../src/protocol/deadline.ts'
import { mainFrame, never, scriptedSession, type ScriptedSession } from './browser-fixtures.ts'

// Opening a page reads its main frame, then turns on the page's events. A document that commits between the two is
// told by no event, as the first document of an Electron app's window is, so the frame is read again once events are
// on. These run on a scripted session: the browser here is the answers below.

const silent: Transport = { listen: () => {}, send: () => ({ written: true, withdraw: () => {} }), close: () => {} }

type Frames = {
  /** The address each read of the frame tree finds, in turn; the last one stands for every later read. */
  reads: string[]
  /** Runs as a read is answered, before its answer arrives, as an event the browser sent first would. */
  onRead?: (read: number, scripted: ScriptedSession) => void
}

async function opened(frames: Frames): Promise<{ page: ChromiumPage; methods: string[] }> {
  let reads = 0
  let scripted: ScriptedSession | undefined
  scripted = scriptedSession(async (method) => {
    if (method === 'Page.getFrameTree') {
      reads += 1
      const url = frames.reads[Math.min(reads, frames.reads.length) - 1] ?? ''
      if (scripted !== undefined) frames.onRead?.(reads, scripted)
      return { frameTree: { frame: { id: mainFrame, url } } }
    }
    if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: '1' }
    // A title is read in the page's own world, which these pages never answer.
    if (method === 'Page.createIsolatedWorld' || method === 'Runtime.callFunctionOn') return never()
    return {}
  })
  const options = {
    connection: new CdpConnection(silent, { timeoutMs: 1000, onDiagnostic: () => {} }),
    session: scripted.session,
    browserContextId: 'C1',
    baseUrl: undefined,
    emulation: undefined,
    restoredOrigins: [],
    proxyServer: undefined,
    onListenerError: (error: unknown) => {
      throw error
    },
  }
  const page = await ChromiumPage.open(options, new Deadline(2000))
  return { page, methods: scripted.sent.map(({ method }) => method) }
}

describe('opening a page', () => {
  test('a document that commits before the page hears its events is the page\'s address from the start', async () => {
    const { page, methods } = await opened({ reads: ['', 'file:///work/desktop/index.html'] })
    assert.equal(page.url, 'file:///work/desktop/index.html')
    assert.deepEqual(methods.slice(0, 3), ['Page.getFrameTree', 'Page.enable', 'Page.getFrameTree'], 'the frame is read again once its events are on')
  })

  test('so is an http address, whose origin then counts as one the page opened', async () => {
    const { page } = await opened({ reads: ['about:blank', 'http://127.0.0.1:4173/tasks?token=1#top'] })
    assert.equal(page.url, 'http://127.0.0.1:4173/tasks')
  })

  test('a commit the page was told while the frame was read again is newer than the read, and stands', async () => {
    const told = (read: number, scripted: ScriptedSession) => {
      if (read !== 2) return
      scripted.emit('Page.frameNavigated', { frame: { id: mainFrame, url: 'http://app.test/newer', loaderId: 'L3' } })
    }
    const { page } = await opened({ reads: ['about:blank', 'http://app.test/older'], onRead: told })
    assert.equal(page.url, 'http://app.test/newer')
  })

  test('a blank page stays as it was, as a browser\'s new page is', async () => {
    const { page } = await opened({ reads: ['about:blank'] })
    assert.equal(page.url, 'about:blank')
  })
})
