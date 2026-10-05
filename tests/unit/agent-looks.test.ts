import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { changedMatches, elementRecipe, isElementRef, sameMatches, SessionLooks } from '../../src/agent/looks.ts'
import { observationOf } from '../support/observation.ts'

// The reference rules an agent session holds every element reference to, on their own: a reference is good only in
// the session that served its look, while that look is kept, on the document the look read, and for a place its list
// has. Each refusal is a usage failure naming why, and none needs the page.

const buttons = { by: 'role', role: 'button' } as const
const three = observationOf([
  { text: 'Save', visible: true },
  { text: 'Cancel', visible: true },
  { text: 'Delete', visible: false },
])

function refusalOf(looks: SessionLooks, ref: unknown): string | undefined {
  const resolved = looks.resolve(ref)
  if (resolved.ok) return undefined
  const reason = resolved.failure.details?.['refused']
  assert.equal(resolved.failure.class, 'usage')
  return typeof reason === 'string' ? reason : 'none'
}

describe('element references', () => {
  test('a reference of a current look resolves to its look and place', () => {
    const looks = new SessionLooks('k3v9q0x2mb:owner')
    const look = looks.serve(buttons, three, looks.generation)
    assert.equal(look.observationId, 'o1')
    const resolved = looks.resolve({ sessionId: 'k3v9q0x2mb:owner', observationId: 'o1', element: 2 })
    assert.ok(resolved.ok)
    assert.equal(resolved.element, 2)
    assert.deepEqual(elementRecipe(resolved.look.locator, resolved.element), { by: 'role', role: 'button', pick: 2 })
  })

  test("another session's reference is refused, even when this session served a look with the same id", () => {
    const discovery = new SessionLooks('aaaaaaaaaa:owner')
    const reproduction = new SessionLooks('bbbbbbbbbb:owner')
    discovery.serve(buttons, three, 0)
    reproduction.serve(buttons, three, 0)
    const resolved = reproduction.resolve({ sessionId: 'aaaaaaaaaa:owner', observationId: 'o1', element: 0 })
    assert.ok(!resolved.ok)
    assert.equal(resolved.failure.details?.['refused'], 'other-session')
    assert.match(resolved.failure.message, /^o1\.e0 of aaaaaaaaaa:owner belongs to the session "aaaaaaaaaa:owner", not to "bbbbbbbbbb:owner"\./)
  })

  test('a look the session never served, and one it no longer keeps, are refused apart', () => {
    const looks = new SessionLooks('k3v9q0x2mb:owner', 2)
    looks.serve(buttons, three, 0)
    looks.serve(buttons, three, 0)
    looks.serve(buttons, three, 0)
    assert.equal(refusalOf(looks, { sessionId: looks.sessionId, observationId: 'o1', element: 0 }), 'expired')
    assert.equal(refusalOf(looks, { sessionId: looks.sessionId, observationId: 'o2', element: 0 }), undefined)
    assert.equal(refusalOf(looks, { sessionId: looks.sessionId, observationId: 'o9', element: 0 }), 'unknown-look')
    assert.equal(refusalOf(looks, { sessionId: looks.sessionId, observationId: 'first', element: 0 }), 'unknown-look')
  })

  test('every look taken before the page opened another document is stale', () => {
    const looks = new SessionLooks('k3v9q0x2mb:owner')
    looks.serve(buttons, three, looks.generation)
    looks.nextDocument()
    const resolved = looks.resolve({ sessionId: looks.sessionId, observationId: 'o1', element: 0 })
    assert.ok(!resolved.ok)
    assert.equal(resolved.failure.details?.['refused'], 'new-document')
    assert.match(resolved.failure.message, /the page opened another document since it was taken/)
    looks.serve(buttons, three, looks.generation)
    assert.equal(refusalOf(looks, { sessionId: looks.sessionId, observationId: 'o2', element: 0 }), undefined)
  })

  test('a look that saw the page open another document while it was taken is stale as it is served', () => {
    const looks = new SessionLooks('k3v9q0x2mb:owner')
    const startedOn = looks.generation
    looks.nextDocument()
    looks.serve(buttons, three, startedOn)
    const resolved = looks.resolve({ sessionId: looks.sessionId, observationId: 'o1', element: 0 })
    assert.ok(!resolved.ok)
    assert.match(resolved.failure.message, /while it was taken/)
  })

  test('a place past the end of the list is refused', () => {
    const looks = new SessionLooks('k3v9q0x2mb:owner')
    looks.serve(buttons, three, 0)
    assert.equal(refusalOf(looks, { sessionId: looks.sessionId, observationId: 'o1', element: 3 }), 'no-element')
  })

  test('a reference of the wrong shape is refused without naming a session', () => {
    const looks = new SessionLooks('k3v9q0x2mb:owner')
    for (const value of [undefined, 'o1.e0', { sessionId: looks.sessionId, observationId: 'o1' }, { sessionId: looks.sessionId, observationId: 'o1', element: -1 }, { sessionId: looks.sessionId, observationId: 'o1', element: 0.5 }, { sessionId: looks.sessionId, observationId: 'o1', element: 0, extra: true }]) {
      assert.equal(refusalOf(looks, value), 'malformed')
      assert.equal(isElementRef(value), false)
    }
  })

  test('a page look gets an id and lists nothing, so it hands out no reference', () => {
    const looks = new SessionLooks('k3v9q0x2mb:owner')
    assert.equal(looks.servePage(), 'o1')
    looks.serve(buttons, three, 0)
    assert.equal(refusalOf(looks, { sessionId: looks.sessionId, observationId: 'o1', element: 0 }), 'unknown-look')
    assert.equal(refusalOf(looks, { sessionId: looks.sessionId, observationId: 'o2', element: 0 }), undefined)
  })

  test('a locator that keeps one match by its own pick names that match', () => {
    assert.deepEqual(elementRecipe({ by: 'role', role: 'button', pick: 'last' }, 0), { by: 'role', role: 'button', pick: 'last' })
  })
})

describe('matches a look saw', () => {
  test('the same list is the same, whatever a field holds now', () => {
    const field = observationOf([{ text: '', visible: true }], 'before')
    assert.equal(sameMatches(field, observationOf([{ text: '', visible: true }], 'after')), true)
  })

  test('an element added, removed, reworded or hidden is a change, and says which', () => {
    assert.equal(sameMatches(three, observationOf([{ text: 'Save', visible: true }])), false)
    assert.equal(changedMatches(three, observationOf([{ text: 'Save', visible: true }])), 'it saw 3 matches and the page now has 1')
    const reworded = observationOf([{ text: 'Save', visible: true }, { text: 'Close', visible: true }, { text: 'Delete', visible: false }])
    assert.equal(sameMatches(three, reworded), false)
    assert.equal(changedMatches(three, reworded), 'element 1 changed')
    const shown = observationOf([{ text: 'Save', visible: true }, { text: 'Cancel', visible: true }, { text: 'Delete', visible: true }])
    assert.equal(sameMatches(three, shown), false)
  })
})
