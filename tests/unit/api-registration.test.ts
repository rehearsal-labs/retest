import type { Hook } from '../../src/api/test-body.ts'
import assert from 'node:assert/strict'
import { describe, test as check } from 'node:test'
import { RetestError } from '../../src/api/failure.ts'
import { test } from '../../src/index.ts'
import { collectedTest, collectionFailure, collectSource } from '../support/api/collect-source.ts'
import { inProcessRun, pageWithText } from '../support/api/in-process-run.ts'

const lines = (hooks: readonly Hook[]): number[] => hooks.map((hook) => hook.location.line)

describe('test.describe', () => {
  check('adds its name to the test ids inside it, and passes tags down', async () => {
    const source = await collectSource(`test('top', () => {})
test.describe('archive', { tags: ['smoke'] }, () => {
  test('archives a task', { tags: ['slow', 'smoke'], timeout: 5000 }, () => {})
  test.describe('bulk', { tags: ['slow'] }, () => {
    test('archives all', () => {})
  })
})
test.describe('restore', () => {
  test('archives a task', () => {})
})`)
    assert.ok(source.collected.ok)
    const [top, archives, all, restored] = source.collected.tests
    assert.deepEqual(top, { name: 'top', location: { file: source.file, line: 2, column: 1 } })
    assert.equal(archives?.timeout, 5000)
    assert.deepEqual(archives?.tags, ['smoke', 'slow'])
    assert.deepEqual(archives?.describes?.map(({ name, location }) => [name, location.line]), [['archive', 3]])
    assert.deepEqual(all?.tags, ['smoke', 'slow'])
    assert.deepEqual(all?.describes?.map(({ name, location }) => [name, location.line]), [['archive', 3], ['bulk', 5]])
    assert.equal(all?.location.line, 6)
    assert.deepEqual(restored?.describes?.map(({ name }) => name), ['restore'])
    assert.equal(restored?.tags, undefined, 'a block without tags adds none')
    assert.equal(collectedTest(source, 'archives a task', ['restore']).location.line, 10)
    assert.equal(collectedTest(source, 'archives all', ['archive', 'bulk']).name, 'archives all')
  })

  check('passes apps down, adding the test\'s own, and merges state by app', async () => {
    const source = await collectSource(`test.describe('sharing', { apps: ['owner'], state: { owner: 'signed-in' } }, (inner) => {
  inner('shares', { apps: ['member', 'owner'], state: { member: 'guest' } }, () => {})
  inner('replaces', { state: 'other' }, () => {})
  inner('keeps', () => {})
})`)
    assert.ok(source.collected.ok)
    const [shares, replaces, keeps] = source.collected.tests
    assert.deepEqual(shares?.apps, ['owner', 'member'])
    assert.deepEqual(shares?.state, { owner: 'signed-in', member: 'guest' })
    assert.equal(replaces?.state, 'other')
    assert.deepEqual(keeps?.apps, ['owner'])
    assert.deepEqual(keeps?.state, { owner: 'signed-in' })
  })

  check('hands its function the same test, so tests declared through it join the block', async () => {
    const source = await collectSource(`let handed
test.describe('outer', (inner) => {
  handed = inner === test
  inner('inside', () => {})
})
test('handed test', () => expect(handed).toBe(true))`)
    assert.ok(source.collected.ok)
    assert.deepEqual(source.collected.tests[0]?.describes?.map(({ name }) => name), ['outer'])
    const { runPage } = inProcessRun(source.file, pageWithText(''), { rootDir: source.rootDir })
    assert.equal((await runPage(collectedTest(source, 'handed test').body)).status, 'passed')
  })

  check('an async function is a usage failure, since the file does not wait for it', async () => {
    const failure = collectionFailure(await collectSource(`test.describe('waits', async () => {
  test('never registers in the block', () => {})
})`))
    assert.equal(failure.class, 'usage')
    assert.equal(
      failure.message,
      'test.describe() runs its function once, while the file loads, and does not wait for it. Remove async from the function on line 2.',
    )
  })

  check('two tests with one title in a block fail collection; the same name in another block does not', async () => {
    const failure = collectionFailure(await collectSource(`test.describe('archive', () => {
  test('archives', () => {})
  test('archives', () => {})
})`))
    assert.equal(failure.class, 'collection_failed')
    assert.equal(failure.message, 'Two tests are named "archive > archives", on lines 3 and 4. Give each test its own name.')
    assert.equal(failure.location?.line, 4)
  })

  check('rejects options it does not take and a missing function', async () => {
    const timeout = collectionFailure(await collectSource(`test.describe('slow', { timeout: 5000 }, () => {})`))
    assert.equal(timeout.message, 'Unknown test.describe option "timeout". test.describe() options are apps, tags and state.')
    const noFunction = collectionFailure(await collectSource(`test.describe('empty', { tags: ['smoke'] })`))
    assert.equal(noFunction.message, 'test.describe("empty") takes a name, optional options and a function: test.describe(name, options?, fn).')
  })

  check('declaring anything after the file loaded is a usage error, thrown at once', () => {
    assert.throws(() => test.describe('late', () => {}), {
      name: 'RetestError',
      message: 'test.describe() registers tests while retest loads a test file. Run the file with retest run.',
    })
    assert.throws(() => test.beforeEach(() => {}), (error: unknown) => error instanceof RetestError && error.failure.class === 'usage')
  })
})

