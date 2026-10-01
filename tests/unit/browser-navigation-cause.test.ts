import type { PageNavigation } from '../../src/browser/contract.ts'
import type { ScriptedPage } from './browser-fixtures.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { NavigationCauses } from '../../src/browser/navigation-causes.ts'
import { disarmFunction, pageFactsFunction, prepareFunction, verdictFunction } from '../../src/browser/page-scripts.ts'
import { isRecord, mainFrame, scriptedPage, value } from './browser-fixtures.ts'

const facts = { href: 'http://app.test/start', title: 'Start' }
const ready = { status: 'ready', point: { x: 10, y: 20 }, token: 1, via: null, scale: 1, page: facts }
const button = { by: 'testId', value: 'go' } as const

type Hooks = {
  /** Runs while the last input call of the action is being answered, before its answer. */
  duringInput?: () => void
  /** Runs while the guard's disarm is being answered, after the input answered. */
  duringDisarm?: () => void
  /** Runs while the select call that applies is being answered. */
  duringSelect?: () => void
}

type CausePage = ScriptedPage & { navigations: PageNavigation[]; requestFor(url: string, disposition?: string): void; startAndCommit(url: string, loaderId: string): void }

function causePage(hooks: Hooks = {}): CausePage {
  const page: CausePage = Object.assign(
    scriptedPage({
      input: (method, params) => {
        if (method === 'Input.dispatchMouseEvent' && isRecord(params) && params['type'] === 'mouseReleased') hooks.duringInput?.()
        return Promise.resolve({})
      },
      call: (source, params) => {
        if (source === prepareFunction) {
          if (!applying(params)) return value(ready)
          hooks.duringSelect?.()
          return value({ status: 'selected', page: facts })
        }
        if (source === verdictFunction) return value({ reached: ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'], intercepted: null, landed: '<a>', leaving: null })
        if (source === disarmFunction) {
          hooks.duringDisarm?.()
          return value(true)
        }
        if (source === pageFactsFunction) return value(facts)
        return Promise.reject(new Error('unexpected call'))
      },
      other: (method) => {
        if (method !== 'Page.navigate') return Promise.reject(new Error(`unexpected ${method}`))
        page.emit('Page.frameStartedNavigating', { frameId: mainFrame, url: 'http://app.test/opened', loaderId: 'G1', navigationType: 'differentDocument' })
        setImmediate(() => {
          page.emit('Page.frameNavigated', { frame: { id: mainFrame, url: 'http://app.test/opened', loaderId: 'G1' } })
          page.emit('Page.lifecycleEvent', { frameId: mainFrame, loaderId: 'G1', name: 'load' })
        })
        return Promise.resolve({ frameId: mainFrame, loaderId: 'G1' })
      },
    }),
    {
      navigations: [],
      requestFor: (url: string, disposition = 'currentTab') =>
        page.emit('Page.frameRequestedNavigation', { frameId: mainFrame, url, reason: 'anchorClick', disposition }),
      startAndCommit: (url: string, loaderId: string) => {
        page.emit('Page.frameStartedNavigating', { frameId: mainFrame, url, loaderId, navigationType: 'differentDocument' })
        page.emit('Page.frameNavigated', { frame: { id: mainFrame, url, loaderId } })
      },
    },
  )
  page.page.onNavigation((navigation) => void page.navigations.push(navigation))
  return page
}

function applying(params: Record<string, unknown>): boolean {
  const [intent] = Array.isArray(params['arguments']) ? params['arguments'] : []
  return isRecord(intent) && isRecord(intent['value']) && intent['value']['apply'] === true
}

function causes(page: CausePage): string[] {
  return page.navigations.map(({ url, cause }) => `${new URL(url).pathname} ${cause}`)
}

const next = 'http://app.test/next'

test("the navigation a goto starts is the goto's", async () => {
  const page = causePage()
  const result = await page.page.execute({ kind: 'goto', url: '/opened' }, 1000)
  assert.deepEqual(result, { ok: true, kind: 'goto', url: 'http://app.test/opened', page: { url: 'http://app.test/start', title: 'Start' } })
  assert.deepEqual(causes(page), ['/opened goto'])
})

test("a navigation the page requested while a click's input was delivered is the action's", async () => {
  const page = causePage({ duringInput: () => page.requestFor(next) })
  await page.page.execute({ kind: 'click', locator: button }, 1000)
  page.startAndCommit(next, 'L2')
  assert.deepEqual(causes(page), ['/next action'])
})

test('a request that arrives after the input answered, but before the guard was disarmed, is still the action (fact F12)', async () => {
  const page = causePage({ duringDisarm: () => page.requestFor(next) })
  await page.page.execute({ kind: 'click', locator: button }, 1000)
  page.startAndCommit(next, 'L2')
  assert.deepEqual(causes(page), ['/next action'])
})

test("a request after the action was over, as a timer's, is the page's", async () => {
  const page = causePage()
  await page.page.execute({ kind: 'click', locator: button }, 1000)
  page.requestFor(next)
  page.startAndCommit(next, 'L2')
  page.startAndCommit('http://app.test/redirected', 'L3')
  assert.deepEqual(causes(page), ['/next page', '/redirected page'])
})

test('a new path within the document is the action while it is delivered, and the page afterwards', async () => {
  const page = causePage({ duringDisarm: () => page.emit('Page.navigatedWithinDocument', { frameId: mainFrame, url: 'http://app.test/pushed' }) })
  await page.page.execute({ kind: 'click', locator: button }, 1000)
  page.emit('Page.navigatedWithinDocument', { frameId: mainFrame, url: 'http://app.test/later' })
  assert.deepEqual(causes(page), ['/pushed action', '/later page'])
})

test('a change listener that navigates during the select call makes the navigation the action', async () => {
  const page = causePage({ duringSelect: () => page.requestFor(next) })
  const result = await page.page.execute({ kind: 'select', locator: button, choices: [{ label: 'B' }] }, 1000)
  assert.ok(result.ok, JSON.stringify(result))
  page.startAndCommit(next, 'L2')
  assert.deepEqual(causes(page), ['/next action'])
})

test('a request for another tab, or for an address the browser did not then open, is not the action', async () => {
  const page = causePage({
    duringInput: () => {
      page.requestFor('http://app.test/popup', 'newTab')
      page.requestFor('http://app.test/elsewhere')
    },
  })
  await page.page.execute({ kind: 'click', locator: button }, 1000)
  page.startAndCommit('http://app.test/popup', 'L2')
  page.startAndCommit(next, 'L3')
  assert.deepEqual(causes(page), ['/popup page', '/next page'])
})

test("the goto's loader is the goto's even when the page asked for the same address at that moment", () => {
  const causes = new NavigationCauses()
  const opening = causes.opening(async () => {
    causes.requested('http://app.test/opened')
    causes.started('http://app.test/opened', 'G1')
    causes.opened('G1')
    return causes.committed('G1')
  })
  return opening.then((cause) => assert.equal(cause, 'goto'))
})

test('a navigation nothing announced is the goto while one opens, and the page otherwise', async () => {
  const causes = new NavigationCauses()
  assert.equal(causes.committed('X1'), 'page')
  assert.equal(await causes.opening(async () => causes.committed('X2')), 'goto')
  assert.equal(await causes.delivering(async () => causes.movedWithinDocument()), 'action')
  assert.equal(causes.movedWithinDocument(), 'page')
})
