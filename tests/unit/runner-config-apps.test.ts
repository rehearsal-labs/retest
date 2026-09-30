import type { RetestEvent } from '../../src/protocol/events.ts'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { lastRunFile, lastRunSchema } from '../../src/protocol/last-run.ts'
import { targetBrowserLogFile } from '../../src/protocol/run-folder.ts'
import { parse } from '../../src/protocol/schema.ts'
import { findTargetExecutable } from '../../src/runner/target-executable.ts'
import { runProject, tempProject } from '../support/project.ts'
import { eventsOfType } from '../support/run-harness.ts'

const imports = `import { app, chromium, defineConfig } from '@rehearsal-labs/retest'\n`

const matrixConfig = `${imports}
export default defineConfig({
  apps: {
    web: app({
      baseUrl: 'http://127.0.0.1:4173',
      targets: { stable: chromium({ executablePath: '/fake/stable' }), beta: chromium({ executablePath: '/fake/beta' }) },
    }),
  },
})
`

const matrixTests = `import { expect, test } from '@rehearsal-labs/retest'

test('saves a task', async ({ page }) => {
  await page.goto('/tasks')
  await page.getByTestId('task-title').fill('Release checklist')
  await expect(page.getByTestId('task-title')).toHaveText('Release checklist')
})

test('shows a note', async ({ page }) => {
  await expect(page.getByTestId('hidden-note')).toBeVisible()
})
`

const attemptTypes = new Set<RetestEvent['type']>(['test.started', 'test.finished', 'navigation', 'action.completed', 'assertion.passed', 'assertion.failed', 'evidence.captured'])

describe('a test whose app has two targets', async () => {
  const record = await runProject(tempProject({ 'retest.config.ts': matrixConfig, 'tests/matrix.retest.ts': matrixTests }), { files: ['tests/matrix.retest.ts'] })
  const results = record.result.files.flatMap((file) => file.tests)

  test('runs once per target, and each result is unique by test id and variant key', () => {
    assert.deepEqual(
      results.map((result) => [result.name, result.variantKey, result.status]),
      [
        ['saves a task', 'web=stable', 'passed'],
        ['saves a task', 'web=beta', 'passed'],
        ['shows a note', 'web=stable', 'failed'],
        ['shows a note', 'web=beta', 'failed'],
      ],
    )
    assert.deepEqual(results[1]?.variant, { web: 'beta' })
    assert.equal(record.result.exitCode, 1)
    assert.deepEqual(record.written, record.result)
  })

  test('every event of an attempt carries its variant, which the parent adds', () => {
    const attempts = record.events.filter((event) => attemptTypes.has(event.type))
    assert.ok(attempts.length > 8)
    for (const event of attempts) {
      assert.ok('variantKey' in event && (event.variantKey === 'web=stable' || event.variantKey === 'web=beta'), `${event.type} has its variant`)
    }
    const fromChild = record.events.filter((event) => event.origin === 'child')
    assert.ok(fromChild.length > 0 && fromChild.every((event) => event.type.startsWith('assertion.') || event.type.startsWith('step.')))
    assert.equal(eventsOfType(record.events, 'action.completed')[0]?.session, 'web')
  })

  test('each target launches its own browser once, named with its app and target, with its own log', () => {
    assert.deepEqual(record.browsers.map((browser) => browser.executablePath), ['/fake/stable', '/fake/beta'])
    assert.deepEqual(record.browsers.map((browser) => browser.pages.length), [2, 2])
    assert.ok(record.browsers.every((browser) => browser.closed && browser.pages.every((page) => page.disposed)))
    assert.deepEqual(
      eventsOfType(record.events, 'browser.started').map((event) => [event.app, event.target, event.pid]),
      [
        ['web', { name: 'stable' }, record.browsers[0]?.pid],
        ['web', { name: 'beta' }, record.browsers[1]?.pid],
      ],
    )
    assert.equal(record.browsers[1]?.launchOptions.logFile, join(record.folder, targetBrowserLogFile('web=beta')))
    assert.deepEqual(record.result.browsers?.map((browser) => [browser.app, browser.target?.name]), [['web', 'stable'], ['web', 'beta']])
    assert.equal(record.browsers[0]?.pages[0]?.baseUrl, 'http://127.0.0.1:4173')
  })

  test('the run records its config and each collected test with its apps and variants', () => {
    assert.equal(eventsOfType(record.events, 'run.started')[0]?.options.config, 'retest.config.ts')
    assert.deepEqual(eventsOfType(record.events, 'collection.completed')[0]?.tests[0], {
      testId: 'tests/matrix.retest.ts > saves a task',
      name: 'saves a task',
      location: { file: 'tests/matrix.retest.ts', line: 3, column: 1 },
      apps: ['web'],
      variants: [{ web: 'stable' }, { web: 'beta' }],
    })
  })

  test('a failure takes a screenshot named with the app', () => {
    const [evidence] = results[2]?.evidence ?? []
    assert.equal(evidence?.app, 'web')
    assert.match(evidence?.path ?? '', /-web-[a-z0-9]+-failure\.png$/)
    assert.ok(existsSync(join(record.folder, evidence?.path ?? 'missing')))
  })

  test('.retest/last-run.json lists each run that did not pass, with its variant key', () => {
    const lastRun = parse(lastRunSchema, JSON.parse(readFileSync(join(record.root, lastRunFile), 'utf8')))
    assert.ok(lastRun.ok)
    assert.equal(lastRun.value.runId, record.result.runId)
    assert.deepEqual(lastRun.value.tests, [
      { testId: 'tests/matrix.retest.ts > shows a note', variantKey: 'web=stable', status: 'failed' },
      { testId: 'tests/matrix.retest.ts > shows a note', variantKey: 'web=beta', status: 'failed' },
    ])
  })
})

