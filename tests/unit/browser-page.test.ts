import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BrowserError } from '../../src/browser/browser-error.ts'
import { disarmFunction, prepareFunction, readPageFunction, verdictFunction } from '../../src/browser/page-scripts.ts'
import { functionsCalled, isRecord, mainFrame, never, scriptedPage, value } from './browser-fixtures.ts'

// A page over a scripted session: `call` answers each call into Retest's world by its function.
function pageAnswering(call: (functionDeclaration: unknown) => Promise<unknown>) {
  return scriptedPage({ call })
}

const facts = { href: 'http://app.test/start?token=1', title: 'Start' }

test('a press readies its element, then sends the key down and up as real key events while the guard watches', async () => {
  const { page, sent } = pageAnswering((functionDeclaration) => {
    if (functionDeclaration === prepareFunction) return value({ status: 'ready', point: null, token: 1, via: null, scale: 1, page: facts })
    if (functionDeclaration === verdictFunction) return value({ reached: ['keydown'], intercepted: null, landed: '<input>', leaving: null })
    if (functionDeclaration === disarmFunction) return value(true)
    return Promise.reject(new Error('unexpected call'))
  })
  const result = await page.execute({ kind: 'press', locator: { by: 'testId', value: 'query' }, key: 'Shift+Tab' }, 1000)
  assert.deepEqual(result, { ok: true, kind: 'press', page: { url: 'http://app.test/start', title: 'Start' } })
  assert.deepEqual(
    sent.filter(({ method }) => method !== 'Page.createIsolatedWorld').map(({ method, params }) => (method === 'Input.dispatchKeyEvent' ? params : method)),
    [
      'Runtime.callFunctionOn',
      'Runtime.callFunctionOn',
      { type: 'rawKeyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers: 8 },
      { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers: 8 },
      'Runtime.callFunctionOn',
    ],
  )
  assert.deepEqual(functionsCalled(sent), [prepareFunction, verdictFunction, disarmFunction])
})

test('the page refuses a key it cannot send before it sends anything, as unsupported or as usage', async () => {
  const { page, sent } = pageAnswering(() => Promise.reject(new Error('nothing should reach the page')))
  const modifier = await page.execute({ kind: 'press', key: 'Control+a' }, 1000)
  assert.ok(!modifier.ok && modifier.failure.class === 'unsupported', JSON.stringify(modifier))
  const unknown = await page.execute({ kind: 'press', locator: { by: 'testId', value: 'query' }, key: 'Entr' }, 1000)
  assert.ok(!unknown.ok && unknown.failure.class === 'usage', JSON.stringify(unknown))
  assert.deepEqual(sent, [])
})

test('reading the page sends the queries as arguments and answers with its address, as origin and path, its title and what it found', async () => {
  const queries = [
    { text: 'Order placed', ignoreCase: false },
    { text: 'error', ignoreCase: true },
  ]
  const reading = value({ found: [true, false], title: '  Order\u0007 placed ' })
  const { page, sent } = pageAnswering((functionDeclaration) => (functionDeclaration === readPageFunction ? reading : Promise.reject(new Error('unexpected'))))
  assert.deepEqual(await page.readPage(queries, 1000), { url: 'http://app.test/start', title: 'Order placed', navigating: false, found: [true, false] })
  const call = sent.find(({ method }) => method === 'Runtime.callFunctionOn')
  assert.ok(isRecord(call?.params))
  assert.deepEqual(call.params['arguments'], [{ value: queries }])
  assert.equal(sent.filter(({ method }) => method.startsWith('Input.')).length, 0, 'reading sends no input')
})

test('while the frame is opening another document the page is not read, and the reading says so', async () => {
  const { page, sent, startNavigating } = pageAnswering(() => value({ found: [true], title: '' }))
  startNavigating()
  assert.deepEqual(await page.readPage([{ text: 'Done', ignoreCase: false }], 1000), { url: 'http://app.test/start', navigating: true, found: [] })
  assert.deepEqual(sent, [])
})

test('a navigation within the document is not one that replaces it, and the page is read', async () => {
  const { page, startNavigating } = pageAnswering(() => value({ found: [true], title: '' }))
  startNavigating('historySameDocument')
  assert.deepEqual(await page.readPage([{ text: 'Done', ignoreCase: false }], 1000), { url: 'http://app.test/start', navigating: false, found: [true] })
})

test('a navigation that begins while the page is read ends the read at once, and the reading says the page is opening another', async () => {
  const asked = Promise.withResolvers<void>()
  const { page, startNavigating } = pageAnswering(() => {
    asked.resolve()
    return never()
  })
  const reading = page.readPage([{ text: 'Done', ignoreCase: false }], 5000)
  await asked.promise
  const started = performance.now()
  startNavigating()
  assert.deepEqual(await reading, { url: 'http://app.test/start', navigating: true, found: [] })
  assert.ok(performance.now() - started < 1000)
})

test('once the new document commits, the reading is of that document', async () => {
  const { page, emit, startNavigating } = pageAnswering((functionDeclaration) =>
    functionDeclaration === readPageFunction ? value({ found: [false], title: 'Next' }) : value({ href: 'http://app.test/next?code=1', title: 'Next' }),
  )
  startNavigating()
  emit('Page.frameNavigated', { frame: { id: mainFrame, url: 'http://app.test/next?code=1', loaderId: 'L2' } })
  assert.equal(page.url, 'http://app.test/next')
  assert.deepEqual(await page.readPage([{ text: 'Done', ignoreCase: false }], 1000), { url: 'http://app.test/next', title: 'Next', navigating: false, found: [false] })
})

test('a page a dialog holds, or one that does not answer in time, cannot be read, and the error says which', async () => {
  const held = pageAnswering(() => value({ found: [true], title: '' }))
  held.emit('Page.javascriptDialogOpening', { type: 'confirm' })
  await assert.rejects(held.page.readPage([], 1000), (error) => error instanceof BrowserError && error.failure.class === 'unsupported')
  assert.deepEqual(held.sent, [])
  const silentPage = pageAnswering(() => never())
  await assert.rejects(
    silentPage.page.readPage([], 50),
    (error) => error instanceof BrowserError && error.failure.class === 'timeout' && error.failure.message === 'Could not read the page within 50 ms.',
  )
})
