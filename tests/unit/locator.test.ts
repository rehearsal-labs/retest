import type { LocatorRecipe } from '../../src/protocol/locator.ts'
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { ariaRoles } from '../../src/protocol/aria-role.ts'
import { describeEmptyStep, describeLocator, locatorProblem, locatorRecipeSchema } from '../../src/protocol/locator.ts'
import { parse } from '../../src/protocol/schema.ts'

type Step = Record<string, unknown>

// A RegExp made in the description's own context reads back as the pattern a recipe carries.
function readMatch(value: unknown): unknown {
  if (Object.prototype.toString.call(value) !== '[object RegExp]' || typeof value !== 'object' || value === null) return value
  return { pattern: Reflect.get(value, 'source'), flags: Reflect.get(value, 'flags') }
}

function readOptions(value: unknown): Step {
  if (typeof value !== 'object' || value === null) return {}
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, readMatch(item)]))
}

// The steps a description's calls make, outermost first, as the recipe holds them.
class Chain {
  readonly steps: Step[]

  constructor(steps: Step[]) {
    this.steps = steps
  }

  getByTestId(value: unknown): Chain {
    return this.#then({ by: 'testId', value })
  }

  getByRole(role: unknown, extra: unknown): Chain {
    return this.#then({ by: 'role', role, ...readOptions(extra) })
  }

  getByLabel(text: unknown, extra: unknown): Chain {
    return this.#then({ by: 'label', text: readMatch(text), ...readOptions(extra) })
  }

  getByText(text: unknown, extra: unknown): Chain {
    return this.#then({ by: 'text', text: readMatch(text), ...readOptions(extra) })
  }

  getByPlaceholder(text: unknown, extra: unknown): Chain {
    return this.#then({ by: 'placeholder', text: readMatch(text), ...readOptions(extra) })
  }

  locator(selector: unknown): Chain {
    return this.#then({ by: 'css', selector })
  }

  first(): Chain {
    return this.#pick('first')
  }

  last(): Chain {
    return this.#pick('last')
  }

  nth(index: unknown): Chain {
    return this.#pick(index)
  }

  recipe(): unknown {
    const last = this.steps.at(-1)
    const within = this.steps.slice(0, -1)
    return within.length === 0 ? last : { ...last, within }
  }

  #then(step: Step): Chain {
    return new Chain([...this.steps, step])
  }

  #pick(pick: unknown): Chain {
    const last = this.steps.at(-1) ?? {}
    return new Chain([...this.steps.slice(0, -1), { ...last, pick }])
  }
}

// Runs a description as the calls it claims to be, and returns the recipe those calls would make.
function readBack(description: string): unknown {
  const start = new Chain([])
  const chain: unknown = runInNewContext(description, {
    getByTestId: (value: unknown) => start.getByTestId(value),
    getByRole: (role: unknown, extra: unknown) => start.getByRole(role, extra),
    getByLabel: (text: unknown, extra: unknown) => start.getByLabel(text, extra),
    getByText: (text: unknown, extra: unknown) => start.getByText(text, extra),
    getByPlaceholder: (text: unknown, extra: unknown) => start.getByPlaceholder(text, extra),
    locator: (selector: unknown) => start.locator(selector),
  })
  assert.ok(chain instanceof Chain)
  return chain.recipe()
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
      [{ by: 'placeholder', text: 'Search tasks' }, "getByPlaceholder('Search tasks')"],
      [{ by: 'css', selector: '.task > button' }, "locator('.task > button')"],
      [{ by: 'role', role: 'button', name: { pattern: '^Save', flags: 'i' } }, "getByRole('button', { name: /^Save/i })"],
      [{ by: 'text', text: { pattern: 'saved \\d+', flags: '' } }, 'getByText(/saved \\d+/)'],
      [{ by: 'role', role: 'listitem', pick: 'first' }, "getByRole('listitem').first()"],
      [{ by: 'role', role: 'listitem', pick: -1 }, "getByRole('listitem').nth(-1)"],
      [
        { by: 'role', role: 'button', name: 'Delete', within: [{ by: 'testId', value: 'tasks' }, { by: 'role', role: 'listitem', pick: 'last' }] },
        "getByTestId('tasks').getByRole('listitem').last().getByRole('button', { name: 'Delete' })",
      ],
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

  test('a chain, its picks and its patterns read back exactly', () => {
    const recipes: LocatorRecipe[] = [
      { by: 'css', selector: "li[data-state='done']", pick: 2, within: [{ by: 'placeholder', text: 'x', exact: false }] },
      { by: 'label', text: { pattern: 'e-?mail', flags: 'iu' }, within: [{ by: 'role', role: 'dialog', name: { pattern: 'Sign in', flags: '' }, pick: 'first' }] },
      { by: 'testId', value: 'box', pick: 'last', within: [{ by: 'css', selector: '.a' }, { by: 'text', text: 'b' }, { by: 'testId', value: 'c', pick: 0 }] },
    ]
    for (const recipe of recipes) assert.deepEqual(readBack(describeLocator(recipe)), recipe, JSON.stringify(recipe))
  })
})

