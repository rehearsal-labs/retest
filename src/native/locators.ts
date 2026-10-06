import type { NativeKind } from '../browser/contract.ts'
import type { AriaRole } from '../protocol/aria-role.ts'
import type { Failure } from '../protocol/failures.ts'
import type { EmptyStep, LocatorPick, LocatorRecipe, LocatorStep, TextMatch } from '../protocol/locator.ts'
import type { Rect } from './webdriver-client.ts'
import { matchesText } from '../browser/text-match.ts'
import { describeLocator, describeStep, locatorProblem, locatorSteps } from '../protocol/locator.ts'
import { quoteText } from '../protocol/text.ts'

// Native locators, read from the session's own scoped tree. A test id is the element's accessibility identifier, read
// back from the element that matched: on macOS the runner writes `identifier` itself, and on iOS WebDriverAgent writes
// `name`, which is the identifier, or the label when the identifier is empty, so a `name` equal to the `label` cannot be
// told from a label and never counts as an identifier. A role is an element type, by the explicit table below; a role
// with no type on a platform is refused by name. Label, name and text compare as the web's locators do. Nothing here
// guesses: an element is found in the tree or it is not, and an action later resolves exactly that element on the
// executor with a predicate whose count must equal the tree's.

/** XCTest's element types by name, as `XCUIElementType` numbers them; the tree's tags carry the name after the prefix. */
export const elementTypeNumbers: Readonly<Record<string, number>> = {
  Any: 0, Other: 1, Application: 2, Group: 3, Window: 4, Sheet: 5, Drawer: 6, Alert: 7, Dialog: 8, Button: 9, RadioButton: 10,
  RadioGroup: 11, CheckBox: 12, DisclosureTriangle: 13, PopUpButton: 14, ComboBox: 15, MenuButton: 16, ToolbarButton: 17,
  Popover: 18, Keyboard: 19, Key: 20, NavigationBar: 21, TabBar: 22, TabGroup: 23, Toolbar: 24, StatusBar: 25, Table: 26,
  TableRow: 27, TableColumn: 28, Outline: 29, OutlineRow: 30, Browser: 31, CollectionView: 32, Slider: 33, PageIndicator: 34,
  ProgressIndicator: 35, ActivityIndicator: 36, SegmentedControl: 37, Picker: 38, PickerWheel: 39, Switch: 40, Toggle: 41,
  Link: 42, Image: 43, Icon: 44, SearchField: 45, ScrollView: 46, ScrollBar: 47, StaticText: 48, TextField: 49,
  SecureTextField: 50, DatePicker: 51, TextView: 52, Menu: 53, MenuItem: 54, MenuBar: 55, MenuBarItem: 56, Map: 57,
  WebView: 58, IncrementArrow: 59, DecrementArrow: 60, Timeline: 61, RatingIndicator: 62, ValueIndicator: 63, SplitGroup: 64,
  Splitter: 65, RelevanceIndicator: 66, ColorWell: 67, HelpTag: 68, Matte: 69, DockItem: 70, Ruler: 71, RulerMarker: 72,
  Grid: 73, LevelIndicator: 74, Cell: 75, LayoutArea: 76, LayoutItem: 77, Handle: 78, Stepper: 79, Tab: 80, TouchBar: 81,
  StatusItem: 82,
}

/**
 * The element types each ARIA role finds, per platform. A role absent here, or absent for a platform, has no native
 * element type there and is refused by name. Static text has no ARIA role: `getByText` and `getByTestId` find it.
 */
