import assert from 'node:assert/strict'
import { existsSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { configFileName, loadConfig } from '../../src/config/load.ts'
import { useProject } from '../../src/loader/project.ts'
import { tempProject } from '../support/project.ts'

// The config loads in Retest's own process, which Node does not start with its TypeScript transformer, so these load
// it through the hooks that call the transformer themselves.

const everydayConfig = `import { chromium, defineConfig } from '@rehearsal-labs/retest'
import { Budget, Target } from '@config/budgets'
import { port } from './settings/port'

const target = new Target('stable', 'bin/chromium')

export default defineConfig({
  apps: { web: chromium({ baseUrl: \`http://127.0.0.1:\${port}\`, executablePath: target.executablePath }) },
  timeouts: { assertion: Budget.Assertion },
})
`

const budgets = `// The enum and the parameter properties need the transformer, not only type stripping.
export enum Budget {
  Assertion = 3000,
}

export class Target {
  constructor(
    readonly name: string,
    readonly executablePath: string,
  ) {}
}
`

// The enum above the function moves its lines in what Node runs.
const stackHelper = `export enum Where {
  Here = 'here',
}

export function stackHere(): string {
  return new Error(Where.Here).stack ?? ''
}
`

describe('loadConfig with TypeScript beyond type stripping', () => {
  test('a config imports an enum and a class with parameter properties through a tsconfig alias, and a helper without its extension', async () => {
    const root = tempProject({
      'tsconfig.json': '{\n  // read through extends\n  "extends": "./tsconfig.paths.json",\n}\n',
      'tsconfig.paths.json': JSON.stringify({ compilerOptions: { paths: { '@config/*': ['./config/*'] } } }),
      'config/budgets.ts': budgets,
      'settings/port.ts': 'export const port: number = 4173\n',
      [configFileName]: everydayConfig,
    })
    const warnings: string[] = []
    const onWarning = (warning: Error): void => void warnings.push(warning.message)
    process.on('warning', onWarning)
    try {
      const loaded = await loadConfig(join(root, configFileName))
      assert.ok(loaded.ok, loaded.ok ? '' : loaded.failure.message)
      const web = loaded.config.apps.get('web')
      assert.equal(web?.baseUrl, 'http://127.0.0.1:4173')
      assert.deepEqual(web?.targets.get('chromium'), { name: 'chromium', browser: 'chromium', headless: true, executablePath: join(root, 'bin/chromium') })
      assert.equal(loaded.config.timeouts?.assertion, 3000)
      await new Promise((settle) => setImmediate(settle))
    } finally {
      process.off('warning', onWarning)
    }
    assert.deepEqual(warnings, [], "Node's warning that its transformer is experimental is not shown")
  })

  test("a transformed module's stack names its TypeScript lines", async () => {
    const root = tempProject({ 'support/stack.ts': stackHelper })
    const project = useProject({ folder: root, entry: join(root, 'support/stack.ts') })
    assert.ok(project.ok)
    const helper: unknown = await import(pathToFileURL(join(root, 'support/stack.ts')).href)
    assert.ok(typeof helper === 'object' && helper !== null && 'stackHere' in helper && typeof helper.stackHere === 'function')
    const stack: unknown = helper.stackHere()
    assert.equal(typeof stack, 'string')
    assert.match(String(stack), new RegExp(`at (?:Module\\.)?stackHere \\(${join(realpathSync(root), 'support/stack.ts')}:6:10\\)`), String(stack))
  })

  test('a CommonJS config, a JSX line and a decorator each fail naming the construct and the file', async () => {
    const commonJs = tempProject({ [configFileName]: `const { defineConfig } = require('@rehearsal-labs/retest')\nmodule.exports = defineConfig({ apps: {} })\n` })
    const refused = await loadConfig(join(commonJs, configFileName))
    assert.ok(!refused.ok)
    assert.equal(
      refused.failure.message,
      `${join(commonJs, configFileName)} could not be loaded: retest.config.ts uses require(), so Node loads it as CommonJS. Retest loads test files, the config and TypeScript as ES modules: write import and export, and set "type": "module" in package.json or use the .mts or .mjs extension.`,
    )

    const markup = tempProject({ 'package.json': '{ "type": "module" }', 'support/markup.ts': `const title = 'Tasks'\nexport const view = <h1>{title}</h1>\n`, [configFileName]: `import { view } from './support/markup.ts'\nexport default view\n` })
    const unreadable = await loadConfig(join(markup, configFileName))
    assert.ok(!unreadable.ok)
    assert.equal(unreadable.failure.message, `${join(markup, configFileName)} could not be loaded: Node's TypeScript transformer cannot read support/markup.ts:2: Expression expected.`)

    const decorated = tempProject({
      'package.json': '{ "type": "module" }',
      'support/decorated.ts': `function logged<Value>(value: Value): Value {\n  return value\n}\n\nexport class Tasks {\n  @logged\n  count(): number {\n    return 1\n  }\n}\n`,
      [configFileName]: `import { Tasks } from './support/decorated.ts'\nexport default new Tasks()\n`,
    })
    const decorator = await loadConfig(join(decorated, configFileName))
    assert.ok(!decorator.ok)
    assert.equal(
      decorator.failure.message,
      `${join(decorated, configFileName)} could not be loaded: Invalid or unexpected token. support/decorated.ts:6 has a decorator, which may be the cause: Node cannot run decorators, and Retest does not transform them.`,
    )
  })

  test('a missing export gets the import type hint only when the TypeScript file imported declares it as a type', async () => {
    const typeOnly = tempProject({
      'package.json': '{ "type": "module" }',
      'support/titles.ts': 'export type Title = string\nexport interface Shown { title: Title }\n',
      [configFileName]: `import { Title } from './support/titles.ts'\nconst title: Title = 'x'\nexport default title\n`,
    })
    const hinted = await loadConfig(join(typeOnly, configFileName))
    assert.ok(!hinted.ok)
    assert.match(hinted.failure.message, /does not provide an export named 'Title'\. support\/titles\.ts declares Title only as a type: import it with import type\.$/)

    const missingValue = tempProject({
      'package.json': '{ "type": "module" }',
      'support/titles.ts': 'export type Title = string\n',
      'support/plain.js': 'export const shown = 1\n',
      [configFileName]: `import { hidden } from './support/plain.js'\nexport default { hidden }\n`,
      'package.config.ts': `import { notThere } from '@rehearsal-labs/retest'\nexport default { notThere }\n`,
    })
    const plain = await loadConfig(join(missingValue, configFileName))
    assert.ok(!plain.ok)
    assert.match(plain.failure.message, /does not provide an export named 'hidden'$/, 'nothing is said of a JavaScript module')
    const packaged = await loadConfig(join(missingValue, 'package.config.ts'))
    assert.ok(!packaged.ok)
    assert.match(packaged.failure.message, /does not provide an export named 'notThere'$/, 'nothing is said of a package')
  })

  test('a tsconfig that cannot be read is a usage failure naming it, and the config is never imported', async () => {
    const root = tempProject({
      'tsconfig.json': '{ "compilerOptions": { "paths": { "@config/*": ["./config/*"] } }',
      [configFileName]: `import { writeFileSync } from 'node:fs'\nwriteFileSync(new URL('./imported', import.meta.url), '')\nexport default {}\n`,
    })
    const loaded = await loadConfig(join(root, configFileName))
    assert.ok(!loaded.ok)
    assert.equal(loaded.failure.class, 'usage')
    assert.match(loaded.failure.message, new RegExp(`^${join(realpathSync(root), 'tsconfig.json')} is not valid JSON: `))
    assert.equal(existsSync(join(root, 'imported')), false)
  })
})
