import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, test } from 'node:test'
import { findTsconfig, parseJsonWithComments, readTsconfig } from '../../src/loader/tsconfig.ts'
import { tempFolder } from '../support/temp-folder.ts'

// A project folder with these files, by its real path, as Node and the reader name files.
function project(files: Readonly<Record<string, string>>): string {
  const root = realpathSync(tempFolder('tsconfig-'))
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  return root
}

// The aliases of the tsconfig nearest the folder, which must be there and read.
function aliasesOf(folder: string) {
  const found = findTsconfig(folder)
  assert.ok(found !== undefined, `a tsconfig.json is at or above ${folder}`)
  const read = readTsconfig(found)
  assert.ok(read.ok, read.ok ? '' : read.failure.message)
  return read.paths
}

function failureOf(folder: string) {
  const found = findTsconfig(folder)
  assert.ok(found !== undefined, `a tsconfig.json is at or above ${folder}`)
  const read = readTsconfig(found)
  assert.ok(!read.ok, 'the tsconfig is refused')
  assert.equal(read.failure.class, 'usage')
  return read.failure.message
}

describe('parseJsonWithComments', () => {
  test('reads line and block comments and trailing commas as spaces, and leaves comment markers inside strings alone', () => {
    const text = '{\n  // a line comment\n  "url": "http://x//y", /* a block\n comment */ "glob": "a/*/b",\n  "list": [1, 2,],\n}\n'
    assert.deepEqual(parseJsonWithComments(text), { url: 'http://x//y', glob: 'a/*/b', list: [1, 2] })
    assert.deepEqual(parseJsonWithComments('﻿{ "a": "quote \\" // still text" }'), { a: 'quote " // still text' })
  })

  test('keeps positions, so an error names the place in the file', () => {
    assert.throws(() => parseJsonWithComments('{\n  // note\n  "a": 1\n  "b": 2\n}'), /line 4 column 3/)
  })
})

describe('findTsconfig', () => {
  test('finds the tsconfig.json in the folder or the nearest one above it, and none where there is none', () => {
    const root = project({ 'tsconfig.json': '{}', 'tests/deep/a.ts': '' })
    assert.equal(findTsconfig(join(root, 'tests/deep')), join(root, 'tsconfig.json'))
    const nested = project({ 'tsconfig.json': '{}', 'tests/tsconfig.json': '{}' })
    assert.equal(findTsconfig(join(nested, 'tests')), join(nested, 'tests/tsconfig.json'))
    const folder = project({ 'tsconfig.json/readme': 'a folder with the name, not a file' })
    assert.notEqual(findTsconfig(folder), join(folder, 'tsconfig.json'))
  })
})

