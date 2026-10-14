import type { RouteRefusal } from '../../src/browser/routes.ts'
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { readDragOptions } from '../../src/api/drag.ts'
import { CdpTimeoutError } from '../../src/browser/cdp/errors.ts'
import { between } from '../../src/browser/drag.ts'
import { fetchPattern, PageRoutes, RouteTable } from '../../src/browser/routes.ts'
import { Deadline } from '../../src/protocol/deadline.ts'
import { commandLocators, describeCommand } from '../../src/protocol/commands.ts'
import { describeDragArguments, dragProblem } from '../../src/protocol/drag.ts'
import {
  describeRoutePattern,
  describeRouteSummary,
  globSource,
  routeAnswerProblem,
  routeMatches,
  routePatternProblem,
  routeRequestProblem,
  samePattern,
  summarizeRouteAnswer,
} from '../../src/protocol/routes.ts'
import { describeRouteChange } from '../../src/reporters/routes.ts'
import { Redactor } from '../../src/runner/redactor.ts'
import { never, protocolError, scriptedSession } from './browser-fixtures.ts'

// The pure parts of routes and drags: which addresses a glob or an expression matches, what both processes refuse, how
// a route and a drag are written in steps and reports, and the positions a drag's moves go through.

const page = 'http://127.0.0.1:4173'

test('** matches any run of characters and * any run without a slash, against the whole address', () => {
  const cases: [string, string, boolean][] = [
    ['**/api/tasks', `${page}/api/tasks`, true],
    ['**/api/tasks', `${page}/v1/api/tasks`, true],
    ['**/api/tasks', `${page}/api/tasks?page=2`, false],
    ['**/api/tasks*', `${page}/api/tasks?page=2`, true],
    ['**/api/*', `${page}/api/tasks`, true],
    ['**/api/*', `${page}/api/tasks/7`, false],
    ['**/api/**', `${page}/api/tasks/7`, true],
    [`${page}/api/tasks`, `${page}/api/tasks`, true],
    [`${page}/api/tasks`, `${page}/api/tasks/7`, false],
    ['http://*/api/tasks', `${page}/api/tasks`, true],
    ['http://*/api/tasks', 'https://127.0.0.1:4173/api/tasks', false],
    ['**/a.b?c', `${page}/a.b?c`, true],
    ['**/a.b?c', `${page}/aXb?c`, false],
    ['**/(x)+[y]', `${page}/(x)+[y]`, true],
  ]
  for (const [glob, url, expected] of cases) assert.equal(routeMatches(glob, url), expected, `${glob} against ${url}`)
  assert.equal(globSource('**/api/*'), '^.*\\/api\\/[^/]*$')
})

test('a regular expression is searched for anywhere in the address, with its own flags, and a g flag carries nothing over', () => {
  const pattern = { pattern: '\\/api\\/TASKS\\/\\d+$', flags: 'gi' }
  assert.equal(routeMatches(pattern, `${page}/api/tasks/7`), true)
  assert.equal(routeMatches(pattern, `${page}/api/tasks/7`), true)
  assert.equal(routeMatches(pattern, `${page}/api/tasks`), false)
})

test('Chrome holds at least what a glob matches, and every request once a route is a regular expression', () => {
  assert.equal(fetchPattern('**/api/tasks'), '*/api/tasks')
  assert.equal(fetchPattern('**/a?b\\c*'), '*/a\\?b\\\\c*')
  assert.equal(fetchPattern({ pattern: 'tasks', flags: '' }), '*')
  const table = new RouteTable()
  assert.deepEqual(table.patterns(), [])
})

test('both processes refuse a pattern that is not a whole address, a body given twice, and a status out of range', () => {
  assert.equal(routePatternProblem('/api/tasks', 'route'), "page.route() matches the whole address, received '/api/tasks'. Start it with ** or a scheme, such as '**/api/tasks'.")
  assert.equal(routePatternProblem('', 'unroute'), 'page.unroute() takes a pattern of the whole address, received an empty one.')
  assert.equal(routePatternProblem('*.example.com/**', 'route'), undefined)
  assert.equal(routePatternProblem('https://example.com/api', 'route'), undefined)
  assert.match(routePatternProblem({ pattern: '(', flags: '' }, 'route') ?? '', /^page\.route\(\) takes a regular expression JavaScript can read: /)
  assert.equal(routeAnswerProblem({ status: 99 }), 'page.route() takes status as a whole number from 200 to 599, received 99.')
  assert.equal(routeAnswerProblem({ status: 600 }), 'page.route() takes status as a whole number from 200 to 599, received 600.')
  assert.equal(routeAnswerProblem({ body: 'a', base64: 'YQ==' }), 'page.route() takes a body as text or as bytes, not both.')
  assert.equal(routeAnswerProblem({ base64: 'not base64!' }), 'page.route() received bytes for a body that are not base64.')
  assert.equal(routeAnswerProblem({ headers: { 'x total': '1' } }), "page.route() takes header names made of letters, digits and !#$%&'*+.^_`|~-, received \"x total\".")
  assert.equal(routeAnswerProblem({ headers: { 'x-total': 'a\r\nb' } }), 'page.route() takes header values without a line break, received one for "x-total".')
  assert.equal(routeAnswerProblem({ contentType: '' }), "page.route() takes contentType as a header value, such as 'application/json'.")
  assert.equal(routeAnswerProblem({ abort: 'timedout' }), undefined)
  assert.deepEqual(routeRequestProblem({ kind: 'remove', pattern: '' }), { class: 'usage', message: 'page.unroute() takes a pattern of the whole address, received an empty one.' })
})