describe('hooks', () => {
  check('a test runs the hooks of its blocks: beforeEach from the outside in, afterEach from the inside out', async () => {
    const source = await collectSource(`test.beforeEach(() => {})
test.describe('outer', () => {
  test.afterEach(() => {})
  test.beforeEach(() => {})
  test('inner', () => {})
  test.afterEach(() => {})
})
test.afterEach(() => {})
test('top', () => {})`)
    assert.ok(source.collected.ok)
    const inner = collectedTest(source, 'inner', ['outer'])
    assert.deepEqual(lines(inner.hooks.beforeEach), [2, 5])
    assert.deepEqual(lines(inner.hooks.afterEach), [4, 7, 9], 'a hook declared after the test still applies')
    const top = collectedTest(source, 'top')
    assert.deepEqual(lines(top.hooks.beforeEach), [2])
    assert.deepEqual(lines(top.hooks.afterEach), [9])
  })

  check('a hook takes exactly one function', async () => {
    const failure = collectionFailure(await collectSource(`test.beforeEach('open the page', () => {})
test('x', () => {})`))
    assert.equal(failure.class, 'usage')
    assert.equal(failure.message, 'test.beforeEach() takes one function, such as test.beforeEach(async ({ page }) => {}).')
  })

  check('declaring inside a running test fails that test', async () => {
    const source = await collectSource(`test('declares', () => {
  test.describe('inside', () => {})
})`)
    const { runPage } = inProcessRun(source.file, pageWithText(''), { rootDir: source.rootDir })
    const verdict = await runPage(collectedTest(source, 'declares').body)
    assert.equal(verdict.failure?.class, 'usage')
    assert.equal(
      verdict.failure?.message,
      'test.describe() cannot run inside a test. Declare tests, hooks and test.describe() at the top level of a file.',
    )
  })
})

describe('test.for', () => {
  check('names one test per row from its keys and hands each its row', async () => {
    const source = await collectSource(`const rows = [{ title: 'One', count: 1 }, { title: 'Two', count: 2, tags: { a: 1 } }]
test.for(rows)('opens "$title" ($count) for $5', { tags: ['smoke'] }, (_context, row) => {
  expect(row).toBe(rows[row.count - 1])
})`)
    assert.ok(source.collected.ok)
    assert.deepEqual(
      source.collected.tests.map((entry) => [entry.name, entry.row, entry.tags, entry.location.line]),
      [
        ['opens "One" (1) for $5', { template: 'opens "$title" ($count) for $5', index: 0 }, ['smoke'], 3],
        ['opens "Two" (2) for $5', { template: 'opens "$title" ($count) for $5', index: 1 }, ['smoke'], 3],
      ],
    )
    const { runPage } = inProcessRun(source.file, pageWithText(''), { rootDir: source.rootDir })
    assert.equal((await runPage(collectedTest(source, 'opens "Two" (2) for $5').body)).status, 'passed')
  })

  check('prints values that are not text as Retest prints values', async () => {
    const source = await collectSource(`test.for([{ at: { x: 1 }, done: false, none: null }])('at $at, $done, $none', () => {})`)
    assert.ok(source.collected.ok)
    assert.equal(source.collected.tests[0]?.name, 'at { x: 1 }, false, null')
  })

  check('two rows that make one name fail collection', async () => {
    const failure = collectionFailure(await collectSource(`test.for([{ title: 'A', n: 1 }, { title: 'B', n: 2 }, { title: 'A', n: 3 }])('opens $title', () => {})`))
    assert.equal(failure.class, 'collection_failed')
    assert.equal(failure.message, 'Rows 1 and 3 of test.for() are both named "opens A". Put a $key whose value differs between them in the name.')
  })

  check('a $key a row does not have, even one it inherits, is a usage failure', async () => {
    const missing = collectionFailure(await collectSource(`test.for([{ title: 'A' }, { name: 'B' }])('opens $title', () => {})`))
    assert.equal(missing.message, 'Row 2 of test.for() has no "title" for $title in "opens $title".')
    const inherited = collectionFailure(await collectSource(`test.for([{ title: 'A' }])('opens $constructor', () => {})`))
    assert.equal(inherited.message, 'Row 1 of test.for() has no "constructor" for $constructor in "opens $constructor".')
  })

  check('rows must be plain objects', async () => {
    const failure = collectionFailure(await collectSource(`test.for(['A', 'B'])('opens $0', () => {})`))
    assert.equal(failure.class, 'usage')
    assert.match(failure.message, /^test\.for\(\) takes a list of rows, each an object such as \{ title: 'Release checklist' \}, received \[ 'A', 'B' \]\.$/)
  })
})

