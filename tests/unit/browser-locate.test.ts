import type { LocatorRecipe } from '../../src/protocol/locator.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { locatorArguments } from '../../src/browser/locate.ts'
import { Deadline } from '../../src/protocol/deadline.ts'
import { scriptedSession } from './browser-fixtures.ts'

function roleOf(params: unknown): unknown {
  return typeof params === 'object' && params !== null && 'role' in params ? params.role : undefined
}

// A page with one button named Save and one text box named Email, as Chrome's tree reports them.
function page() {
  return scriptedSession((method, params) => {
    if (method === 'Runtime.evaluate') return Promise.resolve({ result: { objectId: 'document' } })
    if (method === 'DOM.resolveNode') return Promise.resolve({ object: { objectId: 'element' } })
    const role = roleOf(params)
    const named = (name: string) => [{ ignored: false, name: { value: name }, backendDOMNodeId: 1 }]
    return Promise.resolve({ nodes: role === 'button' ? named('Save') : role === 'textbox' ? named('Email') : [] })
  })
}

async function made(locator: LocatorRecipe) {
  const { session, sent } = page()
  const args = locatorArguments(locator, ['click', false])
  assert.equal(typeof args, 'function')
  const built = typeof args === 'function' ? await args({ session, context: 7, objectGroup: 'g' }, new Deadline(1000)) : []
  const roles = sent.filter((command) => command.method === 'Accessibility.queryAXTree').map((command) => roleOf(command.params))
  return { built, roles }
}

test('test ids, text, placeholders and CSS are found in the page, from values alone, step by step with each pick', () => {
  assert.deepEqual(locatorArguments({ by: 'testId', value: 'save' }, [100]), [100, { steps: [{ by: 'testId', value: 'save', pick: null }] }])
  assert.deepEqual(locatorArguments({ by: 'text', text: 'Save' }, [100]), [100, { steps: [{ by: 'text', text: 'Save', exact: true, pick: null }] }])
  assert.deepEqual(locatorArguments({ by: 'text', text: 'Save', exact: false }, []), [{ steps: [{ by: 'text', text: 'Save', exact: false, pick: null }] }])
  const pattern = { pattern: '^search', flags: 'i' }
  assert.deepEqual(locatorArguments({ by: 'placeholder', text: pattern, pick: 'last', within: [{ by: 'css', selector: 'form', pick: 1 }] }, []), [
    {
      steps: [
        { by: 'css', selector: 'form', pick: 1 },
        { by: 'placeholder', text: pattern, exact: true, pick: 'last' },
      ],
    },
  ])
})

test('role passes the elements Chrome names after the values and a step that takes them', async () => {
  const { built, roles } = await made({ by: 'role', role: 'button', name: 'Save' })
  assert.deepEqual(built, [{ value: 'click' }, { value: false }, { value: { steps: [{ by: 'elements', from: 0, count: 1, pick: null }] } }, { objectId: 'element' }])
  assert.deepEqual(roles, ['button'])
})

test('a name that does not match leaves the step with no elements', async () => {
  const { built } = await made({ by: 'role', role: 'button', name: 'save' })
  assert.deepEqual(built, [{ value: 'click' }, { value: false }, { value: { steps: [{ by: 'elements', from: 0, count: 0, pick: null }] } }])
})

test("each role or label step of a chain names which of the elements after the query are its own, and a name may be a pattern", async () => {
  const { built, roles } = await made({
    by: 'label',
    text: { pattern: '^em', flags: 'i' },
    within: [{ by: 'role', role: 'button', name: { pattern: 'av', flags: '' }, pick: 'first' }, { by: 'testId', value: 'form' }],
  })
  assert.deepEqual(built, [
    { value: 'click' },
    { value: false },
    {
      value: {
        steps: [
          { by: 'elements', from: 0, count: 1, pick: 'first' },
          { by: 'testId', value: 'form', pick: null },
          { by: 'elements', from: 1, count: 1, pick: null },
        ],
      },
    },
    { objectId: 'element' },
    { objectId: 'element' },
  ])
  assert.deepEqual(roles, ['button', 'textbox', 'searchbox', 'combobox', 'listbox', 'checkbox', 'radio', 'switch', 'slider', 'spinbutton'])
})

test('a role Chrome names its own way is asked for by that name', async () => {
  assert.deepEqual((await made({ by: 'role', role: 'img' })).roles, ['image'])
})

test('label asks for every form control role and matches the name', async () => {
  const { built, roles } = await made({ by: 'label', text: 'email', exact: false })
  assert.deepEqual(built.at(-1), { objectId: 'element' })
  assert.deepEqual(roles, ['textbox', 'searchbox', 'combobox', 'listbox', 'checkbox', 'radio', 'switch', 'slider', 'spinbutton'])
})

test("by Playwright's rules every query refuses open shadow roots, and a label step also finds what aria-label or aria-labelledby names", async () => {
  assert.deepEqual(locatorArguments({ by: 'testId', value: 'save', dialect: 'playwright' }, [100]), [100, { steps: [{ by: 'testId', value: 'save', pick: null }], shadow: 'refused' }])
  const { built } = await made({ by: 'label', text: 'Email', exact: false, dialect: 'playwright' })
  assert.deepEqual(built.slice(0, 3), [
    { value: 'click' },
    { value: false },
    { value: { steps: [{ by: 'elements', from: 0, count: 1, pick: null, labelled: { text: 'Email', exact: false } }], shadow: 'refused' } },
  ])
  const { built: native } = await made({ by: 'label', text: 'Email', exact: false })
  assert.deepEqual(native[2], { value: { steps: [{ by: 'elements', from: 0, count: 1, pick: null }] } }, "Retest's own label finds only what the tree names a form control")
})
