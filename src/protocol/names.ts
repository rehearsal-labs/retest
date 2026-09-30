const namePattern = /^[A-Za-z][\w-]*$/

/** The words `--tag` reads as operators, so none of them can be a tag. */
export const tagOperators: ReadonlySet<string> = new Set(['and', 'or', 'not'])

/**
 * Whether text can name an app, target, secret, tag or state: letters, digits, `_` and `-`, starting with a
 * letter, since the names go into file names, `--target app=name` and `{{name}}`.
 *
 * @example isName('web-beta') // true
 */
export function isName(text: string): boolean {
  return namePattern.test(text)
}
