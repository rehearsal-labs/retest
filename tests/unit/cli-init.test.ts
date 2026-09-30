import type { CliDependencies } from '../../src/cli/command.ts'
import type { Prompt } from '../../src/cli/prompt.ts'
import type { Environment } from '../../src/cli/terminal.ts'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { answering, fakeCli } from './cli-fixtures.ts'
import { plain, temporaryFolder } from './reporters-fixtures.ts'

const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

// Chrome is installed; Edge and a Chromium from RETEST_CHROMIUM are not.
const chromeOnly: CliDependencies['resolveExecutable'] = (target) =>
  target.browser === 'chrome'
    ? { ok: true, path: chromePath }
    : { ok: false, failure: { class: 'setup_failed', message: `${target.browser} is not installed.` }, tried: [] }

type InitOptions = { prompt?: Prompt; isTTY?: boolean; env?: Environment; resolveExecutable?: CliDependencies['resolveExecutable'] }

async function init(project: string, args: string[], options: InitOptions = {}) {
  const fake = fakeCli({ cwd: project, resolveExecutable: chromeOnly, ...options })
  const code = await fake.cli(['init', ...args])
  return { code, stdout: fake.stdout.text, stderr: fake.stderr.text }
}

function read(project: string, path: string): string {
  return readFileSync(join(project, path), 'utf8')
}

function snapshot(project: string): Record<string, string> {
  const files: Record<string, string> = {}
  const walk = (folder: string): void => {
    for (const entry of readdirSync(join(project, folder), { withFileTypes: true })) {
      const path = folder === '' ? entry.name : `${folder}/${entry.name}`
      if (entry.isDirectory()) walk(path)
      else files[path] = read(project, path)
    }
  }
  walk('')
  return files
}

describe('init in a new project', () => {
  test('writes the config, an example test, a tsconfig, package.json and .gitignore, and says what comes next', async () => {
    const project = temporaryFolder()
    const { code, stdout, stderr } = await init(project, ['--yes'])
    assert.equal(code, 0, stderr)
    assert.equal(
      stdout,
      [
        '',
        '  Retest 0.0.0',
        '',
        '  created  retest.config.ts',
        '  created  tests/example.retest.ts',
        '  created  tsconfig.retest.json',
        '  created  package.json   scripts: "test:e2e", "typecheck:e2e"',
        '  created  .gitignore     .retest/',
        '',
        '  Next',
        '    npm i -D @rehearsal-labs/retest typescript @types/node',
        '    npx retest doctor        check the browser and the app',
        '    npx retest run           run tests/example.retest.ts',
        '',
      ].join('\n'),
    )
    assert.deepEqual(Object.keys(snapshot(project)).sort(), [
      '.gitignore',
      'package.json',
      'retest.config.ts',
      'tests/example.retest.ts',
      'tsconfig.retest.json',
    ])
  })

  test('the config registers its types, and the example uses the one app', async () => {
    const project = temporaryFolder()
    await init(project, ['--yes'])
    assert.equal(
      read(project, 'retest.config.ts'),
      [
        "import { chrome, defineConfig } from '@rehearsal-labs/retest'",
        '',
        'const config = defineConfig({',
        '  apps: {',
        '    web: chrome({',
        "      baseUrl: 'http://localhost:3000',",
        '    }),',
        '  },',
        '})',
        '',
        'export default config',
        '',
        '// Lets every test file see your app names, secrets, test ids and tags.',
        "declare module '@rehearsal-labs/retest' {",
        '  interface Register {',
        '    config: typeof config',
        '  }',
        '}',
        '',
      ].join('\n'),
    )
    assert.equal(
      read(project, 'tests/example.retest.ts'),
      [
        "import { expect, test } from '@rehearsal-labs/retest'",
        '',
        "test('shows the home page', async ({ page }) => {",
        "  await page.goto('/')",
        "  await expect(page.getByRole('main')).toBeVisible()",
        '})',
        '',
      ].join('\n'),
    )
  })

  test('the tsconfig sets the flags that reject what Node cannot run', async () => {
    const project = temporaryFolder()
    await init(project, ['--yes'])
    assert.deepEqual(JSON.parse(read(project, 'tsconfig.retest.json')), {
      compilerOptions: {
        target: 'es2024',
        module: 'nodenext',
        types: ['node'],
        strict: true,
        noEmit: true,
        erasableSyntaxOnly: true,
        verbatimModuleSyntax: true,
        rewriteRelativeImportExtensions: true,
        noUncheckedIndexedAccess: true,
        skipLibCheck: true,
      },
      include: ['retest.config.ts', '**/*.retest.ts'],
    })
    assert.deepEqual(JSON.parse(read(project, 'package.json')), {
      private: true,
      type: 'module',
      scripts: { 'test:e2e': 'retest run', 'typecheck:e2e': 'tsc --noEmit -p tsconfig.retest.json' },
    })
    assert.equal(read(project, '.gitignore'), '.retest/\n')
  })

  test('running it again changes nothing and says so', async () => {
    const project = temporaryFolder()
    await init(project, ['--yes', '--ci', 'github'])
    const before = snapshot(project)
    const { code, stdout } = await init(project, ['--yes', '--ci', 'github'])
    assert.equal(code, 0)
    assert.deepEqual(snapshot(project), before)
    assert.equal(
      stdout.slice(0, stdout.indexOf('\n\n  Next')),
      [
        '',
        '  Retest 0.0.0',
        '',
        '  left as is  retest.config.ts',
        '  left as is  tests/example.retest.ts',
        '  left as is  tsconfig.retest.json',
        '  left as is  .github/workflows/retest.yml',
        '  left as is  package.json   scripts: "test:e2e", "typecheck:e2e"',
        '  left as is  .gitignore     .retest/',
      ].join('\n'),
    )
    assert.match(stdout, /npx retest run {11}run the tests\n$/)
  })
})