test('unroute takes away the routes of the same pattern only: the same glob, or the same source and flags', () => {
  assert.equal(samePattern('**/api/tasks', '**/api/tasks'), true)
  assert.equal(samePattern('**/api/tasks', '**/api/tasks*'), false)
  assert.equal(samePattern({ pattern: 'a', flags: 'g' }, { pattern: 'a', flags: 'g' }), true)
  assert.equal(samePattern({ pattern: 'a', flags: 'g' }, { pattern: 'a', flags: '' }), false)
  assert.equal(samePattern('a', { pattern: 'a', flags: '' }), false)
})

test('a route is written as the test wrote it, and its answer by status, type and size, never its body', () => {
  assert.equal(describeRoutePattern('**/api/tasks'), "'**/api/tasks'")
  assert.equal(describeRoutePattern({ pattern: '\\/api\\/tasks\\/\\d+$', flags: '' }), '/\\/api\\/tasks\\/\\d+$/')
  assert.deepEqual(summarizeRouteAnswer({ contentType: 'application/json', headers: { 'x-total': '3' }, body: 'héllo' }), { status: 200, contentType: 'application/json', headers: ['x-total'], bodyBytes: 6 })
  assert.deepEqual(summarizeRouteAnswer({ status: 204, base64: 'AAEC' }), { status: 204, bodyBytes: 3 })
  assert.deepEqual(summarizeRouteAnswer({ abort: 'namenotresolved' }), { abort: 'namenotresolved' })
  assert.equal(describeRouteSummary({ status: 404, bodyBytes: 1 }), '404, 1 byte')
  assert.equal(describeRouteSummary({ abort: 'failed' }), 'refuses requests as failed')
  assert.equal(describeRouteChange({ operation: 'add', pattern: "'**/api/tasks'", answer: { status: 200, contentType: 'application/json', bodyBytes: 21 } }), "page.route('**/api/tasks') answers 200, application/json, 21 bytes")
  assert.equal(describeRouteChange({ operation: 'add', pattern: "'**/api/slow'", answer: { abort: 'connectionrefused' } }), "page.route('**/api/slow') refuses requests as connectionrefused")
  assert.equal(describeRouteChange({ operation: 'remove', pattern: "'**/api/tasks'", removed: 2 }), "page.unroute('**/api/tasks') removed 2 routes")
  assert.equal(describeRouteChange({ operation: 'answer', pattern: "'**/api/tasks'", url: 'http://127.0.0.1:4173/api/tasks' }), "page.route('**/api/tasks') could not answer http://127.0.0.1:4173/api/tasks, which Retest failed")
})

test('a drag is written as the test wrote it, with its steps only when given, and names its target among its locators', () => {
  const source = { by: 'text', text: 'Write release notes' } as const
  const target = { by: 'testId', value: 'done-column' } as const
  assert.equal(describeCommand({ kind: 'dragTo', locator: source, target }), "getByText('Write release notes').dragTo(getByTestId('done-column'))")
  assert.equal(describeCommand({ kind: 'dragTo', locator: source, target, steps: 10 }), "getByText('Write release notes').dragTo(getByTestId('done-column'), { steps: 10 })")
  assert.equal(describeDragArguments({ target }), "getByTestId('done-column')")
  assert.deepEqual(commandLocators({ kind: 'dragTo', locator: source, target }), [source, target])
})

test('steps are a whole number from 1 to 100, read with the timeout every action takes', () => {
  assert.equal(dragProblem({}), undefined)
  assert.equal(dragProblem({ steps: 100 }), undefined)
  assert.deepEqual(dragProblem({ steps: 0 }), { class: 'usage', message: 'dragTo() takes steps as a whole number from 1 to 100, received 0.', details: { inputSent: false } })
  assert.equal(dragProblem({ steps: 2.5 })?.message, 'dragTo() takes steps as a whole number from 1 to 100, received 2.5.')
  assert.deepEqual(readDragOptions({ steps: 10, timeout: 2000 }), { ok: true, steps: { steps: 10 }, call: { timeout: 2000 } })
  assert.deepEqual(readDragOptions(undefined), { ok: true, steps: {}, call: undefined })
  assert.deepEqual(readDragOptions({ steps: '10' }), { ok: false, problem: "dragTo() takes steps as a whole number from 1 to 100, received '10'." })
  assert.deepEqual(readDragOptions({ force: true }), { ok: false, problem: 'Unknown dragTo() option "force". Its options are steps and timeout.' })
  assert.deepEqual(readDragOptions('fast'), { ok: false, problem: "dragTo() takes options such as { steps: 10, timeout: 2000 }, received 'fast'." })
})

