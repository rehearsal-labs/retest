import type { CdpSession } from '../../src/browser/cdp/session.ts'
import type { InputDispatch } from '../../src/browser/contract.ts'
import type { Failure } from '../../src/protocol/failures.ts'
import type { LocatorRecipe } from '../../src/protocol/locator.ts'
import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'
import { describe, test } from 'node:test'
import { Channel } from '../../src/browser/cdp/channel.ts'
import { CdpClosedError, CdpDisconnectedError, CdpTimeoutError } from '../../src/browser/cdp/errors.ts'
import { CdpSession as Session } from '../../src/browser/cdp/session.ts'
import { Dispatch } from '../../src/browser/dispatch.ts'
import { disarmFunction, prepareFunction, registrationFunction, verdictFunction } from '../../src/browser/page-scripts.ts'
import { Deadline } from '../../src/protocol/deadline.ts'
import { never, protocolError, scriptedPage, value } from './browser-fixtures.ts'

const command = { method: 'Input.dispatchMouseEvent', sessionId: 'S1' }
const save: LocatorRecipe = { by: 'testId', value: 'save-task' }
const facts = { href: 'http://app.test/start', title: 'Start' }
const stopped: Failure = { class: 'interrupted', message: 'The run was interrupted.' }

function sessionAnswering(answer: () => Promise<unknown>): CdpSession {
  return new Session('S1', new Channel('S1', () => {}), answer)
}

async function inputAfter(answers: (() => Promise<unknown>)[]): Promise<InputDispatch> {
  const dispatch = new Dispatch()
  for (const answer of answers) {
    await dispatch.send(sessionAnswering(answer), 'Input.dispatchMouseEvent', {}, new Deadline(1000)).catch(() => undefined)
  }
  return dispatch.input
}

describe('how far a command’s input got', () => {
  test('nothing went until a command does; a command the browser answered was sent', async () => {
    assert.equal(new Dispatch().input, 'not_sent')
    assert.equal(await inputAfter([async () => ({})]), 'sent')
    assert.equal(await inputAfter([() => Promise.reject(new CdpClosedError(command, 'the browser closed the pipe'))]), 'not_sent')
  })

  test('a command that went without an answer leaves the input unknown, and a later answer does not undo it', async () => {
    const lost = () => Promise.reject(new CdpDisconnectedError(command, { reason: 'gone', written: true }))
    const late = () => Promise.reject(new CdpTimeoutError(command, { timeoutMs: 1, written: true }))
    assert.equal(await inputAfter([lost]), 'unknown')
    assert.equal(await inputAfter([late]), 'unknown')
    assert.equal(await inputAfter([async () => ({}), lost]), 'unknown', 'a press answered, then a release lost')
    assert.equal(await inputAfter([lost, async () => ({})]), 'unknown', 'a later answer')
  })

  test('an attempt is sent when its answer says it acted, and unknown when it went and no answer could be read', async () => {
    const acted = (answer: unknown) => typeof answer === 'object' && answer !== null && 'acted' in answer && answer.acted === true
    const sent = new Dispatch()
    await sent.attempt((attempt) => attempt.send(sessionAnswering(async () => ({ acted: true })), 'Runtime.callFunctionOn', {}, new Deadline(1000)), acted)
    assert.equal(sent.input, 'sent')
    const declined = new Dispatch()
    await declined.attempt((attempt) => attempt.send(sessionAnswering(async () => ({ acted: false })), 'Runtime.callFunctionOn', {}, new Deadline(1000)), acted)
    assert.equal(declined.input, 'not_sent')
    const unread = new Dispatch()
    const unreadable = new Error('the answer had the wrong shape')
    const send = async (attempt: Dispatch) => {
      await attempt.send(sessionAnswering(async () => ({ acted: 'perhaps' })), 'Runtime.callFunctionOn', {}, new Deadline(1000))
      throw unreadable
    }
    await assert.rejects(unread.attempt(send, acted), unreadable)
    assert.equal(unread.input, 'unknown')
  })
})

