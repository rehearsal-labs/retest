import type { LocatorRecipe } from '../../src/protocol/locator.ts'
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { ariaRoles } from '../../src/protocol/aria-role.ts'
import { describeLocator, locatorRecipeSchema } from '../../src/protocol/locator.ts'
import { parse } from '../../src/protocol/schema.ts'

// Runs a description as the call it claims to be, and returns the recipe that call would make.
function readBack(description: string): unknown {
  const options = (value: unknown): object => (typeof value === 'object' && value !== null ? value : {})
  return runInNewContext(description, {
    getByTestId: (value: unknown) => ({ by: 'testId', value }),
    getByRole: (role: unknown, extra: unknown) => ({ by: 'role', role, ...options(extra) }),
    getByLabel: (text: unknown, extra: unknown) => ({ by: 'label', text, ...options(extra) }),
    getByText: (text: unknown, extra: unknown) => ({ by: 'text', text, ...options(extra) }),
  })
}

const awkward = [
  '',
  "'",
  '"',
  '\\',
  "\\'",
  '\\"',
  '\n\r\t\b\f\v\0',
  '\u0001\u001f\u007f',
  '\u2028\u2029',
  '\ud800',
  '\udc00x',
  '😀 ünïcödé 日本',
  '</script><script>',
  '${injected}',
  "'); alert(1); ('",
  "', { exact: false }), ('",
]

describe('describeLocator', () => {
  test('writes each kind as the call that makes it', () => {
    const cases: [LocatorRecipe, string][] = [
      [{ by: 'testId', value: 'save-task' }, "getByTestId('save-task')"],
      [{ by: 'role', role: 'button' }, "getByRole('button')"],
      [{ by: 'role', role: 'button', name: 'Save' }, "getByRole('button', { name: 'Save' })"],
      [{ by: 'role', role: 'button', name: 'Save', exact: false }, "getByRole('button', { name: 'Save', exact: false })"],
      [{ by: 'role', role: 'listitem', exact: false }, "getByRole('listitem', { exact: false })"],
      [{ by: 'label', text: 'Email' }, "getByLabel('Email')"],
      [{ by: 'label', text: 'Email', exact: false }, "getByLabel('Email', { exact: false })"],
      [{ by: 'text', text: 'Saved' }, "getByText('Saved')"],
      [{ by: 'text', text: 'Saved', exact: false }, "getByText('Saved', { exact: false })"],
    ]
    for (const [recipe, description] of cases) assert.equal(describeLocator(recipe), description)
  })

  test('leaves out exact when it is true, the default', () => {
    assert.equal(describeLocator({ by: 'role', role: 'button', name: 'Save', exact: true }), "getByRole('button', { name: 'Save' })")
    assert.equal(describeLocator({ by: 'role', role: 'button', exact: true }), "getByRole('button')")
    assert.equal(describeLocator({ by: 'label', text: 'Email', exact: true }), "getByLabel('Email')")
    assert.equal(describeLocator({ by: 'text', text: 'Saved', exact: true }), "getByText('Saved')")
  })

  test('escapes each value as a JavaScript string', () => {
    assert.equal(describeLocator({ by: 'testId', value: `it's "done"` }), `getByTestId('it\\'s "done"')`)
    assert.equal(describeLocator({ by: 'testId', value: 'a\\b' }), "getByTestId('a\\\\b')")
    assert.equal(describeLocator({ by: 'role', role: 'button', name: "Don't" }), "getByRole('button', { name: 'Don\\'t' })")
    assert.equal(describeLocator({ by: 'label', text: 'line\nbreak' }), "getByLabel('line\\nbreak')")
    assert.equal(describeLocator({ by: 'text', text: '\u2028' }), "getByText('\\u2028')")
  })

  test('every value of every kind reads back exactly, on one line', () => {
    for (const value of awkward) {
      const recipes: LocatorRecipe[] = [
        { by: 'testId', value },
        { by: 'role', role: 'button', name: value },
        { by: 'role', role: 'button', name: value, exact: false },
        { by: 'label', text: value },
        { by: 'label', text: value, exact: false },
        { by: 'text', text: value },
        { by: 'text', text: value, exact: false },
      ]
      for (const recipe of recipes) {
        const description = describeLocator(recipe)
        assert.deepEqual(readBack(description), recipe, `round trip of ${JSON.stringify(recipe)}`)
        assert.doesNotMatch(description, /[\n\r\u2028\u2029]/)
      }
    }
  })
})

describe('locatorRecipeSchema', () => {
  test('accepts every kind', () => {
    const recipes: LocatorRecipe[] = [
      { by: 'testId', value: 'save-task' },
      { by: 'role', role: 'button' },
      { by: 'role', role: 'heading', name: 'Tasks', exact: true },
      { by: 'label', text: 'Email', exact: false },
      { by: 'text', text: 'Saved' },
    ]
    for (const recipe of recipes) assert.deepEqual(parse(locatorRecipeSchema, recipe), { ok: true, value: recipe })
  })

  test('rejects a role that is not a WAI-ARIA 1.2 role', () => {
    for (const role of ['buton', 'Button', 'widget', 'landmark', 'image', '']) {
      const result = parse(locatorRecipeSchema, { by: 'role', role })
      assert.equal(result.ok, false, role)
      if (result.ok) continue
      assert.equal(result.issues.length, 1)
      assert.equal(result.issues[0]?.path, '$.role')
      assert.match(result.issues[0]?.message ?? '', /^expected one of "alert", .*"treeitem", received /)
    }
  })

  test('rejects an unknown kind and keys that belong to another kind', () => {
    assert.deepEqual(parse(locatorRecipeSchema, { by: 'css', value: 'button' }), {
      ok: false,
      issues: [{ path: '$.by', message: 'expected one of "testId", "role", "label", "text", received "css"' }],
    })
    assert.deepEqual(parse(locatorRecipeSchema, { by: 'testId', value: 'x', exact: true }), {
      ok: false,
      issues: [{ path: '$.exact', message: 'unknown key' }],
    })
    assert.deepEqual(parse(locatorRecipeSchema, { by: 'role', role: 'button', text: 'Save' }), {
      ok: false,
      issues: [{ path: '$.text', message: 'unknown key' }],
    })
    assert.deepEqual(parse(locatorRecipeSchema, { by: 'label', text: 'Email', exact: 'yes' }), {
      ok: false,
      issues: [{ path: '$.exact', message: 'expected boolean, received "yes"' }],
    })
    assert.deepEqual(parse(locatorRecipeSchema, { by: 'text' }), {
      ok: false,
      issues: [{ path: '$.text', message: 'missing required key' }],
    })
  })
})

describe('ariaRoles', () => {
  test('lists the 82 WAI-ARIA 1.2 roles an author may use, once each and no abstract role', () => {
    assert.equal(ariaRoles.length, 82)
    assert.equal(new Set(ariaRoles).size, ariaRoles.length)
    const listed: readonly string[] = ariaRoles
    for (const abstract of ['command', 'composite', 'input', 'landmark', 'range', 'roletype', 'section', 'sectionhead', 'select', 'structure', 'widget', 'window']) {
      assert.equal(listed.includes(abstract), false, abstract)
    }
    for (const role of ['button', 'textbox', 'searchbox', 'combobox', 'checkbox', 'switch', 'spinbutton', 'listitem', 'heading', 'generic', 'none', 'presentation']) {
      assert.equal(listed.includes(role), true, role)
    }
  })
})
