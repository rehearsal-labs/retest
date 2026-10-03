import type { Schema } from '../protocol/schema.ts'
import { s } from '../protocol/schema.ts'

// A console message's arguments as text, from what the engine sent with the message and nothing else: Retest never
// asks the page for an object's properties, so no getter runs and no handle to a page object is kept. The engine
// previews an object one level deep, showing a getter as an accessor without calling it.

/** A property in the engine's preview of an object. `value` is the engine's own text for it. */
export type PropertyPreview = { name: string; type: string; subtype?: string; value?: string }

/** The engine's preview of an object, one level deep, which says whether it left properties out. */
export type ObjectPreview = { type: string; subtype?: string; description?: string; overflow: boolean; properties: PropertyPreview[] }

/** A console argument as the engine describes it. An object's handle is never read from it. */
export type ConsoleArgument = {
  type: string
  subtype?: string
  className?: string
  value?: string | number | boolean | null
  unserializableValue?: string
  description?: string
  preview?: ObjectPreview
}

const propertyPreviewSchema: Schema<PropertyPreview> = s.object({
  name: s.string(),
  type: s.string(),
  subtype: s.optional(s.string()),
  value: s.optional(s.string()),
})

const objectPreviewSchema: Schema<ObjectPreview> = s.object({
  type: s.string(),
  subtype: s.optional(s.string()),
  description: s.optional(s.string()),
  overflow: s.boolean(),
  properties: s.array(propertyPreviewSchema),
})

export const consoleArgumentSchema: Schema<ConsoleArgument> = s.object({
  type: s.string(),
  subtype: s.optional(s.string()),
  className: s.optional(s.string()),
  value: s.optional(s.union([s.string(), s.number(), s.boolean(), s.literal(null)])),
  unserializableValue: s.optional(s.string()),
  description: s.optional(s.string()),
  preview: s.optional(objectPreviewSchema),
})

// Chrome cuts a value in an object's preview to this many characters, keeping its start and its end, so a value this
// long may be part of one: a secret cut in two is no longer one the redactor can find, so none of it is kept.
const previewCut = 100
/** What stands in for a value Chrome cut in a preview, of which nothing is kept. */
export const cutValue = '(cut)'

/**
 * A console message's arguments as one text, joined by a space, as the console shows them: strings as written,
 * other values as the engine describes them, an error with its stack, and an object's previewed properties. Nothing
 * here is cut or escaped, so the redactor sees every value whole before any cut: a value Chrome itself cut in a preview
 * is written `(cut)`, and a string is quoted as it is.
 *
 * @example consoleText([{ type: 'string', value: 'saved' }, { type: 'number', value: 3, description: '3' }]) // 'saved 3'
 */
export function consoleText(args: readonly ConsoleArgument[]): string {
  return args.map(argumentText).join(' ')
}

/**
 * One value as text, as `consoleText` writes each argument. An exception the page threw is described the same way.
 *
 * @example argumentText({ type: 'undefined' }) // 'undefined'
 */
export function argumentText(argument: ConsoleArgument): string {
  switch (argument.type) {
    case 'string':
      return typeof argument.value === 'string' ? argument.value : (argument.description ?? '')
    case 'number':
    case 'boolean':
    case 'bigint':
      return argument.unserializableValue ?? argument.description ?? String(argument.value)
    case 'undefined':
      return 'undefined'
    case 'symbol':
      return argument.description ?? 'Symbol()'
    case 'function':
      return functionText(argument)
    case 'object':
      return objectText(argument)
    default:
      return argument.description ?? argument.type
  }
}

// A function's description is its source; its first line is kept whole, and cut, if at all, only once it is redacted.
function functionText(argument: ConsoleArgument): string {
  const [first = 'function'] = (argument.description ?? 'function').split('\n')
  return first
}

function objectText(argument: ConsoleArgument): string {
  if (argument.subtype === 'null') return 'null'
  // An error's description is its message and its stack; a node's is its tag, id and classes.
  if (argument.subtype === 'error' || argument.subtype === 'node' || argument.preview === undefined) {
    return argument.description ?? argument.className ?? 'Object'
  }
  return previewText(argument.preview, argument.description)
}

function previewText(preview: ObjectPreview, description: string | undefined): string {
  const array = preview.subtype === 'array' || preview.subtype === 'typedarray'
  const parts = preview.properties.map((property) => (array && /^\d+$/.test(property.name) ? propertyValue(property) : `${propertyName(property)}: ${propertyValue(property)}`))
  if (preview.overflow) parts.push('…')
  const body = array ? `[${parts.join(', ')}]` : `{${parts.join(', ')}}`
  const name = description ?? preview.description
  // A plain object or array reads as its contents; anything else, such as a Map or a class instance, is named first.
  if (name === undefined || name === 'Object' || (array && /^Array\(\d+\)$/.test(name))) return body
  return parts.length === 0 ? name : `${name} ${body}`
}

function propertyName(property: PropertyPreview): string {
  return property.name.length >= previewCut ? cutValue : property.name
}

function propertyValue(property: PropertyPreview): string {
  if (property.type === 'accessor') return '(...)'
  const value = property.value ?? ''
  if (value.length >= previewCut) return cutValue
  if (property.type === 'string') return `"${value}"`
  if (property.type === 'function' && value === '') return 'function'
  return property.value ?? property.subtype ?? property.type
}