describe('init --ci github', () => {
  test('writes a workflow that type-checks and runs the tests, and keeps the runs', async () => {
    const project = temporaryFolder()
    const { stdout } = await init(project, ['--yes', '--ci', 'github'])
    assert.match(stdout, /\n {2}created {2}\.github\/workflows\/retest\.yml\n/)
    assert.equal(
      read(project, '.github/workflows/retest.yml'),
      [
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
      ].join('\n'),
    )
  })

  test('says the workflow uses npm when the project uses another package manager', async () => {
    const project = temporaryFolder()
    writeFileSync(join(project, 'pnpm-lock.yaml'), '')
    const { stdout } = await init(project, ['--yes', '--ci', 'github'])
    assert.match(stdout, /created {2}\.github\/workflows\/retest\.yml {3}uses npm; change its install step for pnpm\n/)
    assert.match(stdout, /pnpm add -D @rehearsal-labs\/retest typescript @types\/node/)
    assert.match(stdout, /pnpm exec retest doctor/)
  })

  test('rejects any other CI', async () => {
    const project = temporaryFolder()
    const { code, stderr } = await init(project, ['--ci', 'gitlab'])
    assert.equal(code, 2)
    assert.match(stderr, /--ci must be github, received "gitlab"\./)
    assert.deepEqual(snapshot(project), {})
  })
})