describe('--target', () => {
  test('keeps the variants on that target, and launches only its browser', async () => {
    const root = tempProject({ 'retest.config.ts': matrixConfig, 'tests/matrix.retest.ts': matrixTests })
    const record = await runProject(root, { files: ['tests/matrix.retest.ts'], selection: { targets: { web: 'beta' } } })
    assert.deepEqual(record.result.files[0]?.tests.map((result) => result.variantKey), ['web=beta', 'web=beta'])
    assert.deepEqual(record.browsers.map((browser) => browser.executablePath), ['/fake/beta'])
  })
})

describe('two apps in one test', async () => {
  const config = `${imports}
export default defineConfig({
  apps: {
    owner: chromium({ baseUrl: 'http://127.0.0.1:4173', executablePath: '/fake/chromium' }),
    member: chromium({ baseUrl: 'http://127.0.0.1:4174', executablePath: '/fake/chromium' }),
  },
  defaultApp: 'owner',
})
`
  const tests = `import { expect, test } from '@rehearsal-labs/retest'

test('shares a task', { apps: ['owner', 'member'] }, async ({ owner, member }) => {
  await owner.goto('/')
  await member.goto('/')
  await owner.getByTestId('task-title').fill('From owner')
  await member.getByTestId('task-title').fill('From member')
  await expect(owner.getByTestId('task-title')).toHaveText('From owner')
  await expect(member.getByTestId('hidden-note')).toBeVisible()
})
`
  const record = await runProject(tempProject({ 'retest.config.ts': config, 'tests/share.retest.ts': tests }), { files: ['tests/share.retest.ts'] })
  const [result] = record.result.files[0]?.tests ?? []
  const pages = record.browsers[0]?.pages ?? []

  test('each app gets its own page with its own base URL, and apps on the same target share one browser', () => {
    assert.equal(record.browsers.length, 1)
    assert.deepEqual(pages.map((page) => page.baseUrl), ['http://127.0.0.1:4173', 'http://127.0.0.1:4174'])
    const started = eventsOfType(record.events, 'browser.started')
    assert.deepEqual(started.map((event) => [event.app, event.pid]), [
      ['owner', record.browsers[0]?.pid],
      ['member', record.browsers[0]?.pid],
    ])
    assert.deepEqual(result?.variant, { owner: 'chromium', member: 'chromium' })
  })

  test('each command reaches the page of the app that sent it, and events name that app', () => {
    assert.deepEqual(pages.map((page) => page.typed.map((typed) => typed.value)), [['From owner'], ['From member']])
    assert.deepEqual(
      eventsOfType(record.events, 'navigation').map((event) => [event.session, event.url]),
      [
        ['owner', 'http://127.0.0.1:4173/'],
        ['member', 'http://127.0.0.1:4174/'],
      ],
    )
    assert.deepEqual(eventsOfType(record.events, 'action.completed').map((event) => event.session), ['owner', 'member', 'owner', 'member'])
    assert.deepEqual(eventsOfType(record.events, 'assertion.passed').map((event) => [event.session, event.pageUrl]), [['owner', 'http://127.0.0.1:4173/']])
  })

  test('a failure takes one screenshot of each app, named with the app', () => {
    assert.equal(result?.status, 'failed')
    assert.deepEqual(result?.evidence.map((evidence) => evidence.app), ['owner', 'member'])
    assert.equal(new Set(result?.evidence.map((evidence) => evidence.path)).size, 2)
    assert.deepEqual(eventsOfType(record.events, 'evidence.captured').map((event) => event.session), ['owner', 'member'])
    assert.ok(pages.every((page) => page.disposed))
  })
})

