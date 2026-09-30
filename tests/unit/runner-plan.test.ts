import type { PlannedFile } from '../../src/runner/plan.ts'
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { collectedTest, planTests } from '../../src/runner/plan.ts'
import { collectConfig } from '../../src/runner/run-config.ts'
import { appWith, at, configOf, planOf, registered, target } from '../support/plans.ts'

const config = configOf({
  apps: { web: appWith('chromium', 'beta'), admin: target('chromium') },
  defaultApp: 'web',
  tags: ['smoke', 'slow'],
  states: ['signed-in', 'admin-in'],
})

function failed(file: PlannedFile | undefined): string {
  assert.ok(file !== undefined && !file.ok, 'the file failed its checks')
  return file.failure.message
}

describe('planTests', () => {
  test("milestone 1's single app: every test uses page, once, and lists as before", () => {
    const single = collectConfig(undefined)
    const plan = planOf(single, { 'tests/a.retest.ts': [registered('saves', 3)] })
    const [file] = plan.files
    assert.ok(file?.ok)
    const [planned] = file.tests
    assert.deepEqual([planned?.apps, planned?.variants], [['page'], [{ page: 'page' }]])
    assert.deepEqual(planned === undefined ? undefined : collectedTest(planned, single), {
      testId: 'tests/a.retest.ts > saves',
      name: 'saves',
      location: at(3),
    })
  })

  test('a test without apps uses the default app, and lists its apps, variants, tags, describe path and setup mark', () => {
    const describes = [{ name: 'archive', location: at(2) }]
    const plan = planOf(config, {
      'tests/a.retest.ts': [registered('archives', 3, { describes, tags: ['smoke'] }), registered('signed-in', 9, { setup: true })],
    })
    const [file] = plan.files
    assert.ok(file?.ok)
    const [archives, setup] = file.tests.map((planned) => collectedTest(planned, config))
    assert.deepEqual(archives, {
      testId: 'tests/a.retest.ts > archive > archives',
      name: 'archives',
      location: at(3),
      describePath: ['archive'],
      tags: ['smoke'],
      apps: ['web'],
      variants: [{ web: 'chromium' }, { web: 'beta' }],
    })
    assert.equal(setup?.setup, true)
    assert.deepEqual(plan.setups.get('signed-in')?.usable, true)
  })

  test('an app the config lacks, an app listed twice, or no app to fall back on fails the file at the test', () => {
    const plan = planOf(config, { 'tests/a.retest.ts': [registered('uses', 4, { apps: ['web', 'mobile', 'web'] })] })
    const [file] = plan.files
    assert.ok(file !== undefined && !file.ok)
    assert.equal(file.failure.class, 'collection_failed')
    assert.deepEqual(file.failure.location, at(4))
    assert.equal(file.failure.message, '"uses": It uses the app "mobile", which the config does not have. The config\'s apps are web, admin.')
    assert.equal(file.failure.details?.['also'], 'collection_failed: "uses": It lists the app "web" twice.')
    const several = configOf({ apps: { web: target('chromium'), admin: target('chromium') } })
    assert.equal(
      failed(planOf(several, { 'tests/a.retest.ts': [registered('uses', 4)] }).files[0]),
      '"uses": It declares no apps, and the config has several with no defaultApp. Name its apps, or set defaultApp.',
    )
  })

  test("a tag or state the config does not list is a problem; without such a list any name goes", () => {
    const plan = planOf(config, {
      'tests/a.retest.ts': [registered('tagged', 2, { tags: ['smok'] })],
      'tests/b.retest.ts': [registered('signed-out', 2, { setup: true })],
    })
    assert.equal(failed(plan.files[0]), '"tagged": The tag "smok" is not in the config\'s tags: smoke, slow.')
    assert.equal(failed(plan.files[1]), '"signed-out": The state "signed-out" is not in the config\'s states: signed-in, admin-in.')
    const open = configOf({ apps: { web: target('chromium') } })
    assert.equal(planOf(open, { 'tests/a.retest.ts': [registered('tagged', 2, { tags: ['anything'] })] }).files[0]?.ok, true)
  })

  test('a state no setup saves is a problem for the test that needs it', () => {
    const plan = planOf(config, { 'tests/a.retest.ts': [registered('needs', 5, { state: 'signed-in' })] })
    assert.equal(
      failed(plan.files[0]),
      '"needs": No setup in this run saves the state "signed-in". Declare test.setup("signed-in", ...) in a file this run includes.',
    )
  })

  test('a setup in another file provides its state; a setup for another app does not', () => {
    const plan = planOf(config, {
      'tests/archive.retest.ts': [registered('archives', 2, { state: 'signed-in' }), registered('admin page', 6, { apps: ['admin'], state: 'signed-in' })],
      'tests/sign-in.retest.ts': [registered('signed-in', 2, { setup: true })],
    })
    assert.equal(failed(plan.files[0]), '"admin page": The setup that saves "signed-in" uses the app "web", not "admin".')
    assert.equal(plan.files[1]?.ok, true)
  })

  test('state by app: each app needs its own setup, and a key the test does not use is a problem', () => {
    const plan = planOf(config, {
      'tests/a.retest.ts': [
        registered('signed-in', 2, { setup: true }),
        registered('admin-in', 3, { setup: true, apps: ['admin'] }),
        registered('both', 5, { apps: ['web', 'admin'], state: { web: 'signed-in', admin: 'admin-in' } }),
      ],
      'tests/b.retest.ts': [registered('stray', 2, { state: { admin: 'admin-in' } })],
    })
    const [first] = plan.files
    assert.ok(first?.ok)
    assert.deepEqual([...(first.tests[2]?.states ?? [])], [['web', 'signed-in'], ['admin', 'admin-in']])
    assert.equal(failed(plan.files[1]), '"stray": Its state names the app "admin", which it does not use.')
  })

  test('two setups for one state: the second file fails, and the first stays the one that runs', () => {
    const plan = planOf(config, {
      'tests/a.retest.ts': [registered('signed-in', 2, { setup: true })],
      'tests/b.retest.ts': [registered('signed-in', 7, { setup: true })],
    })
    assert.equal(plan.files[0]?.ok, true)
    assert.equal(
      failed(plan.files[1]),
      '"signed-in": The state "signed-in" is also saved by the setup at tests/a.retest.ts:2. Give each setup its own name.',
    )
    assert.equal(plan.setups.get('signed-in')?.test.file, 'tests/a.retest.ts')
  })

  test('a setup whose file fails its checks is known, and marked as not usable', () => {
    const plan = planOf(config, {
      'tests/a.retest.ts': [registered('signed-in', 2, { setup: true }), registered('tagged', 4, { tags: ['nope'] })],
      'tests/b.retest.ts': [registered('needs', 2, { state: 'signed-in' })],
    })
    assert.equal(plan.files[0]?.ok, false)
    assert.equal(plan.files[1]?.ok, true)
    assert.equal(plan.setups.get('signed-in')?.usable, false)
  })

  test('two test.for rows that make one name, and two describe blocks with one name, fail the file', () => {
    const rows = planOf(config, {
      'tests/a.retest.ts': [
        registered('archives "x"', 4, { row: { template: 'archives "$title"', index: 0 } }),
        registered('archives "x"', 4, { row: { template: 'archives "$title"', index: 2 } }),
      ],
    })
    assert.equal(failed(rows.files[0]), 'test.for rows 1 and 3 both make the name "archives \\"x\\"". Give each row its own name.')
    const blocks = planOf(config, {
      'tests/a.retest.ts': [
        registered('one', 3, { describes: [{ name: 'archive', location: at(2) }] }),
        registered('two', 8, { describes: [{ name: 'archive', location: at(7) }] }),
      ],
    })
    const [file] = blocks.files
    assert.ok(file !== undefined && !file.ok)
    assert.equal(file.failure.message, 'Two test.describe blocks are named "archive", on lines 2 and 7. Give each its own name.')
    assert.deepEqual(file.failure.location, at(7))
  })

  test('a test whose apps have several targets each fails without a runs entry for them', () => {
    const matrix = configOf({ apps: { web: appWith('chromium', 'beta'), mobile: appWith('pixel', 'iphone') }, defaultApp: 'web' })
    const plan = planOf(matrix, { 'tests/a.retest.ts': [registered('syncs', 2, { apps: ['web', 'mobile'] })] })
    assert.match(failed(plan.files[0]), /no entry in runs names all of them/)
  })

  test('a file that could not be collected stays as it was', () => {
    const problem = { class: 'collection_failed' as const, message: 'Could not load it.' }
    const plan = planTests([{ file: 'tests/a.retest.ts', ok: false, failure: problem }], config)
    assert.deepEqual(plan.files, [{ file: 'tests/a.retest.ts', ok: false, failure: problem }])
  })
})
