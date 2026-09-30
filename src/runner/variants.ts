import type { Variant } from '../protocol/variant.ts'
import type { RunConfig } from './run-config.ts'
import { variantKey } from '../protocol/variant.ts'

export type Variants = { ok: true; variants: Variant[] } | { ok: false; message: string }

type Choices = ReadonlyMap<string, readonly string[]>

/**
 * Each run of a test with these apps, which the config has. Apps with one target always use it. With one app
 * that has several targets, the test runs once per target; with two or more, once for each `runs` entry that
 * names all of them, and never for a pairing no entry lists.
 *
 * @example testVariants(['web'], config) // { ok: true, variants: [{ web: 'chromium' }, { web: 'beta' }] }
 */
export function testVariants(apps: readonly string[], config: RunConfig): Variants {
  const targets: Choices = new Map(apps.map((app) => [app, [...(config.apps.get(app)?.targets.keys() ?? [])]]))
  const matrix = apps.filter((app) => (targets.get(app)?.length ?? 0) > 1)
  if (matrix.length < 2) return { ok: true, variants: combinations(apps, targets) }
  const variants = new Map<string, Variant>()
  for (const entry of config.runs) {
    const chosen = new Map(targets)
    for (const app of matrix) {
      const target = Object.hasOwn(entry, app) ? entry[app] : undefined
      chosen.set(app, target === undefined ? [] : [target])
    }
    for (const variant of combinations(apps, chosen)) variants.set(variantKey(variant), variant)
  }
  if (variants.size > 0) return { ok: true, variants: [...variants.values()] }
  const listed = matrix.map((app) => JSON.stringify(app)).join(' and ')
  return { ok: false, message: `This test uses ${listed}, which have several targets each, and no entry in runs names all of them. Add one to runs.` }
}

// Every way to pick one target per app, in the order the test declared its apps.
function combinations(apps: readonly string[], choices: Choices): Variant[] {
  let variants: Variant[] = [{}]
  for (const app of apps) {
    const targets = choices.get(app) ?? []
    variants = variants.flatMap((variant) => targets.map((target) => ({ ...variant, [app]: target })))
  }
  return variants
}