describe('locatorProblem', () => {
  test('refuses what neither process can send: a broken pattern, exact beside a pattern, a selector of another syntax, a fractional index', () => {
    const cases: [LocatorRecipe, string][] = [
      [{ by: 'text', text: { pattern: '(', flags: '' } }, 'getByText() received a RegExp the page cannot read: Invalid regular expression: /(/: Unterminated group.'],
      [{ by: 'role', role: 'button', name: { pattern: 'x', flags: 'q' } }, "getByRole() received a RegExp the page cannot read: Invalid flags supplied to RegExp constructor 'q'."],
      [{ by: 'label', text: { pattern: 'x', flags: '' }, exact: true }, 'getByLabel() takes exact only with text. A RegExp says itself how it matches, so leave exact out.'],
      [{ by: 'css', selector: '  ' }, 'locator() takes a CSS selector, received an empty one.'],
      [{ by: 'css', selector: 'xpath=//a' }, 'locator() takes a CSS selector, received "xpath=//a". XPath and Playwright\'s selector engines, such as text= or >>, are not supported.'],
      [{ by: 'css', selector: '(//a)[2]' }, 'locator() takes a CSS selector, received "(//a)[2]". XPath and Playwright\'s selector engines, such as text= or >>, are not supported.'],
      [{ by: 'css', selector: 'div >> text=Save' }, 'locator() takes a CSS selector, received "div >> text=Save". XPath and Playwright\'s selector engines, such as text= or >>, are not supported.'],
      [{ by: 'testId', value: 'x', within: [{ by: 'role', role: 'list', pick: 0.5 }] }, 'nth() takes a whole number, counted from 0, received 0.5.'],
    ]
    for (const [recipe, message] of cases) assert.deepEqual(locatorProblem(recipe), { class: 'usage', message }, JSON.stringify(recipe))
    for (const fine of [{ by: 'css', selector: 'a[href*="x=1"]' }, { by: 'text', text: { pattern: 'x', flags: 'gi' } }, { by: 'role', role: 'button', name: 'Save', exact: false }] as const) {
      assert.equal(locatorProblem(fine), undefined, JSON.stringify(fine))
    }
  })

  test('the step that kept nothing is named, unless it is the whole locator', () => {
    const recipe: LocatorRecipe = { by: 'role', role: 'button', within: [{ by: 'testId', value: 'tasks' }, { by: 'role', role: 'listitem', pick: 4 }] }
    assert.equal(describeEmptyStep(recipe, { step: 0, matched: 0 }), "getByTestId('tasks') matched no element.")
    assert.equal(describeEmptyStep(recipe, { step: 1, matched: 2 }), "getByTestId('tasks').getByRole('listitem') matched 2 elements, and nth(4) keeps none of them.")
    assert.equal(describeEmptyStep(recipe, { step: 2, matched: 0 }), undefined)
    assert.equal(describeEmptyStep({ by: 'text', text: 'x', pick: 'first' }, { step: 0, matched: 0 }), undefined)
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
      { by: 'placeholder', text: { pattern: 'search', flags: 'i' } },
      { by: 'css', selector: 'ul > li', pick: -2 },
      { by: 'role', role: 'button', pick: 'last', within: [{ by: 'testId', value: 'tasks', pick: 'first' }, { by: 'css', selector: 'li' }] },
    ]
    for (const recipe of recipes) assert.deepEqual(parse(locatorRecipeSchema, recipe), { ok: true, value: recipe })
  })

  test('a step inside within takes no within of its own, and a pick is first, last or a whole number', () => {
    assert.equal(parse(locatorRecipeSchema, { by: 'text', text: 'x', within: [{ by: 'testId', value: 'a', within: [] }] }).ok, false)
    assert.equal(parse(locatorRecipeSchema, { by: 'text', text: 'x', pick: 'second' }).ok, false)
    assert.equal(parse(locatorRecipeSchema, { by: 'text', text: 'x', pick: 1.5 }).ok, false)
    assert.equal(parse(locatorRecipeSchema, { by: 'text', text: { pattern: 'x' } }).ok, false)
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
    assert.deepEqual(parse(locatorRecipeSchema, { by: 'xpath', value: '//button' }), {
      ok: false,
      issues: [{ path: '$.by', message: 'expected one of "testId", "role", "label", "text", "placeholder", "css", received "xpath"' }],
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
