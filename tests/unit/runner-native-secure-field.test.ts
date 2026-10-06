import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { test } from 'node:test'
import { phoneSignIn } from './native-interaction-fake.ts'
import { standInRun } from './runner-native-stand-in.ts'

for (const nativeWithholding of [undefined, false, true]) {
  for (const field of ['secure', 'plain', 'unreadable'] as const) {
    test(`native ${field} entry with withholding ${nativeWithholding ?? 'default'} records its pixel branch and preserves the required failure`, async t => {
      const value = randomBytes(18).toString('hex')
      const run = await standInRun(t, {
        configFields: `${nativeWithholding === undefined ? '' : `recording: { nativeWithholding: ${nativeWithholding} }, `}secrets: { password: env('RETEST_UNIT_PRIVATE') }, secretOrigins: { password: ['dev.retest.fixtures.taskphone'] }`,
        secretEnvironment: { RETEST_UNIT_PRIVATE: value },
        screen: () => phoneSignIn().map(element => element.identifier !== 'password-field' ? element : {
          ...element,
          ...(field === 'plain' ? { type: 'TextField' } : {}),
          ...(field === 'unreadable' ? { omit: ['type'] } : {}),
        }),
        tests: `import { expect, secret, test } from '@rehearsal-labs/retest'
          test('required wrong state', { apps: ['phone'] }, async ({ phone }) => {
            await phone.getByTestId('password-field').fill(secret('password'))
            expect(1).toBe(2)
          })`,
      })
      const result = run.result.files.flatMap(file => file.tests)[0]
      assert.equal(run.result.exitCode, 1)
      assert.equal(result?.status, 'failed')
      assert.equal(result?.failure?.class, 'check_failed')
      const withheld = nativeWithholding === true && field !== 'secure'
      const entries = run.events.filter(event => event.type === 'capture.native_entry')
      assert.equal(entries.length, 1)
      const entry = entries[0]
      assert.ok(entry?.type === 'capture.native_entry')
      assert.equal(entry.nativeField, field)
      assert.equal(entry.branch, field === 'secure' ? 'typed into a secure field' : field === 'plain' ? `typed into a plain field, pixels ${withheld ? 'withheld' : 'kept'}` : `field type unreadable, pixels ${withheld ? 'withheld' : 'kept'}`)
      assert.equal(run.events.filter(event => event.type === 'capture.withheld').length, withheld ? 1 : 0)
      const masked = run.events.filter(event => event.type === 'capture.masked_entry')
      assert.equal(masked.length, field === 'secure' ? 1 : 0)
      if (field === 'secure') assert.equal(masked[0]?.readBack, 'length_matched')
      assert.equal(run.events.filter(event => event.type === 'evidence.captured').length, withheld ? 0 : 1)
      assert.equal(run.events.filter(event => event.type === 'capture.resumed').length, withheld ? 1 : 0)
      const completed = run.events.find(event => event.type === 'action.completed' && event.command === 'fill')
      assert.ok(completed?.type === 'action.completed')
      assert.equal(run.app.requests.filter(request => request.route === 'POST /session/:session/wda/keys' && request.body.includes(value)).length, 1, 'the secret was typed once')
      assert.equal(JSON.stringify(run.result).includes(value), false)
      assert.equal(JSON.stringify(run.events).includes(value), false)
    })
  }
}

for (const nativeWithholding of [undefined, true]) {
for (const problem of ['type-changed', 'missing-value', 'unknown-input'] as const) {
  test(`native secure ${problem} with withholding ${nativeWithholding ?? 'default'} preserves its failure and keeps the selected pixels`, async t => {
    const value = randomBytes(18).toString('hex')
    const run = await standInRun(t, {
      configFields: `${nativeWithholding === undefined ? '' : 'recording: { nativeWithholding: true }, '}secrets: { password: env('RETEST_UNIT_PRIVATE') }, secretOrigins: { password: ['dev.retest.fixtures.taskphone'] }`,
      secretEnvironment: { RETEST_UNIT_PRIVATE: value },
      screen: phoneSignIn,
      prepare: app => {
        const route = problem === 'unknown-input' ? 'POST /session/:session/wda/keys' : 'GET /session/:session/source'
        const react = (): void => {
          if (problem === 'unknown-input' && app.requests.at(-1)?.body.includes(value)) app.behaviours.set(route, { drop: true })
          else if (problem !== 'unknown-input' && app.find('password-field').text) {
            if (problem === 'type-changed') app.find('password-field').type = 'TextField'
            else app.find('password-field').omit = ['value']
          } else app.once(route, react)
        }
        app.once(route, react)
      },
      tests: `import { secret, test } from '@rehearsal-labs/retest'
        test('requires confirmed secret input', { apps: ['phone'] }, async ({ phone }) => {
          await phone.getByTestId('password-field').fill(secret('password'))
          throw new Error('failed input must stop the body')
        })`,
    })
    assert.notEqual(run.result.exitCode, 0)
    const failed = run.events.find(event => event.type === 'action.failed' && event.command === 'fill')
    assert.ok(failed?.type === 'action.failed')
    assert.equal(failed.failure.class, problem === 'unknown-input' ? 'outcome_unknown' : 'not_actionable')
    assert.equal(run.events.filter(event => event.type === 'capture.masked_entry').length, 0, 'failed input supplies no masked read-back proof')
    assert.equal(run.events.filter(event => event.type === 'capture.withheld').length, 0)
    const entry = run.events.find(event => event.type === 'capture.native_entry')
    assert.ok(entry?.type === 'capture.native_entry')
    assert.equal(entry.branch, 'typed into a secure field')
    assert.equal(run.events.filter(event => event.type === 'evidence.captured').length, problem === 'unknown-input' ? 0 : 1)
    assert.equal(run.events.some(event => event.type === 'evidence.failed' && event.message.includes('withheld')), false)
    assert.equal(run.events.filter(event => event.type === 'capture.resumed').length, 0)
    assert.equal(run.app.requests.filter(request => request.route === 'POST /session/:session/wda/keys' && request.body.includes(value)).length, 1)
    assert.equal(JSON.stringify(run.result).includes(value), false)
    assert.equal(JSON.stringify(run.events).includes(value), false)
  })
}
}
