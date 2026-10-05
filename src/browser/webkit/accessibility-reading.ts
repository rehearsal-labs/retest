import type { CommandIdentity } from '../cdp/errors.ts'
import type { Schema } from '../../protocol/schema.ts'
import { ariaRoles } from '../../protocol/aria-role.ts'
import { s } from '../../protocol/schema.ts'
import { CdpProtocolError } from '../cdp/errors.ts'
import { isRecord } from '../cdp/message.ts'
import { readProtocol } from '../cdp-results.ts'
import { chromeRoleOf } from './roles.ts'

// Chrome's tree query, as the shared role lookup sends it, is answered on WebKit from WebKit's own accessibility of
// every element of the document, read through `DOM.getAccessibilityPropertiesForNode`. Read side by side with Chrome's
// tree on build 2359, element kind by element kind and role by role (`webkit-roles.test.ts`), WebKit's tree agrees with
// Chrome's for most of them. Where it does not, the reading says so from what the page itself holds, never from an
// approximation of either engine's rules: an element WebKit names by its own rules is named as Chrome names it when the
// page's own facts settle what that is (`chromeRoleOf`), and otherwise the reading reports a doubt, which the page turns
// into a refusal by name of every lookup the doubt could change.

/** An element's accessibility as WebKit computes it, with its role named as Chrome's tree names it. */
export type AccessibleNode = { readonly nodeId: number; readonly role: string; readonly label: string }

/**
 * Lookups WebKit cannot answer as Chrome does on the document a reading read: lookups of `role`, or of every role for
 * `'*'`, either all of them, only those with a name, only those without one, or only those whose name one of `names`
 * could match. `reason` says, in one clause, what on the page causes it, and `fewer` whether WebKit's tree finds less
 * there than Chrome's, rather than other elements.
 */
export type RoleDoubt = { readonly role: string; readonly reason: string; readonly fewer: boolean } & (
  | { readonly lookups: 'all' | 'named' | 'unnamed' }
  | { readonly lookups: 'names'; readonly names: readonly string[] }
)

/** What one reading found: every element WebKit's tree holds, and the doubts the document gives. */
export type AccessibilityReading = { readonly nodes: readonly AccessibleNode[]; readonly doubts: readonly RoleDoubt[] }

/** What a reading needs: a way to send to the page target within the reading's budget, the document, and the world. */
export type ReadingTools = {
  send: (method: string, params?: object) => Promise<unknown>
  /** The document's node id, from `DOM.getDocument`. */
  root: number
  /** Retest's own world in the document, where the reading's page functions run. */
  contextId: number
  /** An object group of the reading's own, released when it ends. */
  objectGroup: string
}

const nodesSchema = s.object({ nodeIds: s.array(s.number({ integer: true })) })
const propertiesSchema = s.object({
  properties: s.object({ exists: s.boolean(), ignored: s.optional(s.boolean()), role: s.string(), label: s.string() }),
})
const resolvedSchema = s.object({ object: s.object({ objectId: s.string() }) })
const valueSchema = s.object({ result: s.object({ type: s.string(), description: s.optional(s.string()) }), wasThrown: s.optional(s.boolean()) })

// Reading each element's accessibility waits on the page, so a document with many elements is read in batches.
const accessibilityBatch = 100

// Outside aria-hidden="true", where both engines leave everything out.
const shown = ':not([aria-hidden="true" i], [aria-hidden="true" i] *)'

// Element kinds the role naming needs, each exactly as CSS states it.
const kindSelectors = [
  ['oneOptionSelect', 'select:not([multiple]):not([size]), select[size="0"]:not([multiple]), select[size="1"]:not([multiple])'],
  ['numberField', 'input[type="number" i]'],
  ['listInput', 'input[list]:not([role])'],
  ['dateField', 'input:is([type="date" i], [type="time" i], [type="datetime-local" i], [type="month" i], [type="week" i]):not([role])'],
  ['plainEditor', ':is(div, span):is([contenteditable=""], [contenteditable="true" i], [contenteditable="plaintext-only" i]):not([role])'],
  ['figureCaption', 'figcaption'],
  ['ownTextbox', 'input, textarea, [role]'],
  ['nativeTable', 'table:not([role])'],
] as const

