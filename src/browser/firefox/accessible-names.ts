import type { BidiClient, SendOptions } from './bidi-client.ts'
import type { AriaRole } from '../../protocol/aria-role.ts'
import type { Deadline } from '../../protocol/deadline.ts'
import type { Failure } from '../../protocol/failures.ts'
import type { LocatorRecipe } from '../../protocol/locator.ts'
import { ariaRoles } from '../../protocol/aria-role.ts'
import { describeLocator, locatorSteps } from '../../protocol/locator.ts'
import { parse, s } from '../../protocol/schema.ts'
import { normalizeText } from '../../protocol/text.ts'
import { labelledRoles } from '../accessibility.ts'
import { BrowserError } from '../browser-error.ts'
import { BidiTimeoutError } from './bidi-errors.ts'

/**
 * Which names the locators being resolved together ask of one role: whether any step takes every element of it, the
 * exact names their steps ask for, as Retest compares them, and whether any step matches loosely or by a pattern. One
 * look resolves one locator; a keyed read resolves several in one call.
 */
export type Lookup = { locators: readonly LocatorRecipe[]; wants: Map<AriaRole, RoleWants> }

export type RoleWants = { nameless: boolean; exact: Set<string>; loose: boolean }

/** One element of a role, by its reference in the document, and its accessible name as Firefox computed it. */
export type NamedElement = { sharedId: string; name: string }

/**
 * How resolution reaches the page: its browsing context, the BiDi client, and the one deadline every round trip of the
 * resolution shares, so a resolution of many round trips ends within the look's own budget.
 */
export type NameSource = { client: BidiClient; context: string; deadline: Deadline }

const nodesSchema = s.object({ nodes: s.array(s.object({ sharedId: s.string(), value: s.optional(s.object({ localName: s.optional(s.string()) })) })) })
const callSchema = s.object({ type: s.enum(['success', 'exception']), result: s.optional(s.object({ type: s.string(), value: s.optional(s.string()) })) })
const candidatesSchema = s.array(s.array(s.string()))

// How many name confirmations one resolution may send, and how many at once. A page with more distinct names in one
// role than this is refused rather than read for minutes.
const confirmationLimit = 400
const concurrency = 32

/**
 * What the locator asks of each role, from its role and label steps. A label step asks for its text in every role a
 * label names, as `getByLabel` finds through the accessibility tree.
 *
 * @example roleWants({ by: 'role', role: 'button', name: 'Save' }).get('button') // { nameless: false, exact: Set { 'Save' }, loose: false }
 */
export function roleWants(locator: LocatorRecipe): Map<AriaRole, RoleWants> {
  return roleWantsOf([locator])
}

/**
 * What several locators resolved together ask of each role: every step of every locator, merged.
 *
 * @example roleWantsOf([{ by: 'role', role: 'button', name: 'Save' }, { by: 'role', role: 'button' }]).get('button') // { nameless: true, exact: Set { 'Save' }, loose: false }
 */
export function roleWantsOf(locators: readonly LocatorRecipe[]): Map<AriaRole, RoleWants> {
  const wants = new Map<AriaRole, RoleWants>()
  const entry = (role: AriaRole): RoleWants => {
    let found = wants.get(role)
    if (found === undefined) {
      found = { nameless: false, exact: new Set(), loose: false }
      wants.set(role, found)
    }
    return found
  }
  for (const step of locators.flatMap((locator) => locatorSteps(locator))) {
    if (step.by === 'role') {
      const wanted = entry(step.role)
      if (step.name === undefined) wanted.nameless = true
      else if (typeof step.name === 'string' && (step.exact ?? true)) wanted.exact.add(normalizeText(step.name))
      else wanted.loose = true
    } else if (step.by === 'label') {
      for (const role of labelledRoles) {
        const wanted = entry(role)
        if (typeof step.text === 'string' && (step.exact ?? true)) wanted.exact.add(normalizeText(step.text))
        else wanted.loose = true
      }
    }
  }
  return wants
}

