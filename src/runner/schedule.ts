import type { Variant } from '../protocol/variant.ts'
import type { Selection } from './contract.ts'
import type { Plan, PlannedTest } from './plan.ts'
import { variantKey } from '../protocol/variant.ts'
import { testSelected, variantSelected } from './selection.ts'

/** One run of a test: the target each of its apps uses. */
export type Attempt = { test: PlannedTest; targets: Variant }

/** Attempts that run one after another in one process for their file. */
export type Visit = { file: string; attempts: Attempt[] }

/** The visits in order, and how many attempts the selection chose, before setups were added. */
export type Schedule = { visits: Visit[]; selected: number }

type Placed = Attempt & { position: readonly number[] }

/**
 * Orders the selected attempts, and the setups they need, into visits. Setups come first, each before the
 * setups that start from its state, once per target; then the rest, file by file in the order given, each
 * test's runs together. Consecutive attempts in one file share a visit. A borrowed file's setups run only for
 * the attempts that need them. `variants` false leaves milestone 1's attempts without a variant, so `lastFailed`
 * matches them by test id.
 *
 * @example scheduleRun(plan, { grep: 'saves' }, true).visits
 */
export function scheduleRun(plan: Plan, selection: Selection, variants: boolean): Schedule {
  const chosen = plan.files.flatMap((file, fileIndex) => {
    if (!file.ok || file.borrowed === true) return []
    return file.tests.flatMap((test, testIndex) => {
      if (!testSelected(test, selection)) return []
      return test.variants.flatMap((targets, variantIndex) => {
        const kept = variantSelected(test.testId, variants ? targets : undefined, selection)
        return kept ? [{ test, targets, position: [fileIndex, testIndex, variantIndex] }] : []
      })
    })
  })
  const setups = new Map<string, Placed>()
  const need = (attempt: Placed): void => {
    for (const setup of neededSetups(attempt, plan)) {
      const key = attemptKey(setup)
      if (setups.has(key)) continue
      const known = chosen.find((each) => attemptKey(each) === key) ?? setup
      setups.set(key, known)
      need(known)
    }
  }
  for (const attempt of chosen) {
    if (attempt.test.registered.setup === true) setups.set(attemptKey(attempt), attempt)
    need(attempt)
  }
  const rest = chosen.filter((attempt) => attempt.test.registered.setup !== true)
  return { visits: intoVisits([...inDependencyOrder([...setups.values()], plan), ...rest]), selected: chosen.length }
}

/** An attempt's identity in a run: its test id and its variant's key. */
export function attemptKey({ test, targets }: Attempt): string {
  return `${test.testId}\n${variantKey(targets)}`
}

// A setup is needed once for each target its dependents use; a setup that failed its file's checks is not.
function neededSetups({ test, targets }: Attempt, plan: Plan): Placed[] {
  return [...test.states].flatMap(([app, state]) => {
    const setup = plan.setups.get(state)
    const target = targets[app]
    if (setup === undefined || !setup.usable || target === undefined) return []
    const setupTargets = { [app]: target }
    return [{ test: setup.test, targets: setupTargets, position: positionOf(setup.test, setupTargets, plan) }]
  })
}

// Each setup comes after the setups it starts from, and otherwise in file order, which keeps a file's setups together.
function inDependencyOrder(setups: readonly Placed[], plan: Plan): Placed[] {
  const ordered: Placed[] = []
  const done = new Set<string>()
  let remaining = [...setups].sort(byPosition)
  while (remaining.length > 0) {
    const ready = remaining.find((setup) => neededSetups(setup, plan).every((needed) => done.has(attemptKey(needed)))) ?? remaining[0]
    if (ready === undefined) break
    ordered.push(ready)
    done.add(attemptKey(ready))
    remaining = remaining.filter((setup) => setup !== ready)
  }
  return ordered
}

function positionOf(test: PlannedTest, targets: Variant, plan: Plan): number[] {
  const fileIndex = plan.files.findIndex((file) => file.file === test.file)
  const file = plan.files[fileIndex]
  const testIndex = file?.ok === true ? file.tests.indexOf(test) : -1
  const key = variantKey(targets)
  return [fileIndex, testIndex, test.variants.findIndex((variant) => variantKey(variant) === key)]
}

function byPosition(first: Placed, second: Placed): number {
  for (const [index, value] of first.position.entries()) {
    const difference = value - (second.position[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

function intoVisits(attempts: readonly Placed[]): Visit[] {
  const visits: Visit[] = []
  for (const { test, targets } of attempts) {
    const last = visits.at(-1)
    if (last?.file === test.file) last.attempts.push({ test, targets })
    else visits.push({ file: test.file, attempts: [{ test, targets }] })
  }
  return visits
}
