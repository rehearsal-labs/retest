import type { NativeKind } from '../../browser/contract.ts'
import type { NativeElement, NativeTree, TestIdReading } from '../locators.ts'
import type { Rect } from '../webdriver-client.ts'
import { fieldTypes, toggleTypes } from '../locators.ts'

// A screen as agent-device reads it, turned into the tree Retest's locators and checks read. agent-device's snapshot is
// a flat list of nodes, each naming its parent; this keeps their order, gives each node the element type Retest's
// tables use, and writes the facts the readings need as the attributes they read: `label`, `value`,
// `placeholderValue`, `enabled`, `visible`, `selected` (and `traits` on iOS), `hintShowing` and, where it can be told
// from a content description, `text` on Android, and the frame.
// Every text the app wrote passes through `redact` before it is kept. The test ids an element has are read here once,
// as `TestIdReading`: an iOS node's accessibility identifier, or an Android node's resource id and content description.
// Nothing here is from agent-device's own code; it reads the fields agent-device 0.21.36 documents for its nodes.

/** One node of a snapshot, as Retest reads it: only the fields it uses, each checked for its type. */
export type SnapshotNode = {
  readonly index: number
  readonly parentIndex?: number
  readonly ref?: string
  readonly type?: string
  readonly label?: string
  readonly value?: string
  readonly placeholder?: string
  readonly identifier?: string
  readonly contentDescription?: string
  readonly rect?: Rect
  readonly enabled?: boolean
  readonly selected?: boolean
  readonly checked?: boolean
  readonly focused?: boolean
  readonly password?: boolean
  readonly editable?: boolean
  readonly hintShowing?: boolean
  readonly visibleToUser?: boolean
  readonly covered?: boolean
}

/** A snapshot as Retest reads it: its nodes, the app it read, the generation its refs belong to, and whether it is whole. */
export type Snapshot = { readonly nodes: readonly SnapshotNode[]; readonly appBundleId?: string; readonly refsGeneration?: number; readonly truncated: boolean }

/**
 * Reads agent-device's snapshot answer, or says why it cannot: a value that is not a snapshot, or one with no nodes.
 *
 * @example readSnapshot({ nodes: [{ index: 0, type: 'Other', ref: 'e1' }], refsGeneration: 4 }).ok // true
 */
export function readSnapshot(value: unknown): { readonly ok: true; readonly snapshot: Snapshot } | { readonly ok: false; readonly problem: string } {
  if (typeof value !== 'object' || value === null) return { ok: false, problem: 'agent-device answered the snapshot with no snapshot.' }
  const listed: unknown = Reflect.get(value, 'nodes')
  if (!Array.isArray(listed)) return { ok: false, problem: 'agent-device answered the snapshot with no nodes.' }
  const nodes: SnapshotNode[] = []
  for (const item of listed) {
    const node = readNode(item)
    if (node === undefined) return { ok: false, problem: 'agent-device answered the snapshot with a node Retest cannot read.' }
    nodes.push(node)
  }
  const appBundleId = text(Reflect.get(value, 'appBundleId'))
  const generation: unknown = Reflect.get(value, 'refsGeneration')
  const truncated = Reflect.get(value, 'truncated') === true
  return { ok: true, snapshot: { nodes, ...(appBundleId === undefined ? {} : { appBundleId }), ...(typeof generation === 'number' && Number.isSafeInteger(generation) ? { refsGeneration: generation } : {}), truncated } }
}

function readNode(item: unknown): SnapshotNode | undefined {
  if (typeof item !== 'object' || item === null) return undefined
  const get = (key: string): unknown => Reflect.get(item, key)
  const index = get('index')
  if (typeof index !== 'number' || !Number.isSafeInteger(index)) return undefined
  const parent = get('parentIndex')
  const strings = Object.fromEntries((['ref', 'type', 'label', 'value', 'placeholder', 'identifier', 'contentDescription'] as const).flatMap((key) => {
    const read = text(get(key))
    return read === undefined ? [] : [[key, read]]
  }))
  const flags = Object.fromEntries((['enabled', 'selected', 'checked', 'focused', 'password', 'editable', 'hintShowing', 'visibleToUser'] as const).flatMap((key) => {
    const read = get(key)
    return typeof read === 'boolean' ? [[key, read]] : []
  }))
  const rect = readRect(get('rect'))
  return {
    index,
    ...(typeof parent === 'number' && Number.isSafeInteger(parent) ? { parentIndex: parent } : {}),
    ...strings,
    ...flags,
    ...(rect === undefined ? {} : { rect }),
    ...(get('interactionBlocked') === 'covered' ? { covered: true } : {}),
  }
}

