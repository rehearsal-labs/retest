import type { PageNavigation } from '../../src/browser/contract.ts'
import type { TitleSource } from '../../src/browser/navigation-titles.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { NavigationTitles, titleWaitMs } from '../../src/browser/navigation-titles.ts'
import { observeFunction, pageFactsFunction } from '../../src/browser/page-scripts.ts'
import { Deadline } from '../../src/protocol/deadline.ts'
import { functionsCalled, mainFrame, scriptedPage, value } from './browser-fixtures.ts'

const observed = { count: 0, visible: null, text: null, value: null, items: [], itemsTruncated: false }

type TitledPage = ReturnType<typeof scriptedPage> & {
  navigations: PageNavigation[]
  /** The title the page shows now; a read answers with it. */
  title: { now: string }
  commit(path: string, loaderId: string): void
  contentLoaded(loaderId: string): void
}

// A page whose reads answer the title it shows now, and whose looks find nothing.
function titledPage(read: () => Promise<unknown> = () => Promise.resolve(undefined)): TitledPage {
  const title = { now: 'Start' }
  const scripted = scriptedPage({
    call: async (source) => {
      if (source === pageFactsFunction) {
        await read()
        return value({ href: 'http://app.test/any', title: title.now })
      }
      if (source === observeFunction) return value({ observation: observed, page: { href: 'http://app.test/any', title: title.now } })
      return Promise.reject(new Error('unexpected call'))
    },
  })
  const navigations: PageNavigation[] = []
  scripted.page.onNavigation((navigation) => void navigations.push(navigation))
  const commit = (path: string, loaderId: string) => scripted.emit('Page.frameNavigated', { frame: { id: mainFrame, url: `http://app.test${path}?secret=1`, loaderId } })
  const contentLoaded = (loaderId: string) => scripted.emit('Page.lifecycleEvent', { frameId: mainFrame, loaderId, name: 'DOMContentLoaded' })
  return { ...scripted, navigations, title, commit, contentLoaded }
}

function settledYet(promise: Promise<unknown>): Promise<boolean> {
  const pending = Symbol('pending')
  return Promise.race([promise.then(() => true), new Promise<symbol>((resolve) => setImmediate(() => resolve(pending)))]).then((result) => result === true)
}

test("a new document's title is read when its DOMContentLoaded fires, and cleaned", async () => {
  const page = titledPage()
  page.commit('/next', 'L2')
  const [navigation] = page.navigations
  assert.ok(navigation !== undefined)
  assert.equal(navigation.url, 'http://app.test/next')
  assert.equal(page.page.url, 'http://app.test/next')
  assert.equal(await settledYet(navigation.title), false, 'the title waits for its document')
  page.title.now = '  Next\u0007 page '
  page.contentLoaded('L2')
  assert.equal(await navigation.title, 'Next page')
})

test('a title waiting when the next command begins is read before that command sends anything', async () => {
  const page = titledPage()
  page.commit('/next', 'L2')
  const [navigation] = page.navigations
  assert.ok(navigation !== undefined)
  page.title.now = 'Next'
  let settledFirst = false
  void navigation.title.then(() => {
    settledFirst = functionsCalled(page.sent).every((source) => source !== observeFunction)
  })
  const result = await page.page.execute({ kind: 'observe', locator: { by: 'testId', value: 'x' } }, 1000)
  assert.ok(result.ok)
  assert.equal(await navigation.title, 'Next')
  assert.ok(settledFirst, 'the title settled before the command looked at the page')
  assert.deepEqual(functionsCalled(page.sent), [pageFactsFunction, observeFunction])
})

test('a title with no DOMContentLoaded and no command is read one second after its commit', async () => {
  const page = titledPage()
  const started = performance.now()
  page.commit('/next', 'L2')
  page.title.now = 'Late'
  const [navigation] = page.navigations
  assert.ok(navigation !== undefined)
  assert.equal(await navigation.title, 'Late')
  const waited = performance.now() - started
  assert.ok(waited >= titleWaitMs - 20 && waited < titleWaitMs + 500, `settled after ${waited} ms`)
})

test('a document replaced before its title was read has none, and the next one has its own', async () => {
  const page = titledPage()
  page.commit('/first', 'L2')
  page.commit('/second', 'L3')
  const [first, second] = page.navigations
  assert.ok(first !== undefined && second !== undefined)
  assert.equal(await first.title, undefined)
  page.title.now = 'Second'
  page.contentLoaded('L3')
  assert.equal(await second.title, 'Second')
})