/**
 * The refusal of a lookup that asks for a table cell by name, which Firefox cannot answer as Chrome does: Chrome names
 * a cell from its text, and Firefox's accessibility tree gives a cell no name, so such a lookup would find nothing on
 * Firefox that Chrome finds, and a check that the cell is gone would pass. Column and row headers, grid cells and
 * tooltips Firefox names, and they are looked up as on Chrome.
 *
 * @example unnamedCellRefusal({ by: 'role', role: 'cell', name: 'Ada' })?.class // 'unsupported'
 */
export function lookupRefusal(locator: LocatorRecipe): Failure | undefined {
  const step = locatorSteps(locator).find((each) => each.by === 'role' && (['none', 'presentation', 'rowgroup', 'gridcell', 'generic', 'caption'].includes(each.role) || (['cell', 'figure'].includes(each.role) && each.name !== undefined)))
  if (step === undefined) return undefined
  if (step.by !== 'role') return undefined
  if (step.role !== 'cell') return refusal(locator, step.role, `Firefox's accessibility locator gives a different set or name for ${step.role} than Chrome does`)
  return {
    class: 'unsupported',
    message: `Could not look up ${describeLocator(locator)}: Chrome names a cell from its text, and Firefox's accessibility tree does not, so Retest refuses the lookup rather than find less on Firefox. Find it with getByText() or getByTestId(), or by its position with nth().`,
    details: { role: 'cell' },
  }
}

/**
 * The role a Chromium accessibility query names, as WAI-ARIA names it: Chrome names `img` and `math` its own way,
 * and Firefox computes every role by its WAI-ARIA name.
 *
 * @example ariaRoleOf('image') // 'img'
 */
export function ariaRoleOf(chromeRole: string): AriaRole | undefined {
  if (chromeRole === 'image') return 'img'
  if (chromeRole === 'MathMLMath') return 'math'
  return ariaRoles.find((role) => role === chromeRole)
}

/**
 * The elements of a role in the context's current document, each with its accessible name as Firefox computed it.
 * Firefox's accessibility locator finds elements by role, and by a name it compares exactly, and has no command that
 * reads a name. So a role asked only for exact names, or for every element, is answered by Firefox's own matches: an
 * element is given the name it matched, or no name when no exact name was asked of it. A role matched loosely or by a
 * pattern needs every element's name: each is offered the names its markup suggests, and Firefox confirms the one it
 * computed by an exact match. An element whose name none of them confirms is refused by name, never guessed.
 *
 * @example const named = await namedElements(source, 'button', { nameless: false, exact: new Set(['Save']), loose: false })
 */
export async function namedElements(source: NameSource, role: AriaRole, lookup: Lookup | undefined): Promise<NamedElement[]> {
  const wants = lookup?.wants.get(role)
  if (lookup !== undefined) await checkMarkup(source, role, lookup.locators)
  const found = wants !== undefined && !wants.loose && !wants.exact.has('') ? await matchedElements(source, role, wants) : await confirmedElements(source, role)
  if (role !== 'textbox') return found
  const passwords = await passwordFields(source)
  const kept = wants === undefined || wants.loose || wants.nameless ? passwords : passwords.filter(({ name }) => wants.exact.has(normalizeText(name)))
  return [...found, ...kept]
}

function refusal(locator: LocatorRecipe, role: AriaRole, reason: string): Failure {
  return { class: 'unsupported', message: `Could not look up ${describeLocator(locator)}: ${reason}. Retest cannot judge this lookup on Firefox. Use a test id or text.`, details: { role } }
}

const markupSchema = s.object({ type: s.enum(['success', 'exception']), result: s.optional(s.object({ type: s.string(), value: s.optional(s.string()) })) })

