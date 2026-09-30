import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { format, inspect } from 'node:util'
import { RetestError } from '../../src/api/failure.ts'
import { expect, secret } from '../../src/index.ts'
import { inProcessRun, pageWithText } from '../support/api/in-process-run.ts'

const file = 'tests/unit/api-secret.test.ts'

describe('secret', () => {
  test('prints as {{name}} however it is turned into text', () => {
    const password = secret('password')
    assert.equal(password.name, 'password')
    assert.equal(String(password), '{{password}}')
    assert.equal(`${password}`, '{{password}}')
    assert.equal('p=' + password, 'p={{password}}')
    assert.equal(JSON.stringify(password), '"{{password}}"')
    assert.equal(JSON.stringify({ login: { password } }), '{"login":{"password":"{{password}}"}}')
    assert.equal(inspect(password), '{{password}}')
    assert.equal(inspect({ password }), '{ password: {{password}} }')
    assert.equal(format('%s %o', password, password), '{{password}} {{password}}')
  })

  test('holds nothing but its name, and no enumerable property', () => {
    const code = secret('code')
    assert.deepEqual(Object.keys(code), [])
    assert.deepEqual(Object.getOwnPropertyNames(code), [])
    assert.deepEqual(Object.getOwnPropertySymbols(code), [])
  })

  test('a name that is not text is a usage error, recorded against the running test', async () => {
    assert.throws(() => Reflect.apply(secret, undefined, [42]), (error: unknown) => {
      assert.ok(error instanceof RetestError)
      assert.equal(error.failure.class, 'usage')
      assert.equal(error.failure.message, 'secret() takes the name of a secret from the config, received 42.')
      return true
    })
    const { runPage } = inProcessRun(file, pageWithText(''))
    const verdict = await runPage(() => {
      try {
        Reflect.apply(secret, undefined, [''])
      } catch {
        // Swallowed on purpose: the test still fails.
      }
      expect(1).toBe(1)
    })
    assert.equal(verdict.failure?.class, 'usage')
    assert.equal(verdict.failure?.message, "secret() takes the name of a secret from the config, received ''.")
    assert.equal(verdict.failure?.location?.file, file)
  })

  test('expect refuses a secret at run time too, since it cannot be compared or printed', async () => {
    const { runPage, events } = inProcessRun(file, pageWithText(''))
    const verdict = await runPage(() => {
      const password: unknown = secret('password')
      expect.soft(password).toBe('hunter2')
    })
    assert.equal(verdict.failure?.class, 'usage')
    assert.equal(verdict.failure?.message, 'A secret cannot be compared or printed.')
    assert.deepEqual(events(), [], 'no assertion was reported')
  })
})