test('a read the browser held until a newer document committed is not taken as the older one', async () => {
  const held = Promise.withResolvers<void>()
  let reads = 0
  const page = titledPage(() => (++reads === 1 ? held.promise : Promise.resolve()))
  page.commit('/refresh', 'L2')
  page.contentLoaded('L2')
  page.commit('/after', 'L3')
  page.title.now = 'After'
  held.resolve()
  const [refresh, after] = page.navigations
  assert.ok(refresh !== undefined && after !== undefined)
  assert.equal(await refresh.title, undefined, 'the answer came from the newer document')
  page.contentLoaded('L3')
  assert.equal(await after.title, 'After')
})

test('a navigation within the document is read at once, and settles an earlier one of the same document still waiting', async () => {
  const page = titledPage()
  page.commit('/list', 'L2')
  page.title.now = 'Item 7'
  page.emit('Page.navigatedWithinDocument', { frameId: mainFrame, url: 'http://app.test/items/7' })
  const [list, item] = page.navigations
  assert.ok(list !== undefined && item !== undefined)
  assert.equal(item.url, 'http://app.test/items/7')
  assert.equal(await item.title, 'Item 7')
  assert.equal(await list.title, 'Item 7')
  page.emit('Page.navigatedWithinDocument', { frameId: mainFrame, url: 'http://app.test/items/7#details' })
  assert.equal(page.navigations.length, 2, 'a fragment is not a navigation')
})

test('an empty title is none, and a DOMContentLoaded while the frame opens another document waits for the next chance', async () => {
  const page = titledPage()
  page.commit('/blank', 'L2')
  page.title.now = ' \u0000 '
  page.contentLoaded('L2')
  const [blank] = page.navigations
  assert.ok(blank !== undefined)
  assert.equal(await blank.title, undefined)
  page.commit('/leaving', 'L3')
  page.startNavigating('differentDocument', 'L4')
  page.contentLoaded('L3')
  const [, leaving] = page.navigations
  assert.ok(leaving !== undefined)
  assert.equal(await settledYet(leaving.title), false, 'no read is sent while it would be held')
  const before = functionsCalled(page.sent).length
  await page.page.execute({ kind: 'goto', url: 'http://app.test/elsewhere' }, 50).catch(() => undefined)
  assert.equal(await leaving.title, undefined, 'the next command settles it, and reads nothing it would wait on')
  assert.equal(functionsCalled(page.sent).length, before)
})

test('a page that closes settles every title still waiting with none', async () => {
  const page = titledPage()
  page.commit('/next', 'L2')
  const [navigation] = page.navigations
  assert.ok(navigation !== undefined)
  // The scripted browser never answers the context's closing; the titles settle before Retest asks it.
  const closing = page.page.dispose(20).catch(() => undefined)
  assert.equal(await navigation.title, undefined)
  await closing
})

// The rules alone, over a source a test controls.
function source(title: string | undefined, readable = true): TitleSource & { reads: number } {
  const counted = {
    reads: 0,
    readable: () => readable,
    read: async () => {
      counted.reads += 1
      return title
    },
  }
  return counted
}

test('each title settles once, from the first of its chances, and reads no more after', async () => {
  const from = source('One')
  const titles = new NavigationTitles(from)
  const title = titles.committed('L1')
  titles.contentLoaded('L1')
  titles.contentLoaded('L1')
  assert.equal(await title, 'One')
  await titles.settle(new Deadline(100))
  assert.equal(from.reads, 1)
  titles.contentLoaded('L0')
  assert.equal(from.reads, 1, 'a DOMContentLoaded of another loader reads nothing')
  titles.dispose()
})

test('a source that cannot be read settles at the next command with none, and a failed read too', async () => {
  const titles = new NavigationTitles(source('Never', false))
  const title = titles.committed('L1')
  await titles.settle(new Deadline(100))
  assert.equal(await title, undefined)
  const failing = new NavigationTitles({ readable: () => true, read: () => Promise.reject(new Error('gone')) })
  const failed = failing.committed('L1')
  failing.contentLoaded('L1')
  assert.equal(await settledYet(failed), false, 'a failed DOMContentLoaded read waits for the next chance')
  await failing.settle(new Deadline(100))
  assert.equal(await failed, undefined)
})
