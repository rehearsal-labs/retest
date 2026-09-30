import assert from 'node:assert/strict'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { configFileName, findConfigFile, loadConfig } from '../../src/config/load.ts'
import { tempProject } from '../support/project.ts'

const typed = `import { app, chromium, defineConfig, env } from '@rehearsal-labs/retest'

type Port = number
const port: Port = 4173

export default defineConfig({
  apps: {
    web: app({ baseUrl: \`http://127.0.0.1:\${port}\`, targets: { stable: chromium({ executablePath: 'bin/chromium' }) } }),
  },
  secrets: { password: env('TEST_PASSWORD') },
  tags: ['smoke'],
})
`

describe('findConfigFile', () => {
  test('finds retest.config.ts in the root, and nothing where there is none', () => {
    const root = tempProject({ [configFileName]: typed })
    assert.equal(findConfigFile(root), join(root, configFileName))
    assert.equal(findConfigFile(tempProject({})), undefined)
  })

  test('resolves a given path against the root, whether or not it exists', () => {
    const root = tempProject({})
    assert.equal(findConfigFile(root, 'config/retest.ci.ts'), join(root, 'config/retest.ci.ts'))
  })
})

describe('loadConfig', () => {
  test('imports a TypeScript config with its types stripped, and validates its default export', async () => {
    const root = tempProject({ [configFileName]: typed })
    const loaded = await loadConfig(join(root, configFileName))
    assert.ok(loaded.ok, loaded.ok ? '' : loaded.failure.message)
    const web = loaded.config.apps.get('web')
    assert.equal(web?.baseUrl, 'http://127.0.0.1:4173')
    assert.deepEqual(web?.targets.get('stable'), { name: 'stable', browser: 'chromium', headless: true, executablePath: join(root, 'bin/chromium') })
    assert.equal(loaded.config.file, join(root, configFileName))
    assert.deepEqual(loaded.config.tags, ['smoke'])
  })

  test('an invalid config is a usage failure naming the file and the key', async () => {
    const config = `import { chromium, defineConfig } from '@rehearsal-labs/retest'
export default defineConfig({ apps: { web: chromium({ baseUrl: 'localhost:3000' }) } })
`
    const root = tempProject({ [configFileName]: config })
    const path = join(root, configFileName)
    const loaded = await loadConfig(path)
    assert.ok(!loaded.ok)
    assert.equal(loaded.failure.class, 'usage')
    assert.equal(loaded.failure.message, `${path}: apps.web.baseUrl: expected an http or https URL, received "localhost:3000"`)
    assert.deepEqual(loaded.failure.details, { key: 'apps.web.baseUrl' })
  })

  test('a file that does not load is a usage failure with the error', async () => {
    const root = tempProject({ [configFileName]: 'export default {\n' })
    const path = join(root, configFileName)
    const loaded = await loadConfig(path)
    assert.ok(!loaded.ok)
    assert.equal(loaded.failure.class, 'usage')
    assert.ok(loaded.failure.message.startsWith(`${path} could not be loaded: `), loaded.failure.message)
  })

  test('a config that throws while it loads is a usage failure with its error', async () => {
    const root = tempProject({ [configFileName]: `throw new Error('no environment')\n` })
    const loaded = await loadConfig(join(root, configFileName))
    assert.ok(!loaded.ok)
    assert.match(loaded.failure.message, /could not be loaded: no environment$/)
  })

  test('a config without a default export says how to write one', async () => {
    const root = tempProject({ [configFileName]: `export const config = {}\n` })
    const path = join(root, configFileName)
    const loaded = await loadConfig(path)
    assert.deepEqual(loaded, { ok: false, failure: { class: 'usage', message: `${path} has no default export. Write export default defineConfig({ ... }).` } })
  })

  test('a missing file is a usage failure naming it', async () => {
    const path = join(tempProject({}), 'missing.config.ts')
    assert.deepEqual(await loadConfig(path), { ok: false, failure: { class: 'usage', message: `There is no config file at ${path}.` } })
  })
})
