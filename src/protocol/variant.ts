import { s, type Schema } from './schema.ts'

/** One run of a test: the target each of its apps uses, by app name. */
export type Variant = Record<string, string>

export const variantSchema: Schema<Variant> = s.record(s.string())

const separators = /[=,]/

/**
 * A variant as one string: `app=target` pairs sorted by app name and joined with commas, the same whatever
 * order the variant lists its apps in. Names cannot hold `=` or `,`, which would make two variants share a key.
 *
 * @example variantKey({ web: 'beta', mobile: 'pixel' }) // 'mobile=pixel,web=beta'
 */
export function variantKey(variant: Readonly<Variant>): string {
  const pairs = Object.entries(variant).map(([app, target]) => {
    if (separators.test(app) || separators.test(target)) {
      throw new TypeError(`An app or target name cannot contain "=" or ",", received ${JSON.stringify(`${app}=${target}`)}.`)
    }
    return `${app}=${target}`
  })
  return pairs.sort(byCodeUnit).join(',')
}

/**
 * A variant's `app=target` pairs, in the order of its key. None for a run without a variant.
 *
 * @example variantPairs({ web: 'beta', mobile: 'pixel' }) // ['mobile=pixel', 'web=beta']
 */
export function variantPairs(variant: Readonly<Variant> | undefined): string[] {
  return variant === undefined || Object.keys(variant).length === 0 ? [] : variantKey(variant).split(',')
}

/**
 * Whether a variant uses each target `targets` names for its app, as `--target web=beta` asks.
 *
 * @example matchesTargets({ web: 'beta', api: 'stable' }, { web: 'beta' }) // true
 */
export function matchesTargets(variant: Readonly<Variant> | undefined, targets: Readonly<Variant>): boolean {
  return Object.entries(targets).every(([app, target]) => variant?.[app] === target)
}

// Code units, not the locale, so every machine sorts the same way.
function byCodeUnit(first: string, second: string): number {
  return first < second ? -1 : first > second ? 1 : 0
}
