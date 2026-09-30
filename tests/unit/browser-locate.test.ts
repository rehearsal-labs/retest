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

test('test id and text are found in the page, from values alone', () => {
  assert.deepEqual(locatorArguments({ by: 'testId', value: 'save' }, [100]), [100, { by: 'testId', value: 'save' }])
  assert.deepEqual(locatorArguments({ by: 'text', text: 'Save' }, [100]), [100, { by: 'text', text: 'Save', exact: true }])
  assert.deepEqual(locatorArguments({ by: 'text', text: 'Save', exact: false }, []), [{ by: 'text', text: 'Save', exact: false }])
})

test('role passes the elements Chrome names after the values and a query that takes them', async () => {
  const { built, roles } = await made({ by: 'role', role: 'button', name: 'Save' })
  assert.deepEqual(built, [{ value: 'click' }, { value: false }, { value: { by: 'elements' } }, { objectId: 'element' }])
  assert.deepEqual(roles, ['button'])
})

test('a name that does not match leaves the query with no elements', async () => {
  const { built } = await made({ by: 'role', role: 'button', name: 'save' })
  assert.deepEqual(built, [{ value: 'click' }, { value: false }, { value: { by: 'elements' } }])
})

test('a role Chrome names its own way is asked for by that name', async () => {
  assert.deepEqual((await made({ by: 'role', role: 'img' })).roles, ['image'])
})

test('label asks for every form control role and matches the name', async () => {
  const { built, roles } = await made({ by: 'label', text: 'email', exact: false })
  assert.deepEqual(built.at(-1), { objectId: 'element' })
  assert.deepEqual(roles, ['textbox', 'searchbox', 'combobox', 'listbox', 'checkbox', 'radio', 'switch', 'slider', 'spinbutton'])
})
