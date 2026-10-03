import type { BrowserName } from '../../config/types.ts'

/** What `init` asks: the app, where it answers, how to start it, and which browser runs the tests. */
export type InitAnswers = { app: string; url: string; start?: string; browser: BrowserName }

export const packageName = '@rehearsal-labs/retest'

export const exampleTestFile = 'tests/example.retest.ts'

/** The tsconfig `init` writes beside the tests. Retest reads its `paths` when it loads them, and `tsc` checks them with it. */
export const testTsconfigFile = 'tests/tsconfig.json'

/** The scripts `init` adds to package.json. The type check uses the tsconfig it writes. */
export const packageScripts: Readonly<Record<string, string>> = {
  'test:e2e': 'retest run',
  'typecheck:e2e': `tsc -p ${testTsconfigFile}`,
}

const identifier = /^[A-Za-z_$][\w$]*$/

/**
 * `retest.config.ts` for one app on one browser, with the block that registers its types.
 *
 * @example configSource({ app: 'web', url: 'http://localhost:3000', browser: 'chrome' })
 */
export function configSource(answers: InitAnswers): string {
  const { app, url, start, browser } = answers
  const key = identifier.test(app) ? app : jsString(app)
  const settings = [
    `      baseUrl: ${jsString(url)},`,
    ...(start === undefined ? [] : [`      start: { command: ${jsString(start)}, ready: ${jsString(url)} },`]),
  ]
  const imports = [browser, 'defineConfig'].sort()
  const chromiumNote = browser === 'chromium' ? ['    // chromium() runs the browser RETEST_CHROMIUM points to, unless you add executablePath.'] : []
  return [
    `import { ${imports.join(', ')} } from '${packageName}'`,
    '',
    'const config = defineConfig({',
    '  apps: {',
    ...chromiumNote,
    `    ${key}: ${browser}({`,
    ...settings,
    '    }),',
    '  },',
    '})',
    '',
    'export default config',
    '',
    '// Lets every test file see your app names, secrets, test ids and tags.',
    `declare module '${packageName}' {`,
    '  interface Register {',
    '    config: typeof config',
    '  }',
    '}',
    '',
  ].join('\n')
}

export const exampleTestSource: string = [
  `import { expect, test } from '${packageName}'`,
  '',
  "test('shows the home page', async ({ page }) => {",
  "  await page.goto('/')",
  "  await expect(page.getByRole('main')).toBeVisible()",
  '})',
  '',
].join('\n')

/**
 * The tests' tsconfig, whose options accept what Retest loads and refuse what it does not: ES modules, imports with or
 * without their extension or by the `.js` of a `.ts` file, enums, namespaces and parameter properties, and `import
 * type` for every type; no JSX and no `import x = require()`. Given the project's own tsconfig, as a path from the test
 * folder, it extends it, keeping its `paths` and strictness, and sets back what would let `tsc` pass what Retest
 * refuses, such as `jsx`.
 *
 * @example testTsconfigSource('../tsconfig.json') // '{\n  "extends": "../tsconfig.json", ...'
 */
export function testTsconfigSource(projectTsconfig?: string): string {
  const reset = projectTsconfig === undefined ? {} : { jsx: null, rootDir: null, composite: false }
  const compilerOptions = {
    target: 'es2024',
    module: 'esnext',
    moduleResolution: 'bundler',
    types: ['node'],
    strict: true,
    noEmit: true,
    allowImportingTsExtensions: true,
    verbatimModuleSyntax: true,
    erasableSyntaxOnly: false,
    noUncheckedIndexedAccess: true,
    skipLibCheck: true,
    ...reset,
  }
  // The project's own files and include list stay its own; this one checks the tests and the config.
  const files = projectTsconfig === undefined ? {} : { files: [] }
  const extended = projectTsconfig === undefined ? {} : { extends: projectTsconfig }
  return `${JSON.stringify({ ...extended, compilerOptions, ...files, include: ['../retest.config.ts', '**/*'] }, null, 2)}\n`
}

export const workflowFile = '.github/workflows/retest.yml'

export const workflowSource: string = [
  'name: Retest',
  'on: [pull_request]',
  'jobs:',
  '  e2e:',
  '    runs-on: ubuntu-latest',
  '    steps:',
  '      - uses: actions/checkout@v4',
  '      - uses: actions/setup-node@v4',
  '        with: { node-version: 24 }',
  '      - run: npm ci',
  '      - run: npm run typecheck:e2e',
  '      - run: npm run test:e2e',
  '      - uses: actions/upload-artifact@v4',
  '        if: always()',
  '        with: { name: retest-runs, path: .retest/runs }',
  '',
].join('\n')

// Single quotes, as the rest of the file is written; JSON escaping covers every other character.
function jsString(text: string): string {
  const escaped = JSON.stringify(text).slice(1, -1).replaceAll('\\"', '"').replaceAll("'", "\\'")
  return `'${escaped}'`
}
