import type { Path, Schema } from '../protocol/schema.ts'
import { describeValue, formatPath, parse } from '../protocol/schema.ts'
import { isName } from '../protocol/names.ts'
import { isWebUrl } from '../protocol/url.ts'

/** One thing wrong with a config, at the key it names, such as `apps.web.targets.beta.channel`. */
export type ConfigIssue = { key: string; message: string }

/** Collects what is wrong with a config, each at its key, so one pass reports every problem. */
export class Problems {
  readonly issues: ConfigIssue[] = []

  add(path: Path, message: string): void {
    this.issues.push({ key: configKey(path), message })
  }

  /** The value when it matches the schema; otherwise records each issue at its key and returns undefined. */
  check<T>(schema: Schema<T>, value: unknown, path: Path): T | undefined {
    const parsed = parse(schema, value)
    if (parsed.ok) return parsed.value
    const prefix = formatPath(path)
    for (const issue of parsed.issues) this.issues.push({ key: displayKey(prefix + issue.path.slice(1)), message: issue.message })
    return undefined
  }

  /**
   * Names are used in file names, `--target app=name` and `{{name}}`, so they hold letters, digits, `_` and `-`
   * and start with a letter. Records a name that does not, and says whether it does.
   */
  checkName(path: Path, name: string): boolean {
    if (isName(name)) return true
    this.add(path, `expected a name of letters, digits, "_" and "-" that starts with a letter, received ${describeValue(name)}`)
    return false
  }

  /** Records an http or https URL that is not one. */
  checkUrl(path: Path, text: string): void {
    if (!isWebUrl(URL.parse(text))) this.add(path, `expected an http or https URL, received ${describeValue(text)}`)
  }

  /** Records an empty string where a value is needed. */
  checkFilled(path: Path, text: string, what: string): void {
    if (text.trim() === '') this.add(path, `expected ${what}, received ${describeValue(text)}`)
  }
}

/**
 * A path in a config as messages write it.
 *
 * @example configKey(['apps', 'web', 'targets']) // 'apps.web.targets'
 */
export function configKey(path: Path): string {
  return displayKey(formatPath(path))
}

function displayKey(formatted: string): string {
  const key = formatted.slice(1)
  return key.startsWith('.') ? key.slice(1) : key
}
