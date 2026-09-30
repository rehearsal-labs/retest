import type { RegisteredTest } from '../../src/protocol/messages.ts'
import type { CollectedTests } from '../../src/runner/plan.ts'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { searchSetups } from '../../src/runner/setup-search.ts'
import { tempFolder } from '../support/temp-folder.ts'

const location = { file: 'tests/x.retest.ts', line: 1, column: 1 }

function registered(name: string, options: Partial<RegisteredTest> = {}): RegisteredTest {
  return { name, location, ...options }
}

const setup = (name: string, options: Partial<RegisteredTest> = {}): RegisteredTest => registered(name, { setup: true, ...options })

// A project whose files the search can find, and a loader that answers for each from `files` and counts its calls.
function project(files: Record<string, RegisteredTest[] | 'broken'>) {
  const root = tempFolder('setup-search-')
  for (const file of Object.keys(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    writeFileSync(join(root, file), '')
  }
  const loads: string[] = []
  const collect = async (file: string): Promise<CollectedTests> => {
    loads.push(file)
    const tests = files[file]
    if (tests === undefined || tests === 'broken') return { file, ok: false, failure: { class: 'collection_failed', message: 'broken' } }
    return { file, ok: true, tests }
  }
  return { root, loads, collect }
}

const archive: CollectedTests = {
  file: 'tests/archive.retest.ts',
  ok: true,
  tests: [registered('archives', { state: 'signed-in' }), registered('lists')],
}

test('takes only the setups that save a missing state, and loads files in path order until every one is found', async () => {
  const { root, loads, collect } = project({
    'tests/archive.retest.ts': archive.ok ? archive.tests : [],
    'tests/a-other.retest.ts': [registered('other'), setup('unused')],
    'tests/b-sign-in.retest.ts': [registered('beside'), setup('signed-in'), setup('also-unused')],
    'tests/c-later.retest.ts': [setup('signed-in')],
  })
  const search = await searchSetups({ rootDir: root, collected: [archive], collect })
  assert.deepEqual(search, { borrowed: [{ file: 'tests/b-sign-in.retest.ts', ok: true, tests: [setup('signed-in')], borrowed: true }], unreadable: [] })
  assert.deepEqual(loads, ['tests/a-other.retest.ts', 'tests/b-sign-in.retest.ts'], 'the named file is not loaded again, and the search stops once done')
})

test('loads nothing when every state has its setup among the collected files', async () => {
  const { root, loads, collect } = project({ 'tests/sign-in.retest.ts': [setup('signed-in')] })
  const signIn: CollectedTests = { file: 'tests/sign-in.retest.ts', ok: true, tests: [setup('signed-in')] }
  assert.deepEqual(await searchSetups({ rootDir: root, collected: [archive, signIn], collect }), { borrowed: [], unreadable: [] })
  assert.deepEqual(loads, [])
})

test('a setup that starts from a state brings its setup too, from a file already looked through', async () => {
  const needsAdmin: CollectedTests = { file: 'tests/archive.retest.ts', ok: true, tests: [registered('archives', { state: { web: 'admin' } })] }
  const { root, collect } = project({
    'tests/a-sign-in.retest.ts': [setup('signed-in')],
    'tests/b-admin.retest.ts': [setup('admin', { state: 'signed-in' })],
  })
  const search = await searchSetups({ rootDir: root, collected: [needsAdmin], collect })
  assert.deepEqual(search.borrowed.map((entry) => [entry.file, entry.ok ? entry.tests.map((each) => each.name) : []]), [
    ['tests/a-sign-in.retest.ts', ['signed-in']],
    ['tests/b-admin.retest.ts', ['admin']],
  ])
})

test('names every file it could not load, and borrows nothing when no file saves the state', async () => {
  const { root, collect } = project({ 'tests/a-broken.retest.ts': 'broken', 'tests/b-plain.retest.ts': [registered('plain')] })
  assert.deepEqual(await searchSetups({ rootDir: root, collected: [archive], collect }), { borrowed: [], unreadable: ['tests/a-broken.retest.ts'] })
})
