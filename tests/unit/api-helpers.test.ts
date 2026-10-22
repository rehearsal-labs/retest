import assert from 'node:assert/strict'
import { join, resolve } from 'node:path'
import { describe, test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { failureFrom, fromEarlierTest, RetestError } from '../../src/api/failure.ts'
import { callerLocation, describeLine, errorLocation } from '../../src/api/source-location.ts'
import { failure } from '../../src/protocol/failures.ts'
import { relativePosixPath } from '../../src/shared/posix-path.ts'
import { rootDir } from '../support/run-harness.ts'

const file = 'tests/unit/api-helpers.test.ts'

describe('source locations', () => {
  test('the caller is the first frame outside Retest, relative to the root', () => {
    const location = callerLocation(rootDir)
    assert.equal(location?.file, file)
    assert.ok((location?.line ?? 0) > 1)
    assert.ok((location?.column ?? 0) >= 1)
  })

  test('an error is located at its first frame outside Retest', () => {
    const error = new Error('here')
    assert.equal(errorLocation(error, rootDir)?.file, file)
    assert.equal(errorLocation(Object.assign(new Error('no stack'), { stack: undefined }), rootDir), undefined)
    assert.equal(errorLocation(Object.assign(new Error('node only'), { stack: 'Error\n    at node:internal/x:1:1' }), rootDir), undefined)
  })

  test('stack frames with and without a function name are read', () => {
    // A root that is absolute as this platform writes it: /work, or \work on the current drive on Windows, where a
    // frame names its script by a file URL or by a drive path.
    const work = resolve('/work')
    const named = pathToFileURL(join(work, 'tests', 'a.retest.ts')).href
    const unnamed = join(work, 'tests', 'b.retest.ts')
    const stack = ['Error: x', `    at named (${named}:3:7)`, `    at ${unnamed}:9:2`].join('\n')
    assert.deepEqual(errorLocation(Object.assign(new Error('x'), { stack }), work), { file: 'tests/a.retest.ts', line: 3, column: 7 })
    const bare = ['Error: x', `    at ${unnamed}:9:2`].join('\n')
    assert.deepEqual(errorLocation(Object.assign(new Error('x'), { stack: bare }), work), { file: 'tests/b.retest.ts', line: 9, column: 2 })
  })

  test('paths are POSIX and relative', () => {
    assert.equal(relativePosixPath('/work', '/work/tests/a.retest.ts'), 'tests/a.retest.ts')
    assert.equal(relativePosixPath('/work/tests', '/work/helpers/b.ts'), '../helpers/b.ts')
  })

  test('a line in the test file is named by number, and elsewhere by file', () => {
    assert.equal(describeLine({ file: 'a.retest.ts', line: 7, column: 1 }, 'a.retest.ts'), 'line 7')
    assert.equal(describeLine({ file: 'helpers.ts', line: 7, column: 1 }, 'a.retest.ts'), 'helpers.ts:7')
    assert.equal(describeLine(undefined, 'a.retest.ts'), 'an unknown line')
  })
})

describe('failures from test code', () => {
  test('failureFrom keeps Retest failures and turns anything else into test_error', () => {
    const retest = failure('not_found', 'gone')
    assert.equal(failureFrom(new RetestError(retest), rootDir), retest)
    const error = failureFrom(new SyntaxError('bad'), rootDir)
    assert.equal(error.class, 'test_error')
    assert.equal(error.message, 'SyntaxError: bad')
    assert.equal(error.location?.file, file)
    assert.equal(failureFrom(undefined, rootDir).message, 'The test threw undefined.')
    assert.equal(failureFrom({ code: 7 }, rootDir).message, 'The test threw { code: 7 }.')
  })

  test('an error from code an earlier test started names that test and where it was thrown', () => {
    const at = { file: 'a.retest.ts', line: 5, column: 3 }
    assert.deepEqual(fromEarlierTest(failure('test_error', 'Error: late', at), 'leaves a timer behind'), {
      class: 'test_error',
      message: 'Error: late\nCode from the earlier test "leaves a timer behind" may be the cause; this was thrown at a.retest.ts:5.',
      location: at,
    })
    assert.equal(
      fromEarlierTest(failure('test_error', 'The test threw 3.'), 'counts').message,
      'The test threw 3.\nCode from the earlier test "counts" may be the cause.',
    )
  })
})
