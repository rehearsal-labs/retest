import type { RegisteredTest } from '../protocol/messages.ts'
import type { CollectedTests } from './plan.ts'
import { findTestFiles } from '../shared/test-files.ts'
import { startStates } from './plan.ts'

/** The setups a run took from test files it was not given, and the files it could not load while it looked. */
export type SetupSearch = { borrowed: CollectedTests[]; unreadable: string[] }

export type SetupSearchOptions = {
  rootDir: string
  collected: readonly CollectedTests[]
  /** Loads one file's tests as collection does. */
  collect: (file: string) => Promise<CollectedTests>
}

type Candidate = { file: string; setups: RegisteredTest[] }

/**
 * Finds, among the other test files under the root, the setups that save the states the collected tests start
 * from and no collected file saves, and the setups those start from in turn. Files are loaded in path order until
 * every such state is found. A file keeps only the setups taken from it, so its other tests stay out of the run.
 *
 * @example await searchSetups({ rootDir: '/work', collected, collect }) // { borrowed: [{ file: 'tests/sign-in.retest.ts', ok: true, tests: [setup], borrowed: true }], unreadable: [] }
 */
export async function searchSetups({ rootDir, collected, collect }: SetupSearchOptions): Promise<SetupSearch> {
  const loaded = collected.flatMap((entry) => (entry.ok ? entry.tests : []))
  const saved = new Set(loaded.flatMap((test) => (test.setup === true ? [test.name] : [])))
  const missing = new Set(loaded.flatMap(startStates).filter((state) => !saved.has(state)))
  const candidates: Candidate[] = []
  const taken = new Set<RegisteredTest>()
  const unreadable: string[] = []
  const named = new Set(collected.map((entry) => entry.file))
  for (const file of missing.size === 0 ? [] : findTestFiles(rootDir)) {
    if (missing.size === 0) break
    if (named.has(file)) continue
    const found = await collect(file)
    if (!found.ok) {
      unreadable.push(file)
      continue
    }
    candidates.push({ file, setups: found.tests.filter((test) => test.setup === true) })
    take(candidates, { missing, saved, taken })
  }
  const borrowed = candidates.flatMap(({ file, setups }): CollectedTests[] => {
    const tests = setups.filter((setup) => taken.has(setup))
    return tests.length === 0 ? [] : [{ file, ok: true, tests, borrowed: true }]
  })
  return { borrowed, unreadable }
}

type Taking = { missing: Set<string>; saved: Set<string>; taken: Set<RegisteredTest> }

// A setup taken may start from a state of its own, which files already looked through can save.
function take(candidates: readonly Candidate[], { missing, saved, taken }: Taking): void {
  for (let progress = true; progress; ) {
    progress = false
    for (const setup of candidates.flatMap((candidate) => candidate.setups)) {
      if (!missing.has(setup.name)) continue
      missing.delete(setup.name)
      saved.add(setup.name)
      taken.add(setup)
      for (const state of startStates(setup)) if (!saved.has(state)) missing.add(state)
      progress = true
    }
  }
}