function readRect(value: unknown): Rect | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const [x, y, width, height] = ['x', 'y', 'width', 'height'].map((key): unknown => Reflect.get(value, key))
  if (typeof x !== 'number' || typeof y !== 'number' || typeof width !== 'number' || typeof height !== 'number') return undefined
  if (![x, y, width, height].every(Number.isFinite)) return undefined
  return { x, y, width, height }
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/**
 * Retest's element types for Android's widget classes, as an accessibility tree names them. A class this table does
 * not name is `Other`, so no role finds it. Written from Android's documented class names; not yet checked against a
 * real emulator or device.
 */
export const androidElementTypes: Readonly<Record<string, string>> = {
  'android.widget.Button': 'Button',
  'android.widget.ImageButton': 'Button',
  'android.widget.EditText': 'TextField',
  'android.widget.AutoCompleteTextView': 'TextField',
  'android.widget.MultiAutoCompleteTextView': 'TextField',
  'android.widget.TextView': 'StaticText',
  'android.widget.CheckBox': 'CheckBox',
  'android.widget.Switch': 'Switch',
  'androidx.appcompat.widget.SwitchCompat': 'Switch',
  'com.google.android.material.switchmaterial.SwitchMaterial': 'Switch',
  'android.widget.ToggleButton': 'Toggle',
  'android.widget.RadioButton': 'RadioButton',
  'android.widget.RadioGroup': 'RadioGroup',
  'android.widget.ImageView': 'Image',
  'android.widget.SeekBar': 'Slider',
  'android.widget.ProgressBar': 'ProgressIndicator',
  'android.widget.Spinner': 'PopUpButton',
  'android.widget.ListView': 'CollectionView',
  'android.widget.GridView': 'CollectionView',
  'androidx.recyclerview.widget.RecyclerView': 'CollectionView',
  'android.widget.ScrollView': 'ScrollView',
  'android.widget.HorizontalScrollView': 'ScrollView',
  'androidx.core.widget.NestedScrollView': 'ScrollView',
  'android.widget.TabWidget': 'TabBar',
  'android.webkit.WebView': 'WebView',
}

/** A tree read from a snapshot: the tree, each element's ref to act on it by, and each field's value as the app holds it. */
export type ReadTree = {
  readonly tree: NativeTree
  /** The ref agent-device gave each element, good only for the snapshot it came from. */
  readonly refs: ReadonlyMap<NativeElement, string>
  /** Each field's value before redaction, for a fill's own read-back alone. It never leaves the interaction session. */
  readonly rawValues: ReadonlyMap<NativeElement, string>
  /** Whether the element was covered when agent-device read it, by its own reading of what lies over it. */
  readonly covered: ReadonlySet<NativeElement>
  /** Whether the element held the keyboard focus. */
  readonly focused: ReadonlySet<NativeElement>
}

type Building = { index: number; type: string; attributes: Record<string, string>; frame: Rect | undefined; parent: Building | undefined; children: Building[]; testIds: TestIdReading }

/**
 * Builds the tree of a snapshot for a platform. A snapshot with several top nodes gets a root of its own, an
 * `Application` with no attributes, so the tree has one root as the locators expect.
 *
 * @example buildTree(snapshot, 'ios-simulator', (text) => text).tree.elements.length // the snapshot's node count
 */
export function buildTree(snapshot: Snapshot, platform: Exclude<NativeKind, 'macos'>, redact: (text: string) => string): ReadTree {
  const byIndex = new Map<number, Building>()
  const refs = new Map<Building, string>()
  const rawValues = new Map<Building, string>()
  const covered = new Set<Building>()
  const focused = new Set<Building>()
  const ordered: Building[] = []
  for (const node of snapshot.nodes) {
    const element = buildElement(node, platform, redact)
    byIndex.set(node.index, element)
    ordered.push(element)
    if (node.ref !== undefined) refs.set(element, node.ref)
    if (node.value !== undefined && fieldTypes.has(element.type)) rawValues.set(element, node.value)
    if (node.covered === true) covered.add(element)
    if (node.focused === true) focused.add(element)
  }
  const tops: Building[] = []
  for (const [position, node] of snapshot.nodes.entries()) {
    const element = ordered[position]
    if (element === undefined) continue
    const parent = node.parentIndex === undefined ? undefined : byIndex.get(node.parentIndex)
    if (parent === undefined || parent === element) tops.push(element)
    else {
      element.parent = parent
      parent.children.push(element)
    }
  }
  const [only, ...others] = tops
  const root: Building = only !== undefined && others.length === 0 ? only : { index: 0, type: 'Application', attributes: {}, frame: undefined, parent: undefined, children: tops, testIds: { verified: [], unverifiable: [] } }
  if (root !== only) for (const top of tops) top.parent = root
  // Document order: a parent before its children, siblings as the snapshot lists them.
  const elements: Building[] = []
  const visit = (element: Building): void => {
    element.index = elements.length
    elements.push(element)
    for (const child of element.children) visit(child)
  }
  visit(root)
  const tree: NativeTree = { platform, root, elements }
  return { tree, refs, rawValues, covered, focused }
}