describe('init without questions', () => {
  test('flags answer every question', async () => {
    const project = temporaryFolder()
    const { code, stdout } = await init(project, ['--app', 'admin=http://localhost:4000', '--start', 'npm run dev', '--browser', 'chromium'])
    assert.equal(code, 0)
    const config = read(project, 'retest.config.ts')
    assert.match(config, /^import \{ chromium, defineConfig \} from '@rehearsal-labs\/retest'\n/)
    assert.match(config, /\n {4}\/\/ chromium\(\) runs the browser RETEST_CHROMIUM points to, unless you add executablePath\.\n {4}admin: chromium\(\{\n/)
    assert.match(config, /\n {6}baseUrl: 'http:\/\/localhost:4000',\n {6}start: \{ command: 'npm run dev', ready: 'http:\/\/localhost:4000' \},\n/)
    assert.match(stdout, /\n\n {2}Set RETEST_CHROMIUM to the browser's path, here and in CI: chromium\(\) runs the browser it points to\.\n\n {2}Next\n/)
  })

  test('an address alone names the app web; quotes in a command are escaped', async () => {
    const project = temporaryFolder()
    await init(project, ['--app', 'https://staging.example.com', '--start', `node -e "console.log('up')"`, '--browser', 'edge'])
    const config = read(project, 'retest.config.ts')
    assert.match(config, /\n {4}web: edge\(\{\n {6}baseUrl: 'https:\/\/staging\.example\.com',\n/)
    assert.ok(config.includes(`command: 'node -e "console.log(\\'up\\')"'`), config)
  })

  test('a coding agent is never asked anything, and needs --app or --yes', async () => {
    const project = temporaryFolder()
    const prompt = answering([])
    const { code, stdout, stderr } = await init(project, [], { prompt, isTTY: true, env: { CLAUDECODE: '1' } })
    assert.equal(code, 2)
    assert.deepEqual(prompt.questions, [])
    assert.match(stderr, /init asks questions only at a terminal\. Pass --app web=http:\/\/localhost:3000, with --start and --browser if you need them, or --yes to take the defaults\./)
    assert.equal(plain(stdout), '\n  Retest 0.0.0\n\n')
    assert.deepEqual(snapshot(project), {})
  })

  test('outside a terminal, without --yes, a question with no flag is left unanswered rather than guessed', async () => {
    const project = temporaryFolder()
    writeFileSync(join(project, 'package.json'), '{\n  "type": "module",\n  "scripts": { "dev": "vite" }\n}\n')
    await init(project, ['--app', 'http://localhost:5173'])
    assert.doesNotMatch(read(project, 'retest.config.ts'), /start:/)
    const defaults = temporaryFolder()
    writeFileSync(join(defaults, 'package.json'), '{\n  "type": "module",\n  "scripts": { "dev": "vite" }\n}\n')
    await init(defaults, ['--yes'])
    assert.match(read(defaults, 'retest.config.ts'), /start: \{ command: 'npm run dev', ready: 'http:\/\/localhost:3000' \}/)
  })

  test('takes the first browser installed where Retest looks, and Chrome when none is', async () => {
    const edgeOnly: CliDependencies['resolveExecutable'] = (target) =>
      target.browser === 'edge' ? { ok: true, path: '/Applications/Microsoft Edge.app' } : { ok: false, failure: { class: 'setup_failed', message: 'no' }, tried: [] }
    const withEdge = temporaryFolder()
    await init(withEdge, ['--yes'], { resolveExecutable: edgeOnly })
    assert.match(read(withEdge, 'retest.config.ts'), /web: edge\(\{/)
    const none = temporaryFolder()
    await init(none, ['--yes'], { resolveExecutable: () => ({ ok: false, failure: { class: 'setup_failed', message: 'no' }, tried: [] }) })
    assert.match(read(none, 'retest.config.ts'), /web: chrome\(\{/)
  })

  test('rejects an --app that is not an http or https address', async () => {
    const project = temporaryFolder()
    const { code, stderr } = await init(project, ['--app', 'web=localhost:3000'])
    assert.equal(code, 2)
    assert.match(stderr, /--app takes name=url with a full http or https address, such as web=http:\/\/localhost:3000, received "web=localhost:3000"\./)
    assert.deepEqual(snapshot(project), {})
  })
})

describe('init at a terminal', () => {
  test('asks each question without a flag, explains an answer that does not fit, and asks again', async () => {
    const project = temporaryFolder()
    const prompt = answering(['', 'npm run dev', 'edgy', 'edge'])
    const { code, stdout } = await init(project, [], { prompt, isTTY: true })
    assert.equal(code, 0)
    assert.deepEqual(prompt.questions, [
      '  What should the tests open? (http://localhost:3000) › ',
      '  How do you start the app? (none) › ',
      `  Which browser: chromium, chrome or edge? (chrome, found at ${chromePath}) › `,
      `  Answer chromium, chrome or edge. Did you mean edge?\n  Which browser: chromium, chrome or edge? (chrome, found at ${chromePath}) › `,
    ])
    assert.match(read(project, 'retest.config.ts'), /web: edge\(\{\n {6}baseUrl: 'http:\/\/localhost:3000',\n {6}start: \{ command: 'npm run dev'/)
    assert.match(plain(stdout), /^\n {2}Retest 0\.0\.0\n\n\n {2}created {2}retest\.config\.ts\n/)
  })

  test('offers the dev script, takes it on enter, and "none" leaves the server to you', async () => {
    const project = temporaryFolder()
    writeFileSync(join(project, 'package.json'), '{ "type": "module", "scripts": { "dev": "vite" } }')
    const prompt = answering(['bad address', 'http://localhost:5173', 'none', ''])
    await init(project, ['--browser', 'chrome'], { prompt, isTTY: true })
    assert.deepEqual(prompt.questions.slice(0, 3), [
      '  What should the tests open? (http://localhost:3000) › ',
      '  Write a full http or https address, such as http://localhost:3000.\n  What should the tests open? (http://localhost:3000) › ',
      '  How do you start the app? (npm run dev, or none) › ',
    ])
    assert.equal(prompt.questions.length, 3, 'the browser has a flag')
    assert.doesNotMatch(read(project, 'retest.config.ts'), /start:/)
  })

  test('input that ends before an answer writes nothing', async () => {
    const project = temporaryFolder()
    const { code, stderr } = await init(project, [], { prompt: answering(['http://localhost:3000']), isTTY: true })
    assert.equal(code, 2)
    assert.equal(stderr, 'A question had no answer, so nothing was written.\n')
    assert.deepEqual(snapshot(project), {})
  })

  test('an interrupt while it asks writes nothing and exits 130', async () => {
    const project = temporaryFolder()
    const controller = new AbortController()
    const prompt: Prompt = {
      isTTY: true,
      ask: async () => {
        controller.abort('SIGINT')
        return undefined
      },
    }
    const fake = fakeCli({ cwd: project, resolveExecutable: chromeOnly, prompt, isTTY: true, signal: controller.signal })
    assert.equal(await fake.cli(['init']), 130)
    assert.equal(fake.stderr.text, 'Stopped. Nothing was written.\n')
    assert.deepEqual(snapshot(project), {})
  })

  test('--yes asks nothing, even at a terminal', async () => {
    const project = temporaryFolder()
    const prompt = answering([])
    assert.equal((await init(project, ['--yes'], { prompt, isTTY: true })).code, 0)
    assert.deepEqual(prompt.questions, [])
  })
})

describe('init beside existing files', () => {
  test('adds only the missing script, keeps the indent, and asks for "type": "module"', async () => {
    const project = temporaryFolder()
    const original = '{\n    "name": "shop",\n    "scripts": {\n        "test:e2e": "playwright test"\n    },\n    "devDependencies": {\n        "typescript": "6.0.3"\n    }\n}\n'
    writeFileSync(join(project, 'package.json'), original)
    const { stdout } = await init(project, ['--yes'])
    assert.equal(
      read(project, 'package.json'),
      '{\n    "name": "shop",\n    "scripts": {\n        "test:e2e": "playwright test",\n        "typecheck:e2e": "tsc --noEmit -p tsconfig.retest.json"\n    },\n    "devDependencies": {\n        "typescript": "6.0.3"\n    }\n}\n',
    )
    assert.match(stdout, /\n {2}updated {5}package\.json {3}scripts: "typecheck:e2e"\n {2}left as is {2}package\.json {3}scripts: "test:e2e"\n/)
    assert.match(stdout, /\n {4}npm i -D @rehearsal-labs\/retest @types\/node\n/)
    assert.match(stdout, /\n\n {2}Add "type": "module" to package\.json, so the type check reads the tests as ES modules\.\n\n {2}Next\n/)
  })

  test('appends .retest/ to a .gitignore without a final newline, and leaves one that has it', async () => {
    const project = temporaryFolder()
    writeFileSync(join(project, '.gitignore'), 'node_modules')
    await init(project, ['--yes'])
    assert.equal(read(project, '.gitignore'), 'node_modules\n.retest/\n')
    const ignored = temporaryFolder()
    writeFileSync(join(ignored, '.gitignore'), '/.retest\n')
    const { stdout } = await init(ignored, ['--yes'])
    assert.equal(read(ignored, '.gitignore'), '/.retest\n')
    assert.match(stdout, /left as is {2}\.gitignore {5}\.retest\/\n/)
  })

  test('a package.json that is not a JSON object stops it before anything is written', async () => {
    for (const text of ['{ "name": ', '[]', '{ "scripts": [] }']) {
      const project = temporaryFolder()
      writeFileSync(join(project, 'package.json'), text)
      const { code, stderr } = await init(project, ['--yes'])
      assert.equal(code, 2)
      assert.match(stderr, /init changed nothing/)
      assert.deepEqual(Object.keys(snapshot(project)), ['package.json'])
    }
  })

  test('an existing config is left as is, and the flags meant for it are said to be unused', async () => {
    const project = temporaryFolder()
    writeFileSync(join(project, 'retest.config.ts'), '// mine\n')
    const prompt = answering([])
    const { code, stdout } = await init(project, ['--app', 'http://localhost:4000', '--browser', 'edge'], { prompt, isTTY: true })
    assert.equal(code, 0)
    assert.deepEqual(prompt.questions, [])
    assert.equal(read(project, 'retest.config.ts'), '// mine\n')
    assert.match(plain(stdout), /\n\n {2}retest\.config\.ts is left as is, so --app and --browser were not used\.\n/)
    assert.match(plain(stdout), /\n {2}left as is {2}retest\.config\.ts\n/)
  })

  test('an example test that is already there is left as is', async () => {
    const project = temporaryFolder()
    mkdirSync(join(project, 'tests'))
    writeFileSync(join(project, 'tests/example.retest.ts'), '// mine\n')
    await init(project, ['--yes'])
    assert.equal(read(project, 'tests/example.retest.ts'), '// mine\n')
    assert.ok(existsSync(join(project, 'retest.config.ts')))
  })

  test('uses the package manager package.json names', async () => {
    const project = temporaryFolder()
    writeFileSync(join(project, 'package.json'), '{ "type": "module", "packageManager": "yarn@4.9.0", "scripts": { "start": "node server.js" } }')
    const { stdout } = await init(project, ['--yes'])
    assert.match(stdout, /yarn add -D @rehearsal-labs\/retest typescript @types\/node/)
    assert.match(stdout, /\n {4}yarn retest doctor /)
    assert.match(read(project, 'retest.config.ts'), /start: \{ command: 'yarn start'/)
  })
})
