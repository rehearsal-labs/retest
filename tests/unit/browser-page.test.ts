import type { SessionIdentity, SessionOwner } from '../../src/browser/contract.ts'
import type { RecordIdentity } from '../../src/protocol/identity.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BrowserError } from '../../src/browser/browser-error.ts'
import { CdpTimeoutError } from '../../src/browser/cdp/errors.ts'
import { disarmFunction, pageLookFunction, prepareFunction, readPageFunction, verdictFunction } from '../../src/browser/page-scripts.ts'
import { functionsCalled, isRecord, mainFrame, never, scriptedPage, value } from './browser-fixtures.ts'

// A page over a scripted session: `call` answers each call into Retest's world by its function.
function pageAnswering(call: (functionDeclaration: unknown) => Promise<unknown>) {
  return scriptedPage({ call })
}

const facts = { href: 'http://app.test/start?token=1', title: 'Start' }

test('a press readies its element, then sends the key down and up as real key events while the guard watches', async () => {
  const { page, sent } = pageAnswering((functionDeclaration) => {
    if (functionDeclaration === prepareFunction) return value({ status: 'ready', point: null, token: 1, via: null, scale: 1, page: facts, plan: null })
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
      { type: 'rawKeyDown', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16, modifiers: 8, location: 1 },
      { type: 'rawKeyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers: 8 },
      { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers: 8 },
      { type: 'keyUp', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16, modifiers: 0, location: 1 },
      'Runtime.callFunctionOn',
    ],
  )
  assert.deepEqual(functionsCalled(sent), [prepareFunction, verdictFunction, disarmFunction])
  const [prepared] = sent.filter(({ method }) => method === 'Runtime.callFunctionOn')
  assert.ok(isRecord(prepared?.params) && Array.isArray(prepared.params['arguments']))
  assert.deepEqual(prepared.params['arguments'][0], { value: { action: 'press', strokes: 2 } }, 'the guard waits for both keys to come up')
})

test('a hover readies its element, then moves the mouse to its centre while the guard watches, and presses nothing', async () => {
  const { page, sent } = pageAnswering((functionDeclaration) => {
    if (functionDeclaration === prepareFunction) return value({ status: 'ready', point: { x: 30, y: 40 }, token: 1, via: null, scale: 1, page: facts, plan: null })
    if (functionDeclaration === verdictFunction) return value({ reached: ['pointerover', 'pointermove', 'mouseover', 'mousemove'], intercepted: null, landed: '<button>', leaving: null })
    if (functionDeclaration === disarmFunction) return value(true)
    return Promise.reject(new Error('unexpected call'))
  })
  const result = await page.execute({ kind: 'hover', locator: { by: 'testId', value: 'menu' } }, 1000)
  assert.deepEqual(result, { ok: true, kind: 'hover', page: { url: 'http://app.test/start', title: 'Start' } })
  assert.deepEqual(sent.filter(({ method }) => method.startsWith('Input.')).map(({ params }) => params), [{ type: 'mouseMoved', x: 30, y: 40 }])
  const [prepared] = sent.filter(({ method }) => method === 'Runtime.callFunctionOn')
  assert.ok(isRecord(prepared?.params) && Array.isArray(prepared.params['arguments']))
  assert.deepEqual(prepared.params['arguments'][0], { value: { action: 'hover' } })
})

test('a look at the page answers its whole address and title as the page has them, the base URL, and a title unknown while another document is on its way', async () => {
  const looks = [
    value({ url: 'http://app.test/start?tab=2#top', title: ' Tasks ', cut: [] }),
    value({ url: 'http://app.test/start', title: 'Report', cut: ['title'] }),
  ]
  let looked = 0
  const answer = (functionDeclaration: unknown) => (functionDeclaration === pageLookFunction ? (looks[looked++] ?? Promise.reject(new Error('one look too many'))) : Promise.reject(new Error('unexpected')))
  const { page, startNavigating } = pageAnswering(answer)
  const look = await page.execute({ kind: 'observePage' }, 1000)
  assert.ok(look.ok && look.kind === 'observePage', JSON.stringify(look))
  assert.deepEqual([look.observation, look.baseUrl, look.page], [{ url: 'http://app.test/start?tab=2#top', title: ' Tasks ' }, 'http://app.test/', { url: 'http://app.test/start', title: ' Tasks ' }])
  const cut = await page.execute({ kind: 'observePage' }, 1000)
  assert.deepEqual(cut.ok && cut.kind === 'observePage' ? cut.observation : undefined, { url: 'http://app.test/start', title: 'Report', cut: ['title'] })
  startNavigating()
  const opening = await page.execute({ kind: 'observePage' }, 1000)
  assert.ok(opening.ok && opening.kind === 'observePage')
  assert.deepEqual(opening.observation, { url: 'http://app.test/start?token=1#top', title: null }, 'the address the frame holds, whole')
})

test('the page refuses a key it cannot send before it sends anything, as usage', async () => {
  const { page, sent } = pageAnswering(() => Promise.reject(new Error('nothing should reach the page')))
  const modifier = await page.execute({ kind: 'press', key: 'Ctrl+a' }, 1000)
  assert.ok(!modifier.ok && modifier.failure.class === 'usage', JSON.stringify(modifier))
  const unknown = await page.execute({ kind: 'press', locator: { by: 'testId', value: 'query' }, key: 'Entr' }, 1000)
  assert.ok(!unknown.ok && unknown.failure.class === 'usage', JSON.stringify(unknown))
  assert.deepEqual(sent, [])
})

test('reading the page sends the queries as arguments and answers with its address, as origin and path, its title as the page has it and what it found', async () => {
  const queries = [
    { text: 'Order placed', ignoreCase: false },
    { text: 'error', ignoreCase: true },
  ]
  const reading = value({ found: [true, false], title: '  Order\u0007 placed ', body: true })
  const { page, sent } = pageAnswering((functionDeclaration) => (functionDeclaration === readPageFunction ? reading : Promise.reject(new Error('unexpected'))))
  assert.deepEqual(await page.readPage(queries, 1000), { url: 'http://app.test/start', title: '  Order\u0007 placed ', navigating: false, found: [true, false] })
  const call = sent.find(({ method }) => method === 'Runtime.callFunctionOn')
  assert.ok(isRecord(call?.params))
  assert.deepEqual(call.params['arguments'], [{ value: queries }])
  assert.equal(sent.filter(({ method }) => method.startsWith('Input.')).length, 0, 'reading sends no input')
})

test('while the frame is opening another document the page is not read, and the reading says so', async () => {
  const { page, sent, startNavigating } = pageAnswering(() => value({ found: [true], title: '', body: true }))
  startNavigating()
  assert.deepEqual(await page.readPage([{ text: 'Done', ignoreCase: false }], 1000), { url: 'http://app.test/start', navigating: true, found: [] })
  assert.deepEqual(sent, [])
})

test('a navigation within the document is not one that replaces it, and the page is read', async () => {
  const { page, startNavigating } = pageAnswering(() => value({ found: [true], title: '', body: true }))
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
    functionDeclaration === readPageFunction ? value({ found: [false], title: 'Next', body: true }) : value({ href: 'http://app.test/next?code=1', title: 'Next' }),
  )
  startNavigating()
  emit('Page.frameNavigated', { frame: { id: mainFrame, url: 'http://app.test/next?code=1', loaderId: 'L2' } })
  assert.equal(page.url, 'http://app.test/next')
  assert.deepEqual(await page.readPage([{ text: 'Done', ignoreCase: false }], 1000), { url: 'http://app.test/next', title: 'Next', navigating: false, found: [false] })
})