// What on a page makes a lookup differ, each exactly as CSS states it; WebKit's own reading of the element says the rest.
const doubtSelectors = [
  ['bareImage', `img:not([alt])${shown}`],
  ['drawing', `svg:not(svg svg):not([role])${shown}`],
  ['selectOption', 'select option'],
  ['optionGroup', 'select optgroup'],
  ['headingGroup', `hgroup${shown}`],
  ['emphasis', `em${shown}`],
  ['strong', `strong${shown}`],
  ['strayOption', '[role~="option" i]:not([role~="listbox" i] *)'],
  ['strayListItem', '[role~="listitem" i]:not(:is(ul, ol, menu, [role~="list" i], [role~="directory" i], [role~="group" i]) *)'],
  ['strayTreeItem', '[role~="treeitem" i]:not(:is([role~="tree" i], [role~="treegrid" i]) *)'],
  ['authorNamed', '[aria-label]:not([aria-label=""]), [aria-labelledby]'],
] as const

// The roles Chrome names from an element's own text and WebKit's tree names only from aria-label or aria-labelledby.
const contentNamedRoles: readonly string[] = ['cell', 'gridcell', 'columnheader', 'rowheader', 'tooltip']

// Every token of the role attribute as the page wrote it, each value once.
const roleValuesExpression = '[...new Set(Array.from(document.querySelectorAll("[role]"), (element) => element.getAttribute("role") ?? ""))]'

// Every text an option of a select could take its name from: its text, its label, aria-label, title, and the text of
// the elements aria-labelledby names.
const optionTextsExpression = `Array.from(document.querySelectorAll('select option'), (option) => {
  const named = (option.getAttribute('aria-labelledby') ?? '').split(/\\s+/).filter((id) => id !== '').map((id) => document.getElementById(id)?.textContent ?? '').join(' ')
  return [option.textContent ?? '', option.getAttribute('label') ?? '', option.getAttribute('aria-label') ?? '', option.getAttribute('title') ?? '', named]
}).flat().filter((text) => text.trim() !== '')`

// Chrome names an input a combobox when its list attribute names a <datalist> of its document and it is a field a list
// applies to, other than a range or a colour. WebKit's own `list` answers null for the date and time fields it draws
// itself, so the attribute is read as Chrome reads it.
const suggestsFunction = `function () {
  const id = this.getAttribute('list')
  const list = id === null ? null : this.ownerDocument.getElementById(id)
  return list !== null && list.localName === 'datalist' && list.namespaceURI === 'http://www.w3.org/1999/xhtml'
    && ['text', 'search', 'url', 'tel', 'email', 'date', 'month', 'week', 'time', 'datetime-local', 'number'].includes(this.type)
}`

// For each control a hidden <label> labels, every text its name could come from on either engine: WebKit's tree still
// names it by the hidden label's text and Chrome's does not, so only a lookup by one of these texts can differ. They are
// each label's text, all its labels' texts together, aria-label, the text of what aria-labelledby names, title and
// placeholder.
const hiddenLabelExpression = `Array.from(document.querySelectorAll('label')).flatMap((label) => {
  const control = label.control
  if (control === null || label.checkVisibility({ visibilityProperty: true })) return []
  const labels = Array.from(control.labels ?? [], (each) => each.textContent ?? '')
  const named = (control.getAttribute('aria-labelledby') ?? '').split(/\\s+/).filter((id) => id !== '').map((id) => document.getElementById(id)?.textContent ?? '').join(' ')
  return [...labels, labels.join(' '), control.getAttribute('aria-label') ?? '', named, control.getAttribute('title') ?? '', control.getAttribute('placeholder') ?? '']
}).filter((text) => text.trim() !== '')`

// The roles of the elements a <label> can name.
const labelableRoles: readonly string[] = ['button', 'checkbox', 'combobox', 'listbox', 'meter', 'progressbar', 'radio', 'searchbox', 'slider', 'spinbutton', 'status', 'switch', 'textbox']

// The roles a table and its parts can have, which a table WebKit reads as a layout table may change.
const tableRoles: readonly string[] = ['table', 'group', 'row', 'rowgroup', 'cell', 'gridcell', 'columnheader', 'rowheader']

/**
 * Reads the accessibility of every element of the document, with the doubts the document gives. A node the page removed
 * while it was read fails the reading with WebKit's own error, which its caller reads with `isMissingNode` and answers by
 * reading the whole document again; it is never read as an element that is not there.
 */
