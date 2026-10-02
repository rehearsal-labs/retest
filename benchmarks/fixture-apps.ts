import type { FixtureName } from './options.ts'
import { startService, type Service } from './programs.ts'

const CLIS: Readonly<Record<FixtureName, readonly string[]>> = {
  'task-app': ['fixtures/task-app/cli.ts', '--mode', 'ok'],
  'search-app': ['fixtures/search-app/cli.ts'],
}

/** What each fixture stands for in the report. */
export const FIXTURE_NOTES: Readonly<Record<FixtureName, string>> = {
  'task-app': 'runner-dominated: the page answers at once, so the runner sets the pace',
  'search-app': 'app-dominated: a 150 ms API and a 300 ms debounce, so the app sets the pace',
}

/** Starts a fixture app from this checkout and returns its address. */
export function startFixtureApp(name: FixtureName, repositoryRoot: string): Promise<Service> {
  return startService(process.execPath, CLIS[name], repositoryRoot)
}