export const nativeRoleTypes: Readonly<Record<NativeKind, Partial<Readonly<Record<AriaRole, readonly string[]>>>>> = {
  'ios-simulator': {
    alert: ['Alert'],
    alertdialog: ['Alert'],
    button: ['Button'],
    cell: ['Cell'],
    gridcell: ['Cell'],
    img: ['Image'],
    link: ['Link'],
    list: ['Table', 'CollectionView'],
    listitem: ['Cell'],
    menu: ['Menu'],
    menuitem: ['MenuItem'],
    navigation: ['NavigationBar'],
    progressbar: ['ProgressIndicator'],
    scrollbar: ['ScrollBar'],
    searchbox: ['SearchField'],
    slider: ['Slider'],
    spinbutton: ['Stepper'],
    switch: ['Switch', 'Toggle'],
    tab: ['Tab'],
    tablist: ['TabBar'],
    textbox: ['TextField', 'SecureTextField', 'TextView'],
    toolbar: ['Toolbar'],
  },
  macos: {
    alert: ['Alert'],
    alertdialog: ['Alert'],
    button: ['Button'],
    cell: ['Cell'],
    checkbox: ['CheckBox'],
    combobox: ['ComboBox', 'PopUpButton'],
    dialog: ['Dialog', 'Sheet'],
    gridcell: ['Cell'],
    img: ['Image'],
    link: ['Link'],
    list: ['Table', 'Outline', 'CollectionView'],
    listitem: ['Cell'],
    menu: ['Menu'],
    menuitem: ['MenuItem'],
    progressbar: ['ProgressIndicator', 'LevelIndicator'],
    radio: ['RadioButton'],
    radiogroup: ['RadioGroup'],
    row: ['TableRow', 'OutlineRow'],
    scrollbar: ['ScrollBar'],
    searchbox: ['SearchField'],
    slider: ['Slider'],
    spinbutton: ['Stepper'],
    switch: ['Switch', 'Toggle'],
    tab: ['Tab'],
    tablist: ['TabGroup'],
    textbox: ['TextField', 'SecureTextField', 'TextView'],
    toolbar: ['Toolbar'],
    tree: ['Outline'],
    treeitem: ['OutlineRow'],
  },
}

// The roles `getByLabel` finds, as the web's labelled form controls, mapped through the table above.
const labelledRoles: readonly AriaRole[] = ['textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'switch', 'slider', 'spinbutton']

/** Element types that hold typed text: their value is what was typed, and they have no text of their own. */
export const fieldTypes: ReadonlySet<string> = new Set(['TextField', 'SecureTextField', 'SearchField', 'TextView'])

/** Element types whose value is a state, on or off, rather than text. */
export const toggleTypes: ReadonlySet<string> = new Set(['Switch', 'Toggle', 'CheckBox', 'RadioButton'])

/**
 * Element types whose selected state Retest reads, per platform: on iOS the `Selected` trait of buttons, cells and
 * tabs, as segmented controls, lists and tab bars set it; on macOS the runner's `selected` of rows, cells and tabs.
 * Every other type has no selected state to read, so a check of it is refused rather than passed on a `false`.
 */
export const selectableTypes: Readonly<Record<NativeKind, ReadonlySet<string>>> = {
  'ios-simulator': new Set(['Button', 'Cell', 'Tab']),
  macos: new Set(['Cell', 'TableRow', 'OutlineRow', 'Tab']),
}

/** An element of a scoped tree: its type after the `XCUIElementType` prefix, its attributes, frame and place. */
export type NativeElement = {
  /** Its position in the tree in document order, from 0. */
  readonly index: number
  readonly type: string
  readonly attributes: Readonly<Record<string, string>>
  readonly frame: Rect | undefined
  readonly parent: NativeElement | undefined
  readonly children: readonly NativeElement[]
}

/** A scoped tree, parsed: its root and every element in document order. */
export type NativeTree = { readonly platform: NativeKind; readonly root: NativeElement; readonly elements: readonly NativeElement[] }

type BuildingElement = { index: number; type: string; attributes: Record<string, string>; frame: Rect | undefined; parent: BuildingElement | undefined; children: BuildingElement[] }

// A tag with its attributes, each value quoted, so a `>` inside a value does not end the tag.
const tagPattern = /<(\/?)XCUIElementType(\w+)((?:\s+[\w:-]+="[^"]*")*)\s*(\/?)>/g
const attributePattern = /([\w:-]+)="([^"]*)"/g
const namedEntities: Readonly<Record<string, string>> = { quot: '"', apos: "'", lt: '<', gt: '>', amp: '&' }

