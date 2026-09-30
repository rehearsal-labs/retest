import type { ChildOutput } from '../../src/runner/contract.ts'
import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { isArray } from '../../src/protocol/schema.ts'
import { runProject, tempProject } from '../support/project.ts'
import { runSupportFiles } from '../support/run-harness.ts'

const hostVariable = 'RETEST_UNIT_HOST_TOKEN'
const secretVariable = 'RETEST_UNIT_ENV_SECRET'

before(() => {
  process.env[hostVariable] = 'host-only-4417'
  process.env[secretVariable] = 'secret-value-8812'
})
after(() => {
  delete process.env[hostVariable]
  delete process.env[secretVariable]
})

// macOS's CoreFoundation sets this in every process that starts without it, so the parent never passed it.
const setByTheSystem = '__CF_USER_TEXT_ENCODING'

// The names the test printed, from its line of output.
function printed(output: readonly ChildOutput[]): string[] {
  const match = /environment (\[.*\])/.exec(output.map((chunk) => chunk.text).join(''))
  assert.ok(match?.[1] !== undefined, 'the test printed its environment')
  const names: unknown = JSON.parse(match[1])
  assert.ok(isArray(names))
  return names.flatMap((name) => (typeof name === 'string' && name !== setByTheSystem ? [name] : []))
}

describe('the test environment', () => {
  test("with testEnvironment, the test process gets exactly those variables and nothing of the parent; without it, the parent's", async () => {
    const given = await runSupportFiles(['environment.retest.ts'], { testEnvironment: { RETEST_CANARY: 'visible', LANG: 'C' } })
    assert.equal(given.result.exitCode, 0)
    assert.deepEqual(printed(given.output), ['LANG', 'RETEST_CANARY'])
    const inherited = await runSupportFiles(['environment.retest.ts'])
    assert.ok(printed(inherited.output).includes(hostVariable))
  })

  test('a variable an env secret reads is hidden from the test process, even when testEnvironment holds it', async () => {
    const root = tempProject({
      'retest.config.ts': `import { chromium, defineConfig, env } from '@rehearsal-labs/retest'
export default defineConfig({
  apps: { web: chromium({ baseUrl: 'http://127.0.0.1:4173', executablePath: '/fake/chromium' }) },
  secrets: { token: env('${secretVariable}') },
})
`,
      'tests/environment.retest.ts': `import { expect, test } from '@rehearsal-labs/retest'
test('prints its environment', () => {
  console.log(\`environment \${JSON.stringify(Object.keys(process.env).sort())}\`)
  expect(true).toBe(true)
})
`,
    })
    const record = await runProject(root, {
      files: ['tests/environment.retest.ts'],
      env: { [secretVariable]: 'secret-value-8812' },
      testEnvironment: { [secretVariable]: 'secret-value-8812', RETEST_CANARY: 'visible' },
    })
    assert.equal(record.result.exitCode, 0)
    assert.deepEqual(printed(record.output), ['RETEST_CANARY'])
  })
})
