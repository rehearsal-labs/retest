import type { NativeKind } from '../../src/browser/contract.ts'
import type { NativeTree } from '../../src/native/locators.ts'
import type { LocatorRecipe } from '../../src/protocol/locator.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { describeElement, elementTypeNumbers, enabledReading, identifierOf, locate, nativeLocatorProblem, nativeRoleTypes, parseNativeTree, predicateFor, quotePredicate, resolutionKeys, resolutionPlan, selectedReading, textOf, textReading, valueOf, valueReading, visibilityReading } from '../../src/native/locators.ts'
import { ariaRoles } from '../../src/protocol/aria-role.ts'

// The native locator mappings, read from scoped trees written as each executor writes them: WebDriverAgent with `type`,
// `name` and `label`, the macOS runner with `elementType`, `identifier`, `label` and `title`.

function tree(xml: string, platform: NativeKind): NativeTree {
  const parsed = parseNativeTree(xml, platform)
  if (!parsed.ok) throw new Error(parsed.problem)
  return parsed.tree
}

function ios(children: string): NativeTree {
  return tree(`<XCUIElementTypeApplication type="XCUIElementTypeApplication" name="TaskPhone" label="TaskPhone" visible="true" x="0" y="0" width="402" height="874" bundleId="dev.retest.fixtures.taskphone">${children}</XCUIElementTypeApplication>`, 'ios-simulator')
}

function macos(children: string): NativeTree {
  return tree(`<XCUIElementTypeWindow elementType="4" identifier="main" label="" title="TaskDesk" enabled="false" selected="false" x="20" y="60" width="700" height="480">${children}</XCUIElementTypeWindow>`, 'macos')
}

function iosElement(type: string, attributes: Record<string, string>): string {
  const text = Object.entries({ type: `XCUIElementType${type}`, enabled: 'true', visible: 'true', x: '10', y: '10', width: '50', height: '20', ...attributes }).map(([name, value]) => ` ${name}="${value}"`).join('')
  return `<XCUIElementType${type}${text}/>`
}

function macElement(type: string, attributes: Record<string, string>): string {
  const text = Object.entries({ elementType: String(elementTypeNumbers[type]), identifier: '', label: '', title: '', enabled: 'true', selected: 'false', x: '30', y: '70', width: '50', height: '20', ...attributes }).map(([name, value]) => ` ${name}="${value}"`).join('')
  return `<XCUIElementType${type}${text}/>`
}

function matched(subject: NativeTree, recipe: LocatorRecipe): string[] {
  const located = locate(subject, recipe)
  if (!located.ok) throw new Error(located.failure.message)
  return located.matches.map((element) => `${element.type}:${element.attributes['name'] ?? element.attributes['identifier'] ?? ''}`)
}

test('a tree parses with XML entities and character references decoded, and a broken one is refused', () => {
  const parsed = macos(macElement('Button', { identifier: 'save', label: 'Save &amp; go&#10;now &lt;3 &#x263A;' }))
  assert.equal(parsed.elements[1]?.attributes['label'], 'Save & go\nnow <3 ☺')
  assert.equal(parsed.elements[1]?.parent, parsed.root)
  assert.deepEqual(parsed.root.frame, { x: 20, y: 60, width: 700, height: 480 })
  assert.equal(parseNativeTree('<XCUIElementTypeWindow><XCUIElementTypeButton></XCUIElementTypeWindow>', 'macos').ok, false)
  assert.equal(parseNativeTree('<XCUIElementTypeWindow/><XCUIElementTypeWindow/>', 'macos').ok, false)
  assert.equal(parseNativeTree('no tree', 'macos').ok, false)
})

test('a test id is the identifier read back from the element: macOS identifier, iOS name only where it differs from the label', () => {
  const mac = macos(macElement('Button', { identifier: 'sign-in-button', label: 'Sign in' }) + macElement('Button', { label: 'Sign in' }))
  assert.deepEqual(matched(mac, { by: 'testId', value: 'sign-in-button' }), ['Button:sign-in-button'])
  assert.deepEqual(matched(mac, { by: 'testId', value: 'Sign in' }), [], 'a label is never a test id')
  const phone = ios(iosElement('Button', { name: 'sign-in-button', label: 'Sign in' }) + iosElement('StaticText', { name: 'Sign in', label: 'Sign in', value: 'Sign in' }))
  assert.deepEqual(matched(phone, { by: 'testId', value: 'sign-in-button' }), ['Button:sign-in-button'])
  const unverified = locate(phone, { by: 'testId', value: 'Sign in' })
  assert.equal(unverified.ok && unverified.matches.length, 0, 'a name equal to the label cannot be told from the label, so it is not an identifier')
  assert.deepEqual(unverified.ok && unverified.unverified, { value: 'Sign in', count: 1 })
  assert.deepEqual(identifierOf(phone.elements[2] ?? phone.root, 'ios-simulator'), { kind: 'unverifiable', candidate: 'Sign in' })
  assert.deepEqual(identifierOf(mac.elements[2] ?? mac.root, 'macos'), { kind: 'none' })
})

