import { s, type Schema } from './schema.ts'

/** A secret named in place of its value. Only the parent process knows the value. */
export type SecretRef = { secret: string }

export const secretRefSchema: Schema<SecretRef> = s.object({ secret: s.string() })

/**
 * What stands in for a secret's value in anything Retest records, prints or sends to a test file's process.
 *
 * @example secretPlaceholder('password') // '{{password}}'
 */
export function secretPlaceholder(name: string): string {
  return `{{${name}}}`
}
