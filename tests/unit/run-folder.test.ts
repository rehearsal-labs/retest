import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  appLogFile,
  browserLogFile,
  childLogFile,
  defaultRunFolder,
  eventsFile,
  failureScreenshotFile,
  resultFile,
  slug,
  stateFile,
  statesFolder,
  targetBrowserLogFile,
  testId,
  testTitle,
} from '../../src/protocol/run-folder.ts'

const safeSlug = /^(?:[a-z0-9]+(?:-[a-z0-9]+)*-)?[a-z0-9]{13}$/

function assertSafe(text: string): string {
  const result = slug(text)
  assert.match(result, safeSlug, `slug of ${JSON.stringify(text.slice(0, 80))}`)
  assert.ok(result.length <= 60, `${result} is ${result.length} characters`)
  return result
}

describe('testId', () => {
  test('joins the file and the name', () => {
    assert.equal(testId('examples/task.retest.ts', 'saves a task'), 'examples/task.retest.ts > saves a task')
  })

  test('keeps the name exactly as declared', () => {
    assert.equal(testId('a.retest.ts', ' spaced > nested ünï '), 'a.retest.ts >  spaced > nested ünï ')
    assert.equal(testId('a.retest.ts', ''), 'a.retest.ts > ')
  })

  test('takes a full title with the describe blocks in it', () => {
    assert.equal(testId('tests/archive.retest.ts', testTitle('archives a task', ['archive'])), 'tests/archive.retest.ts > archive > archives a task')
  })
})

describe('testTitle', () => {
  test('is the describe blocks, outermost first, then the name', () => {
    assert.equal(testTitle('saves a task'), 'saves a task')
    assert.equal(testTitle('saves a task', []), 'saves a task')
    assert.equal(testTitle('archives a task', ['tasks', 'archive']), 'tasks > archive > archives a task')
  })
})

describe('slug', () => {
  test('keeps a readable prefix and ends with a hash', () => {
    const result = assertSafe('Saves a task')
    assert.match(result, /^saves-a-task-[a-z0-9]{13}$/)
    assert.equal(slug('Saves a task'), result)
  })

  test('gives different texts different slugs', () => {
    const variants = ['Task', 'task', 'TASK', 'a b', 'a-b', 'a_b', 'a  b', 'a/b', 'a.b', 'café', 'cafe\u0301', 'cafe', '']
    const slugs = variants.map(assertSafe)
    assert.equal(new Set(slugs).size, variants.length)
  })

  test('gives ten thousand distinct test ids ten thousand distinct slugs', () => {
    const slugs = new Set<string>()
    for (let index = 0; index < 10_000; index++) slugs.add(slug(testId(`tests/file-${index % 7}.retest.ts`, `case ${index}`)))
    assert.equal(slugs.size, 10_000)
  })

  test('texts that differ only past the readable prefix still differ', () => {
    const prefix = 'a'.repeat(200)
    const first = assertSafe(`${prefix}-first`)
    const second = assertSafe(`${prefix}-second`)
    assert.notEqual(first, second)
    assert.equal(first.slice(0, 46), second.slice(0, 46))
  })

  test('removes everything unsafe in a path', () => {
    for (const text of ['../../etc/passwd', 'C:\\Windows\\System32', 'a\u0000b', 'con', 'a:b*c?d"e<f>g|h', '  ', '---', '.']) {
      const result = assertSafe(text)
      assert.doesNotMatch(result, /[./\\:\s]/)
    }
    assert.match(slug('../../etc/passwd'), /^etc-passwd-/)
    assert.match(slug('---'), /^[a-z0-9]{13}$/)
  })

  test('caps very long text at 60 characters', () => {
    assert.equal(assertSafe('a'.repeat(100_000)).length, 60)
    assert.equal(assertSafe('é'.repeat(10_000)).length, 60)
    assert.ok(assertSafe(`${'word '.repeat(20)}end`).length <= 60)
  })

  test('takes a shorter limit, down to the hash alone, and keeps it unique', () => {
    assert.match(slug('examples/task.retest.ts > saves a task', 40), /^examples-task-retest-ts-sa-[a-z0-9]{13}$/)
    assert.equal(slug('a'.repeat(1000), 40).length, 40)
    assert.match(slug('Saves a task', 13), /^[a-z0-9]{13}$/)
    assert.match(slug('Saves a task', 14), /^[a-z0-9]{13}$/)
    assert.match(slug('Saves a task', 15), /^s-[a-z0-9]{13}$/)
    assert.notEqual(slug('same start, first', 20), slug('same start, second', 20))
    for (const maxLength of [12, 0, -1, 40.5, Number.NaN]) {
      assert.throws(() => slug('x', maxLength), RangeError, String(maxLength))
    }
  })

  test('folds accents and compatibility forms, and drops other scripts', () => {
    assert.match(assertSafe('Café déjà vu'), /^cafe-deja-vu-/)
    assert.match(assertSafe('İstanbul'), /^istanbul-/)
    assert.match(assertSafe('ﬁle ＡＢＣ'), /^file-abc-/)
    assert.match(assertSafe('🚀 launch'), /^launch-/)
    assert.match(assertSafe('日本語のテスト'), /^[a-z0-9]{13}$/)
    assertSafe('\ud800 lone surrogate')
  })
})

