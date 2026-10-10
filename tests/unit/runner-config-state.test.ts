import assert from 'node:assert/strict'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { statesFolder } from '../../src/protocol/run-folder.ts'
import { createHumanReporter } from '../../src/reporters/human.ts'
import { runProject, tempProject } from '../support/project.ts'
import { eventsOfType } from '../support/run-harness.ts'
import { capture } from './reporters-fixtures.ts'

const config = `import { app, chromium, defineConfig } from '@rehearsal-labs/retest'
export default defineConfig({
  apps: {
    web: app({
      baseUrl: 'http://127.0.0.1:4173',
      targets: { stable: chromium({ executablePath: '/fake/stable' }), beta: chromium({ executablePath: '/fake/beta' }) },
    }),
  },
  states: ['signed-in'],
})
`

// The dependents sort before the setup, so the run has to reach ahead for it.
const archive = `import { expect, test } from '@rehearsal-labs/retest'

test('starts signed in', { state: 'signed-in' }, async ({ page }) => {
  await expect(page.getByTestId('session')).toHaveText('Signed in')
})

test('starts signed out', async ({ page }) => {
  await expect(page.getByTestId('session')).toHaveText('Signed out')
})
`

const signIn = (expected: string) => `import { expect, test } from '@rehearsal-labs/retest'

test.setup('signed-in', async ({ page }) => {
  await page.goto('/login')
  await page.getByTestId('sign-in').click()
  await expect(page.getByTestId('session')).toHaveText('${expected}')
})
`

function project(setupExpects = 'Signed in'): string {
  return tempProject({ 'retest.config.ts': config, 'tests/archive.retest.ts': archive, 'tests/sign-in.retest.ts': signIn(setupExpects) })
}

const files = ['tests/archive.retest.ts', 'tests/sign-in.retest.ts']

describe('a setup that passes', async () => {
  const record = await runProject(project(), { files, fake: {
    sessionCookieValue: (executablePath) => {
      assert.ok(executablePath === '/fake/stable' || executablePath === '/fake/beta')
      return executablePath === '/fake/stable' ? 'stable-session-2718' : 'beta-session-3141'
    },
  } })
  const tests = record.result.files.flatMap((file) => file.tests)

  test('runs once per target before the tests that need its state, and is marked as a setup', () => {
    const started = eventsOfType(record.events, 'test.started').map((event) => `${event.name} ${event.variantKey}${event.setup === true ? ' setup' : ''}`)
    assert.deepEqual(started.slice(0, 2), ['signed-in web=stable setup', 'signed-in web=beta setup'])
    assert.equal(started.length, 6)
    assert.deepEqual(record.result.files[1]?.tests.map((result) => [result.setup, result.status]), [[true, 'passed'], [true, 'passed']])
    assert.equal(record.result.exitCode, 0)
  })

  test('the saved state is restored into the new page of each test that names it, for its own target', () => {
    const restored = record.browsers.map((browser) => browser.pages[1]?.options.storageState?.cookies.map((cookie) => cookie.value))
    assert.deepEqual(record.browsers.map((browser) => browser.launchOptions.executablePath), ['/fake/stable', '/fake/beta'])
    assert.deepEqual(record.browsers.map((browser) => browser.pages[0]?.cookies.map((cookie) => cookie.value)), [['stable-session-2718'], ['beta-session-3141']])
    assert.deepEqual(restored, [['stable-session-2718'], ['beta-session-3141']])
    assert.ok(record.browsers.every((browser) => browser.pages[2]?.options.storageState === undefined), 'a test without state starts signed out')
    assert.deepEqual(tests.map((result) => result.status), ['passed', 'passed', 'passed', 'passed', 'passed', 'passed'])
  })

  test('states are saved and restored as events that carry no contents', () => {
    const saved = eventsOfType(record.events, 'state.saved')
    assert.deepEqual(saved.map(({ state, app, target, variantKey }) => ({ state, app, target, variantKey })), [
      { state: 'signed-in', app: 'web', target: 'stable', variantKey: 'web=stable' },
      { state: 'signed-in', app: 'web', target: 'beta', variantKey: 'web=beta' },
    ])
    assert.equal(eventsOfType(record.events, 'state.restored').length, 2)
    for (const cookie of ['signed-in-0', 'stable-session-2718', 'beta-session-3141']) {
      assert.ok(!record.lines.some((line) => line.includes(cookie)), 'no event holds the cookie')
    }
  })

  test('no state file is left once the run ends', () => {
    assert.equal(existsSync(join(record.folder, statesFolder)), false)
    assert.ok(!readdirSync(record.folder).includes(statesFolder))
  })
})

