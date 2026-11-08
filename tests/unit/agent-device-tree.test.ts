import type { SnapshotNode } from '../../src/native/agent-device/tree.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { androidElementTypes, buildTree, readSnapshot } from '../../src/native/agent-device/tree.ts'
import { observeTree, unsupportedCheck } from '../../src/native/assertions.ts'
import { describeElement, identifierOf, locate, textReading, valueReading, visibilityReading } from '../../src/native/locators.ts'

// Snapshots agent-device gives, read into the trees Retest's locators and checks read. The iOS nodes are TaskPhone's
// sign-in screen as agent-device 0.21.36 snapshotted it on the iOS 26.5 simulator; the Android nodes are written from
// agent-device's documented node fields and have not come from a real emulator or device.

const iosNodes: readonly SnapshotNode[] = [
  { index: 0, type: 'Other', label: 'TaskPhone', rect: { x: 0, y: 0, width: 402, height: 874 }, enabled: true, ref: 'e1' },
  { index: 1, parentIndex: 0, type: 'NavigationBar', identifier: 'TaskPhone', rect: { x: 0, y: 62, width: 402, height: 106 }, enabled: true, ref: 'e2' },
  { index: 2, parentIndex: 0, type: 'CollectionView', rect: { x: 0, y: 0, width: 402, height: 874 }, enabled: true, ref: 'e3' },
  { index: 3, parentIndex: 2, type: 'Cell', rect: { x: 16, y: 253, width: 370, height: 42 }, enabled: true, ref: 'e4' },
  { index: 4, parentIndex: 3, type: 'StaticText', label: 'Sign in', rect: { x: 16, y: 253, width: 370, height: 42 }, enabled: true, ref: 'e5' },
  { index: 5, parentIndex: 2, type: 'Cell', rect: { x: 16, y: 295, width: 370, height: 54 }, enabled: true, ref: 'e6' },
  { index: 6, parentIndex: 5, type: 'TextField', value: 'Account', placeholder: 'Account', identifier: 'account-field', rect: { x: 32, y: 311, width: 338, height: 23 }, enabled: true, password: false, editable: true, ref: 'e7' },
  { index: 7, parentIndex: 2, type: 'Cell', rect: { x: 16, y: 350, width: 370, height: 54 }, enabled: true, ref: 'e8' },
  { index: 8, parentIndex: 7, type: 'SecureTextField', value: '••••', placeholder: 'Password', identifier: 'password-field', rect: { x: 32, y: 365, width: 338, height: 23 }, enabled: true, password: true, focused: true, ref: 'e9' },
  { index: 9, parentIndex: 2, type: 'Cell', rect: { x: 16, y: 404, width: 370, height: 54 }, enabled: true, ref: 'e10' },
  { index: 10, parentIndex: 9, type: 'Button', label: 'Sign in', identifier: 'sign-in-button', rect: { x: 16, y: 404, width: 370, height: 54 }, enabled: false, ref: 'e11' },
  { index: 11, parentIndex: 9, type: 'StaticText', label: 'Hidden', rect: { x: 16, y: 404, width: 0, height: 0 }, enabled: true, ref: 'e12' },
]

const androidNodes: readonly SnapshotNode[] = [
  { index: 0, type: 'android.widget.FrameLayout', rect: { x: 0, y: 0, width: 1080, height: 2400 }, visibleToUser: true, ref: 'e1' },
  { index: 1, parentIndex: 0, type: 'android.widget.EditText', value: '', placeholder: 'Title', hintShowing: true, identifier: 'dev.retest.tasks:id/title', rect: { x: 40, y: 200, width: 1000, height: 120 }, enabled: true, visibleToUser: true, ref: 'e2' },
  { index: 2, parentIndex: 0, type: 'android.widget.EditText', value: 'secret', password: true, identifier: 'password', rect: { x: 40, y: 340, width: 1000, height: 120 }, enabled: true, visibleToUser: true, ref: 'e3' },
  { index: 3, parentIndex: 0, type: 'android.widget.Button', label: 'Save', contentDescription: 'save-task', rect: { x: 40, y: 480, width: 400, height: 120 }, enabled: true, visibleToUser: true, ref: 'e4' },
  { index: 4, parentIndex: 0, type: 'android.widget.ImageButton', label: 'close-dialog', rect: { x: 900, y: 40, width: 120, height: 120 }, enabled: true, visibleToUser: true, ref: 'e5' },
  { index: 5, parentIndex: 0, type: 'android.widget.Switch', label: 'Done', checked: true, rect: { x: 40, y: 620, width: 400, height: 120 }, enabled: true, visibleToUser: false, ref: 'e6' },
  { index: 6, parentIndex: 0, type: 'com.example.CustomView', label: 'Custom', rect: { x: 40, y: 760, width: 400, height: 120 }, visibleToUser: true, ref: 'e7' },
]

const keep = (text: string): string => text

