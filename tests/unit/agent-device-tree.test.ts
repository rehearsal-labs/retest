import type { AgentDevicePort } from '../../src/native/agent-device/package.ts'
import type { SnapshotNode } from '../../src/native/agent-device/tree.ts'
import type { NativeTree } from '../../src/native/locators.ts'
import type { EventBody } from '../../src/protocol/events.ts'
import type { Failure } from '../../src/protocol/failures.ts'
import type { LocatorCheckRecord } from '../../src/protocol/locator-checks.ts'
import type { LocatorRecipe } from '../../src/protocol/locator.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AgentDeviceInteraction } from '../../src/native/agent-device/interaction.ts'
import { androidElementTypes, buildTree, readSnapshot } from '../../src/native/agent-device/tree.ts'
import { observeTree, unsupportedCheck } from '../../src/native/assertions.ts'
import { describeElement, identifierOf, locate, textReading, valueReading, visibilityReading } from '../../src/native/locators.ts'
import { holdsOneLabelNote, locatorCheck, oneLabelNote } from '../../src/protocol/locator-checks.ts'
import { NativePageAdapter } from '../../src/runner/native-pool.ts'
import { RunningTest } from '../../src/runner/running-test.ts'
import { ScriptedProcess } from '../support/scripted-process.ts'

// Snapshots agent-device gives, read into the trees Retest's locators and checks read. The iOS nodes are TaskPhone's
// sign-in screen as agent-device 0.21.36 snapshotted it on the iOS 26.5 simulator. The first Android nodes are written
// from agent-device's documented node fields; the benchmark task app's nodes came from the Android 15 emulator.

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
  // A cell carries no label, so Retest read no text of it, and a failed text check does not say it has empty text.
  const cell = observeTree(tree, { by: 'role', role: 'cell', pick: 'first' })
  assert.ok(cell.ok && cell.observation.text === null)
  assert.match(locatorCheck({ matcher: 'toHaveText', text: 'Sign in' }).mismatch(cell.observation, "getByRole('cell').first()"), /^getByRole\('cell'\)\.first\(\) has no text Retest could read, expected "Sign in"\./)
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

// The benchmark task app's own nodes on the Android 15 emulator, as agent-device 0.21.36 snapshotted them on 13 November
// 2026, before Save and after it. Android's own dump of the first screen gives the saved task `text=""` and
// `content-desc="saved_task"`, and the title `text="Bench Tasks"` and `content-desc=""`; agent-device gives both a label
// and neither a content description.
function benchmarkScreen(saved: string | undefined): unknown {
  const app = { enabled: true, selected: false, editable: false, password: false, hintShowing: false, bundleId: 'dev.retest.bench.tasks', visibleToUser: true }
  return {
    appBundleId: 'dev.retest.bench.tasks',
    refsGeneration: 856597,
    truncated: false,
    nodes: [
      { ...app, index: 7, type: 'android.widget.FrameLayout', rect: { x: 0, y: 136, width: 1080, height: 2264 }, depth: 0, ref: 'e8', kind: 'group' },
      { ...app, index: 8, type: 'android.view.ViewGroup', identifier: 'android:id/decor_content_parent', rect: { x: 0, y: 136, width: 1080, height: 2201 }, depth: 1, parentIndex: 7, ref: 'e9', kind: 'group' },
      { ...app, index: 9, type: 'android.widget.TextView', label: 'Bench Tasks', rect: { x: 42, y: 174, width: 301, height: 71 }, depth: 2, parentIndex: 8, ref: 'e10', kind: 'text' },
      { ...app, index: 10, type: 'android.widget.FrameLayout', identifier: 'android:id/content', rect: { x: 0, y: 283, width: 1080, height: 2054 }, depth: 2, parentIndex: 8, ref: 'e11', kind: 'group' },
      { ...app, index: 11, type: 'android.widget.LinearLayout', rect: { x: 0, y: 283, width: 1080, height: 2054 }, depth: 3, parentIndex: 10, ref: 'e12', kind: 'group' },
      saved === undefined
        ? { ...app, index: 12, type: 'android.widget.EditText', label: 'Task title', value: '', contentDescription: 'task_title', editable: true, hintShowing: true, placeholder: 'Task title', identifier: 'dev.retest.bench.tasks:id/task_title', rect: { x: 48, y: 379, width: 984, height: 118 }, hittable: true, depth: 4, parentIndex: 11, ref: 'e13', kind: 'text-field' }
        : { ...app, index: 12, type: 'android.widget.EditText', label: saved, value: saved, contentDescription: 'task_title', editable: true, placeholder: 'Task title', selectionStart: 19, selectionEnd: 19, identifier: 'dev.retest.bench.tasks:id/task_title', rect: { x: 48, y: 379, width: 984, height: 118 }, focused: true, hittable: true, depth: 4, parentIndex: 11, ref: 'e13', kind: 'text-field' },
      { ...app, index: 13, type: 'android.widget.Button', label: 'Save', contentDescription: 'save_task', identifier: 'dev.retest.bench.tasks:id/save_task', rect: { x: 48, y: 497, width: 984, height: 126 }, hittable: true, depth: 4, parentIndex: 11, ref: 'e14', kind: 'button' },
      { ...app, index: 14, type: 'android.widget.TextView', label: saved ?? 'saved_task', ...(saved === undefined ? {} : { contentDescription: 'saved_task' }), identifier: 'dev.retest.bench.tasks:id/saved_task', rect: { x: 48, y: 623, width: 984, height: 71 }, depth: 4, parentIndex: 11, ref: 'e15', kind: 'text' },
    ],
  }
}

