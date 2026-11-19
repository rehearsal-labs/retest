import type { CliDependencies } from '../../src/cli/command.ts'
import type { InstallEnd, InstallRequest } from '../../src/cli/init/package-install.ts'
import type { InstallCommand } from '../../src/cli/init/package-manager.ts'
import type { PackageJson } from '../../src/cli/init/project-files.ts'
import type { Prompt } from '../../src/cli/prompt.ts'
import type { Environment } from '../../src/cli/terminal.ts'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { runInstall } from '../../src/cli/init/package-install.ts'
import { detectPackageManager, installCommand } from '../../src/cli/init/package-manager.ts'
import { missingPackages } from '../../src/cli/init/project-files.ts'
import { projectPackages } from '../../src/cli/init/templates.ts'
import { isPlainObject } from '../../src/protocol/schema.ts'
import { unixOnly } from '../support/platform-skip.ts'
import { answering, fakeCli } from './cli-fixtures.ts'
import { plain, temporaryFolder } from './reporters-fixtures.ts'

const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

// Chrome is installed; Edge and Chrome's headless shell, which a headless chromium() runs, are not.
const chromeOnly: CliDependencies['resolveExecutable'] = (target) =>
  target.browser === 'chrome'
    ? { ok: true, path: chromePath }
    : { ok: false, failure: { class: 'setup_failed', message: `${target.browser} is not installed.` }, tried: [] }

type InitOptions = {
  prompt?: Prompt
  isTTY?: boolean
  env?: Environment
  resolveExecutable?: CliDependencies['resolveExecutable']
  signal?: AbortSignal
  version?: string
  /** How the install ends, or what it does as it runs; it exits 0 unless given. */
  install?: (request: InstallRequest) => InstallEnd
}