describe('test.setup', () => {
  check('registers a setup named after its state, with one app and its own timeout', async () => {
    const source = await collectSource(`test.setup('signed-in', { apps: ['owner'], timeout: 3000 }, () => {})
test.setup('guest', () => {})`)
    assert.ok(source.collected.ok)
    const [signedIn, guest] = source.collected.tests
    assert.deepEqual(signedIn, {
      name: 'signed-in',
      location: signedIn?.location,
      timeout: 3000,
      apps: ['owner'],
      setup: true,
    })
    assert.deepEqual(guest, { name: 'guest', location: guest?.location, setup: true })
  })

  check('uses exactly one app, sits at the top level, and takes no tags', async () => {
    const twoApps = collectionFailure(await collectSource(`test.setup('signed-in', { apps: ['owner', 'member'] }, () => {})`))
    assert.equal(twoApps.message, "A setup uses exactly one app, such as apps: ['web'], received [ 'owner', 'member' ].")
    const nested = collectionFailure(await collectSource(`test.describe('outer', () => {
  test.setup('signed-in', () => {})
})`))
    assert.equal(nested.message, 'test.setup() belongs at the top level of a file, outside test.describe().')
    const tagged = collectionFailure(await collectSource(`test.setup('signed-in', { tags: ['smoke'] }, () => {})`))
    assert.equal(tagged.message, 'Unknown test.setup option "tags". test.setup() options are apps and timeout.')
  })
})

describe('test options', () => {
  const cases: [string, string][] = [
    [`test('x', { retries: 2 }, () => {})`, 'Unknown test option "retries". Test options are apps, tags, state and timeout.'],
    [`test('x', { apps: 'web' }, () => {})`, "apps lists each app once, such as apps: ['owner', 'member'], received 'web'."],
    [`test('x', { apps: [] }, () => {})`, "apps lists each app once, such as apps: ['owner', 'member'], received []."],
    [`test('x', { apps: ['web', 'web'] }, () => {})`, "apps lists each app once, such as apps: ['owner', 'member'], received [ 'web', 'web' ]."],
    [`test('x', { tags: ['smoke', 3] }, () => {})`, "tags lists names, such as tags: ['smoke'], received [ 'smoke', 3 ]."],
    [
      `test('x', { state: { owner: 3 } }, () => {})`,
      "state names a saved state, such as state: 'signed-in', or one for each app, such as state: { owner: 'signed-in' }, received { owner: 3 }.",
    ],
    [
      `test('x', { apps: ['web'], state: { phone: 'signed-in' } }, () => {})`,
      'state names the app "phone", which this test does not use. Its apps are web.',
    ],
    [
      `test('x', { state: { web: 'signed-in' } }, () => {})`,
      "state gives a state for each app, but this test declares no apps. Name one state, such as state: 'signed-in'.",
    ],
    [`test('x', { timeout: 0 }, () => {})`, 'The timeout option must be a whole number of milliseconds from 1 to 2147483647, received 0.'],
    [`test('x', 'fast', () => {})`, "Test options must be an object, such as { tags: ['smoke'] }, received 'fast'."],
  ]
  for (const [source, message] of cases) {
    check(`rejects ${source}`, async () => {
      const failure = collectionFailure(await collectSource(source))
      assert.equal(failure.class, 'usage')
      assert.equal(failure.message, message)
      assert.equal(failure.location?.line, 2)
    })
  }

  check('a key set to undefined counts as absent', async () => {
    const source = await collectSource(`test('y', { timeout: undefined, tags: undefined, state: undefined }, () => {})`)
    assert.ok(source.collected.ok)
    assert.deepEqual(source.collected.tests[0], { name: 'y', location: source.collected.tests[0]?.location })
  })

  check('a state for each app names at least one state', async () => {
    const failure = collectionFailure(await collectSource(`test('x', { apps: ['owner'], state: { owner: undefined } }, () => {})`))
    assert.match(failure.message, /^state names a saved state, .* received \{ owner: undefined \}\.$/)
  })
})