export const markupRefusalFunction: string = String.raw`function markupRefusal(role, named, exact) {
  const elements = [...document.querySelectorAll('*')];
  const visible = (element) => element.closest('[aria-hidden="true"], [inert]') === null && element.checkVisibility({ visibilityProperty: true });
  const normalize = (text) => text.trim().replace(/\s+/g, ' ');
  // The names an image's own markup can give it: what labels it, its aria-label, its alternative text and its title.
  const imageNames = (image) => {
    const labelledBy = (image.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean).map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
    return [labelledBy, image.getAttribute('aria-label'), image.getAttribute('alt'), image.getAttribute('title')].filter((name) => name !== null && name !== '').map(normalize);
  };
  // A lookup by exact names can only be changed by a failed image that one of those names could name.
  const changedBy = (image) => exact === null || imageNames(image).some((name) => exact.includes(name));
  if (role === 'button' && elements.some((element) => visible(element) && element instanceof HTMLInputElement && ['color', 'file', 'submit', 'reset', 'image'].includes(element.type))) return 'native colour, file, submit, reset or image inputs have different role membership or default names';
  if (role === 'img' && elements.some((element) => visible(element) && element instanceof HTMLImageElement && (!element.complete || element.naturalWidth === 0) && changedBy(element))) return 'an image that did not load has different accessibility membership';
  if (['textbox', 'combobox', 'spinbutton', 'slider', 'searchbox'].includes(role) && elements.some((element) => visible(element) && element instanceof HTMLInputElement && (element.hasAttribute('list') || ['date', 'time', 'datetime-local', 'month', 'week'].includes((element.getAttribute('type') ?? '').toLowerCase())))) return 'native date fields or datalist fields have different accessibility membership';
  if (role === 'option' && elements.some((element) => visible(element) && element instanceof HTMLSelectElement)) return 'native select options have different accessibility membership';
  if (role === 'textbox' && elements.some((element) => visible(element) && element.hasAttribute('contenteditable') && !element.hasAttribute('role'))) return 'an editable element without an explicit role has different accessibility membership';
  if (role === 'img' && elements.some((element) => visible(element) && element.localName === 'svg' && !element.hasAttribute('role'))) return 'an SVG without an explicit role has different accessibility membership';
  // A caption or header in this table establishes data-table semantics in both engines. A nested table's header
  // cannot establish its parent's semantics, and hidden markup cannot establish the visible table's semantics.
  const dataTable = (table) => {
    const explicit = table.getAttribute('role');
    if (explicit !== null) return ['table', 'grid', 'treegrid'].includes(explicit);
    return [...table.querySelectorAll('caption, th')].some((cue) => cue.closest('table') === table && visible(cue));
  };
  if (['table', 'cell', 'row', 'columnheader', 'rowheader'].includes(role) && elements.some((element) => visible(element) && element.localName === 'table' && !dataTable(element))) return 'native tables can be layout tables in Chrome and data tables in Firefox';
  if (['row', 'columnheader', 'rowheader'].includes(role) && elements.some((element) => visible(element) && element.getAttribute('role') === role && element.parentElement?.closest('[role="grid"], [role="treegrid"], [role="table"]') === null)) return 'a row or header outside a table or grid has different accessibility membership';
  if (role === 'option' && elements.some((element) => visible(element) && element.getAttribute('role') === 'option' && element.parentElement?.closest('[role="listbox"], [role="combobox"]') === null)) return 'an option outside a listbox or combobox has different accessibility membership';
  if (role === 'tab' && elements.some((element) => visible(element) && element.getAttribute('role') === 'tab' && element.parentElement?.closest('[role="tablist"]') === null)) return 'a tab outside a tablist has different accessibility membership';
  if (['menuitem', 'menuitemcheckbox', 'menuitemradio'].includes(role) && elements.some((element) => visible(element) && element.getAttribute('role') === role && element.parentElement?.closest('[role="menu"], [role="menubar"]') === null)) return 'a menu item outside a menu has different accessibility membership';
  if (role === 'heading' && elements.some((element) => visible(element) && element.isContentEditable)) return 'an editable heading can be named differently';
  if (role === 'group' && elements.some((element) => visible(element) && ['audio', 'video'].includes(element.localName) && element.hasAttribute('controls'))) return 'media controls have different accessibility membership';
  if (role === 'textbox' && named && elements.some((element) => visible(element) && [...(element.labels ?? [])].some((label) => !visible(label)))) return 'a field with a hidden native label can be named differently';
  if (role === 'textbox' && named) {
    for (const field of document.querySelectorAll('input[type="password" i]')) {
      if (!visible(field)) continue;
      const ids = (field.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean);
      const labels = ids.length > 0 ? ids.map((id) => document.getElementById(id)).filter(Boolean) : [...(field.labels ?? [])];
      if (labels.some((label) => label.children.length > 0 || !visible(label) || ['::before', '::after'].some((pseudo) => !['none', 'normal', '""'].includes(getComputedStyle(label, pseudo).content)))) return 'a password field has a label whose hidden, nested or generated content cannot be confirmed by Firefox';
    }
  }
  return '';
}`

