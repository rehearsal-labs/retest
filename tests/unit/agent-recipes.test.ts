import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { SessionLooks } from '../../src/agent/looks.ts'
import { durableRecipeProblem, keyedRecipeProblem, oneReadRecipeProblem } from '../../src/agent/recipes.ts'
import { observationOf } from '../support/observation.ts'

// A reference becomes a durable recipe only when a read proves the recipe finds the referenced element itself: a recipe
// that keeps a match by its place is not durable; a keyed read must show the recipe's one element is the node the look
// listed at the reference's place; without keys, only the look's own locator finding one element is proven.

const buttons = { by: 'role', role: 'button' } as const

describe('durable recipes', () => {
  test('a recipe that keeps a match by its place, at any step, is not durable', () => {
    for (const pick of ['first', 'last', 0, 2, -1] as const) {
      const problem = durableRecipeProblem({ by: 'role', role: 'button', pick })
      assert.equal(problem?.class, 'usage', String(pick))
      assert.equal(problem?.details?.['refused'], 'placed')
    }
    assert.equal(durableRecipeProblem({ by: 'text', text: 'Save', within: [{ by: 'testId', value: 'row', pick: 1 }] })?.details?.['refused'], 'placed')
  })

  test('a recipe by test id, role and name, label, text, placeholder or scope is durable', () => {
    assert.equal(durableRecipeProblem({ by: 'testId', value: 'save-task' }), undefined)
    assert.equal(durableRecipeProblem({ by: 'role', role: 'button', name: 'Save' }), undefined)
    assert.equal(durableRecipeProblem({ by: 'label', text: 'Title' }), undefined)
    assert.equal(durableRecipeProblem({ by: 'role', role: 'button', name: 'Delete', within: [{ by: 'testId', value: 'row-2' }] }), undefined)
  })

  test('a recipe the page cannot read is refused as such', () => {
    assert.match(durableRecipeProblem({ by: 'css', selector: 'text=Save' })?.message ?? '', /^locator\(\) takes a CSS selector/)
  })
})

describe('a recipe a keyed read proves', () => {
  // The look listed three buttons, the second and third showing the same text: nodes b and c.
  const look = new SessionLooks('k3v9q0x2mb:owner').serve(buttons, observationOf([
    { text: 'Save', visible: true },
    { text: 'Delete', visible: true },
    { text: 'Delete', visible: true },
  ]), 0, ['node-a', 'node-b', 'node-c'])
  const lookRead = { observation: look.observation, keys: ['node-a', 'node-b', 'node-c'] }

  test('a recipe that finds the very node the look listed at the place names it', () => {
    const recipeRead = { observation: observationOf([{ text: 'Delete', visible: true }]), keys: ['node-c'] }
    assert.equal(keyedRecipeProblem({ look, element: 2, lookRead, recipeRead, locator: { by: 'testId', value: 'row-2-delete' } }), undefined)
  })

  test('a recipe that finds another node showing the same text is refused, whatever it shows', () => {
    const recipeRead = { observation: observationOf([{ text: 'Delete', visible: true }]), keys: ['node-b'] }
    const problem = keyedRecipeProblem({ look, element: 2, lookRead, recipeRead, locator: { by: 'testId', value: 'row-1-delete' } })
    assert.equal(problem?.details?.['refused'], 'other-element')
    assert.match(problem?.message ?? '', /^getByTestId\('row-1-delete'\) finds an element showing "Delete", and it is not the element o1\.e2 names, which shows "Delete"\./)
  })

  test('a look whose node left its place is stale, even when the page shows the same texts', () => {
    const moved = { observation: look.observation, keys: ['node-a', 'node-c', 'node-b'] }
    const recipeRead = { observation: observationOf([{ text: 'Delete', visible: true }]), keys: ['node-c'] }
    assert.equal(keyedRecipeProblem({ look, element: 2, lookRead: moved, recipeRead, locator: { by: 'testId', value: 'row-2-delete' } })?.details?.['refused'], 'changed')
  })

  test('a recipe that finds nothing, or several, names nothing', () => {
    assert.equal(keyedRecipeProblem({ look, element: 0, lookRead, recipeRead: { observation: observationOf([]), keys: [] }, locator: { by: 'testId', value: 'gone' } })?.class, 'not_found')
    const several = keyedRecipeProblem({ look, element: 1, lookRead, recipeRead: { observation: observationOf([{ text: 'Delete', visible: true }, { text: 'Delete', visible: true }]), keys: ['node-b', 'node-c'] }, locator: { by: 'text', text: 'Delete' } })
    assert.equal(several?.class, 'ambiguous')
    assert.equal(several?.details?.['count'], 2)
  })
})

describe('a recipe one read proves, on a driver that cannot compare elements', () => {
  const single = { by: 'testId', value: 'row-2-delete' } as const
  const look = new SessionLooks('k3v9q0x2mb:owner').serve(single, observationOf([{ text: 'Delete', visible: true }]), 0)

  test("the look's own locator, finding one element, is proven by the read of the look", () => {
    assert.equal(oneReadRecipeProblem({ look, element: 0, fresh: look.observation, locator: { value: 'row-2-delete', by: 'testId' }, engine: 'firefox' }), undefined)
  })

  test('any other recipe is refused by name, even one that would find an element showing the same text', () => {
    const problem = oneReadRecipeProblem({ look, element: 0, fresh: look.observation, locator: { by: 'testId', value: 'row-1-delete' }, engine: 'webkit' })
    assert.equal(problem?.class, 'usage')
    assert.deepEqual(problem?.details, { refused: 'unproven', engine: 'webkit' })
    assert.match(problem?.message ?? '', /^Retest cannot tell whether getByTestId\('row-1-delete'\) finds the element o1\.e0 names: the webkit driver cannot compare two elements\./)
  })

  test("the look's own locator finding several is not a recipe", () => {
    const twins = new SessionLooks('k3v9q0x2mb:owner').serve(buttons, observationOf([{ text: 'Delete', visible: true }, { text: 'Delete', visible: true }]), 0)
    assert.equal(oneReadRecipeProblem({ look: twins, element: 1, fresh: twins.observation, locator: buttons, engine: 'chromium' })?.class, 'ambiguous')
  })
})
