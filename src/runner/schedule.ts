import type { Variant } from '../protocol/variant.ts'
import type { Selection } from './contract.ts'
import type { Focus } from './focus.ts'
import type { Plan, PlannedTest } from './plan.ts'
import { variantKey } from '../protocol/variant.ts'
import { testSelected, variantSelected } from './selection.ts'

/** One run of a test: the target each of its apps uses. */
export type Attempt = { test: PlannedTest; targets: Variant }

/** Attempts that run one after another in one process for their file. */
export type Visit = { file: string; attempts: Attempt[] }

/**
 * The visits in order, how many attempts the selection chose, before setups were added, and the chosen attempts of
 * skipped tests, which no visit runs.
 */
export type Schedule = { visits: Visit[]; selected: number; skipped: Attempt[] }

type Placed = Attempt & { position: readonly number[] }

/**
 * Orders the selected attempts, and the setups they need, into visits. Setups come first, each before the
 * setups that start from its state, once per target; then the rest, file by file in the order given, each
 * test's runs together. Consecutive attempts in one file share a visit. A borrowed file's setups run only for
 * the attempts that need them. `variants` false leaves milestone 1's attempts without a variant, so `lastFailed`
 * matches them by test id. With a `focus`, only the tests it keeps are chosen. A skipped test's attempts are chosen
 * but left out of the visits, and need no setup.
 *
 * @example scheduleRun(plan, { grep: 'saves' }, true).visits
 */
export function scheduleRun(plan: Plan, selection: Selection, variants: boolean, focus?: Focus): Schedule {
  const chosen = plan.files.flatMap((file, fileIndex) => {
    if (!file.ok || file.borrowed === true) return []
    return file.tests.flatMap((test, testIndex) => {
      if (!testSelected(test, selection) || focus?.keeps(test) === false) return []
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
  const skipped = chosen.filter((attempt) => attempt.test.registered.skip === true)
  const running = chosen.filter((attempt) => attempt.test.registered.skip !== true)
  for (const attempt of running) {
    if (attempt.test.registered.setup === true) setups.set(attemptKey(attempt), attempt)
    need(attempt)
  }
  const rest = running.filter((attempt) => attempt.test.registered.setup !== true)
  const visits = intoVisits([...inDependencyOrder([...setups.values()], plan), ...rest])
  return { visits, selected: chosen.length, skipped: skipped.map(({ test, targets }) => ({ test, targets })) }
}

/** The visits in two phases: those that run setups, which come first one after another, and those that run tests. */
export type Phases = { setups: Visit[]; tests: Visit[] }

/**
 * Splits the visits into the setup phase and the test phase. A visit that holds both, the last setup's file going
 * straight on to its own tests, becomes one visit in each, so a file's setups run in a visit of their own.
 *
 * @example phasesOf(scheduleRun(plan, {}, true).visits).tests.length
 */
export function phasesOf(visits: readonly Visit[]): Phases {
  const setups: Visit[] = []
  const tests: Visit[] = []
  for (const { file, attempts } of visits) {
    const own = attempts.filter((attempt) => attempt.test.registered.setup === true)
    const rest = attempts.filter((attempt) => attempt.test.registered.setup !== true)
    if (own.length > 0) setups.push({ file, attempts: own })
    if (rest.length > 0) tests.push({ file, attempts: rest })
  }
  return { setups, tests }
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