export async function readAccessibility(tools: ReadingTools, command: CommandIdentity): Promise<AccessibilityReading> {
  const { send, root } = tools
  const select = async (selector: string): Promise<number[]> => {
    try {
      return readProtocol(nodesSchema, await send('DOM.querySelectorAll', { nodeId: root, selector }), command).nodeIds
    } catch (error) {
      if (error instanceof CdpProtocolError && isMissingNode(error.protocolMessage)) throw new StaleDocumentError(command, { cause: error })
      throw error
    }
  }
  try {
    const [all, kinds, found, roleValues, hiddenLabel] = await Promise.all([
      select('*'),
      selectEach(kindSelectors, select),
      selectEach(doubtSelectors, select),
      evaluate(tools, roleValuesExpression, s.array(s.string()), command),
      evaluate(tools, hiddenLabelExpression, s.array(s.string()), command),
    ])
    const [properties, explicit, suggesting, optionTexts] = await Promise.all([
      readProperties(send, all, command),
      explicitRoles(roleValues, select),
      suggestingInputs(tools, [...kinds.of('listInput')], command),
      found.of('selectOption').size === 0 ? Promise.resolve([]) : evaluate(tools, optionTextsExpression, s.array(s.string()), command),
    ])
    const nodes: AccessibleNode[] = []
    const read = new Map<number, ReadNode>()
    for (const [index, nodeId] of all.entries()) {
      const answer = properties[index]
      if (answer === undefined || !answer.exists) continue
      const kind = {
        select: kinds.of('oneOptionSelect').has(nodeId),
        numberField: kinds.of('numberField').has(nodeId),
        suggests: suggesting.has(nodeId),
        dateField: kinds.of('dateField').has(nodeId),
        plainEditor: kinds.of('plainEditor').has(nodeId),
        figureCaption: kinds.of('figureCaption').has(nodeId),
      }
      const node = { nodeId, role: chromeRoleOf(answer.role, kind), label: answer.label, ignored: answer.ignored === true }
      read.set(nodeId, node)
      if (!node.ignored) nodes.push({ nodeId, role: node.role, label: node.label })
    }
    return { nodes, doubts: doubtsOf({ nodes: read, kinds, found, explicit, optionTexts, hiddenLabel }) }
  } finally {
    send('Runtime.releaseObjectGroup', { objectGroup: tools.objectGroup }).catch(() => {
      // The objects go with their document, and a reading that failed is read again in a group of its own.
    })
  }
}

/** The document node a reading was given is no longer in WebKit's node map, so the document must be asked for again. */
export class StaleDocumentError extends Error {
  constructor(command: CommandIdentity, options: { cause: unknown }) {
    super(`${command.method} found the document's node gone from WebKit's node map`, options)
    this.name = 'StaleDocumentError'
  }
}

/**
 * Whether WebKit's answer says the node it was asked about has gone from its node map: the page removed it, or another
 * `DOM.getDocument` gave every node a new id.
 *
 * @example isMissingNode('Missing node for given nodeId') // true
 */
export function isMissingNode(message: string): boolean {
  return /\bnode\b/i.test(message) && /(missing|not found|could not find|no node)/i.test(message)
}

/**
 * The role a role attribute gives: its first token that names a role, in any case, as both engines read it.
 *
 * @example firstRole('fancy BUTTON') // 'button'
 */
export function firstRole(value: string): string | undefined {
  return value.split(/[\t\n\f\r ]+/).map((token) => token.toLowerCase()).find((token) => ariaRoleNames.has(token))
}

/** The role an ARIA role attribute names, as WebKit's tree names it. */
function webKitNameOf(token: string): string {
  if (token === 'img') return 'image'
  if (token === 'presentation') return 'none'
  return token
}

/** The ARIA role a role of Chrome's tree is, as a locator names it. */
function ariaNameOf(role: string): string {
  return role === 'image' ? 'img' : role
}

type ReadNode = { readonly nodeId: number; readonly role: string; readonly label: string; readonly ignored: boolean }

/** The nodes each selector of a table matched, by the selector's name. */
type Matched<Name extends string> = { of(name: Name): ReadonlySet<number> }

type KindName = (typeof kindSelectors)[number][0]
type DoubtName = (typeof doubtSelectors)[number][0]
type DoubtFacts = {
  nodes: ReadonlyMap<number, ReadNode>
  kinds: Matched<KindName>
  found: Matched<DoubtName>
  explicit: ReadonlyMap<number, string>
  optionTexts: readonly string[]
  hiddenLabel: readonly string[]
}

