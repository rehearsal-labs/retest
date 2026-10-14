import type { PageNavigation } from '../../src/browser/contract.ts'
import type { ScriptedPage } from './browser-fixtures.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { NavigationCauses } from '../../src/browser/navigation-causes.ts'
import { disarmFunction, pageFactsFunction, prepareFunction, selectionFunction, registrationFunction, verdictFunction } from '../../src/browser/page-scripts.ts'
import { isRecord, mainFrame, scriptedPage, value } from './browser-fixtures.ts'

const facts = { href: 'http://app.test/start', title: 'Start' }
const ready = { status: 'ready', point: { x: 10, y: 20 }, token: 1, via: null, scale: 1, page: facts, plan: null }
const button = { by: 'testId', value: 'go' } as const

type Hooks = {
  /** Runs while the last input call of the action is being answered, before its answer. */
  duringInput?: () => void
  /** Runs while the guard's disarm is being answered, after the input answered. */
  duringDisarm?: () => void
  /** Runs while the key a select types is being answered. */
  duringSelect?: () => void
}

type CausePage = ScriptedPage & { navigations: PageNavigation[]; requestFor(url: string, disposition?: string): void; startAndCommit(url: string, loaderId: string): void }

function causePage(hooks: Hooks = {}): CausePage {
  const page: CausePage = Object.assign(
    scriptedPage({
      input: (method, params) => {
        if (method === 'Input.dispatchMouseEvent' && isRecord(params) && params['type'] === 'mouseReleased') hooks.duringInput?.()
        if (method === 'Input.dispatchKeyEvent' && isRecord(params) && params['type'] === 'keyUp') hooks.duringSelect?.()
        return Promise.resolve({})
      },
      call: (source, params) => {
        if (source === prepareFunction) {
          if (!selecting(params)) return value(ready)
          return value(typing(params) ? ready : { ...ready, token: null, plan: { quietMs: 0, keys: [{ key: 'b', toggle: false }] } })
        }
        if (source === selectionFunction) return value({ status: 'selected', selected: ['B'], page: facts })
        if (source === registrationFunction) return value(true)
        if (source === verdictFunction) return value({ reached: ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'keydown', 'keyup'], intercepted: null, landed: '<a>', leaving: null })
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

function intentOf(params: Record<string, unknown>): Record<string, unknown> {
  const [intent] = Array.isArray(params['arguments']) ? params['arguments'] : []
  return isRecord(intent) && isRecord(intent['value']) ? intent['value'] : {}
}

function selecting(params: Record<string, unknown>): boolean {
  return intentOf(params)['action'] === 'select'
}

function typing(params: Record<string, unknown>): boolean {
  return intentOf(params)['typing'] === true
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

test('a change listener that navigates while a select types makes the navigation the action', async () => {
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
  const opening = causes.opening(undefined, async () => {
    causes.requested('http://app.test/opened')
    causes.started('http://app.test/opened', 'G1')
    causes.opened('G1')
    return causes.committed('G1')
  })
  return opening.then((started) => assert.equal(started.cause, 'goto'))
})

test('a navigation nothing announced is the goto while one opens, and the page otherwise', async () => {
  const causes = new NavigationCauses()
  assert.equal(causes.committed('X1').cause, 'page')
  assert.equal((await causes.opening(undefined, async () => causes.committed('X2'))).cause, 'goto')
  assert.equal((await causes.delivering(undefined, async () => causes.movedWithinDocument())).cause, 'action')
  assert.equal(causes.movedWithinDocument().cause, 'page')
  // goBack and goForward open through the history, which can move within the document.
  assert.deepEqual(await causes.opening(5, async () => causes.movedWithinDocument()), { cause: 'goto', commandToken: 5 })
})

test('a navigation says whether it opened a new document or moved within the one the frame held', async () => {
  const page = causePage()
  page.startAndCommit(next, 'L2')
  page.emit('Page.navigatedWithinDocument', { frameId: mainFrame, url: 'http://app.test/next/pushed' })
  assert.deepEqual(page.navigations.map(({ url, document }) => `${new URL(url).pathname} ${document}`), ['/next new', '/next/pushed same'])
})

// The runner gives each command a token, so the navigation a command caused can name it, whenever it commits.
test('a navigation names the token of the command whose input or goto started it, and the page\'s own name none', async () => {
  const page = causePage({ duringInput: () => page.requestFor(next) })
  await page.page.execute({ kind: 'goto', url: '/opened' }, 1000, undefined, 3)
  await page.page.execute({ kind: 'click', locator: button }, 1000, undefined, 7)
  page.startAndCommit(next, 'L2')
  page.requestFor('http://app.test/later')
  page.startAndCommit('http://app.test/later', 'L3')
  assert.deepEqual(page.navigations.map(({ url, cause, commandToken }) => [new URL(url).pathname, cause, commandToken]), [
    ['/opened', 'goto', 3],
    ['/next', 'action', 7],
    ['/later', 'page', undefined],
  ])
})

test('a new path within the document during an action names its token too', async () => {
  const page = causePage({ duringDisarm: () => page.emit('Page.navigatedWithinDocument', { frameId: mainFrame, url: 'http://app.test/pushed' }) })
  await page.page.execute({ kind: 'click', locator: button }, 1000, undefined, 9)
  assert.deepEqual(page.navigations.map(({ cause, commandToken, document }) => [cause, commandToken, document]), [['action', 9, 'same']])
})

test("a select's navigation names the select's token", async () => {
  const page = causePage({ duringSelect: () => page.requestFor(next) })
  await page.page.execute({ kind: 'select', locator: button, choices: [{ label: 'B' }] }, 1000, undefined, 4)
  page.startAndCommit(next, 'L2')
  assert.deepEqual(page.navigations.map(({ cause, commandToken }) => [cause, commandToken]), [['action', 4]])
})

// A request the browser never started must not lend its cause to a later navigation to the same address.
test("a request the frame stopped loading without starting is forgotten, so a timer's later navigation there is the page's", async () => {
  const page = causePage({ duringInput: () => page.requestFor(next) })
  await page.page.execute({ kind: 'click', locator: button }, 1000, undefined, 7)
  page.emit('Page.frameStoppedLoading', { frameId: mainFrame })
  page.startAndCommit(next, 'L2')
  assert.deepEqual(page.navigations.map(({ cause, commandToken }) => [cause, commandToken]), [['page', undefined]])
})

test('a request still waiting when another document commits is forgotten', async () => {
  const page = causePage({ duringInput: () => page.requestFor(next) })
  await page.page.execute({ kind: 'click', locator: button }, 1000, undefined, 7)
  page.emit('Page.frameNavigated', { frame: { id: mainFrame, url: 'http://app.test/elsewhere', loaderId: 'L1' } })
  page.startAndCommit(next, 'L2')
  assert.deepEqual(causes(page), ['/elsewhere page', '/next page'])
})

test('NavigationCauses carries the token of the command beside the cause it tells', async () => {
  const causes = new NavigationCauses()
  const opened = await causes.opening(5, async () => {
    causes.started('http://app.test/opened', 'G1')
    causes.opened('G1')
    return causes.committed('G1')
  })
  assert.deepEqual(opened, { cause: 'goto', commandToken: 5 })
  const delivered = await causes.delivering(6, async () => {
    causes.requested('http://app.test/next')
    return causes.movedWithinDocument()
  })
  assert.deepEqual(delivered, { cause: 'action', commandToken: 6 })
  causes.started('http://app.test/next', 'L2')
  assert.deepEqual(causes.committed('L2'), { cause: 'action', commandToken: 6 })
  assert.deepEqual(causes.committed('L3'), { cause: 'page' })
  assert.deepEqual(await causes.delivering(undefined, async () => causes.movedWithinDocument()), { cause: 'action' })
})
