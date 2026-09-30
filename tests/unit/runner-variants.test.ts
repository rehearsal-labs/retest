import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { testVariants } from '../../src/runner/variants.ts'
import { appWith, configOf, target } from '../support/plans.ts'

const config = configOf({
  apps: {
    web: appWith('chromium', 'beta'),
    mobile: appWith('pixel', 'iphone'),
    admin: target('chromium'),
    member: target('chromium'),
  },
  runs: [
    { web: 'chromium', mobile: 'pixel' },
    { web: 'beta', mobile: 'iphone', admin: 'chromium' },
    { web: 'beta', mobile: 'iphone' },
  ],
})

describe('testVariants', () => {
  test('apps with one target each run once', () => {
    assert.deepEqual(testVariants(['admin', 'member'], config), { ok: true, variants: [{ admin: 'chromium', member: 'chromium' }] })
  })

  test('one app with several targets runs once per target, in the config order, beside the fixed apps', () => {
    assert.deepEqual(testVariants(['admin', 'web'], config), {
      ok: true,
      variants: [
        { admin: 'chromium', web: 'chromium' },
        { admin: 'chromium', web: 'beta' },
      ],
    })
  })

  test('two apps with several targets each run only the pairings runs lists, each once', () => {
    assert.deepEqual(testVariants(['mobile', 'web'], config), {
      ok: true,
      variants: [
        { mobile: 'pixel', web: 'chromium' },
        { mobile: 'iphone', web: 'beta' },
      ],
    })
  })

  test('with no runs entry naming all of them, there is no variant and the message says what to add', () => {
    const unlisted = configOf({ apps: { web: appWith('chromium', 'beta'), mobile: appWith('pixel', 'iphone') } })
    assert.deepEqual(testVariants(['web', 'mobile'], unlisted), {
      ok: false,
      message: 'This test uses "web" and "mobile", which have several targets each, and no entry in runs names all of them. Add one to runs.',
    })
  })

  test('an entry naming only some of the apps does not count', () => {
    const partial = configOf({
      apps: { web: appWith('chromium', 'beta'), mobile: appWith('pixel', 'iphone'), desk: appWith('mac', 'linux') },
      runs: [{ web: 'chromium', mobile: 'pixel' }],
    })
    assert.equal(testVariants(['web', 'mobile', 'desk'], partial).ok, false)
  })
})