function doubtsOf({ nodes, kinds, found, explicit, optionTexts, hiddenLabel }: DoubtFacts): RoleDoubt[] {
  const doubts: RoleDoubt[] = []
  const read = (name: DoubtName): ReadNode[] => [...found.of(name)].flatMap((id) => {
    const node = nodes.get(id)
    return node === undefined ? [] : [node]
  })
  const leftOut = (name: DoubtName): boolean => read(name).some((node) => node.ignored)
  if (leftOut('bareImage')) doubts.push({ role: 'img', lookups: 'all', fewer: true, reason: "the page holds an <img> with no alt attribute, which Chrome's tree keeps as an image and WebKit's leaves out" })
  if (read('drawing').length > 0) doubts.push({ role: 'img', lookups: 'all', fewer: false, reason: "the page holds an <svg> drawing with no role, which Chrome's tree keeps as an image and WebKit's names its own way" })
  if (found.of('selectOption').size > 0) {
    doubts.push({ role: 'option', lookups: 'unnamed', fewer: true, reason: "the page holds a select's options, which Chrome's tree counts and WebKit's leaves out of a closed select" })
    if (optionTexts.length > 0) doubts.push({ role: 'option', lookups: 'names', names: optionTexts, fewer: true, reason: "Chrome names each option of a select from its text, and WebKit's accessibility tree names none and leaves out those of a closed select" })
  }
  if (found.of('optionGroup').size > 0) doubts.push({ role: 'group', lookups: 'all', fewer: true, reason: "the page holds a select's option group, which Chrome's tree keeps as a group and WebKit's leaves out" })
  if (leftOut('headingGroup')) doubts.push({ role: 'group', lookups: 'all', fewer: true, reason: "the page holds an <hgroup>, which Chrome's tree keeps as a group and WebKit's leaves out" })
  if (leftOut('emphasis')) doubts.push({ role: 'emphasis', lookups: 'all', fewer: true, reason: "the page holds an <em>, which Chrome's tree keeps as emphasis and WebKit's leaves out" })
  if (leftOut('strong')) doubts.push({ role: 'strong', lookups: 'all', fewer: true, reason: "the page holds a <strong>, which Chrome's tree keeps and WebKit's leaves out" })
  const strays: readonly (readonly [DoubtName, string, string])[] = [
    ['strayOption', 'option', 'a listbox'],
    ['strayListItem', 'listitem', 'a list'],
    ['strayTreeItem', 'treeitem', 'a tree'],
  ]
  for (const [name, role, context] of strays) {
    const kept = read(name)
    if (kept.length === 0) continue
    const reason = `the page holds an element with the role ${role} outside ${context}, which Chrome's tree leaves out`
    doubts.push({ role, lookups: 'all', fewer: false, reason })
    for (const other of new Set(kept.map((node) => ariaNameOf(node.role)))) {
      if (other !== role && other !== '') doubts.push({ role: other, lookups: 'all', fewer: false, reason: `${reason} and WebKit's keeps as ${other}` })
    }
  }
  for (const [nodeId, token] of explicit) {
    const node = nodes.get(nodeId)
    if (node === undefined || node.role === webKitNameOf(token)) continue
    const kept = ariaNameOf(node.role)
    const reason = `the page holds an element whose role attribute says ${token}, which WebKit's accessibility tree names ${kept === '' ? 'nothing' : kept}`
    doubts.push({ role: token, lookups: 'all', fewer: false, reason })
    if (kept !== '') doubts.push({ role: kept, lookups: 'all', fewer: false, reason })
  }
  if ([...nodes.values()].some((node) => node.role === 'textbox' && !kinds.of('ownTextbox').has(node.nodeId))) {
    doubts.push({ role: '*', lookups: 'all', fewer: false, reason: "the page holds an editable element other than a <div> or a <span>, which WebKit's accessibility tree calls a text box where Chrome's keeps the element's own role" })
  }
  if (hiddenLabel.length > 0) {
    const reason = "the page holds a hidden <label>, whose text WebKit's accessibility tree still gives the control it labels and Chrome's does not, and that control could carry the name asked for"
    for (const role of labelableRoles) doubts.push({ role, lookups: 'names', names: hiddenLabel, fewer: false, reason })
  }
  if ([...nodes.values()].some((node) => node.role === 'group' && kinds.of('nativeTable').has(node.nodeId))) {
    const reason = "the page holds a <table> WebKit's accessibility tree reads as a layout table and names a group, where Chrome's reads a table by rules of its own"
    for (const role of tableRoles) doubts.push({ role, lookups: 'all', fewer: false, reason })
  }
  for (const role of contentNamedRoles) {
    const unnamed = [...nodes.values()].some((node) => !node.ignored && node.role === role && (node.label === '' || !found.of('authorNamed').has(node.nodeId)))
    if (unnamed) doubts.push({ role, lookups: 'named', fewer: true, reason: `Chrome names a ${role} from its text, and WebKit's accessibility tree does not` })
  }
  return doubts
}