// A click on a scripted page: its element is ready, and each input and page call answers as `script` says.
function clickPage(script: { input?: (method: string, params: unknown) => Promise<unknown>; verdict?: () => Promise<unknown>; registration?: () => Promise<unknown>; prepare?: () => Promise<unknown> } = {}) {
  return scriptedPage({
    call: (functionDeclaration) => {
      if (functionDeclaration === prepareFunction) return script.prepare?.() ?? value({ status: 'ready', point: { x: 10, y: 20 }, token: 1, via: null, scale: 1, page: facts, plan: null })
      if (functionDeclaration === registrationFunction) return script.registration?.() ?? value(true)
      if (functionDeclaration === verdictFunction) return script.verdict?.() ?? value({ reached: ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'], intercepted: null, landed: '<button>', leaving: null })
      if (functionDeclaration === disarmFunction) return value(true)
      return Promise.reject(new Error('unexpected call'))
    },
    ...(script.input === undefined ? {} : { input: script.input }),
  })
}

function mouseEvent(params: unknown, type: string): boolean {
  return typeof params === 'object' && params !== null && 'type' in params && params.type === type
}

function isPress(params: unknown): boolean {
  return mouseEvent(params, 'mousePressed')
}

async function until(condition: () => boolean): Promise<void> {
  while (!condition()) await sleep(1)
}

describe('a web session says how far each command’s input got', () => {
  test('a click the browser took answers with its input sent', async () => {
    const { page } = clickPage()
    const { result, input } = await page.dispatch({ kind: 'click', locator: save }, 1000)
    assert.deepEqual(result, { ok: true, kind: 'click', page: { url: 'http://app.test/start', title: 'Start' } })
    assert.equal(input, 'sent')
  })

  test('a document that disappears before the guard request is acknowledged refuses the click and reports no input', async () => {
    const { page, sent } = clickPage({ verdict: never, registration: () => Promise.reject(protocolError('Runtime.callFunctionOn', 'Execution context was destroyed.')) })
    const { result, input } = await page.dispatch({ kind: 'click', locator: save }, 1000)
    assert.equal(input, 'not_sent')
    assert.ok(!result.ok)
    assert.deepEqual(result.failure, {
      class: 'not_actionable',
      message: "Could not click getByTestId('save-task'): the page moved to a new document before Retest sent input.",
      details: { reason: 'the page moved to a new document', inputSent: false },
    })
    assert.equal(sent.filter(({ method }) => method.startsWith('Input.')).length, 0)
  })

  test('a click stopped before its input goes sends none, and says so', async () => {
    const { page, sent } = clickPage()
    const stop = new AbortController()
    stop.abort(stopped)
    const { result, input } = await page.dispatch({ kind: 'click', locator: save }, 1000, stop.signal)
    assert.equal(input, 'not_sent')
    assert.ok(!result.ok)
    assert.equal(result.failure.class, 'interrupted')
    assert.match(result.failure.message, /stopped before it could click getByTestId\('save-task'\), and sent nothing/)
    assert.equal(result.failure.details?.['inputSent'], false)
    assert.equal(sent.filter(({ method }) => method.startsWith('Input.')).length, 0)
  })

  test('a click stopped while the browser has not answered its press leaves its input unknown, sends nothing more and takes nothing back', async () => {
    const { page, sent } = clickPage({ input: (_method, params) => (isPress(params) ? never() : Promise.resolve({})) })
    const stop = new AbortController()
    const dispatched = page.dispatch({ kind: 'click', locator: save }, 1000, stop.signal)
    await until(() => sent.some(({ params }) => isPress(params)))
    stop.abort(stopped)
    const { result, input } = await dispatched
    assert.equal(input, 'unknown')
    assert.ok(!result.ok)
    assert.equal(result.failure.class, 'interrupted')
    assert.match(result.failure.message, /Input it sent is not taken back, so it may have taken effect/)
    assert.equal(result.failure.details?.['inputSent'], true)
    await sleep(20)
    const released = sent.filter(({ params }) => typeof params === 'object' && params !== null && 'type' in params && params.type === 'mouseReleased')
    assert.deepEqual(released, [], 'the release is never sent')
  })

  test('a click stopped after the browser took its input says the input was sent, and takes nothing back', async () => {
    const { page, sent } = clickPage({ verdict: never })
    const stop = new AbortController()
    const dispatched = page.dispatch({ kind: 'click', locator: save }, 1000, stop.signal)
    await until(() => sent.filter(({ method }) => method === 'Input.dispatchMouseEvent').length === 3)
    await sleep(5)
    stop.abort(stopped)
    const { result, input } = await dispatched
    assert.equal(input, 'sent')
    assert.ok(!result.ok)
    assert.match(result.failure.message, /Input it sent is not taken back/)
  })

  test('a browser lost after the browser took the click answers outcome unknown, with its input sent', async () => {
    const { page } = clickPage({ verdict: () => Promise.reject(new CdpDisconnectedError({ method: 'Runtime.callFunctionOn', sessionId: 'S1' }, { reason: 'the browser closed the pipe', written: true })) })
    const { result, input } = await page.dispatch({ kind: 'click', locator: save }, 1000)
    assert.equal(input, 'sent')
    assert.ok(!result.ok)
    assert.equal(result.failure.class, 'outcome_unknown')
    assert.match(result.failure.message, /lost the page after it began to click getByTestId\('save-task'\)/)
  })

  test('a browser lost while the press was on its way answers outcome unknown, with its input unknown', async () => {
    const lost = new CdpDisconnectedError(command, { reason: 'the browser closed the pipe', written: true })
    const { page } = clickPage({ input: (_method, params) => (isPress(params) ? Promise.reject(lost) : Promise.resolve({})) })
    const { result, input } = await page.dispatch({ kind: 'click', locator: save }, 1000)
    assert.equal(input, 'unknown')
    assert.ok(!result.ok)
    assert.equal(result.failure.class, 'outcome_unknown')
  })

  test('a browser lost before any input went answers session lost, with nothing sent', async () => {
    const lost = new CdpDisconnectedError({ method: 'Runtime.callFunctionOn', sessionId: 'S1' }, { reason: 'the browser closed the pipe', written: true })
    const { page, sent } = clickPage({ prepare: () => Promise.reject(lost) })
    const { result, input } = await page.dispatch({ kind: 'click', locator: save }, 1000)
    assert.equal(input, 'not_sent')
    assert.ok(!result.ok)
    assert.equal(result.failure.class, 'session_lost')
    assert.equal(sent.filter(({ method }) => method.startsWith('Input.')).length, 0)
  })

  test('a click stopped while the browser has not answered its mouse move leaves its input unknown, and sends no press', async () => {
    const { page, sent } = clickPage({ input: (_method, params) => (mouseEvent(params, 'mouseMoved') ? never() : Promise.resolve({})) })
    const stop = new AbortController()
    const dispatched = page.dispatch({ kind: 'click', locator: save }, 1000, stop.signal)
    await until(() => sent.some(({ params }) => mouseEvent(params, 'mouseMoved')))
    stop.abort(stopped)
    const { result, input } = await dispatched
    assert.equal(input, 'unknown', 'a move can set off hover handlers')
    assert.ok(!result.ok)
    assert.match(result.failure.message, /Input it sent is not taken back/)
    assert.equal(sent.filter(({ params }) => isPress(params)).length, 0)
  })

  test('an input event the browser answers with an error leaves the input unknown, as the failure says it cannot tell', async () => {
    const { page } = clickPage({ input: (_method, params) => (isPress(params) ? Promise.reject(protocolError('Input.dispatchMouseEvent', 'odd')) : Promise.resolve({})) })
    const { result, input } = await page.dispatch({ kind: 'click', locator: save }, 1000)
    assert.equal(input, 'unknown')
    assert.ok(!result.ok)
    assert.equal(result.failure.class, 'outcome_unknown')
    assert.match(result.failure.message, /cannot tell whether that took effect/)
  })

  test('execute answers as dispatch does, without the dispatch', async () => {
    const { page } = clickPage()
    assert.deepEqual(await page.execute({ kind: 'click', locator: save }, 1000), (await clickPage().page.dispatch({ kind: 'click', locator: save }, 1000)).result)
  })
})