test('readSnapshot reads the nodes, the app, the ref generation and whether the tree was cut, and refuses what is not a snapshot', () => {
  const read = readSnapshot({ nodes: [{ index: 0, type: 'Other', ref: 'e1', rect: { x: 0, y: 0, width: 1, height: 1 }, interactionBlocked: 'covered', extra: { kept: false } }], appBundleId: 'dev.retest.fixtures.taskphone', refsGeneration: 739354, truncated: false })
  assert.ok(read.ok)
  assert.deepEqual(read.snapshot, { nodes: [{ index: 0, type: 'Other', ref: 'e1', rect: { x: 0, y: 0, width: 1, height: 1 }, covered: true }], appBundleId: 'dev.retest.fixtures.taskphone', refsGeneration: 739354, truncated: false })
  const cut = readSnapshot({ nodes: [], truncated: true })
  assert.ok(cut.ok && cut.snapshot.truncated)
  assert.equal(readSnapshot(undefined).ok, false)
  assert.equal(readSnapshot({ nodes: 'none' }).ok, false)
  assert.equal(readSnapshot({ nodes: [{ type: 'Other' }] }).ok, false, 'a node without an index cannot be placed')
})

test("an iOS tree keeps the snapshot's types, its identifiers as verified test ids, and the readings Retest's checks use", () => {
  const { tree, refs, rawValues, focused } = buildTree({ nodes: iosNodes, truncated: false }, 'ios-simulator', keep)
  assert.equal(tree.elements.length, iosNodes.length)
  assert.equal(tree.root.type, 'Other')
  const account = locate(tree, { by: 'testId', value: 'account-field' })
  assert.ok(account.ok)
  const [field] = account.matches
  assert.ok(field !== undefined)
  assert.equal(field.type, 'TextField')
  assert.equal(refs.get(field), 'e7')
  assert.deepEqual(identifierOf(field, 'ios-simulator'), { kind: 'verified', identifier: 'account-field' })
  // An empty field reads back as its placeholder, which an empty field and one holding that text both give.
  assert.deepEqual(valueReading(field, 'ios-simulator'), { kind: 'placeholder', placeholder: 'Account' })
  // A navigation bar whose identifier equals its title still counts: agent-device reports the identifier itself.
  const bar = locate(tree, { by: 'testId', value: 'TaskPhone' })
  assert.ok(bar.ok && bar.matches.length === 1)
  const password = locate(tree, { by: 'testId', value: 'password-field' })
  assert.ok(password.ok && password.matches[0] !== undefined)
  assert.equal(password.matches[0].type, 'SecureTextField')
  assert.equal(password.matches[0].attributes['type'], 'XCUIElementTypeSecureTextField')
  assert.equal(rawValues.get(password.matches[0]), '••••')
  assert.ok(focused.has(password.matches[0]))
  // The header's text and the button's name both read "Sign in"; a pick takes the last.
  const signIn = locate(tree, { by: 'text', text: 'Sign in' })
  assert.ok(signIn.ok)
  assert.deepEqual(signIn.matches.map((element) => element.type), ['StaticText', 'Button'])
  const last = locate(tree, { by: 'text', text: 'Sign in', pick: 'last' })
  assert.ok(last.ok && last.matches[0]?.type === 'Button')
  // A chain: the account field inside the second cell.
  const chained = locate(tree, { by: 'testId', value: 'account-field', within: [{ by: 'role', role: 'cell', pick: 1 }] })
  assert.ok(chained.ok && chained.matches.length === 1)
  const button = locate(tree, { by: 'role', role: 'button', name: 'Sign in' })
  assert.ok(button.ok && button.matches.length === 1)
  const observed = observeTree(tree, { by: 'testId', value: 'sign-in-button' })
  assert.ok(observed.ok)
  assert.equal(observed.observation.enabled, false)
  assert.equal(observed.observation.visible, true)
  assert.equal(observed.observation.text, 'Sign in')
  // A node with no area is not on screen.
  const hidden = locate(tree, { by: 'text', text: 'Hidden' })
  assert.ok(hidden.ok && hidden.matches[0] !== undefined)
  assert.deepEqual(visibilityReading(hidden.matches[0], 'ios-simulator'), { kind: 'read', value: false })
})