describe('run folder paths', () => {
  test('fixed files', () => {
    assert.equal(eventsFile, 'events.jsonl')
    assert.equal(resultFile, 'result.json')
    assert.equal(browserLogFile, 'logs/browser.log')
  })

  test('each test file has its own log, which never takes the browser log', () => {
    assert.match(childLogFile('examples/task.retest.ts'), /^logs\/examples-task-retest-ts-[a-z0-9]{13}\.log$/)
    assert.notEqual(childLogFile('browser'), browserLogFile)
    assert.notEqual(childLogFile('a/b.retest.ts'), childLogFile('a-b.retest.ts'))
  })

  test('failure screenshots are named by a test slug of at most 40 characters and the attempt id', () => {
    const id = testId('examples/task.retest.ts', 'saves a task')
    const path = failureScreenshotFile(id, 'k3v9q0x2mb')
    assert.match(path, /^artifacts\/examples-task-retest-ts-sa-[a-z0-9]{13}-k3v9q0x2mb-failure\.png$/)
    assert.notEqual(path, failureScreenshotFile(id, 'k3v9q0x2mc'), 'each attempt has its own file')
    assert.notEqual(path, failureScreenshotFile(testId('examples/task.retest.ts', 'saves a task twice'), 'k3v9q0x2mb'))
    const long = failureScreenshotFile(testId('tests/a/very/deep/folder/file.retest.ts', 'x'.repeat(500)), 'k3v9q0x2mb')
    assert.ok(long.length <= 'artifacts/'.length + 40 + '-k3v9q0x2mb-failure.png'.length, long)
  })

  test('a test with several apps names each screenshot with its app', () => {
    const id = testId('tests/share.retest.ts', 'shares a task')
    const owner = failureScreenshotFile(id, 'k3v9q0x2mb', 'owner')
    const member = failureScreenshotFile(id, 'k3v9q0x2mb', 'member')
    assert.match(owner, /^artifacts\/tests-share-retest-ts-shar-[a-z0-9]{13}-k3v9q0x2mb-owner-[a-z0-9]{13}-failure\.png$/)
    assert.notEqual(owner, member)
    assert.notEqual(failureScreenshotFile(id, 'k3v9q0x2mb', 'Web'), failureScreenshotFile(id, 'k3v9q0x2mb', 'web'))
    assert.notEqual(owner, failureScreenshotFile(id, 'k3v9q0x2mb'))
    assert.doesNotMatch(failureScreenshotFile(id, 'k3v9q0x2mb', '../../etc'), /\.\./)
  })

  test('app servers and further browsers each get a log of their own', () => {
    assert.match(appLogFile('web'), /^logs\/app-web-[a-z0-9]{13}\.log$/)
    assert.notEqual(appLogFile('web'), appLogFile('Web'))
    assert.notEqual(appLogFile('web'), childLogFile('app web'))
    assert.match(targetBrowserLogFile('web=beta'), /^logs\/browser-web-beta-[a-z0-9]{13}\.log$/)
    assert.notEqual(targetBrowserLogFile('web=beta'), browserLogFile)
  })

  test('each state and target pair has its own state file, which no two pairs share', () => {
    assert.equal(statesFolder, 'states')
    assert.match(stateFile('signed-in', 'beta'), /^states\/signed-in-beta-[a-z0-9]{13}\.json$/)
    assert.notEqual(stateFile('signed-in', 'beta'), stateFile('signed', 'in-beta'))
    assert.notEqual(stateFile('signed-in', 'beta'), stateFile('signed-in', 'edge'))
    assert.doesNotMatch(stateFile('../x', '../y'), /\.\./)
  })

  test('an attempt id that is not already safe in a file name becomes a slug', () => {
    const unsafe = failureScreenshotFile('../../x > y', '../z')
    assert.match(unsafe, /^artifacts\/[a-z0-9-]+-failure\.png$/)
    assert.doesNotMatch(unsafe, /\.\.|\/.*\//)
    assert.notEqual(failureScreenshotFile('a > b', 'Attempt'), failureScreenshotFile('a > b', 'attempt'))
  })

  test('the default run folder is named by start time without colons', () => {
    assert.equal(defaultRunFolder(new Date('2026-09-30T09:15:00.000Z')), '.retest/runs/2026-09-30T09-15-00.000Z')
    assert.throws(() => defaultRunFolder(new Date(Number.NaN)), RangeError)
  })
})
