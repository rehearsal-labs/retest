import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { FixtureName, Size } from './options.ts'

export type Tool = 'retest' | 'playwright'

type Template = {
  /** The test's title, with `{n}` for its number. */
  readonly title: string
  /** The test's body, with `{n}` for its number. The same text runs on both tools. */
  readonly body: string
}

const TEMPLATES: Readonly<Record<FixtureName, Template>> = {
  'task-app': {
    title: 'saves task {n}',
    body: `  await page.goto('/')
  await page.getByTestId('task-title').fill('Release checklist {n}')
  await page.getByTestId('save-task').click()
  await expect(page.getByTestId('saved-task')).toHaveText('Release checklist {n}')`,
  },
  'search-app': {
    title: 'finds releases {n}',
    body: `  await page.goto('/')
  await page.getByTestId('search').fill('release')
  await expect(page.getByTestId('status')).toHaveText('3 results for release')`,
  },
}

const IMPORTS: Readonly<Record<Tool, string>> = {
  retest: "import { expect, test } from '@rehearsal-labs/retest'",
  playwright: "import { expect, test } from '@playwright/test'",
}

const SUFFIXES: Readonly<Record<Tool, string>> = { retest: '.retest.ts', playwright: '.spec.ts' }

export type TestRange = { readonly first: number; readonly last: number }

/**
 * Which test numbers each file holds: `tests` spread over exactly `files` files, the first files one test larger
 * when the division is uneven. `files` must not exceed `tests`.
 *
 * @example splitTests(5, 4) // [{ first: 1, last: 2 }, { first: 3, last: 3 }, { first: 4, last: 4 }, { first: 5, last: 5 }]
 */
export function splitTests(tests: number, files: number): TestRange[] {
  const base = Math.floor(tests / files)
  const larger = tests % files
  const ranges: TestRange[] = []
  let next = 1
  for (let file = 0; file < files; file += 1) {
    const count = base + (file < larger ? 1 : 0)
    ranges.push({ first: next, last: next + count - 1 })
    next += count
  }
  return ranges
}

/**
 * Writes `size.tests` tests across exactly `size.files` files into the project's `tests` folder, replacing what was
 * there. Test `n` reads the same on both tools apart from the import line.
 */
export async function writeTests(projectFolder: string, tool: Tool, fixture: FixtureName, size: Size): Promise<string[]> {
  const folder = join(projectFolder, 'tests')
  await rm(folder, { recursive: true, force: true })
  await mkdir(folder, { recursive: true })
  const files: string[] = []
  for (const [index, range] of splitTests(size.tests, size.files).entries()) {
    const tests = []
    for (let n = range.first; n <= range.last; n += 1) tests.push(renderTest(TEMPLATES[fixture], n))
    const path = join(folder, `bench-${index + 1}${SUFFIXES[tool]}`)
    await writeFile(path, `${IMPORTS[tool]}\n\n${tests.join('\n\n')}\n`)
    files.push(path)
  }
  return files
}

function renderTest(template: Template, n: number): string {
  const title = template.title.replaceAll('{n}', String(n))
  const body = template.body.replaceAll('{n}', String(n))
  return `test('${title}', async ({ page }) => {\n${body}\n})`
}

/** The Retest config a benchmark project runs with: one app, in the given Chrome, at the fixture's address. */
export function retestConfig(browser: string, baseUrl: string): string {
  return `import { chromium, defineConfig } from '@rehearsal-labs/retest'

export default defineConfig({
  apps: { web: chromium({ executablePath: ${JSON.stringify(browser)}, baseUrl: ${JSON.stringify(baseUrl)} }) },
})
`
}

/** The Playwright config a benchmark project runs with: its defaults, the same Chrome and the same address. */
export function playwrightConfig(browser: string, baseUrl: string): string {
  return `import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests',
  use: { baseURL: ${JSON.stringify(baseUrl)}, launchOptions: { executablePath: ${JSON.stringify(browser)} } },
})
`
}

export async function writeConfigs(retestFolder: string, playwrightFolder: string, browser: string, baseUrl: string): Promise<void> {
  await writeFile(join(retestFolder, 'retest.config.ts'), retestConfig(browser, baseUrl))
  await writeFile(join(playwrightFolder, 'playwright.config.ts'), playwrightConfig(browser, baseUrl))
}