test('a page a dialog holds, or one that does not answer in time, cannot be read, and the error says which', async () => {
  const held = pageAnswering(() => value({ found: [true], title: '', body: true }))
  held.emit('Page.javascriptDialogOpening', { type: 'confirm' })
  await assert.rejects(held.page.readPage([], 1000), (error) => error instanceof BrowserError && error.failure.class === 'unsupported')
  assert.deepEqual(held.sent, [])
  const silentPage = pageAnswering(() => never())
  await assert.rejects(
    silentPage.page.readPage([], 50),
    (error) => error instanceof BrowserError && error.failure.class === 'timeout' && error.failure.message === 'Could not read the page within 50 ms.',
  )
})

// Only Retest's own function answers a read, so an answer of the wrong shape is a fault of the browser, not a page.
test('a reading that answers another number of queries than it was asked is refused as a protocol problem', async () => {
  const { page } = pageAnswering(() => value({ found: [true], title: 'Order placed', body: true }))
  const queries = [
    { text: 'Order placed', ignoreCase: false },
    { text: 'error', ignoreCase: true },
  ]
  await assert.rejects(page.readPage(queries, 1000), /got a response that could not be read: it answered 1 of 2 text queries/)
  await assert.rejects(pageAnswering(() => value({ found: [], title: '', body: true })).page.readPage([{ text: 'Done', ignoreCase: false }], 1000), /answered 0 of 1/)
})