/**
 * Parses a scoped tree as the session hands it out, XML of `XCUIElementType…` elements, decoding XML's entities and
 * character references in attribute values.
 *
 * @example parseNativeTree('<XCUIElementTypeWindow x="0" y="0" width="10" height="10"/>', 'macos').ok // true
 */
export function parseNativeTree(xml: string, platform: NativeKind): { readonly ok: true; readonly tree: NativeTree } | { readonly ok: false; readonly problem: string } {
  const elements: BuildingElement[] = []
  const open: BuildingElement[] = []
  let root: BuildingElement | undefined
  for (const tag of xml.matchAll(tagPattern)) {
    const [, closing, type = '', attributeText = '', selfClosing] = tag
    if (closing === '/') {
      const closed = open.pop()
      if (closed === undefined || closed.type !== type) return { ok: false, problem: `The tree closes ${type} where it did not open one.` }
      continue
    }
    if (root !== undefined && open.length === 0) return { ok: false, problem: 'The tree has more than one root element.' }
    const attributes = readAttributes(attributeText)
    const parent = open.at(-1)
    const element: BuildingElement = { index: elements.length, type, attributes, frame: readFrame(attributes), parent, children: [] }
    elements.push(element)
    parent?.children.push(element)
    root ??= element
    if (selfClosing !== '/') open.push(element)
  }
  if (root === undefined) return { ok: false, problem: 'The tree holds no element.' }
  if (open.length > 0) return { ok: false, problem: 'The tree ends before its elements close.' }
  return { ok: true, tree: { platform, root, elements } }
}

function readAttributes(text: string): Record<string, string> {
  const attributes: Record<string, string> = {}
  for (const [, name, value = ''] of text.matchAll(attributePattern)) if (name !== undefined) attributes[name] = decodeEntities(value)
  return attributes
}

/** Redacts decoded XML attributes, then escapes them again before the tree leaves the session. */
export function redactNativeXml(xml: string, redact: (text: string) => string): string {
  return xml.replace(attributePattern, (_whole, name: string, value: string) => {
    const safe = redact(decodeEntities(value))
    const escaped = safe.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll("'", '&apos;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    return `${name}="${escaped}"`
  })
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|quot|apos|lt|gt|amp);/g, (whole, entity: string) => {
    if (entity.startsWith('#x')) return codePoint(Number.parseInt(entity.slice(2), 16)) ?? whole
    if (entity.startsWith('#')) return codePoint(Number.parseInt(entity.slice(1), 10)) ?? whole
    return namedEntities[entity] ?? whole
  })
}

function codePoint(value: number): string | undefined {
  return Number.isInteger(value) && value >= 0 && value <= 0x10ffff ? String.fromCodePoint(value) : undefined
}

function readFrame(attributes: Readonly<Record<string, string>>): Rect | undefined {
  const values = ['x', 'y', 'width', 'height'].map((key) => attributes[key])
  if (values.some((value) => value === undefined || value === '')) return undefined
  const [x = Number.NaN, y = Number.NaN, width = Number.NaN, height = Number.NaN] = values.map(Number)
  if (![x, y, width, height].every(Number.isFinite)) return undefined
  return { x, y, width, height }
}

/** An attribute's value, or the empty string when the element does not carry it. */
export function attribute(element: NativeElement, name: string): string {
  return element.attributes[name] ?? ''
}

/**
 * What a test id finds on an element: its identifier, read back from the element; nothing; or, on iOS, a `name` equal
 * to the element's `label`, which WebDriverAgent writes for an element with no identifier too, so it cannot be told
 * from a label.
 */
export type IdentifierReading = { readonly kind: 'verified'; readonly identifier: string } | { readonly kind: 'none' } | { readonly kind: 'unverifiable'; readonly candidate: string }

/**
 * The element's accessibility identifier, as the tree lets Retest read it back.
 *
 * @example identifierOf(saveButton, 'macos') // { kind: 'verified', identifier: 'save-task' }
 */