test('a missing identifier is a locator failure: the lookup finds nothing, and nothing falls back to a label or a point', () => {
  const phone = ios(iosElement('Button', { label: 'Create task' }))
  const located = locate(phone, { by: 'testId', value: 'create-task-button' })
  assert.equal(located.ok && located.matches.length, 0)
  assert.deepEqual(located.ok && located.emptyStep, { step: 0, matched: 0 })
})

test('every role in the table finds its element types on its platform, and every other role is refused by name', () => {
  for (const platform of ['ios-simulator', 'macos'] as const) {
    const table = nativeRoleTypes[platform]
    for (const role of ariaRoles) {
      const types = table[role]
      if (types === undefined) {
        const refused = nativeLocatorProblem({ by: 'role', role }, platform)
        assert.equal(refused?.class, 'unsupported', `${platform} ${role}`)
        assert.match(refused?.message ?? '', new RegExp(`the role "${role}" has no ${platform === 'macos' ? 'macOS' : 'iOS'} element type`))
        continue
      }
      for (const type of types) {
        const subject = platform === 'macos' ? macos(macElement(type, { identifier: `one-${type}` })) : ios(iosElement(type, { name: `one-${type}` }))
        assert.deepEqual(matched(subject, { by: 'role', role }), [`${type}:one-${type}`], `${platform} ${role} ${type}`)
      }
    }
  }
  assert.deepEqual(nativeRoleTypes['ios-simulator'].textbox, ['TextField', 'SecureTextField', 'TextView'])
  assert.equal(nativeRoleTypes['ios-simulator'].checkbox, undefined, 'iOS has no checkbox')
  assert.deepEqual(nativeRoleTypes.macos.checkbox, ['CheckBox'])
})

test('a role name, a label and a text compare as the web compares them: whole and case-sensitive, or a case-insensitive part, or a pattern', () => {
  const mac = macos(macElement('Button', { identifier: 'a', label: 'Sign  in\n' }) + macElement('Button', { identifier: 'b', title: 'Show' }) + macElement('TextField', { identifier: 'c', label: 'Task id' }))
  assert.deepEqual(matched(mac, { by: 'role', role: 'button', name: 'Sign in' }), ['Button:a'], 'whitespace runs read as one space, ends trimmed')
  assert.deepEqual(matched(mac, { by: 'role', role: 'button', name: 'sign in' }), [])
  assert.deepEqual(matched(mac, { by: 'role', role: 'button', name: 'sign', exact: false }), ['Button:a'])
  assert.deepEqual(matched(mac, { by: 'role', role: 'button', name: 'Show' }), ['Button:b'], 'a macOS title names an element with no label')
  assert.deepEqual(matched(mac, { by: 'role', role: 'button', name: { pattern: '^s', flags: 'i' } }), ['Button:a', 'Button:b'])
  assert.deepEqual(matched(mac, { by: 'label', text: 'Task id' }), ['TextField:c'])
  assert.deepEqual(matched(mac, { by: 'label', text: 'Sign in' }), [], 'getByLabel finds labelled controls, as on the web, not buttons')
})

test('text is a static text\'s value, or its label, or another element\'s name; a field has none, and the innermost match wins', () => {
  const phone = ios(`<XCUIElementTypeCell type="XCUIElementTypeCell" name="Open" label="Open" visible="true" x="0" y="0" width="300" height="40">${iosElement('StaticText', { name: 'task-state', label: 'Open', value: 'Open' })}</XCUIElementTypeCell>${iosElement('TextField', { name: 'title-field', value: 'Open', label: '' })}`)
  assert.deepEqual(matched(phone, { by: 'text', text: 'Open' }), ['StaticText:task-state'])
  assert.equal(textOf(phone.elements.find((element) => element.type === 'TextField') ?? phone.root, 'ios-simulator'), undefined)
  const mac = macos(macElement('StaticText', { identifier: 'task-state-1', value: 'Done' }))
  assert.deepEqual(matched(mac, { by: 'text', text: 'Done' }), ['StaticText:task-state-1'])
})