async function selectEach<Name extends string>(selectors: readonly (readonly [Name, string])[], select: (selector: string) => Promise<number[]>): Promise<Matched<Name>> {
  const matched = new Map(await Promise.all(selectors.map(async ([name, selector]) => [name, new Set(await select(selector))] as const)))
  const none: ReadonlySet<number> = new Set()
  return { of: (name) => matched.get(name) ?? none }
}

async function readProperties(send: ReadingTools['send'], nodeIds: readonly number[], command: CommandIdentity): Promise<Properties[]> {
  const read: Properties[] = []
  for (let start = 0; start < nodeIds.length; start += accessibilityBatch) {
    const batch = nodeIds.slice(start, start + accessibilityBatch)
    read.push(...(await Promise.all(batch.map(async (nodeId) => readProtocol(propertiesSchema, await send('DOM.getAccessibilityPropertiesForNode', { nodeId }), command).properties))))
  }
  return read
}

type Properties = { exists: boolean; ignored?: boolean; role: string; label: string }

// Each role attribute's first token that names a role, by the node that carries it: the values the page wrote are read
// once, then the nodes of each value by CSS, so every node is matched to its own attribute and none is guessed at.
async function explicitRoles(values: readonly string[], select: (selector: string) => Promise<number[]>): Promise<Map<number, string>> {
  const roles = new Map<number, string>()
  await Promise.all(values.map(async (value) => {
    const token = firstRole(value)
    if (token === undefined) return
    for (const nodeId of await select(`[role="${cssString(value)}"]`)) roles.set(nodeId, token)
  }))
  return roles
}

async function suggestingInputs(tools: ReadingTools, nodeIds: readonly number[], command: CommandIdentity): Promise<Set<number>> {
  const suggesting = new Set<number>()
  await Promise.all(nodeIds.map(async (nodeId) => {
    const resolved = readProtocol(resolvedSchema, await tools.send('DOM.resolveNode', { nodeId, executionContextId: tools.contextId, objectGroup: tools.objectGroup }), command)
    const answer = await tools.send('Runtime.callFunctionOn', { objectId: resolved.object.objectId, functionDeclaration: suggestsFunction, returnByValue: true })
    if (valueOf(answer, command) === true) suggesting.add(nodeId)
  }))
  return suggesting
}

async function evaluate<T>(tools: ReadingTools, expression: string, schema: Schema<T>, command: CommandIdentity): Promise<T> {
  const answer = await tools.send('Runtime.evaluate', { expression, contextId: tools.contextId, returnByValue: true })
  return readProtocol(schema, valueOf(answer, command), command)
}

// A remote object's value can be any JSON, which no schema names, so it is read on its own.
function valueOf(answer: unknown, command: CommandIdentity): unknown {
  const { result, wasThrown } = readProtocol(valueSchema, answer, command)
  if (wasThrown === true) throw new CdpProtocolError(command, { code: -32000, message: `Retest's reading of the page threw: ${result.description ?? 'no description'}`, data: undefined })
  const raw = isRecord(answer) ? answer['result'] : undefined
  return isRecord(raw) ? raw['value'] : undefined
}

const ariaRoleNames: ReadonlySet<string> = new Set(ariaRoles)

// A CSS string's contents: a backslash and a quote escaped, and a line break written as its code point.
function cssString(value: string): string {
  return value.replace(/["\\]/g, '\\$&').replace(/[\n\r\f]/g, (character) => `\\${character.charCodeAt(0).toString(16)} `)
}