export function identifierOf(element: NativeElement, platform: NativeKind): IdentifierReading {
  if (platform === 'macos') {
    const identifier = attribute(element, 'identifier')
    return identifier === '' ? { kind: 'none' } : { kind: 'verified', identifier }
  }
  const name = attribute(element, 'name')
  if (name === '') return { kind: 'none' }
  return name === attribute(element, 'label') ? { kind: 'unverifiable', candidate: name } : { kind: 'verified', identifier: name }
}

/** The element's accessible name, as `getByRole` reads it: its label, or on macOS its title when it has no label. */
export function nameOf(element: NativeElement, platform: NativeKind): string {
  const label = attribute(element, 'label')
  if (label !== '' || platform === 'ios-simulator') return label
  return attribute(element, 'title')
}

/**
 * The element's own text, as `getByText` and `toHaveText` read it: static text's value, or its label when it has no
 * value; any other element's name. A field has none, since its value is what was typed.
 *
 * @example textOf(staticText, 'macos') // 'Open'
 */
export function textOf(element: NativeElement, platform: NativeKind): string | undefined {
  if (fieldTypes.has(element.type)) return undefined
  if (element.type === 'StaticText') {
    const value = attribute(element, 'value')
    return value !== '' ? value : attribute(element, 'label')
  }
  return nameOf(element, platform)
}

/**
 * A state of an element as its tree gives it: `read` with the state; `none` when the element's type has no such state
 * on the platform; `unreported` when the executor left out the attribute the state is read from, which says nothing
 * about the state; and, for an iOS field's value only, `placeholder`, a value equal to the field's placeholder, which
 * WebDriverAgent writes alike for an empty field and for one holding that text.
 */
export type StateReading<T> =
  | { readonly kind: 'read'; readonly value: T }
  | { readonly kind: 'none' }
  | { readonly kind: 'unreported'; readonly attribute: string }
  | { readonly kind: 'placeholder'; readonly placeholder: string }

// The executors write a boolean attribute as `true` or `false`; anything else, or nothing, is not a reading of it.
function booleanAttribute(element: NativeElement, name: string): StateReading<boolean> {
  const value = element.attributes[name]
  if (value === 'true') return { kind: 'read', value: true }
  if (value === 'false') return { kind: 'read', value: false }
  return { kind: 'unreported', attribute: name }
}

/** Whether an element's type holds a value: a field's text, a toggle's state, a slider's or a stepper's number. */
export function holdsValue(element: NativeElement): boolean {
  return fieldTypes.has(element.type) || toggleTypes.has(element.type) || element.type === 'Slider' || element.type === 'Stepper'
}

/**
 * The `value` attribute exactly as the executor wrote it for an element that holds a value, the empty string when it
 * wrote none, and undefined for an element that holds no value. For the fill's own read in the parent, which compares
 * it with the typed text; `valueReading` says whether the attribute was there and whether it can be told from a
 * placeholder.
 */
export function valueOf(element: NativeElement, _platform: NativeKind): string | undefined {
  if (!holdsValue(element)) return undefined
  return attribute(element, 'value')
}

/**
 * A field's value as typed, or a toggle's state as the platform writes it, `0` or `1`. An absent `value` attribute is
 * `unreported`, never empty: WebDriverAgent leaves it out when a field is empty and has no placeholder, and the macOS
 * runner when XCTest gives none. On iOS a value equal to the field's placeholder is `placeholder`: WebDriverAgent
 * writes the placeholder as the value of an empty field (`wdValue`), so that reading cannot tell an empty field from
 * one holding the placeholder's text.
 *
 * @example valueReading(titleField, 'ios-simulator') // { kind: 'placeholder', placeholder: 'Title' }
 */
export function valueReading(element: NativeElement, platform: NativeKind): StateReading<string> {
  if (!holdsValue(element)) return { kind: 'none' }
  const value = element.attributes['value']
  if (value === undefined) return { kind: 'unreported', attribute: 'value' }
  if (platform === 'ios-simulator' && fieldTypes.has(element.type)) {
    const placeholder = attribute(element, 'placeholderValue')
    if (placeholder !== '' && value === placeholder) return { kind: 'placeholder', placeholder }
  }
  return { kind: 'read', value }
}