test('the moves of a drag go along the straight line from the source to the target', () => {
  const from = { x: 10, y: 20 }
  const to = { x: 110, y: 70 }
  assert.deepEqual([1, 2, 3, 4, 5].map((step) => between(from, to, step / 5)), [
    { x: 30, y: 30 },
    { x: 50, y: 40 },
    { x: 70, y: 50 },
    { x: 90, y: 60 },
    { x: 110, y: 70 },
  ])
})

describe("a page's routes, over a scripted session", () => {
  const paused = (url: string, requestId = 'interception-1', networkId = 'n-1') => ({ requestId, request: { url }, networkId })

  test('an answer Chrome refuses is failed in its place, told once, and marked on its hop for the diagnostics', async () => {
    const scripted = scriptedSession(async (method) => {
      if (method === 'Fetch.fulfillRequest') throw protocolError(method, 'Invalid http status code or phrase')
      return {}
    })
    const routes = new PageRoutes(scripted.session, new RouteTable(), (error) => assert.fail(String(error)))
    const refusals: RouteRefusal[] = []
    routes.onRefused((refusal) => refusals.push(refusal))
    assert.deepEqual(await routes.add('**/api/tasks', { status: 299, body: '[]' }, new Deadline(1000)), { ok: true })
    scripted.emit('Fetch.requestPaused', paused('http://127.0.0.1:4173/api/tasks'))
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.deepEqual(scripted.sent.map((command) => command.method), ['Fetch.enable', 'Fetch.fulfillRequest', 'Fetch.failRequest'])
    assert.deepEqual(scripted.sent[1]?.params, { requestId: 'interception-1', responseCode: 299, responsePhrase: 'Status 299', responseHeaders: [], body: Buffer.from('[]').toString('base64') })
    assert.deepEqual(scripted.sent[2]?.params, { requestId: 'interception-1', errorReason: 'Failed' })
    assert.deepEqual(refusals, [{ pattern: "'**/api/tasks'", url: 'http://127.0.0.1:4173/api/tasks', reason: 'Invalid http status code or phrase' }])
    assert.deepEqual(routes.answeredBy('n-1', 'http://127.0.0.1:4173/api/tasks'), { route: "'**/api/tasks'", refused: 'Invalid http status code or phrase' })
    assert.equal(routes.answeredBy('n-1', 'http://127.0.0.1:4173/elsewhere'), undefined, 'another hop of the same request is not marked')
  })

  test('a request the page cancelled before its answer is no refusal: there is nothing left to fail', async () => {
    const scripted = scriptedSession(async (method) => {
      if (method.startsWith('Fetch.f')) throw protocolError(method, 'Invalid InterceptionId.')
      return {}
    })
    const routes = new PageRoutes(scripted.session, new RouteTable(), (error) => assert.fail(String(error)))
    const refusals: RouteRefusal[] = []
    routes.onRefused((refusal) => refusals.push(refusal))
    await routes.add('**/api/tasks', { body: '[]' }, new Deadline(1000))
    scripted.emit('Fetch.requestPaused', paused('http://127.0.0.1:4173/api/tasks'))
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.deepEqual(refusals, [])
    assert.deepEqual(routes.answeredBy('n-1', 'http://127.0.0.1:4173/api/tasks'), { route: "'**/api/tasks'" })
  })

  test('a change Chrome does not confirm leaves the routes as they were: a removal that times out keeps its route answering', async () => {
    let confirm = true
    const scripted = scriptedSession((method) => (method.startsWith('Fetch.enable') || method === 'Fetch.disable') && !confirm ? never() : Promise.resolve({}))
    const routes = new PageRoutes(scripted.session, new RouteTable(), (error) => assert.fail(String(error)))
    await routes.add('**/api/tasks', { body: '[]' }, new Deadline(1000))
    confirm = false
    await assert.rejects(routes.remove('**/api/tasks', new Deadline(50)), (error: unknown) => error instanceof CdpTimeoutError)
    scripted.emit('Fetch.requestPaused', paused('http://127.0.0.1:4173/api/tasks'))
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(scripted.sent.at(-1)?.method, 'Fetch.fulfillRequest', 'the route still answers')
    confirm = true
    assert.deepEqual(await routes.remove('**/api/tasks', new Deadline(1000)), { ok: true, removed: 1 })
    assert.equal(scripted.sent.at(-1)?.method, 'Fetch.disable')
  })
})

test('a secret is hidden where a regular expression writes it, its special characters and its slashes escaped', () => {
  const redactor = new Redactor()
  redactor.learn('token', 'tok.en$7/q')
  assert.equal(redactor.redact('/never\\/tok\\.en\\$7\\/q$/'), '/never\\/{{token}}$/')
  assert.equal(redactor.redact('tok\\.en\\$7/q'), '{{token}}')
})
