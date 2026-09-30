import type { LoadedApp, LoadedConfig } from '../config/loaded.ts'
import type { Variant } from '../protocol/variant.ts'
import { isName } from '../protocol/names.ts'
import { listWords } from '../shared/list-words.ts'
import { UsageError } from './errors.ts'
import { suggest } from './suggest.ts'

/**
 * Splits `app=value`, as `--target` and `--base-url` take it. A value such as a URL, with no app name before
 * its first `=`, is not a pair.
 *
 * @example splitPair('web=beta') // { app: 'web', value: 'beta' }
 */
export function splitPair(text: string): { app: string; value: string } | undefined {
  const equals = text.indexOf('=')
  const app = text.slice(0, equals)
  const value = text.slice(equals + 1)
  return equals === -1 || value === '' || !isName(app) ? undefined : { app, value }
}

/**
 * Reads each `--target app=name` into a partial variant, each app named once. `hint` may add a suggestion to
 * a value that is not a pair.
 *
 * @example readTargetPairs(['web=beta']) // { web: 'beta' }
 */
export function readTargetPairs(texts: readonly string[], hint: (text: string) => string = () => ''): Variant {
  const variant: Variant = {}
  for (const text of texts) {
    const pair = splitPair(text)
    if (pair === undefined) throw new UsageError(`--target takes app=name, such as web=beta, received ${JSON.stringify(text)}.${hint(text)}`)
    if (Object.hasOwn(variant, pair.app)) throw new UsageError(`--target names ${pair.app} twice. Name one target for each app.`)
    variant[pair.app] = pair.value
  }
  return variant
}

/**
 * Reads each `--target app=name` into the partial variant a selection keeps. Every app and target must be in
 * the config, and each app is named once.
 *
 * @example parseTargets(['web=beta'], config) // { web: 'beta' }
 */
export function parseTargets(texts: readonly string[], config: LoadedConfig): Variant {
  const variant = readTargetPairs(texts, (text) => pairHint(text, config))
  for (const [name, target] of Object.entries(variant)) {
    const targets = [...checkApp('--target', name, config).targets.keys()]
    if (targets.includes(target)) continue
    const guess = suggest(target, targets)
    const hint = guess === undefined ? '' : ` Did you mean ${name}=${guess}?`
    throw new UsageError(`--target ${name}=${target}: ${name} has no target ${target}.${hint} Its targets are ${listWords(targets, 'and')}.`)
  }
  return variant
}

/**
 * The app `--target` or `--base-url` names, or an error that lists the config's apps.
 *
 * @example checkApp('--base-url', 'web', config).baseUrl
 */
export function checkApp(option: string, name: string, config: LoadedConfig): LoadedApp {
  const app = config.apps.get(name)
  if (app !== undefined) return app
  const names = [...config.apps.keys()]
  const guess = suggest(name, names)
  const hint = guess === undefined ? '' : ` Did you mean ${guess}?`
  throw new UsageError(`${option} names no app ${name}.${hint} The config's apps are ${listWords(names, 'and')}.`)
}

// A bare target name that only one app has is almost certainly that app's.
function pairHint(text: string, config: LoadedConfig): string {
  const owners = [...config.apps.values()].filter((app) => app.targets.has(text))
  const [only] = owners
  return owners.length === 1 && only !== undefined ? ` Did you mean ${only.name}=${text}?` : ''
}