/**
 * Whether the element is on screen: on iOS as WebDriverAgent judges it, `unreported` when its tree carries no
 * `visible`; on macOS, whose runner writes no visibility, a frame with area inside the owned window, the tree's root,
 * and inside every scroll view around it, since a list keeps rows scrolled out of view in its tree, and `unreported`
 * when the element carries no frame at all.
 */
export function visibilityReading(element: NativeElement, platform: NativeKind): StateReading<boolean> {
  if (platform === 'ios-simulator') return booleanAttribute(element, 'visible')
  const frame = element.frame
  if (frame === undefined) return { kind: 'unreported', attribute: 'frame' }
  if (frame.width <= 0 || frame.height <= 0) return { kind: 'read', value: false }
  for (let ancestor = element.parent; ancestor !== undefined; ancestor = ancestor.parent) {
    const clip = ancestor.frame
    if ((ancestor.parent === undefined || ancestor.type === 'ScrollView') && clip !== undefined && !intersects(frame, clip)) return { kind: 'read', value: false }
  }
  return { kind: 'read', value: true }
}

/** Whether the element is on screen as `visibilityReading` reads it; a visibility the executor did not report is not on screen. */
export function visibleOf(element: NativeElement, tree: NativeTree): boolean {
  const reading = visibilityReading(element, tree.platform)
  return reading.kind === 'read' && reading.value
}

/**
 * The element's own text as `textOf` reads it, `none` for a field, and `unreported` when the tree carries none of the
 * attributes it is read from: a static text with neither `value` nor `label`, or another element with no `label` (and on
 * macOS no `title`), which WebDriverAgent leaves out when they are empty and an executor leaves out when it cannot read
 * them alike.
 */
export function textReading(element: NativeElement, platform: NativeKind): StateReading<string> {
  if (fieldTypes.has(element.type)) return { kind: 'none' }
  const value = element.attributes['value']
  const label = element.attributes['label']
  const title = element.attributes['title']
  if (element.type === 'StaticText') {
    if (value !== undefined && value !== '') return { kind: 'read', value }
    if (label !== undefined) return { kind: 'read', value: label }
    return value === undefined ? { kind: 'unreported', attribute: 'value' } : { kind: 'read', value }
  }
  if (label !== undefined && (label !== '' || platform === 'ios-simulator')) return { kind: 'read', value: label }
  if (platform === 'macos' && title !== undefined) return { kind: 'read', value: title }
  return label === undefined ? { kind: 'unreported', attribute: 'label' } : { kind: 'read', value: label }
}

/** Whether the element is enabled, as the platform reports it; `unreported` when its tree carries no `enabled`. */
export function enabledReading(element: NativeElement): StateReading<boolean> {
  return booleanAttribute(element, 'enabled')
}

/**
 * Whether the element is selected: on macOS the runner's `selected`, on iOS the `Selected` trait among its `traits`;
 * `none` when its type has no selected state on the platform, and `unreported` when the attribute is missing.
 */
export function selectedReading(element: NativeElement, platform: NativeKind): StateReading<boolean> {
  if (!selectableTypes[platform].has(element.type)) return { kind: 'none' }
  if (platform === 'macos') return booleanAttribute(element, 'selected')
  const traits = element.attributes['traits']
  if (traits === undefined) return { kind: 'unreported', attribute: 'traits' }
  return { kind: 'read', value: traits.split(',').some((trait) => trait.trim() === 'Selected') }
}

/**
 * Whether a switch, toggle, checkbox or radio button is on: `none` for any other element or for a value that is
 * neither on nor off, and `unreported` when the executor wrote no `value`.
 */
export function checkedReading(element: NativeElement): StateReading<boolean> {
  if (!toggleTypes.has(element.type)) return { kind: 'none' }
  const value = element.attributes['value']
  if (value === undefined) return { kind: 'unreported', attribute: 'value' }
  if (value === '1' || value === 'true') return { kind: 'read', value: true }
  if (value === '0' || value === 'false') return { kind: 'read', value: false }
  return { kind: 'none' }
}