test('an Android view reads as its text, or as the label agent-device gives a view with no text, and a layout as empty text', () => {
  const treeOf = (saved: string | undefined): NativeTree => {
    const read = readSnapshot(benchmarkScreen(saved))
    assert.ok(read.ok)
    return buildTree(read.snapshot, 'android', keep).tree
  }
  const judged = (tree: NativeTree, recipe: LocatorRecipe, record: LocatorCheckRecord): { readonly text: string | null; readonly passes: boolean } => {
    const observed = observeTree(tree, recipe)
    assert.ok(observed.ok && observed.matches.length === 1)
    assert.equal(unsupportedCheck(record, observed.matches, recipe, 'android'), undefined, 'the check is judged on the text it read')
    return { text: observed.observation.text, passes: locatorCheck(record).passes(observed.observation) }
  }
  const empty = treeOf(undefined)
  // The title has text and no content description: it reads as its text, and a check of it passes.
  assert.deepEqual(judged(empty, { by: 'text', text: 'Bench Tasks' }, { matcher: 'toHaveText', text: 'Bench Tasks' }), { text: 'Bench Tasks', passes: true })
  // The saved task shows nothing, and agent-device gives it its content description as its label, which is read.
  const savedTask = { by: 'testId', value: 'saved_task' } as const
  assert.deepEqual(judged(empty, savedTask, { matcher: 'toHaveText', text: 'Release checklist 1' }), { text: 'saved_task', passes: false })
  assert.deepEqual(judged(empty, savedTask, { matcher: 'toHaveText', text: '' }), { text: 'saved_task', passes: false })
  // A button with text and a content description beside it reads as its text; a layout with neither as empty text.
  assert.deepEqual(judged(empty, { by: 'testId', value: 'save_task' }, { matcher: 'toHaveText', text: 'Save' }), { text: 'Save', passes: true })
  const layout = empty.elements.find((element) => element.attributes['class'] === 'android.widget.LinearLayout')
  assert.ok(layout !== undefined)
  assert.deepEqual(textReading(layout, 'android'), { kind: 'read', value: '' })
  // After Save agent-device reports the content description apart, beside the label that is the view's text.
  const filled = treeOf('Release checklist 1')
  assert.deepEqual(judged(filled, savedTask, { matcher: 'toHaveText', text: 'Release checklist 1' }), { text: 'Release checklist 1', passes: true })
  const found = locate(filled, savedTask)
  assert.ok(found.ok)
  const [saved] = found.matches
  assert.ok(saved !== undefined)
  assert.deepEqual(saved.testIds?.verified, ['dev.retest.bench.tasks:id/saved_task', 'saved_task'])
  assert.equal(saved.attributes['text'], 'Release checklist 1', 'the text is known apart from the description')
  // getByText finds a view by its label, getByLabel the field by its label, which is its hint while it is empty.
  const byText = locate(empty, { by: 'text', text: 'saved_task' })
  assert.ok(byText.ok && byText.matches.length === 1)
  const field = locate(empty, { by: 'label', text: 'Task title' })
  assert.ok(field.ok && field.matches.length === 1 && field.matches[0]?.type === 'TextField')
})

