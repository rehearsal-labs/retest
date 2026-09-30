import type { TagExpression } from '../../src/runner/contract.ts'
import type { PlannedTest } from '../../src/runner/plan.ts'
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { describeTags, emptySelectionFailure, matchesTags, selectionProblem, testSelected, variantSelected } from '../../src/runner/selection.ts'
import { appWith, at, configOf, planOf, registered } from '../support/plans.ts'

const tag = (name: string): TagExpression => ({ kind: 'tag', tag: name })
const not = (operand: TagExpression): TagExpression => ({ kind: 'not', operand })
const and = (left: TagExpression, right: TagExpression): TagExpression => ({ kind: 'and', left, right })
const or = (left: TagExpression, right: TagExpression): TagExpression => ({ kind: 'or', left, right })

const config = configOf({ apps: { web: appWith('stable', 'beta') }, tags: ['smoke', 'slow', 'auth'] })
const describes = [{ name: 'archive', location: at(10) }]
const plan = planOf(config, {
  'tests/a.retest.ts': [
    registered('saves a task', 3, { tags: ['smoke'] }),
    registered('archives a task', 12, { describes, tags: ['slow'] }),
    registered('archives "one"', 20, { describes, row: { template: 'archives "$title"', index: 0 } }),
    registered('archives "two"', 20, { describes, row: { template: 'archives "$title"', index: 1 } }),
  ],
})

function planned(name: string): PlannedTest {
  const [file] = plan.files
  const found = file?.ok === true ? file.tests.find((test) => test.registered.name === name) : undefined
  assert.ok(found)
  return found
}

describe('testSelected', () => {
  test('--grep matches a substring of the full title, describe blocks included', () => {
    assert.equal(testSelected(planned('archives a task'), { grep: 'archive > archives' }), true)
    assert.equal(testSelected(planned('saves a task'), { grep: 'archive' }), false)
  })

  test('--grep as a pattern matches every title alike, whatever the pattern last matched', () => {
    const pattern = /task$/g
    assert.equal(testSelected(planned('saves a task'), { grep: pattern }), true)
    assert.equal(testSelected(planned('archives a task'), { grep: pattern }), true)
    assert.equal(testSelected(planned('archives "one"'), { grep: /TASK/i }), false)
  })

  test('--tag applies its expression to the tags each test has', () => {
    assert.equal(testSelected(planned('saves a task'), { tags: and(tag('smoke'), not(tag('slow'))) }), true)
    assert.equal(testSelected(planned('archives a task'), { tags: and(tag('smoke'), not(tag('slow'))) }), false)
    assert.equal(testSelected(planned('archives "one"'), { tags: not(or(tag('smoke'), tag('slow'))) }), true)
  })

  test('file:line keeps the test, test.for row or describe block declared on that line', () => {
    const lines = (line: number) => ({ locations: [{ file: 'tests/a.retest.ts', line }] })
    assert.deepEqual(['saves a task', 'archives a task', 'archives "one"'].map((name) => testSelected(planned(name), lines(10))), [false, true, true])
    assert.equal(testSelected(planned('archives "one"'), lines(20)), true)
    assert.equal(testSelected(planned('saves a task'), lines(4)), false)
  })

  test('file:line#row keeps one row of the test.for declared on that line, counted from 1', () => {
    const row = (line: number, number: number) => ({ locations: [{ file: 'tests/a.retest.ts', line, row: number }] })
    assert.deepEqual(['archives "one"', 'archives "two"'].map((name) => testSelected(planned(name), row(20, 2))), [false, true])
    assert.deepEqual(['archives "one"', 'archives "two"'].map((name) => testSelected(planned(name), row(20, 1))), [true, false])
    assert.equal(testSelected(planned('archives "two"'), row(20, 3)), false, 'a row the list does not have')
    assert.equal(testSelected(planned('archives a task'), row(12, 1)), false, 'a test that is not a row')
    assert.equal(testSelected(planned('archives "one"'), row(10, 1)), false, 'a row names the test.for line, not its block')
    const both = { locations: [{ file: 'tests/a.retest.ts', line: 20, row: 1 }, { file: 'tests/a.retest.ts', line: 3 }] }
    assert.deepEqual(['saves a task', 'archives "one"', 'archives "two"'].map((name) => testSelected(planned(name), both)), [true, true, false])
  })

  test('a file named with lines narrows only itself; other files keep every test', () => {
    assert.equal(testSelected(planned('saves a task'), { locations: [{ file: 'tests/b.retest.ts', line: 3 }] }), true)
  })
})