test('a document with no body says so, rather than reading as empty text', async () => {
  const { page } = pageAnswering(() => value({ found: [false], title: '', body: false }))
  assert.deepEqual(await page.readPage([{ text: 'Done', ignoreCase: false }], 1000), { url: 'http://app.test/start', navigating: false, found: [false], body: false })
})

// A command timer can fire before its time by the monotonic clock; a poll then takes the timeout as the failure of its
// check instead of its deadline. This one fires as soon as the look is sent.
test('a look whose read times out before its budget has passed tells the timeout only once the budget has passed', async () => {
  const budgetMs = 40
  const early = new CdpTimeoutError({ method: 'Runtime.callFunctionOn', sessionId: 'S1' }, { timeoutMs: budgetMs, written: true })
  const { page } = pageAnswering((functionDeclaration) => (functionDeclaration === pageLookFunction ? Promise.reject(early) : Promise.reject(new Error('unexpected'))))
  const startedAt = performance.now()
  const look = await page.execute({ kind: 'observePage' }, budgetMs)
  const answeredAfterMs = performance.now() - startedAt
  assert.ok(!look.ok && look.failure.class === 'timeout', JSON.stringify(look))
  assert.equal(look.failure.message, `The page did not answer within ${budgetMs} ms while Retest tried to read the page.`)
  assert.ok(answeredAfterMs >= budgetMs, `the timeout came ${answeredAfterMs} ms after the look began, before its ${budgetMs} ms had passed`)
})

// Each command's timer is set for the whole milliseconds its budget has left, so it is due before the budget ends.
test('a look whose read never answers tells the timeout only once its whole budget has passed', async () => {
  const budgetMs = 40
  const { page } = pageAnswering(() => never())
  const startedAt = performance.now()
  const look = await page.execute({ kind: 'observePage' }, budgetMs)
  const answeredAfterMs = performance.now() - startedAt
  assert.ok(!look.ok && look.failure.class === 'timeout', JSON.stringify(look))
  assert.ok(answeredAfterMs >= budgetMs, `the timeout came ${answeredAfterMs} ms after the look began, before its ${budgetMs} ms had passed`)
})

// An action looks for its element until the time is up, each pause cut to the whole milliseconds left, so the last look
// can fail with part of a millisecond still to go. The refusal says it waited the whole budget, so it is told only then.
test('a click on an element that never appears is refused only once its whole budget has passed, every time', async () => {
  const budgetMs = 20
  const { page } = pageAnswering((functionDeclaration) => (functionDeclaration === prepareFunction ? value({ status: 'missing', empty: null }) : Promise.reject(new Error('unexpected call'))))
  const early: number[] = []
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const startedAt = performance.now()
    const refused = await page.execute({ kind: 'click', locator: { by: 'testId', value: 'never' } }, budgetMs)
    const answeredAfterMs = performance.now() - startedAt
    assert.ok(!refused.ok && refused.failure.class === 'not_found' && refused.failure.details?.['waitedMs'] === budgetMs, JSON.stringify(refused))
    if (answeredAfterMs < budgetMs) early.push(answeredAfterMs)
  }
  assert.deepEqual(early, [], `refusals told before their ${budgetMs} ms had passed`)
})

test('a refusal that comes at once, before the budget runs out, is not held', async () => {
  const { page } = pageAnswering((functionDeclaration) => (functionDeclaration === prepareFunction ? value({ status: 'ambiguous', count: 2 }) : Promise.reject(new Error('unexpected call'))))
  const startedAt = performance.now()
  const refused = await page.execute({ kind: 'click', locator: { by: 'testId', value: 'twice' } }, 5000)
  assert.ok(!refused.ok && refused.failure.class === 'ambiguous', JSON.stringify(refused))
  assert.ok(performance.now() - startedAt < 1000, 'the refusal waited for the budget')
})