// The markup is read for every locator resolved together, and a refusal names the one that asked for the role.
async function checkMarkup(source: NameSource, role: AriaRole, locators: readonly LocatorRecipe[]): Promise<void> {
  const asks = (locator: LocatorRecipe): boolean => locatorSteps(locator).some((step) => (step.by === 'role' && step.role === role) || (step.by === 'label' && labelledRoles.includes(role)))
  const locator = locators.find(asks) ?? locators[0]
  if (locator === undefined) return
  const named = locators.some((each) => locatorSteps(each).some((step) => step.by === 'label' || (step.by === 'role' && step.role === role && step.name !== undefined)))
  // Exact names only when every step asking for this role names one exactly; a step that takes every element of the
  // role, or matches loosely, can be changed by any element the markup check finds.
  const wanted = roleWantsOf(locators).get(role)
  const exact = wanted === undefined || wanted.nameless || wanted.loose ? null : [...wanted.exact]
  const answer = await source.client.request('script.callFunction', {
    functionDeclaration: markupRefusalFunction,
    arguments: [{ type: 'string', value: role }, { type: 'boolean', value: named }, exact === null ? { type: 'null' } : { type: 'array', value: exact.map((name) => ({ type: 'string', value: name })) }],
    target: { context: source.context, sandbox: 'retest' }, awaitPromise: false, resultOwnership: 'none',
  }, markupSchema, within(source, 'script.callFunction'))
  if (answer.type !== 'success' || answer.result?.value === undefined) throw new BrowserError({ class: 'setup_failed', message: "Retest could not read the markup needed to confirm Firefox role membership." })
  if (answer.result.value !== '') throw new BrowserError(refusal(locator, role, answer.result.value))
}

async function matchedElements(source: NameSource, role: AriaRole, wants: RoleWants): Promise<NamedElement[]> {
  if (wants.nameless && wants.exact.size === 0) return (await locate(source, { role })).map((node) => ({ sharedId: node.sharedId, name: '' }))
  const named = new Map<string, string>()
  const lists = await Promise.all([...wants.exact].map(async (name) => ({ name, nodes: await locate(source, { role, name }) })))
  for (const { name, nodes } of lists) for (const node of nodes) named.set(node.sharedId, name)
  const all = await locate(source, { role })
  if (all.length > 0) {
    const offered = await candidates(source, all.map((node) => node.sharedId))
    const raw = [...new Set(offered.flat().filter((name) => wants.exact.has(normalizeText(name)) && !wants.exact.has(name)))]
    for (const { name, nodes } of await inBatches(raw, async (name) => ({ name, nodes: await locate(source, { role, name }) }))) {
      for (const node of nodes) named.set(node.sharedId, name)
    }
  }
  if (!wants.nameless) return [...named].map(([sharedId, name]) => ({ sharedId, name }))
  // A step that takes every element of the role reads no name; any other step compares its own exact name, which the
  // element lacks, since Firefox did not match it.
  return all.map((node) => ({ sharedId: node.sharedId, name: named.get(node.sharedId) ?? '' }))
}