describe('variantSelected', () => {
  test('--target keeps the variants that use the named target for every app named', () => {
    assert.equal(variantSelected('id', { web: 'beta' }, { targets: { web: 'beta' } }), true)
    assert.equal(variantSelected('id', { web: 'stable' }, { targets: { web: 'beta' } }), false)
    assert.equal(variantSelected('id', { admin: 'chromium' }, { targets: { web: 'beta' } }), false)
  })

  test('--last-failed keeps each test for the variant it recorded, or for every variant when it recorded none', () => {
    const lastFailed = [
      { testId: 'a', variantKey: 'web=beta', status: 'failed' as const },
      { testId: 'b', status: 'not_run' as const },
    ]
    assert.equal(variantSelected('a', { web: 'beta' }, { lastFailed }), true)
    assert.equal(variantSelected('a', { web: 'stable' }, { lastFailed }), false)
    assert.equal(variantSelected('b', { web: 'stable' }, { lastFailed }), true)
    assert.equal(variantSelected('c', undefined, { lastFailed }), false)
    assert.equal(variantSelected('c', undefined, { lastFailed: [] }), false)
  })
})

describe('selectionProblem', () => {
  test('a tag the config does not list, an unknown app or target, and a line in a file not in the run are usage failures', () => {
    const problem = selectionProblem(
      {
        tags: and(tag('smoke'), not(tag('flaky'))),
        targets: { web: 'canary', mobile: 'pixel' },
        locations: [{ file: 'tests/z.retest.ts', line: 3 }],
      },
      ['tests/a.retest.ts'],
      config,
    )
    assert.deepEqual(problem, {
      class: 'usage',
      message: [
        'The tag "flaky" is not in the config\'s tags: smoke, slow, auth.',
        'The app "web" has no target "canary". Its targets are stable, beta.',
        '--target names the app "mobile", which the config does not have.',
        'tests/z.retest.ts:3 names a file this run does not include.',
      ].join(' '),
    })
  })

  test('a selection that fits the run has no problem, and a config without tags accepts any tag', () => {
    assert.equal(selectionProblem({ tags: tag('smoke'), targets: { web: 'beta' } }, [], config), undefined)
    assert.equal(selectionProblem({ tags: tag('anything') }, [], configOf({ apps: { web: appWith('stable') } })), undefined)
  })
})

describe('describing a selection', () => {
  test('writes tag expressions back with the parentheses they need', () => {
    assert.equal(describeTags(and(tag('smoke'), not(tag('slow')))), 'smoke and not slow')
    assert.equal(describeTags(and(or(tag('a'), tag('b')), tag('c'))), '(a or b) and c')
    assert.equal(describeTags(not(and(tag('a'), tag('b')))), 'not (a and b)')
    assert.equal(matchesTags(or(tag('a'), tag('b')), ['b']), true)
  })

  test('an empty selection names every filter it applied', () => {
    assert.deepEqual(
      emptySelectionFailure({
        grep: /save/i,
        tags: tag('smoke'),
        locations: [{ file: 'tests/a.retest.ts', line: 4 }],
        lastFailed: [],
        targets: { web: 'beta' },
      }),
      {
        class: 'usage',
        message: 'No test matches --grep /save/i, --tag "smoke", tests/a.retest.ts:4, --last-failed (the last run left no failed test) and --target web=beta.',
      },
    )
    assert.equal(emptySelectionFailure({}).message, 'No test matches the files given.')
    assert.equal(emptySelectionFailure({ grep: 'save' }).message, 'No test matches --grep "save".')
    assert.equal(emptySelectionFailure({ locations: [{ file: 'tests/a.retest.ts', line: 20, row: 3 }] }).message, 'No test matches tests/a.retest.ts:20#3.')
    // Each target as the command line takes it: one --target for each app.
    assert.equal(emptySelectionFailure({ targets: { web: 'beta', api: 'stable' } }).message, 'No test matches --target api=stable and --target web=beta.')
  })
})
