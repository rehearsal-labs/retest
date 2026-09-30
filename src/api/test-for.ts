import { formatValue } from './format-value.ts'

const placeholder = /\$([A-Za-z_]\w*)/g

export type FilledName = { readonly name: string } | { readonly missing: string }

/**
 * A `test.for` row's test name: each `$key` in the template replaced by the row's own `key`. Text shows as it
 * is and any other value as Retest prints values. A `$` that does not start a name, as in `$5`, stays.
 *
 * @example fillName('archives "$title"', { title: 'Release checklist' }) // { name: 'archives "Release checklist"' }
 */
export function fillName(template: string, row: object): FilledName {
  let missing: string | undefined
  const name = template.replace(placeholder, (match, key: string) => {
    if (!Object.hasOwn(row, key)) {
      missing ??= key
      return match
    }
    const value: unknown = Reflect.get(row, key)
    return typeof value === 'string' ? value : formatValue(value)
  })
  return missing === undefined ? { name } : { missing }
}

/** Whether a row is an object `test.for` can name tests from: a plain object, not an array or a class instance. */
export function isRow(value: unknown): value is object {
  if (typeof value !== 'object' || value === null) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