async function confirmedElements(source: NameSource, role: AriaRole): Promise<NamedElement[]> {
  const nodes = await locate(source, { role })
  if (nodes.length === 0) return []
  const offered = await candidates(source, nodes.map((node) => node.sharedId))
  const names = new Map<string, string>()
  const tried = new Set<string>()
  const longest = Math.max(0, ...offered.map((list) => list.length))
  for (let level = 0; level < longest; level += 1) {
    const unresolved = nodes.flatMap((node, index) => (names.has(node.sharedId) ? [] : [offered[index]?.[level]]))
    const asked = [...new Set(unresolved.filter((name): name is string => name !== undefined && !tried.has(name)))]
    if (asked.length === 0) continue
    if (tried.size + asked.length > confirmationLimit) {
      throw new BrowserError({ class: 'unsupported', message: `Firefox has more than ${confirmationLimit} distinct accessible names to confirm for the role ${role} on this page, so Retest cannot judge a loose or pattern name among them. Use an exact name, or a test id.` })
    }
    for (const name of asked) tried.add(name)
    const confirmed = await inBatches(asked, (name) => {
      // Firefox walks each start node and its descendants. Restrict confirmation to all unresolved candidates that
      // offer this name; a returned node still needs Firefox's exact accessibility match, never just the offered text.
      const starts = nodes.filter((node, index) => !names.has(node.sharedId) && offered[index]?.includes(name) === true)
      return locate(source, { role, name }, starts).then((found) => ({ name, found }))
    })
    for (const { name, found } of confirmed) for (const node of found) if (!names.has(node.sharedId)) names.set(node.sharedId, name)
    if (nodes.every((node) => names.has(node.sharedId))) break
  }
  const missing = nodes.find((node) => !names.has(node.sharedId))
  if (missing !== undefined) {
    const element = `<${missing.value?.localName ?? 'element'}>`
    throw new BrowserError({ class: 'unsupported', message: `Firefox computed an accessible name for a ${role}, ${element}, that Retest could not read back, so a loose or pattern name cannot be judged on this page: Firefox compares names only whole. Use an exact name, or a test id.`, details: { role, element } })
  }
  return nodes.map((node) => ({ sharedId: node.sharedId, name: names.get(node.sharedId) ?? '' }))
}

type Node = { sharedId: string; value?: { localName?: string } }

// Each field comes back as a pair: the element, serialized as a node, and its name, as a string.
const pairPartSchema = s.discriminatedUnion('type', [s.object({ type: s.literal('node'), sharedId: s.string() }), s.object({ type: s.literal('string'), value: s.string() })])
const passwordsSchema = s.object({
  type: s.enum(['success', 'exception']),
  result: s.optional(s.object({ type: s.string(), value: s.optional(s.array(s.object({ type: s.literal('array'), value: s.array(pairPartSchema) }))) })),
})

/**
 * The password fields of the document, which Firefox's accessibility locator never returns, with the names their
 * markup gives them. Chromium's tree has each as a textbox named as any field is, so Retest reads the name in the
 * order the accessible name computation takes its sources: the elements `aria-labelledby` names, `aria-label`, the
 * field's labels, `title`, then `placeholder`. Firefox computes nothing here; this is Retest's own reading, kept to
 * those sources, for password fields alone. A field hidden from the tree, by `aria-hidden`, `inert` or not being
 * shown, is left out, as Chromium's tree leaves it out.
 */
export const passwordFieldsFunction: string = String.raw`function passwordFields() {
  const text = (element) => element.textContent ?? ''
  const shown = (element) =>
    element.closest('[aria-hidden="true"]') === null && element.closest('[inert]') === null && element.checkVisibility({ visibilityProperty: true })
  const nameOf = (field) => {
    const labelledBy = (field.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter((id) => id !== '').map((id) => document.getElementById(id)).filter((found) => found !== null)
    if (labelledBy.length > 0) return labelledBy.map(text).join(' ')
    const label = field.getAttribute('aria-label')
    if (label !== null && label.trim() !== '') return label
    const labels = field.labels === null ? [] : [...field.labels]
    if (labels.length > 0) return labels.map(text).join(' ')
    return field.getAttribute('title') || field.getAttribute('placeholder') || field.getAttribute('aria-placeholder') || ''
  }
  return [...document.querySelectorAll('input[type="password"]')].filter((field) => field.getRootNode() === document && shown(field)).map((field) => [field, nameOf(field)])
}`