describe('readTsconfig', () => {
  test('resolves paths against baseUrl, keeping each pattern and its targets in order', () => {
    const root = project({ 'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: './src', paths: { '@app/*': ['app/*', 'fallback/*'], config: ['config/index.ts'] } } }) })
    assert.deepEqual(aliasesOf(root), {
      file: join(root, 'tsconfig.json'),
      folder: root,
      aliases: [
        { pattern: '@app/*', targets: [join(root, 'src/app/*'), join(root, 'src/fallback/*')] },
        { pattern: 'config', targets: [join(root, 'src/config/index.ts')] },
      ],
    })
  })

  test('without baseUrl, paths are read from the folder of the file that declares them', () => {
    const root = project({
      'tsconfig.json': JSON.stringify({ extends: './configs/base.json' }),
      'configs/base.json': JSON.stringify({ compilerOptions: { paths: { '@support/*': ['../support/*'] } } }),
    })
    assert.deepEqual(aliasesOf(root).aliases, [{ pattern: '@support/*', targets: [join(root, 'support/*')] }])
  })

  test('a baseUrl from an extended file applies to paths the extending file declares, from the folder that set it', () => {
    const root = project({
      'tsconfig.json': '{\n  // comments are allowed\n  "extends": "./configs/base",\n  "compilerOptions": { "paths": { "@t/*": ["tests/*"], }, },\n}\n',
      'configs/base.json': JSON.stringify({ compilerOptions: { baseUrl: '..', paths: { '@gone/*': ['gone/*'] } } }),
    })
    assert.deepEqual(aliasesOf(root).aliases, [{ pattern: '@t/*', targets: [join(root, 'tests/*')] }], 'the own paths replace the extended ones')
  })

  test('a list of extended files applies in order, the later winning, and null clears an extended setting', () => {
    const root = project({
      'tsconfig.json': JSON.stringify({ extends: ['./one.json', './two.json'], compilerOptions: { baseUrl: null } }),
      'one.json': JSON.stringify({ compilerOptions: { paths: { '@one/*': ['one/*'] } } }),
      'two.json': JSON.stringify({ compilerOptions: { baseUrl: 'lib', paths: { '@two/*': ['two/*'] } } }),
    })
    assert.deepEqual(aliasesOf(root).aliases, [{ pattern: '@two/*', targets: [join(root, 'two/*')] }])
  })

  test('extends names a package by its tsconfig, found from the extending file', () => {
    const root = project({
      'tsconfig.json': JSON.stringify({ extends: '@acme/tsconfig' }),
      'node_modules/@acme/tsconfig/package.json': JSON.stringify({ name: '@acme/tsconfig' }),
      'node_modules/@acme/tsconfig/tsconfig.json': JSON.stringify({ compilerOptions: { paths: { '~/*': ['${configDir}/src/*'] } } }),
    })
    assert.deepEqual(aliasesOf(root).aliases, [{ pattern: '~/*', targets: [join(root, 'src/*')] }], '${configDir} is the folder of the tsconfig that was read')
  })

  test('a tsconfig without paths has no aliases, and one that is empty or holds only comments reads as {}, as tsc reads it', () => {
    const root = project({ 'tsconfig.json': '{ "compilerOptions": { "strict": true } }' })
    assert.deepEqual(aliasesOf(root).aliases, [])
    assert.deepEqual(aliasesOf(project({ 'tsconfig.json': '' })).aliases, [])
    assert.deepEqual(aliasesOf(project({ 'tsconfig.json': '\n  // nothing set yet\n  /* or here */\n' })).aliases, [])
    const extending = project({ 'tsconfig.json': JSON.stringify({ extends: './empty.json', compilerOptions: { paths: { '@a/*': ['./a/*'] } } }), 'empty.json': '' })
    assert.deepEqual(aliasesOf(extending).aliases, [{ pattern: '@a/*', targets: [join(extending, 'a/*')] }])
  })

  test("extends names a package whose package.json gives its tsconfig in a tsconfig field, as tsc resolves it", () => {
    const root = project({
      'tsconfig.json': JSON.stringify({ extends: '@acme/base' }),
      'node_modules/@acme/base/package.json': JSON.stringify({ name: '@acme/base', tsconfig: 'configs/strict.json' }),
      'node_modules/@acme/base/configs/strict.json': JSON.stringify({ compilerOptions: { paths: { '@x/*': ['./x/*'] } } }),
    })
    assert.deepEqual(aliasesOf(root).aliases, [{ pattern: '@x/*', targets: [join(root, 'node_modules/@acme/base/configs/x/*')] }], 'paths are read from the file that declares them')
  })

  test('a tsconfig that is not JSON, or not an object, is a usage failure naming the file', () => {
    const broken = project({ 'tsconfig.json': '{ "compilerOptions": { "paths": ' })
    assert.match(failureOf(broken), new RegExp(`^${join(broken, 'tsconfig.json')} is not valid JSON: `))
    const list = project({ 'tsconfig.json': '[]' })
    assert.equal(failureOf(list), `${join(list, 'tsconfig.json')} must hold a JSON object.`)
  })

  test('a tsconfig that cannot be read is a usage failure naming the file', { skip: process.getuid?.() === 0 ? 'root reads any file' : false }, () => {
    const root = project({ 'tsconfig.json': '{}' })
    chmodSync(join(root, 'tsconfig.json'), 0o000)
    try {
      assert.match(failureOf(root), new RegExp(`^${join(root, 'tsconfig.json')} could not be read: EACCES`))
    } finally {
      chmodSync(join(root, 'tsconfig.json'), 0o644)
    }
  })

  test('an extended file that is not there, and one that extends itself, are usage failures naming the files', () => {
    const missing = project({ 'tsconfig.json': JSON.stringify({ extends: './base.json' }) })
    assert.equal(failureOf(missing), `${join(missing, 'tsconfig.json')} extends "./base.json", and there is no file for it.`)
    const absent = project({ 'tsconfig.json': JSON.stringify({ extends: '@acme/missing' }) })
    assert.equal(failureOf(absent), `${join(absent, 'tsconfig.json')} extends "@acme/missing", and there is no file for it.`)
    const cycle = project({ 'tsconfig.json': JSON.stringify({ extends: './a.json' }), 'a.json': JSON.stringify({ extends: './tsconfig.json' }) })
    const [leaf, other] = [join(cycle, 'tsconfig.json'), join(cycle, 'a.json')]
    assert.equal(failureOf(cycle), `${leaf} extends itself: ${leaf} extends ${other} extends ${leaf}.`)
  })

  test('settings TypeScript would refuse are usage failures naming the file and the setting', () => {
    const cases: [unknown, string][] = [
      [{ extends: 3 }, 'extends must be a path or a list of paths.'],
      [{ compilerOptions: [] }, 'compilerOptions must be an object.'],
      [{ compilerOptions: { baseUrl: 1 } }, 'baseUrl must be a path.'],
      [{ compilerOptions: { paths: ['a'] } }, 'paths must be an object of patterns and their paths.'],
      [{ compilerOptions: { paths: { '@a/*': 'a/*' } } }, 'paths["@a/*"] must be a list of paths.'],
      [{ compilerOptions: { paths: { '@a/*/*': ['a/*'] } } }, '"@a/*/*" in paths has more than one *.'],
      [{ compilerOptions: { paths: { '@a/*': ['a/*/*'] } } }, '"a/*/*" in paths has more than one *.'],
    ]
    for (const [json, problem] of cases) {
      const root = project({ 'tsconfig.json': JSON.stringify(json) })
      assert.equal(failureOf(root), `${join(root, 'tsconfig.json')}: ${problem}`)
    }
  })
})
