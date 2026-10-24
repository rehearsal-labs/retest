/**
 * An environment without the variables a process must not see, such as the ones secrets and judges read. On Windows a
 * variable's name is one name whatever its case, so `Path` and `PATH` are the same variable there, and a hidden name
 * hides it in every case; elsewhere names are compared exactly, as the system compares them.
 *
 * @example withoutVariables(process.env, ['RETEST_PASSWORD']) // process.env without RETEST_PASSWORD
 */
export function withoutVariables(
  environment: Readonly<Record<string, string | undefined>>,
  hidden: Iterable<string> | undefined,
  platform: NodeJS.Platform = process.platform,
): Record<string, string | undefined> {
  const named = platform === 'win32' ? foldCase : (name: string): string => name
  const hide = new Set([...(hidden ?? [])].map(named))
  return Object.fromEntries(Object.entries(environment).filter(([name]) => !hide.has(named(name))))
}

/**
 * A variable name as Windows compares it: each character in its upper case, one character for one, as the system
 * compares names character by character. A character whose upper case is longer, such as ß (SS), stays as it is, so
 * `straße` and `STRASSE` stay two names.
 *
 * @example foldCase('Path') // 'PATH'
 */
export function foldCase(name: string): string {
  let folded = ''
  for (const character of name) {
    const upper = character.toUpperCase()
    folded += [...upper].length === 1 ? upper : character
  }
  return folded
}