async function passwordFields(source: NameSource): Promise<NamedElement[]> {
  const params = { functionDeclaration: passwordFieldsFunction, arguments: [], target: { context: source.context, sandbox: 'retest' }, awaitPromise: false, resultOwnership: 'none', serializationOptions: { maxDomDepth: 0, maxObjectDepth: 2 } }
  const answer = await source.client.request('script.callFunction', params, passwordsSchema, within(source, 'script.callFunction'))
  if (answer.type !== 'success') throw new BrowserError({ class: 'setup_failed', message: "Retest's page script could not read the page's password fields." })
  return (answer.result?.value ?? []).flatMap(({ value: [field, name] }) => (field?.type === 'node' && name?.type === 'string' ? [{ sharedId: field.sharedId, name: name.value }] : []))
}

async function locate(source: NameSource, value: { role: string; name?: string }, starts?: readonly Node[]): Promise<Node[]> {
  // Firefox's locator names the WAI-ARIA role img by its later name, image, and matches nothing asked for as img.
  const asked = value.role === 'img' ? { ...value, role: 'image' } : value
  const params = { context: source.context, locator: { type: 'accessibility', value: asked }, serializationOptions: { maxDomDepth: 0, includeShadowTree: 'none' }, ...(starts === undefined ? {} : { startNodes: starts.map(({ sharedId }) => ({ sharedId })) }) }
  const { nodes } = await source.client.request('browsingContext.locateNodes', params, nodesSchema, within(source, 'browsingContext.locateNodes'))
  return nodes
}

async function candidates(source: NameSource, sharedIds: readonly string[]): Promise<string[][]> {
  const params = {
    functionDeclaration: nameCandidatesFunction,
    arguments: sharedIds.map((sharedId) => ({ sharedId })),
    target: { context: source.context, sandbox: 'retest' },
    awaitPromise: false,
    resultOwnership: 'none',
  }
  const answer = await source.client.request('script.callFunction', params, callSchema, within(source, 'script.callFunction'))
  if (answer.type !== 'success' || answer.result?.value === undefined) throw new BrowserError({ class: 'setup_failed', message: "Retest's page script could not read the names an element's markup suggests." })
  const parsed = parse(candidatesSchema, parseJson(answer.result.value))
  if (!parsed.ok) throw new BrowserError({ class: 'setup_failed', message: "Retest's page script answered the names an element's markup suggests in a form it cannot read." })
  return parsed.value
}

function parseJson(text: string): unknown {
  try {
    const value: unknown = JSON.parse(text)
    return value
  } catch {
    return undefined
  }
}

// What is left of the resolution's deadline, for one more round trip; none is sent once it has passed.
function within({ deadline }: NameSource, method: string): SendOptions {
  if (deadline.expired) throw new BidiTimeoutError({ method }, { timeoutMs: deadline.budgetMs, written: false })
  return { timeoutMs: deadline.commandTimeoutMs, signal: deadline.signal }
}

async function inBatches<T, R>(items: readonly T[], work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = []
  for (let start = 0; start < items.length; start += concurrency) results.push(...(await Promise.all(items.slice(start, start + concurrency).map(work))))
  return results
}

/**
 * Lists, for each element given, the names its markup suggests, most likely first, each trimmed with every run of
 * whitespace one space and as written. They are only offered: Firefox decides which is the name it computed. The sources
 * follow the order the accessible name computation takes them: labelling elements, `aria-label`, native labels and
 * alternatives, the content a person sees, and the title or placeholder.
 */
