import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { splitTests, writeTests } from '../../benchmarks/generate.ts'
import { tempFolder } from '../support/temp-folder.ts'

describe('splitTests', () => {
  test('spreads the tests over exactly the files asked for, the first files one larger when uneven', () => {
    assert.deepEqual(splitTests(5, 4), [
      { first: 1, last: 2 },
      { first: 3, last: 3 },
      { first: 4, last: 4 },
      { first: 5, last: 5 },
    ])
    assert.deepEqual(splitTests(1, 1), [{ first: 1, last: 1 }])
    assert.deepEqual(splitTests(20, 1), [{ first: 1, last: 20 }])
    const even = splitTests(200, 10)
    assert.equal(even.length, 10)
    assert.ok(even.every((range) => range.last - range.first === 19))
    assert.equal(even.at(-1)?.last, 200)
  })
})

describe('writeTests', () => {
  test('writes every test once, across exactly the files asked for, with the tool import on the first line', async () => {
    const project = tempFolder('bench-')
    const files = await writeTests(project, 'playwright', 'task-app', { tests: 5, files: 4 })
    assert.deepEqual(
      files.map((file) => file.slice(project.length + 1)),
      ['tests/bench-1.spec.ts', 'tests/bench-2.spec.ts', 'tests/bench-3.spec.ts', 'tests/bench-4.spec.ts'],
    )
    const texts = await Promise.all(files.map((file) => readFile(file, 'utf8')))
    assert.ok(texts.every((text) => text.startsWith("import { expect, test } from '@playwright/test'\n")))
    const titles = texts.flatMap((text) => [...text.matchAll(/^test\('(.*?)'/gm)].map((match) => match[1]))
    assert.deepEqual(titles, ['saves task 1', 'saves task 2', 'saves task 3', 'saves task 4', 'saves task 5'])
  })

  test('replaces what the folder held and names Retest files by their suffix', async () => {
    const project = tempFolder('bench-')
    await writeTests(project, 'playwright', 'task-app', { tests: 3, files: 3 })
    await writeTests(project, 'retest', 'search-app', { tests: 2, files: 1 })
    assert.deepEqual(await readdir(join(project, 'tests')), ['bench-1.retest.ts'])
    const text = await readFile(join(project, 'tests', 'bench-1.retest.ts'), 'utf8')
    assert.match(text, /^import \{ expect, test \} from '@rehearsal-labs\/retest'\n/)
    assert.match(text, /toHaveText\('3 results for release'\)/)
  })
})
