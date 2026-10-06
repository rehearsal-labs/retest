import type { Rect } from './webdriver-client.ts'
import { sha256Hex } from '../shared/sha256.ts'

// A native app's element tree carries the user's own data: on macOS the Apple menu's Recent Items and an app's Open
// Recent name recent files, recent apps and the user. A tree is cut to what the session owns before anything keeps it,
// and the text of any menu left inside is hashed, so no report, artifact or model input ever holds the rest. The text is
// decoded and redacted before it is hashed: a hash of a secret would let a weak one be guessed offline, and a hash of
// its placeholder stays the same when the secret changes.

/**
 * What a session owns of an app's tree: the app with `bundleId`, or named by any of `appNames` when the executor gives
 * the root no bundle id, and on macOS its first window. `redact` is the session's, run on menu text before it is hashed.
 */
export type SourceScope = { readonly platform: 'ios-simulator' | 'macos'; readonly bundleId: string; readonly appNames: readonly string[]; readonly redact?: ((text: string) => string) | undefined }

/**
 * The part of a tree a session may keep: its XML, how many elements it holds, how many of them sat under a menu and
 * had their text hashed, and on macOS the window's frame in points.
 */
export type ScopedSource = { readonly xml: string; readonly elements: number; readonly hashedMenuElements: number; readonly window?: Rect }

const tagPattern = /<(\/?)(XCUIElementType\w+)\b([^>]*?)(\/?)>/g
const menuTypes = new Set(['XCUIElementTypeMenuBar', 'XCUIElementTypeMenuBarItem', 'XCUIElementTypeMenu', 'XCUIElementTypeMenuItem'])
const textAttributes = /\b(label|title|value|name|placeholderValue)="([^"]*)"/g
const entities: Readonly<Record<string, string>> = { '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>', '&amp;': '&' }

/**
 * Cuts an executor's `/source` tree to what the scope owns. The root must be the owned app: its `bundleId` when the
 * executor gives one, else its `name`, `title` or `label`. A tree of another app, such as the home screen, is refused
 * whole. On macOS only the app's first
 * window is kept, never the menu bar; on iOS the app's own tree. Menu text inside is hashed either way.
 *
 * @example scopeSource(xml, { platform: 'macos', bundleId: 'dev.retest.fixtures.taskdesk', appNames: ['TaskDesk'] }) // { ok: true, source: { xml: '<XCUIElementTypeWindow …', elements: 41, hashedMenuElements: 0, window: { x: 120, y: 80, width: 820, height: 560 } } }
 */
export function scopeSource(xml: string, scope: SourceScope): { readonly ok: true; readonly source: ScopedSource } | { readonly ok: false; readonly problem: string } {
  const tags = [...xml.matchAll(tagPattern)]
  const rootIndex = tags.findIndex((tag) => tag[1] !== '/' && tag[2] === 'XCUIElementTypeApplication')
  const root = tags[rootIndex]
  if (root === undefined) return { ok: false, problem: 'The tree has no application element.' }
  const rootAttributes = readAttributes(root[3] ?? '')
  const names = ['name', 'title', 'label'].map((key) => rootAttributes[key]).filter((value) => value !== undefined && value.length > 0)
  const rootBundle = rootAttributes['bundleId']
  // WebDriverAgent names the root's bundle id, which decides; another app's name is not repeated, as it can itself be
  // the user's data.
  if (rootBundle !== undefined && rootBundle.length > 0 && rootBundle !== scope.bundleId) return { ok: false, problem: `The tree is of another app, not ${scope.bundleId}.` }
  if ((rootBundle === undefined || rootBundle.length === 0) && !names.some((name) => scope.appNames.includes(name ?? ''))) {
    return { ok: false, problem: `The tree is not of the owned app: its root names ${names.length === 0 ? 'nothing' : 'another app'}, not ${scope.appNames.map((name) => JSON.stringify(name)).join(' or ')}.` }
  }
  const startIndex = scope.platform === 'macos' ? tags.findIndex((tag, index) => index > rootIndex && tag[1] !== '/' && tag[2] === 'XCUIElementTypeWindow') : rootIndex
  if (startIndex === -1) return { ok: false, problem: 'The app has no window in its tree.' }
  const cut = cutSubtree(xml, tags, startIndex, scope.redact ?? ((text: string) => text))
  if (cut === undefined) return { ok: false, problem: 'The tree ends before its element closes.' }
  const start = tags[startIndex]
  const window = scope.platform === 'macos' && start !== undefined ? readFrame(readAttributes(start[3] ?? '')) : undefined
  return { ok: true, source: { ...cut, ...(window === undefined ? {} : { window }) } }
}

/** Scope refusals that can clear after app launch; retry only these reads, without accepting their trees. */
export function transientSourceProblem(problem: string): boolean {
  return problem === 'The app has no window in its tree.'
    || problem.startsWith('The tree is of another app, not ')
    || problem.startsWith('The tree is not of the owned app: its root names ')
}

function cutSubtree(xml: string, tags: readonly RegExpExecArray[], startIndex: number, redact: (text: string) => string): Omit<ScopedSource, 'window'> | undefined {
  const parts: string[] = []
  const open: string[] = []
  let elements = 0
  let hashedMenuElements = 0
  let cursor = tags[startIndex]?.index ?? 0
  for (const tag of tags.slice(startIndex)) {
    const [text, closing, type = '', attributes = '', selfClosing] = tag
    parts.push(xml.slice(cursor, tag.index))
    cursor = tag.index + text.length
    if (closing === '/') {
      open.pop()
      parts.push(text)
      if (open.length === 0) return { xml: parts.join(''), elements, hashedMenuElements }
      continue
    }
    elements += 1
    const underMenu = menuTypes.has(type) || open.some((ancestor) => menuTypes.has(ancestor))
    if (underMenu) hashedMenuElements += 1
    parts.push(underMenu ? `<${type}${attributes.replace(textAttributes, (_, name: string, value: string) => `${name}="${hashText(redact(decodeEntities(value)))}"`)}${selfClosing ?? ''}>` : text)
    if (selfClosing === '/') {
      if (open.length === 0) return { xml: parts.join(''), elements, hashedMenuElements }
    } else {
      open.push(type)
    }
  }
  return undefined
}

function readAttributes(text: string): Record<string, string> {
  const attributes: Record<string, string> = {}
  for (const match of text.matchAll(/(\w+)="([^"]*)"/g)) {
    const [, name, value = ''] = match
    if (name !== undefined) attributes[name] = decodeEntities(value)
  }
  return attributes
}

// The executors escape the five XML entities and write characters outside them as numeric references.
function decodeEntities(value: string): string {
  return value.replace(/&(?:(quot|apos|lt|gt|amp)|#(\d+)|#x([0-9a-fA-F]+));/g, (entity, named: string | undefined, decimal: string | undefined, hex: string | undefined) => {
    if (named !== undefined) return entities[entity] ?? entity
    const code = decimal !== undefined ? Number(decimal) : Number.parseInt(hex ?? '', 16)
    return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity
  })
}

function readFrame(attributes: Readonly<Record<string, string>>): Rect | undefined {
  const [x, y, width, height] = ['x', 'y', 'width', 'height'].map((key) => Number(attributes[key]))
  if (x === undefined || y === undefined || width === undefined || height === undefined) return undefined
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return undefined
  return { x, y, width, height }
}

function hashText(value: string): string {
  return value.length === 0 ? '' : `sha256:${sha256Hex(value).slice(0, 12)}`
}