describe('targets that emulate a device', () => {
  test('the page gets the emulation, its user agent carries the browser version, and events say it is emulated', async () => {
    const config = `${imports}
export default defineConfig({
  apps: {
    phone: chromium({ baseUrl: 'http://127.0.0.1:4173', executablePath: '/fake/chromium', emulate: 'Pixel 9' }),
    desk: chromium({ baseUrl: 'http://127.0.0.1:4173', executablePath: '/fake/chromium' }),
  },
  defaultApp: 'phone',
})
`
    const tests = `import { expect, test } from '@rehearsal-labs/retest'
test('opens', { apps: ['phone', 'desk'] }, async ({ phone, desk }) => {
  await phone.goto('/')
  await phone.getByTestId('save-task').click()
  await desk.getByTestId('save-task').click()
  await expect(phone.getByTestId('save-task')).toBeVisible()
})
test('misses', async ({ page }) => {
  await page.getByTestId('missing').click()
})
`
    const record = await runProject(tempProject({ 'retest.config.ts': config, 'tests/phone.retest.ts': tests }), {
      files: ['tests/phone.retest.ts'],
      fake: { version: '154.0.7195.41' },
    })
    assert.deepEqual(record.result.files[0]?.tests.map((result) => [result.name, result.status]), [['opens', 'passed'], ['misses', 'failed']])
    assert.equal(record.browsers.length, 2, 'a target that emulates is distinct from one that does not')
    const recorded = eventsOfType(record.events, 'action.completed').filter((event) => event.command !== 'goto')
    assert.deepEqual(recorded.map((event) => [event.session, event.command]), [['phone', 'tap'], ['desk', 'click']], 'a click on a touch screen is recorded as a tap')
    assert.deepEqual(eventsOfType(record.events, 'action.failed').map((event) => [event.session, event.command, event.failure.class]), [['phone', 'tap', 'not_found']])
    const emulation = record.browsers[0]?.pages[0]?.options.emulation
    assert.deepEqual(emulation?.viewport, { width: 412, height: 923 })
    assert.match(emulation?.userAgent ?? '', /Chrome\/154\.0\.0\.0 Mobile/)
    assert.equal(record.browsers[1]?.pages[0]?.options.emulation, undefined)
    const [phone, desk] = eventsOfType(record.events, 'browser.started')
    assert.equal(phone?.target?.device, 'Pixel 9')
    assert.deepEqual(phone?.target?.emulation, emulation)
    assert.deepEqual(desk?.target, { name: 'chromium' })
  })
})