test('a non-time failure in the last fraction of the budget is returned before a later stop', async (t) => {
  let now = 0
  t.mock.method(performance, 'now', () => now)
  const stop = new AbortController()
  let handle: ReturnType<typeof setTimeout> | undefined
  const { page } = pageAnswering((functionDeclaration) => {
    if (functionDeclaration !== prepareFunction) return Promise.reject(new Error('unexpected call'))
    now = 9.5
    handle = setTimeout(() => stop.abort({ class: 'interrupted', message: 'Stopped after the failure.' }), 0)
    return value({ status: 'ambiguous', count: 2 })
  })
  t.after(() => clearTimeout(handle))
  const result = await page.execute({ kind: 'click', locator: { by: 'testId', value: 'twice' } }, 10, stop.signal)
  assert.ok(!result.ok && result.failure.class === 'ambiguous', JSON.stringify(result))
  assert.equal(stop.signal.aborted, false, 'the failure returned without waiting for the later stop')
})

test('a command stopped while its early timeout waits out the budget is stopped at once, with the stop’s own class', async () => {
  const early = new CdpTimeoutError({ method: 'Runtime.callFunctionOn', sessionId: 'S1' }, { timeoutMs: 5000, written: true })
  const { page } = pageAnswering(() => Promise.reject(early))
  const stop = new AbortController()
  const startedAt = performance.now()
  const looking = page.execute({ kind: 'observePage' }, 5000, stop.signal)
  setTimeout(() => stop.abort({ class: 'interrupted', message: 'The run was stopped.' }), 20)
  const look = await looking
  assert.ok(!look.ok && look.failure.class === 'interrupted', JSON.stringify(look))
  assert.ok(performance.now() - startedAt < 1000, 'the stop did not wait for the rest of the budget')
})

const owner: SessionOwner = { runId: 'run-1', testId: 'tests/tasks.retest.ts > saves', attemptId: 'k3v9q0x2mb', app: 'web' }
const runtime: SessionIdentity['runtime'] = { kind: 'web', engine: 'chromium', product: 'Chrome', version: '140.0.0.0', executablePath: '/Applications/Chrome.app', processIds: [101] }
const named: RecordIdentity = { testId: owner.testId, attemptId: owner.attemptId, app: owner.app, sessionId: 'k3v9q0x2mb:web' }

function session(changes: Partial<SessionOwner> = {}, sessionId = named.sessionId): SessionIdentity {
  return { sessionId, owner: { ...owner, ...changes }, runtime }
}

test('a page named once refuses to be named again by any other owner, the run included, and takes the same owner again', () => {
  const { page } = pageAnswering(() => never())
  page.identify(session())
  page.identify(session())
  assert.throws(() => page.identify(session({ runId: 'run-2' })), {
    message: 'This page is session k3v9q0x2mb:web of run run-1, test "tests/tasks.retest.ts > saves"; it cannot become session k3v9q0x2mb:web of run run-2, test "tests/tasks.retest.ts > saves".',
  })
  assert.throws(() => page.identify(session({ testId: 'tests/tasks.retest.ts > edits' })), /cannot become session k3v9q0x2mb:web of run run-1, test "tests\/tasks.retest.ts > edits"/)
  assert.throws(() => page.identify(session({ app: 'phone' }, 'k3v9q0x2mb:phone')), /cannot become session k3v9q0x2mb:phone/)
  assert.equal(page.frameSource(named).availability().available, true, 'the page is still the session it was first named')
})

test('an owner with an empty part is refused, even when the session id matches what its parts make', () => {
  const { page } = pageAnswering(() => never())
  assert.throws(() => page.identify(session({ attemptId: '', app: '' }, ':')), { message: "A session's owner names its run, test, attempt and app; this one names no attemptId, app." })
  assert.throws(() => page.identify(session({ runId: '' })), /names no runId\./)
  assert.throws(() => page.identify(session({ testId: '' })), /names no testId\./)
  assert.equal(page.frameSource(named).availability().available, false, 'a refused owner leaves the page unnamed')
})

test('the identity a page hands its frame source is frozen, so nothing done with the source or the caller’s objects renames the page', () => {
  const { page } = pageAnswering(() => never())
  const given = session()
  page.identify(given)
  const first = page.frameSource({ ...named })
  assert.ok(Object.isFrozen(first.identity), 'the source’s identity cannot be changed')
  assert.throws(() => Object.assign(first.identity, { sessionId: 'k3v9q0x2mb:phone' }), TypeError)
  Object.assign(given.owner, { runId: 'run-2' })
  const again = page.frameSource({ ...named })
  assert.deepEqual(again.identity, named)
  assert.equal(again.availability().available, true)
  page.identify(session())
})