function buildElement(node: SnapshotNode, platform: Exclude<NativeKind, 'macos'>, redact: (text: string) => string): Building {
  const type = elementType(node, platform)
  const attributes: Record<string, string> = {}
  const put = (key: string, value: string | undefined): void => {
    if (value !== undefined) attributes[key] = redact(value)
  }
  const flag = (key: string, value: boolean | undefined): void => {
    if (value !== undefined) attributes[key] = value ? 'true' : 'false'
  }
  put('label', node.label)
  if (platform === 'android' && !fieldTypes.has(type)) {
    const shown = androidText(node)
    if (shown !== undefined) put('text', shown)
  }
  put('placeholderValue', node.placeholder)
  if (node.type !== undefined) put(platform === 'android' ? 'class' : 'type', platform === 'android' ? node.type : `XCUIElementType${node.type}`)
  // A switch, toggle, checkbox or radio button holds its state as its value, 1 or 0, as the platform's executors write it.
  if (toggleTypes.has(type) && node.checked !== undefined) attributes['value'] = node.checked ? '1' : '0'
  else put('value', node.value)
  flag('enabled', node.enabled)
  flag('selected', node.selected)
  if (platform === 'ios-simulator' && node.selected !== undefined) attributes['traits'] = node.selected ? 'Selected' : ''
  if (platform === 'android') flag('hintShowing', node.hintShowing)
  const visible = visibleOf(node, platform)
  if (visible !== undefined) attributes['visible'] = visible ? 'true' : 'false'
  if (node.rect !== undefined) {
    attributes['x'] = String(node.rect.x)
    attributes['y'] = String(node.rect.y)
    attributes['width'] = String(node.rect.width)
    attributes['height'] = String(node.rect.height)
  }
  return { index: node.index, type, attributes, frame: node.rect, parent: undefined, children: [], testIds: testIdsOf(node, platform, redact) }
}

// The text an Android view shows, where agent-device lets it be told. agent-device labels a view by its text, or by its
// content description when the view shows no text, and reports the content description apart only beside text that
// differs from it. So a label with a content description beside it is the text, and no label is no text. A label alone
// is the text, or the content description of a view that shows none: agent-device writes a title with no content
// description and an empty view with one alike. Such a label carries no `text`; it is read as the text, and a text check
// that fails on it says what it may be.
function androidText(node: SnapshotNode): string | undefined {
  if (node.label === undefined) return ''
  return node.contentDescription === undefined ? undefined : node.label
}

// iOS names its element types as XCTest does, and agent-device writes the name; Android writes the widget class, which
// Retest's table names. A text field that masks what it holds is a secure field on both.
function elementType(node: SnapshotNode, platform: Exclude<NativeKind, 'macos'>): string {
  if (platform === 'ios-simulator') return node.type !== undefined && /^\w+$/.test(node.type) ? node.type : 'Other'
  const type = node.type === undefined ? 'Other' : (androidElementTypes[node.type] ?? 'Other')
  return type === 'TextField' && node.password === true ? 'SecureTextField' : type
}

// On iOS a snapshot holds what lies on screen, cut to its visible part, and leaves out what lies wholly outside: a node
// with an area is on screen unless agent-device says it is not. Android says for each node whether the user sees it;
// a node it says nothing of is unreported.
function visibleOf(node: SnapshotNode, platform: Exclude<NativeKind, 'macos'>): boolean | undefined {
  if (node.visibleToUser !== undefined) return node.visibleToUser
  if (platform === 'android') return undefined
  if (node.rect === undefined) return undefined
  return node.rect.width > 0 && node.rect.height > 0
}

// An iOS node's identifier is its accessibility identifier, as XCTest reports it. An Android node's resource id counts
// whole, `com.example:id/save`, and by the name after `:id/`; its content description counts when agent-device reports
// it beside the node's text. A label agent-device took from the content description of a node with no text cannot be
// told from text, so it never counts, and a lookup that finds only such labels says so.
function testIdsOf(node: SnapshotNode, platform: Exclude<NativeKind, 'macos'>, redact: (text: string) => string): TestIdReading {
  const verified: string[] = []
  const unverifiable: string[] = []
  const add = (list: string[], value: string | undefined): void => {
    if (value === undefined || value === '') return
    const safe = redact(value)
    if (!list.includes(safe)) list.push(safe)
  }
  if (platform === 'ios-simulator') {
    add(verified, node.identifier)
    return { verified, unverifiable }
  }
  add(verified, node.identifier)
  const entry = node.identifier === undefined ? undefined : /:id\/(.+)$/.exec(node.identifier)?.[1]
  add(verified, entry)
  add(verified, node.contentDescription)
  if (node.contentDescription === undefined && node.label !== undefined && !verified.includes(redact(node.label))) add(unverifiable, node.label)
  return { verified, unverifiable }
}