/** Runs init with a fake install, which records each install it is asked for: the command's words and the folder. */
async function init(project: string, args: string[], options: InitOptions = {}) {
  const { install = () => ({ kind: 'exited', code: 0 }), ...rest } = options
  const installs: { command: string; cwd: string }[] = []
  const runInstall: CliDependencies['runInstall'] = async (request) => {
    installs.push({ command: request.command.text, cwd: request.cwd })
    return install(request)
  }
  const fake = fakeCli({ cwd: project, resolveExecutable: chromeOnly, runInstall, ...rest })
  const code = await fake.cli(['init', ...args])
  return { code, stdout: fake.stdout.text, stderr: fake.stderr.text, installs }
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
  test('writes the config, an example test, a tsconfig, package.json and .gitignore, installs the packages, and says what comes next', async () => {
    const project = temporaryFolder()
    const { code, stdout, stderr, installs } = await init(project, ['--yes'])
    assert.equal(code, 0, stderr)
    assert.equal(
      stdout,
      [
        '',
        '  Retest 0.0.0',
        '',
        '  created  retest.config.ts',
        '  created  tests/example.retest.ts',
        '  created  tests/tsconfig.json',
        '  created  package.json   scripts: "test:e2e", "typecheck:e2e"',
        '  created  package.json   devDependencies: retest@latest, typescript@^7.0.2, @types/node@^24.12.0',
        '  created  .gitignore     .retest/',
        '',
        '  Running npm install',
        '',
        '  The packages are installed.',
        '',
        '  Next',
        '    npx retest doctor        check the browser and the app',
        '    npx retest run           run tests/example.retest.ts',
        '',
      ].join('\n'),
    )
    assert.deepEqual(installs, [{ command: 'npm install', cwd: project }])
    assert.deepEqual(Object.keys(snapshot(project)).sort(), [
      '.gitignore',
      'package.json',
      'retest.config.ts',
      'tests/example.retest.ts',
      'tests/tsconfig.json',
    ])
  })

  test('the config registers its types, and the example uses the one app', async () => {
    const project = temporaryFolder()
    await init(project, ['--yes'])
    assert.equal(
      read(project, 'retest.config.ts'),
      [
        "import { chrome, defineConfig } from 'retest'",
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
        "declare module 'retest' {",
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
        "import { expect, test } from 'retest'",
        '',
        "test('shows the home page', async ({ page }) => {",
        "  await page.goto('/')",
        "  await expect(page.getByRole('main')).toBeVisible()",
        '})',
        '',
      ].join('\n'),
    )
  })

  test("the tests' tsconfig accepts what Retest loads and refuses what it does not, and the type check uses it", async () => {
    const project = temporaryFolder()
    await init(project, ['--yes'])
    assert.deepEqual(JSON.parse(read(project, 'tests/tsconfig.json')), {
      compilerOptions: {
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
      },
      include: ['../retest.config.ts', '**/*'],
    })
    assert.equal(
      read(project, 'package.json'),
      `${JSON.stringify(
        {
          private: true,
          type: 'module',
          scripts: { 'test:e2e': 'retest run', 'typecheck:e2e': 'tsc -p tests/tsconfig.json' },
          devDependencies: { '@types/node': '^24.12.0', retest: 'latest', typescript: '^7.0.2' },
        },
        null,
        2,
      )}\n`,
    )
    assert.equal(read(project, '.gitignore'), '.retest/\n')
  })

  test("the tests' tsconfig extends the project's own, and sets back what would let tsc pass JSX", async () => {
    const project = temporaryFolder()
    writeFileSync(join(project, 'tsconfig.json'), '{ "compilerOptions": { "jsx": "react-jsx", "paths": { "@app/*": ["./src/*"] } } }\n')
    await init(project, ['--yes'])
    const written: unknown = JSON.parse(read(project, 'tests/tsconfig.json'))
    assert.ok(typeof written === 'object' && written !== null && 'compilerOptions' in written)
    assert.deepEqual({ ...written, compilerOptions: undefined }, { extends: '../tsconfig.json', compilerOptions: undefined, files: [], include: ['../retest.config.ts', '**/*'] })
    const options = written.compilerOptions
    assert.ok(typeof options === 'object' && options !== null)
    assert.deepEqual(Object.entries(options).filter(([name]) => ['jsx', 'rootDir', 'composite', 'erasableSyntaxOnly', 'moduleResolution'].includes(name)), [
      ['moduleResolution', 'bundler'],
      ['erasableSyntaxOnly', false],
      ['jsx', null],
      ['rootDir', null],
      ['composite', false],
    ])
  })

  test('running it again changes nothing and says so', async () => {
    const project = temporaryFolder()
    await init(project, ['--yes', '--ci', 'github'])
    const before = snapshot(project)
    const { code, stdout, installs } = await init(project, ['--yes', '--ci', 'github'])
    assert.equal(code, 0)
    assert.deepEqual(snapshot(project), before)
    assert.deepEqual(installs, [], 'package.json lists every package, so nothing is installed')
    assert.equal(
      stdout.slice(0, stdout.indexOf('\n\n  Next')),
      [
        '',
        '  Retest 0.0.0',
        '',
        '  left as is  retest.config.ts',
        '  left as is  tests/example.retest.ts',
        '  left as is  tests/tsconfig.json',
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
    const { stdout, installs } = await init(project, ['--yes', '--ci', 'github'])
    assert.match(stdout, /created {2}\.github\/workflows\/retest\.yml {3}uses npm; change its install step for pnpm\n/)
    assert.deepEqual(installs, [{ command: 'pnpm install', cwd: project }])
    assert.match(stdout, /\n {2}Running pnpm install\n/)
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
    assert.match(config, /^import \{ chromium, defineConfig \} from 'retest'\n/)
    assert.match(config, /\n {4}\/\/ chromium\(\) runs what retest install chromium installs, unless you add executablePath\.\n {4}admin: chromium\(\{\n/)
    assert.match(config, /\n {6}baseUrl: 'http:\/\/localhost:4000',\n {6}start: \{ command: 'npm run dev', ready: 'http:\/\/localhost:4000' \},\n/)
    assert.match(stdout, /\n\n {2}Run npx retest install chromium here and in CI: chromium\(\) runs what it installs\.\n\n {2}Next\n/)
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
    assert.match(stderr, /init asks questions only at a terminal\. Pass --app web=http:\/\/localhost:3000, with --start, --browser and --install if you need them, or --yes to take the defaults\./)
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
    const prompt = answering(['', 'npm run dev', 'edgy', 'edge', ''])
    const { code, stdout, installs } = await init(project, [], { prompt, isTTY: true })
    assert.equal(code, 0)
    assert.deepEqual(prompt.questions, [
      '  What should the tests open? (http://localhost:3000) › ',
      '  How do you start the app? (none) › ',
      `  Which browser: chromium, chrome or edge? (chrome, found at ${chromePath}) › `,
      `  Answer chromium, chrome or edge. Did you mean edge?\n  Which browser: chromium, chrome or edge? (chrome, found at ${chromePath}) › `,
      '  Install retest, typescript and @types/node with npm install? (yes) › ',
    ])
    assert.deepEqual(installs, [{ command: 'npm install', cwd: project }], 'enter takes yes')
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
    assert.deepEqual(prompt.questions.slice(3), ['  Install retest, typescript and @types/node with npm install? (yes) › '], 'the browser has a flag')
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
    const { stdout, installs } = await init(project, ['--yes'])
    assert.equal(
      read(project, 'package.json'),
      '{\n    "name": "shop",\n    "scripts": {\n        "test:e2e": "playwright test",\n        "typecheck:e2e": "tsc -p tests/tsconfig.json"\n    },\n    "devDependencies": {\n        "@types/node": "^24.12.0",\n        "retest": "latest",\n        "typescript": "6.0.3"\n    }\n}\n',
    )
    assert.match(stdout, /\n {2}updated {5}package\.json {3}scripts: "typecheck:e2e"\n {2}left as is {2}package\.json {3}scripts: "test:e2e"\n/)
    assert.match(stdout, /\n {2}updated {5}package\.json {3}devDependencies: retest@latest, @types\/node@\^24\.12\.0\n/)
    assert.deepEqual(installs, [{ command: 'npm install', cwd: project }])
    assert.match(stdout, /\n\n {2}Add "type": "module" to package\.json, so Node reads the tests as ES modules without guessing\.\n\n {2}Next\n/)
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
    for (const text of ['{ "name": ', '[]', '{ "scripts": [] }', '{ "devDependencies": [] }', '{ "dependencies": "typescript" }']) {
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
    const { code, stdout } = await init(project, ['--app', 'http://localhost:4000', '--browser', 'edge', '--no-install'], { prompt, isTTY: true })
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
    const { stdout, installs } = await init(project, ['--yes'])
    assert.deepEqual(installs, [{ command: 'yarn install', cwd: project }])
    assert.match(stdout, /\n {4}yarn retest doctor /)
    assert.match(read(project, 'retest.config.ts'), /start: \{ command: 'yarn start'/)
  })
})

/** package.json's fields in the order they are written, and its dev dependencies in theirs. */
function packageOrder(project: string): { fields: string[]; devDependencies: [string, unknown][] } {
  const data: unknown = JSON.parse(read(project, 'package.json'))
  assert.ok(isPlainObject(data) && isPlainObject(data['devDependencies']), read(project, 'package.json'))
  return { fields: Object.keys(data), devDependencies: Object.entries(data['devDependencies']) }
}

const allPackages = '{ "type": "module", "devDependencies": { "retest": "0.5.1", "typescript": "6.0.3", "@types/node": "24.19.0" } }'
const installQuestion = '  Install retest, typescript and @types/node with npm install? (yes) › '
const nextWithInstall = /\n {2}Next\n {4}npm install {14}install the packages in package\.json\n {4}npx retest doctor /

describe('the packages init adds', () => {
  test('Retest at the caret of the version that runs, or latest from a checkout, TypeScript 7 and the types of Node 24', () => {
    assert.deepEqual(projectPackages('0.6.0'), { retest: '^0.6.0', typescript: '^7.0.2', '@types/node': '^24.12.0' })
    assert.deepEqual(projectPackages('0.0.0'), { retest: 'latest', typescript: '^7.0.2', '@types/node': '^24.12.0' })
    assert.deepEqual(Object.keys(projectPackages('1.2.3')), ['retest', 'typescript', '@types/node'], 'the order a person reads them in')
  })

  test('a package either dependency list names, at any version, is left alone; one only a peer names is added', () => {
    const wanted = projectPackages('0.6.0')
    const found = (data: Record<string, unknown>): PackageJson => ({ data, indent: '  ', finalNewline: true })
    assert.deepEqual(missingPackages(undefined, wanted), wanted)
    assert.deepEqual(missingPackages(found({ dependencies: { retest: 'file:../retest.tgz' }, devDependencies: { typescript: '4.9.5' } }), wanted), { '@types/node': '^24.12.0' })
    assert.deepEqual(missingPackages(found({ devDependencies: { '@types/node': '*', typescript: 'workspace:*', retest: '0.1.0' } }), wanted), {})
    assert.deepEqual(missingPackages(found({ peerDependencies: { typescript: '>=5' } }), wanted), wanted)
  })

  test('init at 0.6.0 adds ^0.6.0, keeps an alphabetical list in order, adds to the end of one that is not, and changes no version there', async () => {
    const sorted = temporaryFolder()
    writeFileSync(join(sorted, 'package.json'), '{\n  "type": "module",\n  "devDependencies": {\n    "eslint": "9.0.0",\n    "vite": "7.0.0"\n  }\n}\n')
    const { stdout } = await init(sorted, ['--yes'], { version: '0.6.0' })
    assert.deepEqual(packageOrder(sorted), {
      fields: ['type', 'devDependencies', 'scripts'],
      devDependencies: [['@types/node', '^24.12.0'], ['eslint', '9.0.0'], ['retest', '^0.6.0'], ['typescript', '^7.0.2'], ['vite', '7.0.0']],
    })
    assert.match(stdout, /\n {2}updated {2}package\.json {3}devDependencies: retest@\^0\.6\.0, typescript@\^7\.0\.2, @types\/node@\^24\.12\.0\n/)
    const unsorted = temporaryFolder()
    writeFileSync(join(unsorted, 'package.json'), '{ "name": "shop", "devDependencies": { "vite": "7.0.0", "eslint": "9.0.0" }, "type": "module", "dependencies": { "typescript": "5.9.3" } }')
    await init(unsorted, ['--yes'], { version: '0.6.0' })
    assert.deepEqual(packageOrder(unsorted), {
      fields: ['name', 'devDependencies', 'type', 'dependencies', 'scripts'],
      devDependencies: [['vite', '7.0.0'], ['eslint', '9.0.0'], ['retest', '^0.6.0'], ['@types/node', '^24.12.0']],
    })
    assert.match(read(unsorted, 'package.json'), /"dependencies": \{\n {4}"typescript": "5\.9\.3"\n {2}\}/)
  })
})

describe('which package manager init uses', () => {
  test('the packageManager field first, then the lock file, then the one that started init, then npm', () => {
    const folder = temporaryFolder()
    const pnpmAgent = 'pnpm/10.4.0 npm/? node/v24.12.0 linux x64'
    assert.equal(detectPackageManager({ folder, declared: undefined, userAgent: undefined }).name, 'npm')
    assert.equal(detectPackageManager({ folder, declared: undefined, userAgent: pnpmAgent }).name, 'pnpm')
    writeFileSync(join(folder, 'yarn.lock'), '')
    assert.equal(detectPackageManager({ folder, declared: undefined, userAgent: pnpmAgent }).name, 'yarn')
    assert.equal(detectPackageManager({ folder, declared: 'bun@1.2.0', userAgent: pnpmAgent }).name, 'bun')
  })

  test('the user agent names npm, pnpm, yarn and bun as each sets it, and anything else is npm', () => {
    const folder = temporaryFolder()
    const agents: [string, string][] = [
      ['npm/11.6.2 node/v24.12.0 darwin arm64 workspaces/false', 'npm'],
      ['pnpm/10.4.0 npm/? node/v24.12.0 linux x64', 'pnpm'],
      ['yarn/4.9.0 npm/? node/v24.12.0 win32 x64', 'yarn'],
      ['bun/1.2.0 npm/? node/v24.12.0 darwin arm64', 'bun'],
      ['deno/2.1.0', 'npm'],
      ['', 'npm'],
    ]
    for (const [userAgent, name] of agents) assert.equal(detectPackageManager({ folder, declared: undefined, userAgent }).name, name, userAgent)
  })

  test('init installs with the package manager that started it when nothing in the project names one', async () => {
    const project = temporaryFolder()
    const { stdout, installs } = await init(project, ['--yes'], { env: { npm_config_user_agent: 'bun/1.2.0 npm/? node/v24.12.0 linux x64' } })
    assert.deepEqual(installs, [{ command: 'bun install', cwd: project }])
    assert.match(stdout, /\n {4}bunx retest doctor /)
  })

  test('each manager starts from PATH with install, and through the shell on Windows', () => {
    const platforms: NodeJS.Platform[] = ['linux', 'darwin']
    for (const name of ['npm', 'pnpm', 'yarn', 'bun']) {
      const manager = detectPackageManager({ folder: temporaryFolder(), declared: name, userAgent: undefined })
      for (const platform of platforms) assert.deepEqual(installCommand(manager, platform), { text: `${name} install`, file: name, args: ['install'], shell: false })
      assert.deepEqual(installCommand(manager, 'win32'), { text: `${name} install`, file: `${name} install`, args: [], shell: true })
    }
  })
})

describe('the install question', () => {
  test('--install installs without a question, and without --yes', async () => {
    const quiet = temporaryFolder()
    assert.deepEqual((await init(quiet, ['--app', 'http://localhost:3000', '--install'])).installs, [{ command: 'npm install', cwd: quiet }])
    const terminal = temporaryFolder()
    const prompt = answering([])
    const { installs } = await init(terminal, ['--app', 'http://localhost:3000', '--start', 'none', '--browser', 'chrome', '--install'], { prompt, isTTY: true })
    assert.deepEqual(prompt.questions, [])
    assert.deepEqual(installs, [{ command: 'npm install', cwd: terminal }])
  })

  test('--no-install installs nothing, even with --yes, still adds the packages, and the next steps start with the install', async () => {
    const project = temporaryFolder()
    const { code, stdout, installs } = await init(project, ['--yes', '--no-install'])
    assert.equal(code, 0)
    assert.deepEqual(installs, [])
    assert.match(stdout, nextWithInstall)
    assert.doesNotMatch(stdout, /Running|are installed/)
    assert.equal(packageOrder(project).devDependencies.length, 3)
  })

  test('--install and --no-install together are refused, and nothing is written', async () => {
    const project = temporaryFolder()
    const { code, stderr, installs } = await init(project, ['--yes', '--install', '--no-install'])
    assert.equal(code, 2)
    assert.match(stderr, /--install and --no-install answer the same question\. Give one of them\./)
    assert.deepEqual(installs, [])
    assert.deepEqual(snapshot(project), {})
  })

  test('outside a terminal, without --yes or a flag, nothing is installed, as no question takes its default there', async () => {
    const project = temporaryFolder()
    const { code, stdout, installs } = await init(project, ['--app', 'http://localhost:3000'])
    assert.equal(code, 0)
    assert.deepEqual(installs, [])
    assert.match(stdout, nextWithInstall)
  })

  test('a coding agent is not asked, and its init installs with --yes or --install only', async () => {
    const prompt = answering([])
    const env = { CLAUDECODE: '1' }
    const asked = temporaryFolder()
    assert.deepEqual((await init(asked, ['--app', 'http://localhost:3000'], { prompt, isTTY: true, env })).installs, [])
    const yes = temporaryFolder()
    assert.deepEqual((await init(yes, ['--yes'], { prompt, isTTY: true, env })).installs, [{ command: 'npm install', cwd: yes }])
    assert.deepEqual(prompt.questions, [])
  })

  test('at a terminal, no declines it, and an answer that does not fit is asked again', async () => {
    const project = temporaryFolder()
    const prompt = answering(['', 'none', '', 'maybe', 'No'])
    const { code, stdout, installs } = await init(project, [], { prompt, isTTY: true })
    assert.equal(code, 0)
    assert.deepEqual(prompt.questions.slice(3), [installQuestion, `  Answer yes or no.\n${installQuestion}`])
    assert.deepEqual(installs, [])
    assert.match(plain(stdout), nextWithInstall)
  })

  test('an install question left unanswered writes nothing', async () => {
    const project = temporaryFolder()
    const { code, stderr, installs } = await init(project, [], { prompt: answering(['', 'none', '']), isTTY: true })
    assert.equal(code, 2)
    assert.equal(stderr, 'A question had no answer, so nothing was written.\n')
    assert.deepEqual(installs, [])
    assert.deepEqual(snapshot(project), {})
  })

  test('beside a config that is there, the install is the one question; it names only the packages added', async () => {
    const project = temporaryFolder()
    writeFileSync(join(project, 'retest.config.ts'), '// mine\n')
    writeFileSync(join(project, 'package.json'), '{ "type": "module", "devDependencies": { "typescript": "6.0.3" } }')
    const prompt = answering(['yes'])
    const { code, installs } = await init(project, [], { prompt, isTTY: true })
    assert.equal(code, 0)
    assert.deepEqual(prompt.questions, ['  Install retest and @types/node with npm install? (yes) › '])
    assert.deepEqual(installs, [{ command: 'npm install', cwd: project }])
  })

  test('with every package listed, nothing is asked or installed, unless --install asks for it', async () => {
    const terminal = temporaryFolder()
    writeFileSync(join(terminal, 'package.json'), allPackages)
    const prompt = answering([])
    const asked = await init(terminal, ['--app', 'http://localhost:3000', '--start', 'none', '--browser', 'chrome'], { prompt, isTTY: true })
    assert.deepEqual([prompt.questions, asked.installs], [[], []])
    assert.doesNotMatch(asked.stdout, /npm install/)
    const yes = temporaryFolder()
    writeFileSync(join(yes, 'package.json'), allPackages)
    assert.deepEqual((await init(yes, ['--yes'])).installs, [])
    const install = temporaryFolder()
    writeFileSync(join(install, 'package.json'), allPackages)
    const forced = await init(install, ['--yes', '--install'])
    assert.deepEqual(forced.installs, [{ command: 'npm install', cwd: install }])
    assert.match(forced.stdout, /\n {2}The packages are installed\.\n/)
  })
})

describe('an install that does not finish', () => {
  test('a failed install ends with exit code 2 and the command to run by hand, and the files stay', async () => {
    const project = temporaryFolder()
    const { code, stdout, stderr } = await init(project, ['--yes'], { install: () => ({ kind: 'exited', code: 1 }) })
    assert.equal(code, 2)
    assert.equal(stderr, 'npm install failed with exit code 1. The files are written; run npm install yourself to install the packages.\n')
    assert.deepEqual(Object.keys(snapshot(project)).sort(), ['.gitignore', 'package.json', 'retest.config.ts', 'tests/example.retest.ts', 'tests/tsconfig.json'])
    assert.match(stdout, nextWithInstall)
    assert.doesNotMatch(stdout, /are installed/)
  })

  test('a package manager that cannot start, or that a signal ended, is named with what happened', async () => {
    const pnpm = temporaryFolder()
    writeFileSync(join(pnpm, 'pnpm-lock.yaml'), '')
    const missing = await init(pnpm, ['--yes'], { install: () => ({ kind: 'not started', problem: 'spawn pnpm ENOENT' }) })
    assert.equal(missing.code, 2)
    assert.equal(missing.stderr, 'pnpm install could not start: spawn pnpm ENOENT. The files are written; run pnpm install yourself to install the packages.\n')
    const killed = await init(temporaryFolder(), ['--yes'], { install: () => ({ kind: 'signalled', signal: 'SIGKILL' }) })
    assert.equal(killed.code, 2)
    assert.equal(killed.stderr, 'npm install was ended by SIGKILL. The files are written; run npm install yourself to install the packages.\n')
  })

  test('a stop during the install exits 130, or 143 for SIGTERM, keeps the files and says how to finish', async () => {
    for (const [stop, exitCode] of [['SIGINT', 130], ['SIGTERM', 143]] as const) {
      const project = temporaryFolder()
      const controller = new AbortController()
      const stopping = (): InstallEnd => {
        controller.abort(stop)
        return { kind: 'signalled', signal: stop }
      }
      const { code, stdout, stderr } = await init(project, ['--yes'], { signal: controller.signal, install: stopping })
      assert.equal(code, exitCode)
      assert.equal(stderr, 'Stopped during npm install. The files are written; run npm install to install the packages.\n')
      assert.ok(existsSync(join(project, 'retest.config.ts')))
      assert.doesNotMatch(stdout, /Next/)
    }
  })
})

describe('running an install', () => {
  // Node itself stands in for a package manager: no shell, so the same on every platform.
  const node = (script: string): InstallCommand => ({ text: 'node', file: process.execPath, args: ['-e', script], shell: false })

  test('runs the program in the folder given, and says how it exited', async () => {
    const folder = temporaryFolder()
    const end = await runInstall({ command: node("require('node:fs').writeFileSync('ran.txt', 'here'); process.exitCode = 3"), cwd: folder, signal: new AbortController().signal })
    assert.deepEqual(end, { kind: 'exited', code: 3 })
    assert.equal(read(folder, 'ran.txt'), 'here')
  })

  test('a program that cannot start is told, not thrown, and a stop that came first starts nothing', async () => {
    const folder = temporaryFolder()
    const missing = await runInstall({ command: { text: 'none', file: join(folder, 'no-such-program'), args: [], shell: false }, cwd: folder, signal: new AbortController().signal })
    assert.equal(missing.kind, 'not started')
    assert.match(missing.kind === 'not started' ? missing.problem : '', /ENOENT/)
    const controller = new AbortController()
    controller.abort('SIGINT')
    const stopped = await runInstall({ command: node("require('node:fs').writeFileSync('ran.txt', 'here')"), cwd: folder, signal: controller.signal })
    assert.deepEqual(stopped, { kind: 'not started', problem: 'it was stopped first' })
    assert.equal(existsSync(join(folder, 'ran.txt')), false)
  })

  test('a stop is passed on to the install', { skip: unixOnly('on Windows Ctrl+C and Ctrl+Break reach the install from the console itself') }, async () => {
    for (const stop of ['SIGINT', 'SIGTERM'] as const) {
      const folder = temporaryFolder()
      const controller = new AbortController()
      const running = runInstall({ command: node('setInterval(() => {}, 60_000)'), cwd: folder, signal: controller.signal })
      controller.abort(stop)
      assert.deepEqual(await running, { kind: 'signalled', signal: stop })
    }
  })
})