/** The state a reading holds, or null when it holds none: the type has no such state, or the tree did not report it. */
export function readValue<T>(reading: StateReading<T>): T | null {
  return reading.kind === 'read' ? reading.value : null
}

function intersects(first: Rect, second: Rect): boolean {
  return first.x < second.x + second.width && second.x < first.x + first.width && first.y < second.y + second.height && second.y < first.y + first.height
}

/** Whether `inner` lies inside `outer`, or is it. */
export function isWithin(inner: NativeElement, outer: NativeElement): boolean {
  for (let element: NativeElement | undefined = inner; element !== undefined; element = element.parent) if (element === outer) return true
  return false
}

/**
 * Describes an element for a message: its type, and its identifier when it has one, or its name.
 *
 * @example describeElement(button, 'macos') // "the Button 'sign-in-button'"
 */
export function describeElement(element: NativeElement, platform: NativeKind): string {
  const identifier = identifierOf(element, platform)
  if (identifier.kind === 'verified') return `the ${element.type} ${quoteText(identifier.identifier)}`
  const name = nameOf(element, platform)
  return name === '' ? `a ${element.type} with no identifier or name` : `a ${element.type} named ${quoteText(name)}`
}

/** Test id lookups that found a `name` they could not count as an identifier, as `identifierOf` says. */
export type UnverifiedIdentifiers = { readonly value: string; readonly count: number }

/** A recipe's matches in a tree, in document order, or why the recipe cannot be read on the platform. */
export type Located =
  | { readonly ok: true; readonly matches: readonly NativeElement[]; readonly emptyStep?: EmptyStep; readonly unverified?: UnverifiedIdentifiers }
  | { readonly ok: false; readonly failure: Failure }

/**
 * Finds a recipe's elements in a scoped tree. Each step after the first finds elements inside those the step before
 * kept, never those elements themselves; each step's pick keeps its first, last or nth match. Placeholder and CSS steps,
 * Playwright's rules and roles with no element type on the platform are refused as `unsupported`.
 *
 * @example locate(tree, { by: 'testId', value: 'save-task' }) // { ok: true, matches: [saveButton] }
 */
export function locate(tree: NativeTree, recipe: LocatorRecipe): Located {
  const problem = nativeLocatorProblem(recipe, tree.platform)
  if (problem !== undefined) return { ok: false, failure: problem }
  const steps = locatorSteps(recipe)
  let scope: readonly NativeElement[] | undefined
  let unverified: UnverifiedIdentifiers | undefined
  for (const [index, step] of steps.entries()) {
    const candidates = scope === undefined ? tree.elements : descendantsOf(scope)
    const found = findStep(candidates, step, tree.platform)
    if (found.unverified > 0 && step.by === 'testId') unverified = { value: step.value, count: found.unverified }
    const kept = pick(found.matches, step.pick)
    if (kept.length === 0) return { ok: true, matches: [], emptyStep: { step: index, matched: found.matches.length }, ...(unverified === undefined ? {} : { unverified }) }
    scope = kept
  }
  return { ok: true, matches: scope ?? [], ...(unverified === undefined ? {} : { unverified }) }
}

/**
 * Why a recipe cannot be read in a native app, or undefined when it can: what `locatorProblem` refuses everywhere, and
 * the steps and roles native apps do not have.
 *
 * @example nativeLocatorProblem({ by: 'css', selector: '.task' }, 'macos')?.class // 'unsupported'
 */
