import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { test } from 'node:test'
import { standInRun } from './runner-native-stand-in.ts'
import { phoneSignIn } from './native-interaction-fake.ts'

for (const state of ['focused', 'unmasked', 'secure-unmasked', 'masked', 'empty', 'unread', 'tree-unread', 'window-gone', 'field-gone', 'disabled'] as const) {
  test(`native secret capture ${state} preserves the required failure and clears only proved safe pixels`, async (t) => {
    const secretValue = randomBytes(18).toString('hex')
    const run = await standInRun(t, {
      configFields: `recording: { nativeWithholding: ${state !== 'disabled'} }, secrets: { password: env('RETEST_UNIT_PRIVATE') }, secretOrigins: { password: ['dev.retest.fixtures.taskphone'] }`,
      secretEnvironment: { RETEST_UNIT_PRIVATE: secretValue },
      screen: () => {
        const fields = phoneSignIn()
        // Withholding now applies to plain input. Later observations must still prove every old clearance condition.
        const password = fields.find(field => field.identifier === 'password-field')
        assert.ok(password)
        password.type = 'TextField'
        const button = fields.find(field => field.identifier === 'sign-in-button')
        assert.ok(button)
        button.onClick = (app) => {
          // The button runs this only after the secure fill.
          if (!app.find('password-field').text) return
          if (state === 'focused') return
          app.focused = undefined
          app.keyboardShown = false
          if (state !== 'unmasked') app.find('password-field').type = 'SecureTextField'
          if (state === 'unread') app.behaviours.set('GET /session/:session/element/:element/attribute/:name', { error: 'unknown error' })
          if (state === 'tree-unread') app.behaviours.set('GET /session/:session/source', { error: 'unknown error' })
          if (state === 'unmasked') app.find('password-field').type = 'TextField'
          if (state === 'secure-unmasked') {
            const route = 'GET /session/:session/element/:element/attribute/:name'
            const exposeValue = (): void => {
              if (app.requests.at(-1)?.path.endsWith('/attribute/value')) app.behaviours.set(route, { answer: 'visible field text' })
              else app.once(route, exposeValue)
            }
            app.once(route, exposeValue)
          }
          if (state === 'empty') app.find('password-field').text = ''
          if (state === 'field-gone' || state === 'tree-unread' || state === 'disabled') app.elements = app.elements.filter(field => field.identifier !== 'password-field')
          if (state === 'window-gone') app.windowHidden = true
        }
        return fields
      },
      tests: `import { expect, secret, test } from '@rehearsal-labs/retest'
        test('keeps the application failure', { apps: ['phone'] }, async ({ phone }) => {
          await phone.getByTestId('password-field').fill(secret('password'))
          await phone.getByTestId('sign-in-button').tap()
          expect(1).toBe(2)
        })`,
    })
    assert.equal(run.result.exitCode, 1, JSON.stringify(run.result.files.flatMap(file => file.tests).map(result => result.failure)))
    const result = run.result.files.flatMap(file => file.tests)[0]
    assert.equal(result?.status, 'failed')
    assert.equal(result?.failure?.class, 'check_failed')
    const early = run.events.filter(event => event.type === 'capture.resumed' && event.endedBy !== 'session_ended')
    const allowed = ['masked', 'empty', 'window-gone', 'field-gone'].includes(state)
    assert.equal(early.length, allowed ? 1 : 0)
    assert.equal(run.events.filter(event => event.type === 'evidence.captured').length, allowed || state === 'disabled' ? 1 : 0)
    assert.equal(run.events.filter(event => event.type === 'capture.withheld').length, state === 'disabled' ? 0 : 1)
    if (allowed) {
      const end = early[0]
      assert.ok(end?.type === 'capture.resumed')
      const gone = state === 'window-gone' || state === 'field-gone'
      assert.equal(end.endedBy, gone ? 'field_gone' : state === 'empty' ? 'field_empty' : 'field_masked')
      assert.equal(end.reason, gone ? 'the field that received the secret is gone' : 'the field reads back masked')
      const fill = run.events.find(event => event.type === 'action.completed' && event.command === 'fill')
      assert.ok(fill)
      assert.ok(end.elapsedMs >= fill.elapsedMs)
    }
    assert.equal(JSON.stringify(run.result).includes(secretValue), false)
    assert.equal(JSON.stringify(run.events).includes(secretValue), false)
  })
}
