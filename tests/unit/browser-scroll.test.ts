import type { GuardVerdict } from '../../src/browser/input-guard.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { wheelFailure } from '../../src/browser/input-guard.ts'
import { armDocumentFunction, disarmFunction, prepareFunction, verdictFunction } from '../../src/browser/page-scripts.ts'
import { functionsCalled, scriptedPage, value } from './browser-fixtures.ts'

const page = { href: 'http://app.test/feed', title: 'Feed' }
const terms = { by: 'testId', value: 'terms' } as const

// A page whose look is ready at `point` with the visual viewport at `scale`, and whose guard saw `verdict`.
function wheelPage(point: { x: number; y: number }, scale: number, verdict: unknown = { reached: ['wheel'], intercepted: null, landed: '<div>', leaving: null }) {
  const ready = { status: 'ready', point, token: 2, via: null, scale, page, plan: null }
  return scriptedPage({
    call: (source) => {
      if (source === prepareFunction || source === armDocumentFunction) return value(ready)
      if (source === verdictFunction) return value(verdict)
      if (source === disarmFunction) return value(true)
      return Promise.reject(new Error('unexpected call'))
    },
  })
}

function wheels(sent: { method: string; params: unknown }[]): unknown[] {
  return sent.flatMap(({ method, params }) => (method === 'Input.dispatchMouseEvent' ? [params] : []))
}

test('an element is scrolled by one wheel event at its centre, whose delta is in CSS pixels at the page scale', async () => {
  const { page: owned, sent } = wheelPage({ x: 120, y: 340 }, 0.5)
  assert.deepEqual(await owned.execute({ kind: 'scroll', locator: terms, x: 0, y: 600 }, 1000), { ok: true, kind: 'scroll', page: { url: 'http://app.test/feed', title: 'Feed' } })
  assert.deepEqual(wheels(sent), [{ type: 'mouseWheel', x: 120, y: 340, deltaX: 0, deltaY: 300 }])
  assert.deepEqual(functionsCalled(sent), [prepareFunction, verdictFunction, disarmFunction])
})

test('the page is scrolled at the centre of the viewport, which the document arms for any of its elements', async () => {
  const { page: owned, sent } = wheelPage({ x: 400, y: 300 }, 1)
  assert.deepEqual(await owned.execute({ kind: 'scroll', x: -50, y: 0 }, 1000), { ok: true, kind: 'scroll', page: { url: 'http://app.test/feed', title: 'Feed' } })
  assert.deepEqual(wheels(sent), [{ type: 'mouseWheel', x: 400, y: 300, deltaX: -50, deltaY: 0 }])
  assert.deepEqual(functionsCalled(sent), [armDocumentFunction, verdictFunction, disarmFunction])
})

test('a scroll with no distance, or a distance that is not a finite number, is usage before anything is sent', async () => {
  const { page: owned, sent } = wheelPage({ x: 1, y: 1 }, 1)
  for (const delta of [
    { x: 0, y: 0 },
    { x: Number.NaN, y: 10 },
    { x: 0, y: Number.POSITIVE_INFINITY },
  ]) {
    const result = await owned.execute({ kind: 'scroll', locator: terms, ...delta }, 1000)
    assert.ok(!result.ok && result.failure.class === 'usage', JSON.stringify(result))
  }
  assert.deepEqual(sent, [])
})

test('a wheel another element took fails naming it, and nothing scrolled', async () => {
  const verdict = { reached: [], intercepted: { event: 'wheel', by: '<div class="overlay">' }, landed: '<div class="overlay">', leaving: null }
  const { page: owned } = wheelPage({ x: 1, y: 1 }, 1, verdict)
  assert.deepEqual(await owned.execute({ kind: 'scroll', locator: terms, x: 0, y: 100 }, 1000), {
    ok: false,
    failure: {
      class: 'not_actionable',
      message: `Could not scroll getByTestId('terms'): another element, <div class="overlay">, took the wheel. Retest stopped it before the page received it, and nothing scrolled.`,
      details: { check: 'hit-target', interceptedBy: '<div class="overlay">', event: 'wheel' },
    },
  })
})

test('a wheel that never reached the document, or whose document was replaced, leaves the outcome unknown', () => {
  const unseen: GuardVerdict = { kind: 'seen', reached: [], intercepted: null, landed: '<iframe>', leaving: null }
  assert.deepEqual(wheelFailure(unseen, undefined), {
    class: 'outcome_unknown',
    message: "Retest turned the wheel at the centre of the viewport, but it never reached the page's document, and <iframe> is at that point. Retest cannot tell what received it.",
    details: { landed: '<iframe>' },
  })
  assert.match(wheelFailure(unseen, terms)?.message ?? '', /^Retest turned the wheel at the centre of getByTestId\('terms'\), but it never reached the element's document/)
  assert.deepEqual(wheelFailure({ kind: 'replaced' }, undefined), {
    class: 'outcome_unknown',
    message: 'The page moved to a new document while Retest tried to scroll the page, so Retest cannot tell whether the scroll took effect.',
    details: { reason: 'the page moved to a new document' },
  })
  assert.equal(wheelFailure({ kind: 'seen', reached: ['wheel'], intercepted: null, landed: '<div>', leaving: null }, terms), undefined)
})