export function nativeLocatorProblem(recipe: LocatorRecipe, platform: NativeKind): Failure | undefined {
  const shared = locatorProblem(recipe)
  if (shared !== undefined) return shared
  if (recipe.dialect === 'playwright') return unsupported(`${describeLocator(recipe)} follows Playwright's rules, which are for web pages. A native app takes Retest's own locators.`)
  for (const step of locatorSteps(recipe)) {
    if (step.by === 'css') return unsupported(`${describeStep(step)} is a CSS selector, and a native app has no CSS. Find the element by its test id, role, label or text.`)
    if (step.by === 'placeholder') return unsupported(`${describeStep(step)} reads a placeholder, which Retest does not find native elements by. Find the field by its test id or label.`)
    if (step.by === 'role' && nativeRoleTypes[platform][step.role] === undefined) return unsupported(`${describeStep(step)}: the role ${quoteText(step.role)} has no ${platformName(platform)} element type in Retest's table, so Retest cannot find it there. Find the element by its test id, label or text.`)
  }
  return undefined
}

function unsupported(message: string): Failure {
  return { class: 'unsupported', message }
}

/** How a platform is named in a message. */
export function platformName(platform: NativeKind): string {
  return platform === 'macos' ? 'macOS' : 'iOS'
}

type StepMatches = { readonly matches: readonly NativeElement[]; readonly unverified: number }

function findStep(candidates: readonly NativeElement[], step: LocatorStep, platform: NativeKind): StepMatches {
  switch (step.by) {
    case 'testId': {
      let unverified = 0
      const matches = candidates.filter((element) => {
        const reading = identifierOf(element, platform)
        if (reading.kind === 'unverifiable' && reading.candidate === step.value) unverified += 1
        return reading.kind === 'verified' && reading.identifier === step.value
      })
      return { matches, unverified }
    }
    case 'role': {
      const types = nativeRoleTypes[platform][step.role] ?? []
      const name = step.name
      return { matches: candidates.filter((element) => types.includes(element.type) && (name === undefined || matchesName(nameOf(element, platform), name, step.exact))), unverified: 0 }
    }
    case 'label': {
      const types = labelledRoles.flatMap((role) => nativeRoleTypes[platform][role] ?? [])
      return { matches: candidates.filter((element) => types.includes(element.type) && matchesName(attribute(element, 'label'), step.text, step.exact)), unverified: 0 }
    }
    case 'text': {
      const matching = new Set(candidates.filter((element) => {
        const text = textOf(element, platform)
        return text !== undefined && matchesName(text, step.text, step.exact)
      }))
      // The innermost element whose text matches, as on the web: one inside another that matches is the match.
      return { matches: [...matching].filter((element) => !element.children.some((child) => hasMatchingDescendant(child, matching))), unverified: 0 }
    }
    default:
      return { matches: [], unverified: 0 }
  }
}

function matchesName(actual: string, wanted: TextMatch, exact: boolean | undefined): boolean {
  return matchesText(actual, wanted, exact ?? true)
}

function hasMatchingDescendant(element: NativeElement, matching: ReadonlySet<NativeElement>): boolean {
  return matching.has(element) || element.children.some((child) => hasMatchingDescendant(child, matching))
}

// Every element inside the scope, never a scope element itself unless it lies inside another, in document order.
function descendantsOf(scope: readonly NativeElement[]): NativeElement[] {
  const found = new Set<NativeElement>()
  const visit = (element: NativeElement): void => {
    for (const child of element.children) {
      found.add(child)
      visit(child)
    }
  }
  for (const element of scope) visit(element)
  return [...found].sort((first, second) => first.index - second.index)
}

function pick(matches: readonly NativeElement[], choice: LocatorPick | undefined): readonly NativeElement[] {
  if (choice === undefined) return matches
  if (choice === 'first') return matches.slice(0, 1)
  if (choice === 'last') return matches.slice(-1)
  const index = choice < 0 ? matches.length + choice : choice
  const element = matches[index]
  return index >= 0 && element !== undefined ? [element] : []
}

/**
 * What tells the executor which element to act on: its type, its identifier when it has one, its label and, on macOS,
 * its title. The label and title stay beside an identifier, so an element whose identifier stayed while its name
 * changed after the tree was read is not taken. Empty values are left out, since the executors leave an empty label
 * unset.
 */
export type ResolutionKeys = { readonly type: string; readonly identifier?: string; readonly label?: string; readonly title?: string }