test('a scoped locator finds descendants of what the step before kept, never those elements themselves', () => {
  const mac = macos(`<XCUIElementTypeGroup elementType="3" identifier="task-row-1" label="" title="" enabled="true" selected="false" x="30" y="70" width="500" height="20">${macElement('StaticText', { identifier: 'state', value: 'Open' })}</XCUIElementTypeGroup><XCUIElementTypeGroup elementType="3" identifier="task-row-2" label="" title="" enabled="true" selected="false" x="30" y="90" width="500" height="20">${macElement('StaticText', { identifier: 'state', value: 'Done' })}</XCUIElementTypeGroup>`)
  assert.deepEqual(matched(mac, { by: 'testId', value: 'state' }), ['StaticText:state', 'StaticText:state'])
  const inRow = locate(mac, { by: 'testId', value: 'state', within: [{ by: 'testId', value: 'task-row-2' }] })
  assert.equal(inRow.ok && inRow.matches.length, 1)
  assert.equal(inRow.ok && inRow.matches[0]?.attributes['value'], 'Done')
  assert.deepEqual(matched(mac, { by: 'testId', value: 'task-row-2', within: [{ by: 'testId', value: 'task-row-2' }] }), [], 'a scope is not its own descendant')
})

test('first, last and nth keep one match; an index past the matches keeps none and names the step', () => {
  const mac = macos(['a', 'b', 'c'].map((name) => macElement('Button', { identifier: name, label: 'Show' })).join(''))
  const shown: LocatorRecipe = { by: 'role', role: 'button', name: 'Show' }
  assert.deepEqual(matched(mac, { ...shown, pick: 'first' }), ['Button:a'])
  assert.deepEqual(matched(mac, { ...shown, pick: 'last' }), ['Button:c'])
  assert.deepEqual(matched(mac, { ...shown, pick: 1 }), ['Button:b'])
  assert.deepEqual(matched(mac, { ...shown, pick: -1 }), ['Button:c'])
  const past = locate(mac, { ...shown, pick: 3 })
  assert.deepEqual(past.ok && past.emptyStep, { step: 0, matched: 3 })
})

test('CSS, placeholders, Playwright\'s rules and unreadable patterns are refused before any lookup', () => {
  assert.equal(nativeLocatorProblem({ by: 'css', selector: '.task' }, 'macos')?.class, 'unsupported')
  assert.equal(nativeLocatorProblem({ by: 'placeholder', text: 'Title' }, 'ios-simulator')?.class, 'unsupported')
  assert.equal(nativeLocatorProblem({ by: 'testId', value: 'x', dialect: 'playwright' }, 'macos')?.class, 'unsupported')
  assert.equal(nativeLocatorProblem({ by: 'text', text: { pattern: '(', flags: '' } }, 'macos')?.class, 'usage')
  assert.equal(nativeLocatorProblem({ by: 'testId', value: 'x', within: [{ by: 'css', selector: 'li' }] }, 'macos')?.class, 'unsupported')
})

test('the executor is asked by an exact predicate in each executor\'s own attribute names, quoted literally, the label kept beside an identifier', () => {
  const phone = ios(iosElement('Button', { name: 'save-task', label: 'Save' }))
  const mac = macos(macElement('Button', { identifier: 'save-task', label: 'Save' }))
  assert.equal(predicateFor(resolutionKeys(phone.elements[1] ?? phone.root, 'ios-simulator'), 'ios-simulator'), 'type == "XCUIElementTypeButton" AND name == "save-task" AND label == "Save"')
  assert.equal(predicateFor(resolutionKeys(mac.elements[1] ?? mac.root, 'macos'), 'macos'), 'elementType == 9 AND identifier == "save-task" AND label == "Save"')
  const unnamed = macos(macElement('Button', { label: 'Say &quot;hi&quot; \\ %@', title: 'T' }))
  assert.equal(predicateFor(resolutionKeys(unnamed.elements[1] ?? unnamed.root, 'macos'), 'macos'), 'elementType == 9 AND label == "Say \\"hi\\" \\\\ %@" AND title == "T"')
  assert.equal(quotePredicate('a\nb\tc'), '"a\\nb\\tc"')
})

