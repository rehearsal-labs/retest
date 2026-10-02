import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, test } from 'node:test'
import { everyTestFile, readFileArguments } from '../../src/cli/test-files.ts'
import { findTestFiles, playwrightFileSuffixes, playwrightSpecSuffixes } from '../../src/shared/test-files.ts'
import { tempFolder } from '../support/temp-folder.ts'

function project(files: readonly string[]): string {
  const root = tempFolder('playwright-files-')
  for (const file of files) {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    writeFileSync(join(root, file), '')
  }
  return root
}

const root = project(['tests/a.spec.ts', 'tests/b.test.ts', 'tests/c.retest.ts', 'tests/deep/d.spec.mjs', 'node_modules/pkg/e.spec.ts', '.cache/f.spec.ts'])

describe('test files in a run of Playwright files', () => {
  test('with none named, every .spec file is taken and .test files are left out, as a project keeps its unit tests in them', () => {
    assert.deepEqual(findTestFiles(root, playwrightSpecSuffixes), ['tests/a.spec.ts', 'tests/deep/d.spec.mjs'])
    assert.deepEqual(everyTestFile(root, playwrightSpecSuffixes), ['tests/a.spec.ts', 'tests/deep/d.spec.mjs'])
    assert.deepEqual(findTestFiles(root), ['tests/c.retest.ts'], "Retest's own ending stays the default")
  })

  test('a named file may end in .spec or .test, and may carry a line', () => {
    assert.deepEqual(readFileArguments(root, ['tests/a.spec.ts:7', 'tests/b.test.ts'], playwrightFileSuffixes), {
      files: ['tests/a.spec.ts', 'tests/b.test.ts'],
      locations: [{ file: 'tests/a.spec.ts', line: 7 }],
    })
  })

  test('a file with another ending is refused, naming the endings of the run it is', () => {
    assert.throws(
      () => readFileArguments(root, ['tests/c.retest.ts'], playwrightFileSuffixes),
      /tests\/c\.retest\.ts is not a test file\. Test files end in \.spec\.ts, \.spec\.js, \.spec\.mts, \.spec\.mjs, \.test\.ts, \.test\.js, \.test\.mts or \.test\.mjs\./,
    )
    assert.throws(() => readFileArguments(root, ['tests/a.spec.ts']), /tests\/a\.spec\.ts is not a test file\. Test files end in \.retest\.ts\./)
  })

  test('finding none says which endings were looked for', () => {
    const empty = project(['notes.md'])
    assert.throws(() => everyTestFile(empty, playwrightSpecSuffixes), /No test files found\. Test files end in \.spec\.ts, \.spec\.js, \.spec\.mts or \.spec\.mjs\./)
    assert.throws(() => everyTestFile(empty), /No test files found\. Test files end in \.retest\.ts\./)
  })
})