/**
 * The keys that name an element to the executor.
 *
 * @example resolutionKeys(saveButton, 'macos') // { type: 'Button', identifier: 'save-task', label: 'Save' }
 */
export function resolutionKeys(element: NativeElement, platform: NativeKind): ResolutionKeys {
  const identifier = identifierOf(element, platform)
  const label = attribute(element, 'label')
  const title = platform === 'macos' ? attribute(element, 'title') : ''
  return { type: element.type, ...(identifier.kind === 'verified' ? { identifier: identifier.identifier } : {}), ...(label === '' ? {} : { label }), ...(title === '' ? {} : { title }) }
}

// Whether an element of the tree answers the keys as the executor's predicate would.
function keysMatch(element: NativeElement, keys: ResolutionKeys, platform: NativeKind): boolean {
  if (element.type !== keys.type) return false
  if (keys.identifier !== undefined && attribute(element, platform === 'macos' ? 'identifier' : 'name') !== keys.identifier) return false
  if (keys.label !== undefined && attribute(element, 'label') !== keys.label) return false
  if (keys.title !== undefined && attribute(element, 'title') !== keys.title) return false
  return true
}

/**
 * The keys as a predicate string the executor takes: WebDriverAgent names the type `type` and the identifier `name`,
 * the macOS runner `elementType` by number and `identifier`. Values are quoted, so the executor reads them literally.
 *
 * @example predicateFor({ type: 'Button', identifier: 'save-task' }, 'macos') // 'elementType == 9 AND identifier == "save-task"'
 */
export function predicateFor(keys: ResolutionKeys, platform: NativeKind): string {
  const parts = platform === 'macos' ? [`elementType == ${elementTypeNumbers[keys.type] ?? -1}`] : [`type == ${quotePredicate(`XCUIElementType${keys.type}`)}`]
  if (keys.identifier !== undefined) parts.push(`${platform === 'macos' ? 'identifier' : 'name'} == ${quotePredicate(keys.identifier)}`)
  if (keys.label !== undefined) parts.push(`label == ${quotePredicate(keys.label)}`)
  if (keys.title !== undefined) parts.push(`title == ${quotePredicate(keys.title)}`)
  return parts.join(' AND ')
}

const predicateEscapes: Readonly<Record<string, string>> = { '\\': '\\\\', '"': '\\"', '\n': '\\n', '\r': '\\r', '\t': '\\t' }

/** A string as a quoted predicate literal, which the executors read as text even when it holds `%@` or `$`. */
export function quotePredicate(text: string): string {
  return `"${text.replace(/[\\"\n\r\t]/g, (character) => predicateEscapes[character] ?? character)}"`
}

/**
 * How to name an element to the executor: the keys of the element itself and how many elements of the tree they
 * match, which the executor's own count must equal, and the ancestor to search inside when the keys alone match
 * more than one.
 */
export type ResolutionPlan = { readonly keys: ResolutionKeys; readonly count: number; readonly within?: ResolutionPlan & { readonly element: NativeElement } }

/**
 * Plans the executor lookup for one element: its own keys when they match it alone in the tree, else its keys inside
 * the nearest ancestor that can itself be named alone and holds it as the only match. Undefined when no such plan
 * exists, as for an element with no identifier among others of its type and label.
 */
export function resolutionPlan(tree: NativeTree, element: NativeElement): ResolutionPlan | undefined {
  const keys = resolutionKeys(element, tree.platform)
  const count = tree.elements.filter((each) => keysMatch(each, keys, tree.platform)).length
  if (count === 1) return { keys, count }
  for (let ancestor = element.parent; ancestor !== undefined; ancestor = ancestor.parent) {
    const inside = [ancestor, ...descendantsOf([ancestor])].filter((each) => keysMatch(each, keys, tree.platform)).length
    if (inside !== 1) continue
    const outer = resolutionPlan(tree, ancestor)
    if (outer !== undefined) return { keys, count: inside, within: { ...outer, element: ancestor } }
  }
  return undefined
}