test('an element named alone is resolved by its own keys; one among alike elements inside an ancestor that sets it apart; else none', () => {
  const rows = macos(`<XCUIElementTypeGroup elementType="3" identifier="task-row-1" label="" title="" enabled="true" selected="false" x="30" y="70" width="500" height="20">${macElement('Button', { label: 'Show' })}</XCUIElementTypeGroup><XCUIElementTypeGroup elementType="3" identifier="task-row-2" label="" title="" enabled="true" selected="false" x="30" y="90" width="500" height="20">${macElement('Button', { label: 'Show' })}</XCUIElementTypeGroup>`)
  const second = rows.elements[4] ?? rows.root
  const plan = resolutionPlan(rows, second)
  assert.deepEqual(plan?.keys, { type: 'Button', label: 'Show' })
  assert.equal(plan?.count, 1)
  assert.deepEqual(plan?.within?.keys, { type: 'Group', identifier: 'task-row-2' })
  const twins = macos(macElement('Button', { label: 'Show' }) + macElement('Button', { label: 'Show' }))
  assert.equal(resolutionPlan(twins, twins.elements[1] ?? twins.root), undefined)
  const alone = macos(macElement('Button', { identifier: 'only' }))
  assert.deepEqual(resolutionPlan(alone, alone.elements[1] ?? alone.root), { keys: { type: 'Button', identifier: 'only' }, count: 1 })
})

test('an iOS field\'s value equal to its placeholder cannot be told from an empty field; a static text has no value', () => {
  const phone = ios(iosElement('TextField', { name: 'title', label: '', value: 'Title', placeholderValue: 'Title' }) + iosElement('StaticText', { name: 'id', label: 'task-1', value: 'task-1' }) + iosElement('TextField', { name: 'note', label: '', value: 'Buy milk', placeholderValue: 'Note' }))
  const [, title, id, note] = phone.elements
  assert.ok(title !== undefined && id !== undefined && note !== undefined)
  assert.deepEqual(valueReading(title, 'ios-simulator'), { kind: 'placeholder', placeholder: 'Title' })
  assert.equal(valueOf(title, 'ios-simulator'), 'Title', 'the raw value is what the executor wrote')
  assert.deepEqual(valueReading(note, 'ios-simulator'), { kind: 'read', value: 'Buy milk' })
  assert.deepEqual(valueReading(id, 'ios-simulator'), { kind: 'none' })
  assert.equal(valueOf(id, 'ios-simulator'), undefined)
  assert.equal(describeElement(title, 'ios-simulator'), 'the TextField "title"')
})

test('an attribute the tree does not carry is not reported, never false or empty', () => {
  const phone = ios('<XCUIElementTypeButton type="XCUIElementTypeButton" name="go" label="Go" x="10" y="10" width="50" height="20"/><XCUIElementTypeCell type="XCUIElementTypeCell" name="row" label="Row" enabled="true" visible="true" x="10" y="40" width="50" height="20"/><XCUIElementTypeTextField type="XCUIElementTypeTextField" name="field" label="" enabled="true" visible="true" x="10" y="70" width="50" height="20"/><XCUIElementTypeStaticText type="XCUIElementTypeStaticText" name="blank" enabled="true" visible="true" x="10" y="100" width="50" height="20"/>')
  const [, button, cell, field, blank] = phone.elements
  assert.ok(button !== undefined && cell !== undefined && field !== undefined && blank !== undefined)
  assert.deepEqual(enabledReading(button), { kind: 'unreported', attribute: 'enabled' })
  assert.deepEqual(visibilityReading(button, 'ios-simulator'), { kind: 'unreported', attribute: 'visible' })
  assert.deepEqual(selectedReading(cell, 'ios-simulator'), { kind: 'unreported', attribute: 'traits' })
  assert.deepEqual(valueReading(field, 'ios-simulator'), { kind: 'unreported', attribute: 'value' })
  assert.deepEqual(textReading(blank, 'ios-simulator'), { kind: 'unreported', attribute: 'value' })
  const mac = macos('<XCUIElementTypeCell elementType="75" identifier="row" label="" title="" x="30" y="70" width="50" height="20"/>')
  const [, row] = mac.elements
  assert.ok(row !== undefined)
  assert.deepEqual(selectedReading(row, 'macos'), { kind: 'unreported', attribute: 'selected' })
  assert.deepEqual(enabledReading(row), { kind: 'unreported', attribute: 'enabled' })
})