// The parent's own verdict on a look at the benchmark app through agent-device: the failure of a text check read from a
// label with no content description beside it says the label may be the view's content description; nothing else does.
test('a text check that fails on an Android label agent-device gave a view with no text says it may be its content description', async (t) => {
  let saved: string | undefined
  let generation = 0
  const port: AgentDevicePort = {
    call: (method) => {
      if (method === 'capture.snapshot') {
        generation += 1
        const screen = benchmarkScreen(saved)
        return Promise.resolve({ status: 'answered', value: typeof screen === 'object' && screen !== null ? { ...screen, refsGeneration: generation } : screen, durationMs: 1 })
      }
      return Promise.resolve({ status: 'answered', value: method === 'apps.open' ? { appBundleId: 'dev.retest.bench.tasks' } : {}, durationMs: 1 })
    },
  }
  const interaction = new AgentDeviceInteraction({
    port,
    session: 'retest-1-session',
    sessionId: 'attempt:tasks',
    platform: 'android',
    device: { platform: 'android', serial: 'emulator-5554' },
    bundleId: 'dev.retest.bench.tasks',
    launch: { arguments: [], environment: {} },
    redact: keep,
    install: () => Promise.resolve({ result: { ok: true }, input: 'sent' }),
    processes: () => Promise.resolve({ ok: false, problem: 'not read' }),
    screen: () => Promise.resolve({ ok: false, failure: { class: 'not_actionable', message: 'no screen' } }),
  })
  t.after(() => interaction.dispose(5000))
  const launched = await interaction.launch(5000)
  assert.ok(launched.result.ok)
  const process = new ScriptedProcess()
  const events: EventBody[] = []
  const budgets = { collection: 2000, setup: 2000, action: 2000, assertion: 2000, navigation: 2000, cleanup: 2000, test: 5000 }
  const running = new RunningTest({ process, pages: new Map([['tasks', new NativePageAdapter(interaction)]]), testId: 'test', attemptId: 'attempt', timeouts: budgets, emit: (body) => events.push(body) })
  const report = running.run()
  let id = 0
  const check = async (locator: LocatorRecipe, record: LocatorCheckRecord, claimed: 'passed' | 'failed'): Promise<Failure | undefined> => {
    id += 1
    process.deliver({ type: 'command', ...process.scope, id, app: 'tasks', command: { kind: 'observe', locator }, timeoutMs: 2000 })
    const look = await process.answer(id)
    if (!look.ok || look.kind !== 'observe') throw new Error('no native look')
    const base = { testId: 'test', attemptId: 'attempt', session: 'tasks', observationId: look.observationId, sessionId: look.sessionId, locator, matcher: record.matcher, check: record, attempts: 1, expected: null, actual: null, durationMs: 1 }
    const before = events.length
    process.deliver({ type: 'event', event: claimed === 'passed' ? { type: 'assertion.passed', ...base } : { type: 'assertion.failed', ...base, failure: { class: 'check_failed', message: 'The process says it failed.' } } })
    const written = events.slice(before).find((body) => body.type === 'assertion.passed' || body.type === 'assertion.failed')
    return written?.type === 'assertion.failed' ? written.failure : undefined
  }
  const savedTask = { by: 'testId', value: 'saved_task' } as const
  const empty = await check(savedTask, { matcher: 'toHaveText', text: 'Release checklist 1' }, 'failed')
  assert.equal(empty?.class, 'check_failed')
  assert.match(empty?.message ?? '', /^a look at getByTestId\('saved_task'\) has text "saved_task", expected "Release checklist 1"\./)
  assert.ok(empty?.message.endsWith(` ${oneLabelNote('saved_task')}`), empty?.message)
  assert.equal(oneLabelNote('saved_task'), 'agent-device gives an Android view one label for its text and its content description, so if the view has no text, "saved_task" is its content description.')
  assert.ok(holdsOneLabelNote(empty?.message ?? ''), 'a reporter shows the message, which says more than the values')
  // The title's check passes on its text, and a failing check of a text known apart carries no note.
  assert.equal(await check({ by: 'text', text: 'Bench Tasks' }, { matcher: 'toHaveText', text: 'Bench Tasks' }, 'passed'), undefined)
  saved = 'Release checklist 1'
  const known = await check(savedTask, { matcher: 'toHaveText', text: 'saved_task' }, 'failed')
  assert.equal(known?.class, 'check_failed')
  assert.equal(holdsOneLabelNote(known?.message ?? ''), false, known?.message)
  assert.equal(await check(savedTask, { matcher: 'toHaveText', text: 'Release checklist 1' }, 'passed'), undefined)
  process.deliver({ type: 'test-finished', testId: 'test', attemptId: 'attempt', status: 'failed', failure: { class: 'check_failed', message: 'The process says it failed.' }, assertionCount: 4, durationMs: 0 })
  await report
  running.close()
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