describe('the command line', () => {
  test('a base URL replaces the app’s own for its pages, and is recorded without credentials', async () => {
    const root = tempProject({ 'retest.config.ts': matrixConfig, 'tests/matrix.retest.ts': matrixTests })
    const record = await runProject(root, {
      files: ['tests/matrix.retest.ts'],
      baseUrls: { web: 'https://ada:secret@preview.example' },
      selection: { grep: 'saves', targets: { web: 'stable' } },
    })
    assert.equal(record.browsers[0]?.pages[0]?.baseUrl, 'https://ada:secret@preview.example')
    assert.deepEqual(eventsOfType(record.events, 'run.started')[0]?.options.baseUrls, { web: 'https://preview.example/' })
    assert.ok(!record.lines.some((line) => line.includes('ada:secret')))
  })

  test('a base URL for an app the config lacks is a usage failure: nothing loads and the run exits 2', async () => {
    const root = tempProject({ 'retest.config.ts': matrixConfig, 'tests/matrix.retest.ts': matrixTests })
    const record = await runProject(root, { files: ['tests/matrix.retest.ts'], baseUrls: { admin: 'http://127.0.0.1:1' } })
    const problem = { class: 'usage', message: '--base-url names the app "admin", which the config does not have.' }
    assert.deepEqual([record.result.exitCode, record.result.failure], [2, problem])
    assert.deepEqual(record.result.files[0]?.failure, { class: 'usage', message: `Not loaded: ${problem.message}` })
    assert.equal(record.browsers.length, 0)
  })
})

describe('a target whose browser cannot be found', () => {
  test('keeps the tests that need it from running, with the reason, and the run exits 2', async () => {
    const config = `${imports}
export default defineConfig({ apps: { web: chromium({ baseUrl: 'http://127.0.0.1:4173', executablePath: '/nowhere/chromium' }) } })
`
    const record = await runProject(tempProject({ 'retest.config.ts': config, 'tests/matrix.retest.ts': matrixTests }), {
      files: ['tests/matrix.retest.ts'],
      findExecutable: findTargetExecutable,
    })
    const reason = { class: 'setup_failed', message: 'No browser at /nowhere/chromium, the path executablePath gives. Install one there, or change the path.' }
    assert.deepEqual(record.result.files[0]?.tests.map((result) => [result.status, result.failure]), [['not_run', reason], ['not_run', reason]])
    assert.deepEqual([record.result.exitCode, record.result.failure], [2, reason])
    assert.equal(record.browsers.length, 0)
  })
})

describe('two apps with several targets each', () => {
  const config = (runs: string) => `${imports}
export default defineConfig({
  apps: {
    web: app({ baseUrl: 'http://127.0.0.1:4173', targets: { stable: chromium({ executablePath: '/fake/stable' }), beta: chromium({ executablePath: '/fake/beta' }) } }),
    admin: app({ baseUrl: 'http://127.0.0.1:4174', targets: { stable: chromium({ executablePath: '/fake/stable' }), beta: chromium({ executablePath: '/fake/beta' }) } }),
  },
  defaultApp: 'web',
  ${runs}
})
`
  const tests = `import { expect, test } from '@rehearsal-labs/retest'
test('syncs', { apps: ['web', 'admin'] }, async ({ web }) => {
  await expect(web.getByTestId('save-task')).toBeVisible()
})
`

  test('run only the runs entries that cover them', async () => {
    const root = tempProject({ 'retest.config.ts': config(`runs: [{ web: 'stable', admin: 'beta' }],`), 'tests/sync.retest.ts': tests })
    const record = await runProject(root, { files: ['tests/sync.retest.ts'] })
    assert.deepEqual(record.result.files[0]?.tests.map((result) => result.variantKey), ['admin=beta,web=stable'])
    assert.equal(record.browsers.length, 2)
  })

  test('without an entry, the file fails collection and nothing in it runs', async () => {
    const root = tempProject({ 'retest.config.ts': config(''), 'tests/sync.retest.ts': tests })
    const record = await runProject(root, { files: ['tests/sync.retest.ts'] })
    const [failed] = eventsOfType(record.events, 'collection.failed')
    assert.equal(failed?.failure.class, 'collection_failed')
    assert.match(failed?.failure.message ?? '', /^"syncs": This test uses "web" and "admin", which have several targets each/)
    assert.deepEqual([record.result.exitCode, record.browsers.length], [2, 0])
  })
})
