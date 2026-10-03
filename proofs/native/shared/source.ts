import { createHash } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { within } from './deadline.ts'

/** One element of an executor's XML tree: its XCUIElementType tag and its attributes. */
export type SourceElement = {
  readonly type: string
  readonly attributes: Readonly<Record<string, string>>
}

const XML_ENTITIES: Readonly<Record<string, string>> = { '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>', '&amp;': '&' }
const TAG = /<(\/?)(XCUIElementType\w+)\b([^>]*?)(\/?)>/g
// Menus carry the user's own data: the Apple menu's Recent Items and an app's Open Recent list name recent files,
// recent apps and the user. Their text is hashed wherever a tree is kept.
const MENU_TYPES = new Set(['XCUIElementTypeMenuBar', 'XCUIElementTypeMenuBarItem', 'XCUIElementTypeMenu', 'XCUIElementTypeMenuItem'])
const TEXT_ATTRIBUTES = /\b(label|title|value|placeholderValue)="([^"]*)"/g

/**
 * Reads every element of a `/source` XML tree in document order. The executors write one element per tag with
 * attributes such as `identifier`, `label`, `title`, `value`, `enabled` and the frame; this reads those and
 * nothing else, which is all a proof needs.
 *
 * @example readSource('<XCUIElementTypeButton label="Save" enabled="true"/>') // [{ type: 'XCUIElementTypeButton', attributes: { label: 'Save', enabled: 'true' } }]
 */
export function readSource(xml: string): SourceElement[] {
  const elements: SourceElement[] = []
  for (const match of xml.matchAll(TAG)) {
    if (match[1] === '/') continue
    const attributes: Record<string, string> = {}
    for (const attribute of (match[3] ?? '').matchAll(/(\w+)="([^"]*)"/g)) {
      const name = attribute[1]
      if (name !== undefined) attributes[name] = (attribute[2] ?? '').replace(/&(quot|apos|lt|gt|amp);/g, (entity) => XML_ENTITIES[entity] ?? entity)
    }
    elements.push({ type: match[2] ?? '', attributes })
  }
  return elements
}

/** The part of an app's tree a proof may keep, and how much of it was hashed. */
export type OwnedWindowSource = {
  readonly xml: string
  readonly hashedElements: number
}

/**
 * Cuts the first window's subtree out of a whole-app `/source` tree, so the menu bar (with the Apple menu's Recent
 * Items and the app's Open Recent) never leaves memory, and hashes the text of any menu inside that window as
 * well. This is the only form of a tree the proofs write to disk. Undefined when the tree has no window.
 *
 * @example ownedWindowSource('<XCUIElementTypeApplication><XCUIElementTypeWindow title="Untitled"/></XCUIElementTypeApplication>') // { xml: '<XCUIElementTypeWindow title="Untitled"/>', hashedElements: 0 }
 */
export function ownedWindowSource(xml: string): OwnedWindowSource | undefined {
  const parts: string[] = []
  const open: string[] = []
  let started = false
  let cursor = 0
  let hashedElements = 0
  for (const match of xml.matchAll(TAG)) {
    const [tag, closing, type = '', attributes = '', selfClosing] = match
    if (!started) {
      if (closing === '/' || type !== 'XCUIElementTypeWindow') continue
      started = true
      cursor = match.index
    }
    parts.push(xml.slice(cursor, match.index))
    cursor = match.index + tag.length
    if (closing === '/') {
      open.pop()
      parts.push(tag)
      if (open.length === 0) return { xml: parts.join(''), hashedElements }
      continue
    }
    const underMenu = MENU_TYPES.has(type) || open.some((ancestor) => MENU_TYPES.has(ancestor))
    if (underMenu) hashedElements += 1
    parts.push(underMenu ? `<${type}${attributes.replace(TEXT_ATTRIBUTES, (_, name: string, value: string) => `${name}="${hashText(value)}"`)}${selfClosing ?? ''}>` : tag)
    if (selfClosing === '/') {
      if (open.length === 0) return { xml: parts.join(''), hashedElements }
    } else {
      open.push(type)
    }
  }
  return undefined
}

function hashText(value: string): string {
  return value.length === 0 ? '' : `sha256:${createHash('sha256').update(value).digest('hex').slice(0, 12)}`
}

/**
 * How many elements of each type the tree has, most common first, for a step note.
 *
 * @example countTypes(readSource(xml)).slice(0, 2) // [['XCUIElementTypeButton', 41], ['XCUIElementTypeStaticText', 30]]
 */
export function countTypes(elements: readonly SourceElement[]): Array<[string, number]> {
  const counts = new Map<string, number>()
  for (const element of elements) counts.set(element.type, (counts.get(element.type) ?? 0) + 1)
  return [...counts].sort((left, right) => right[1] - left[1])
}

/** The last value an observation read, whether it met the condition, and how often it looked. */
export type Observation<T> = {
  readonly value: T
  readonly met: boolean
  readonly attempts: number
}

/**
 * Reads state until `condition` holds or the deadline passes. Only reads repeat; the action before it was sent
 * once. Each read is given only the time left, so one slow read cannot carry the observation past its deadline.
 * A read that throws counts as not met and is tried again; at the deadline the last value is returned, or the last
 * error thrown when no read ever answered.
 *
 * @example await observe(() => session.text(field), (text) => text === 'hello', 3000) // { value: 'hello', met: true, attempts: 2 }
 */
export async function observe<T>(read: () => Promise<T>, condition: (value: T) => boolean, timeoutMs: number): Promise<Observation<T>> {
  const deadline = Date.now() + timeoutMs
  let attempts = 0
  let last: { readonly value: T } | undefined
  let lastError: unknown = new Error(`no read answered within ${timeoutMs} ms`)
  for (;;) {
    attempts += 1
    try {
      const answer = await within(read().then((value) => ({ value })), deadline - Date.now())
      if (answer !== undefined) {
        last = answer
        if (condition(answer.value)) return { value: answer.value, met: true, attempts }
      }
    } catch (error) {
      lastError = error
    }
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      if (last !== undefined) return { value: last.value, met: false, attempts }
      throw lastError
    }
    await sleep(Math.min(250, remaining))
  }
}