export const nameCandidatesFunction: string = String.raw`function nameCandidates(...elements) {
  const normalize = (text) => text.trim().replace(/\s+/g, ' ')
  const rendered = (element) => {
    if (element.closest('[aria-hidden="true"]') !== null) return false
    const style = getComputedStyle(element)
    return style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse'
  }
  const blocks = new Set(['block', 'flex', 'grid', 'list-item', 'table', 'table-row', 'table-cell', 'flow-root'])
  const contentOf = (root, spaced) => {
    const parts = []
    const visit = (node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        parts.push(node.data)
        return
      }
      if (!(node instanceof Element) || !rendered(node)) return
      if (['script', 'style', 'template', 'noscript'].includes(node.localName)) return
      const label = node === root ? null : node.getAttribute('aria-label')
      if (label !== null && label.trim() !== '') {
        parts.push(' ' + label + ' ')
        return
      }
      if (node instanceof HTMLImageElement || (node instanceof HTMLInputElement && node.type === 'image')) {
        parts.push(' ' + (node.getAttribute('alt') ?? '') + ' ')
        return
      }
      if (node !== root && (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement)) {
        parts.push(' ' + node.value + ' ')
        return
      }
      const block = spaced && blocks.has(getComputedStyle(node).display)
      if (block) parts.push(' ')
      const before = getComputedStyle(node, '::before').content
      if (spaced && before.startsWith('"')) parts.push(before.slice(1, -1))
      for (const child of node.childNodes) visit(child)
      const after = getComputedStyle(node, '::after').content
      if (spaced && after.startsWith('"')) parts.push(after.slice(1, -1))
      if (block) parts.push(' ')
    }
    visit(root)
    return parts.join('')
  }
  const byIds = (element, attribute) =>
    (element.getAttribute(attribute) ?? '').split(/\s+/).filter((id) => id !== '').map((id) => document.getElementById(id)).filter((found) => found !== null)
  const candidatesOf = (element) => {
    const found = []
    const labelledBy = byIds(element, 'aria-labelledby')
    if (labelledBy.length > 0) {
      found.push(labelledBy.map((label) => contentOf(label, true)).join(' '))
      found.push(labelledBy.map((label) => label.textContent ?? '').join(' '))
    }
    const label = element.getAttribute('aria-label')
    if (label !== null) found.push(label)
    const labels = element.labels ? [...element.labels] : []
    if (labels.length > 0) {
      found.push(labels.map((each) => contentOf(each, true)).join(' '))
      for (const each of labels) found.push(contentOf(each, true), each.textContent ?? '')
    }
    if (element.hasAttribute('alt')) found.push(element.getAttribute('alt') ?? '')
    if (element instanceof HTMLInputElement && ['submit', 'reset', 'button'].includes(element.type)) {
      found.push(element.value)
      if (element.type === 'submit') found.push('Submit Query', 'Submit')
      if (element.type === 'reset') found.push('Reset')
    }
    if (element instanceof HTMLFieldSetElement) {
      const legend = element.querySelector(':scope > legend')
      if (legend !== null) found.push(contentOf(legend, true))
    }
    if (element instanceof HTMLTableElement && element.caption !== null) found.push(contentOf(element.caption, true))
    const figure = element.localName === 'figure' ? element.querySelector(':scope > figcaption') : null
    if (figure !== null) found.push(contentOf(figure, true))
    found.push(contentOf(element, true), contentOf(element, false))
    if (element instanceof HTMLElement) found.push(element.innerText)
    found.push(element.textContent ?? '')
    for (const attribute of ['title', 'placeholder', 'aria-placeholder']) {
      const value = element.getAttribute(attribute)
      if (value !== null) found.push(value)
    }
    found.push('')
    // Firefox trims and collapses the spacing of a name from content, and keeps an attribute's as written, so both forms
    // are offered.
    return [...new Set(found.flatMap((text) => [normalize(text), text]))]
  }
  return JSON.stringify(elements.map(candidatesOf))
}`