test('an Android tree maps widget classes to element types, reads resource ids and content descriptions, and refuses to take a label for a test id', () => {
  const { tree } = buildTree({ nodes: androidNodes, truncated: false }, 'android', keep)
  const types = tree.elements.map((element) => element.type)
  assert.deepEqual(types, ['Other', 'TextField', 'SecureTextField', 'Button', 'Button', 'Switch', 'Other'])
  assert.equal(androidElementTypes['androidx.recyclerview.widget.RecyclerView'], 'CollectionView')
  // A resource id counts whole and by the name after `:id/`.
  for (const value of ['dev.retest.tasks:id/title', 'title']) {
    const found = locate(tree, { by: 'testId', value })
    assert.ok(found.ok && found.matches.length === 1, value)
  }
  // A content description agent-device reports beside the text counts.
  const save = locate(tree, { by: 'testId', value: 'save-task' })
  assert.ok(save.ok && save.matches[0]?.type === 'Button')
  // A label that may be a content description or text is never a test id, and the lookup says so.
  const close = locate(tree, { by: 'testId', value: 'close-dialog' })
  assert.ok(close.ok)
  assert.deepEqual(close.matches, [])
  assert.deepEqual(close.unverified, { value: 'close-dialog', count: 1 })
  // A field showing its hint holds nothing; Android says so, so the value is read as empty, not as the hint.
  const title = locate(tree, { by: 'testId', value: 'title' })
  assert.ok(title.ok && title.matches[0] !== undefined)
  assert.deepEqual(valueReading(title.matches[0], 'android'), { kind: 'read', value: '' })
  // A switch holds its state as 1 or 0; Android reports the user cannot see it.
  const done = locate(tree, { by: 'role', role: 'switch' })
  assert.ok(done.ok && done.matches[0] !== undefined)
  assert.equal(done.matches[0].attributes['value'], '1')
  assert.deepEqual(visibilityReading(done.matches[0], 'android'), { kind: 'read', value: false })
  // A role Retest's Android table does not name is refused by name; a class it does not name has no role.
  const alert = locate(tree, { by: 'role', role: 'alert' })
  assert.ok(!alert.ok && alert.failure.class === 'unsupported')
  assert.match(alert.failure.message, /no Android element type/)
  const custom = locate(tree, { by: 'text', text: 'Custom' })
  assert.ok(custom.ok && custom.matches[0] !== undefined)
  assert.deepEqual(textReading(custom.matches[0], 'android'), { kind: 'read', value: 'Custom' })
  assert.equal(describeElement(custom.matches[0], 'android'), 'a Other named "Custom"')
  // A text check on a field is refused, as on iOS: a field's text is what was typed.
  assert.equal(unsupportedCheck({ matcher: 'toHaveText', text: 'x' }, title.matches, { by: 'testId', value: 'title' }, 'android')?.class, 'unsupported')
})

test('several top nodes get a root of their own, and every text the app wrote is redacted before it is kept', () => {
  const nodes: SnapshotNode[] = [
    { index: 0, type: 'android.widget.TextView', label: 'Code 8271', rect: { x: 0, y: 0, width: 10, height: 10 }, visibleToUser: true, ref: 'e1' },
    { index: 1, type: 'android.widget.EditText', value: '8271', identifier: 'code-8271', rect: { x: 0, y: 20, width: 10, height: 10 }, visibleToUser: true, ref: 'e2' },
  ]
  const { tree, rawValues } = buildTree({ nodes, truncated: false }, 'android', (text) => text.replaceAll('8271', '{{code}}'))
  assert.equal(tree.root.type, 'Application')
  assert.deepEqual(tree.root.children.map((child) => child.type), ['StaticText', 'TextField'])
  assert.equal(tree.elements[1]?.attributes['label'], 'Code {{code}}')
  const field = tree.elements[2]
  assert.ok(field !== undefined)
  assert.equal(field.attributes['value'], '{{code}}')
  assert.deepEqual(field.testIds?.verified, ['code-{{code}}'])
  // The fill's own read-back keeps the value as the app holds it, inside the session alone.
  assert.equal(rawValues.get(field), '8271')
})

test('getByLabel finds a labelled field on iOS and on Android, and not a button or a text with that label', () => {
  const nodes = (platform: 'ios-simulator' | 'android'): SnapshotNode[] => [
    { index: 0, type: platform === 'android' ? 'android.widget.FrameLayout' : 'Other', rect: { x: 0, y: 0, width: 400, height: 800 }, visibleToUser: true, ref: 'e1' },
    { index: 1, parentIndex: 0, type: platform === 'android' ? 'android.widget.EditText' : 'TextField', label: 'Title', value: '', rect: { x: 0, y: 10, width: 400, height: 40 }, visibleToUser: true, enabled: true, ref: 'e2' },
    { index: 2, parentIndex: 0, type: platform === 'android' ? 'android.widget.Button' : 'Button', label: 'Title', rect: { x: 0, y: 60, width: 400, height: 40 }, visibleToUser: true, enabled: true, ref: 'e3' },
    { index: 3, parentIndex: 0, type: platform === 'android' ? 'android.widget.TextView' : 'StaticText', label: 'Title', rect: { x: 0, y: 110, width: 400, height: 40 }, visibleToUser: true, ref: 'e4' },
  ]
  for (const platform of ['ios-simulator', 'android'] as const) {
    const { tree } = buildTree({ nodes: nodes(platform), truncated: false }, platform, keep)
    const found = locate(tree, { by: 'label', text: 'Title' })
    assert.ok(found.ok, platform)
    assert.deepEqual(found.matches.map((element) => element.type), ['TextField'], platform)
    const loose = locate(tree, { by: 'label', text: 'tit', exact: false })
    assert.ok(loose.ok && loose.matches.length === 1, platform)
  }
})