describe('a setup that fails', () => {
  test('keeps every test that needs its state from running, with its failure as the reason; the others run', async () => {
    const record = await runProject(project('Welcome'), { files })
    const dependent = record.result.files[0]?.tests.filter((result) => result.name === 'starts signed in') ?? []
    assert.deepEqual(dependent.map((result) => result.status), ['not_run', 'not_run'])
    const [first] = dependent
    assert.equal(first?.failure?.class, 'check_failed')
    assert.match(first?.failure?.message ?? '', /^Not run: the setup "signed-in" did not pass on stable\. getByTestId\('session'\) has text "Signed in", expected "Welcome"/)
    assert.equal(first?.failure?.location?.file, 'tests/sign-in.retest.ts')
    assert.deepEqual(record.result.files[0]?.tests.filter((result) => result.name === 'starts signed out').map((result) => result.status), ['passed', 'passed'])
    assert.equal(eventsOfType(record.events, 'state.saved').length, 0)
    assert.equal(record.result.exitCode, 1)
  })

  test('to save its state keeps its dependents from running too', async () => {
    const record = await runProject(project(), { files, fake: { captureFails: true } })
    const [setup] = record.result.files[1]?.tests ?? []
    assert.deepEqual([setup?.status, setup?.failure?.class], ['error', 'setup_failed'])
    assert.equal(setup?.failure?.message, 'Retest could not save the state "signed-in": The cookies could not be read.')
    const [dependent] = record.result.files[0]?.tests ?? []
    assert.equal(dependent?.status, 'not_run')
  })
})

describe('choosing tests with states', () => {
  test('a selected test pulls in its setup, only for the targets it runs on', async () => {
    const record = await runProject(project(), { files, selection: { grep: 'signed in', targets: { web: 'beta' } } })
    const ran = record.result.files.flatMap((file) => file.tests).map((result) => `${result.name} ${result.variantKey}`)
    assert.deepEqual(ran, ['starts signed in web=beta', 'signed-in web=beta'])
    assert.equal(record.result.exitCode, 0)
  })

})

describe('a setup in a file the run was not given', () => {
  const alsoInSignIn = `
test('a test beside the setup', async ({ page }) => {
  await expect(page.getByTestId('session')).toHaveText('Signed out')
})
`
  const withNeighbour = () =>
    tempProject({ 'retest.config.ts': config, 'tests/archive.retest.ts': archive, 'tests/sign-in.retest.ts': signIn('Signed in') + alsoInSignIn })

  test('is found among the project test files, and only the setup runs from its file', async () => {
    const stdout = capture()
    const human = createHumanReporter({ stdout, stderr: capture(), color: false, runFolder: 'run' })
    const record = await runProject(withNeighbour(), { files: ['tests/archive.retest.ts'], reporters: [human] })
    assert.deepEqual(record.result.files.map((file) => [file.file, file.tests.map((result) => `${result.name} ${result.variantKey}`)]), [
      ['tests/archive.retest.ts', ['starts signed in web=stable', 'starts signed in web=beta', 'starts signed out web=stable', 'starts signed out web=beta']],
      ['tests/sign-in.retest.ts', ['signed-in web=stable', 'signed-in web=beta']],
    ])
    assert.equal(record.result.exitCode, 0)
    const [, borrowed] = eventsOfType(record.events, 'collection.completed')
    assert.deepEqual(borrowed?.tests.map(({ name, setup, setupFor }) => ({ name, setup, setupFor })), [
      { name: 'signed-in', setup: true, setupFor: ['tests/archive.retest.ts'] },
    ])
    assert.deepEqual(record.result.files.map((file) => file.collection), ['ok', 'ok'])
    const note = 'ran setup signed-in from tests/sign-in.retest.ts for tests/archive.retest.ts'
    assert.equal(stdout.text.split('\n').filter((line) => line.trim() === note).length, 2, stdout.text)
  })

  test('is not run for a selection that needs no state', async () => {
    const record = await runProject(withNeighbour(), { files: ['tests/archive.retest.ts'], selection: { grep: 'signed out' } })
    assert.deepEqual(record.result.files.map((file) => [file.file, file.tests.length]), [['tests/archive.retest.ts', 2], ['tests/sign-in.retest.ts', 0]])
    assert.equal(eventsOfType(record.events, 'test.started').filter((event) => event.setup === true).length, 0)
  })

  test('when no file saves the state, the file that names it fails collection, and the message names the state', async () => {
    const root = tempProject({ 'retest.config.ts': config, 'tests/archive.retest.ts': archive, 'tests/other.retest.ts': alsoInSignIn.replace('\n', "import { expect, test } from '@rehearsal-labs/retest'\n") })
    const record = await runProject(root, { files: ['tests/archive.retest.ts'] })
    assert.equal(record.result.files.length, 1)
    assert.equal(record.result.files[0]?.collection, 'failed')
    assert.match(record.result.files[0]?.failure?.message ?? '', /: No test file saves the state "signed-in"\. Declare test\.setup\("signed-in", \.\.\.\) in one\.$/)
    assert.equal(record.result.exitCode, 2)
  })

  test('names the files it could not load to look in, without keeping their output', async () => {
    const broken = `console.error('broken file output')\nthrow new Error('broken')\n`
    const root = tempProject({ 'retest.config.ts': config, 'tests/archive.retest.ts': archive, 'tests/broken.retest.ts': broken })
    const record = await runProject(root, { files: ['tests/archive.retest.ts'] })
    assert.match(record.result.files[0]?.failure?.message ?? '', /in one\. Retest could not load tests\/broken\.retest\.ts to look there\.$/)
    assert.ok(!record.output.some((chunk) => chunk.text.includes('broken file output')), 'the output of a file looked through is not kept')
  })
})
