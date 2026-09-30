import type { HostCheck } from '../../src/protocol/host-check.ts'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { BrowserError } from '../../src/browser/browser-error.ts'
import { resultFile, testId } from '../../src/protocol/run-folder.ts'
import { runProject, tempProject } from '../support/project.ts'
import { eventsOfType, runSupportFiles, supportFile, testNamed } from '../support/run-harness.ts'

const file = supportFile('host-checks.retest.ts')
const saves = testId(file, 'saves a task')
const failsItself = testId(file, 'fails itself')
const origin = 'http://127.0.0.1:4173'
const onlySaves = { grep: 'saves a task' }

describe('host checks that pass', async () => {
  const checks: HostCheck[] = [
    { kind: 'address', origin, path: '/done' },
    { kind: 'text', text: 'SAVE', ignoreCase: true, name: 'shows the button' },
    { kind: 'text', text: 'Error', absent: true },
    { kind: 'address', origin: `${origin}/`, path: /^\/do/ },
  ]
  const record = await runSupportFiles(['host-checks.retest.ts'], { hostChecks: { [saves]: checks }, selection: onlySaves })
  const result = testNamed(record.result, 'saves a task')

  test('pass the test, as parent events and in the result, in the order given', () => {
    assert.deepEqual([record.result.exitCode, result.status, result.failure], [0, 'passed', undefined])
    const passed = eventsOfType(record.events, 'host_check.passed')
    assert.deepEqual(
      passed.map((event) => [event.origin, event.session, event.check, event.actual]),
      [
        ['parent', 'page', { kind: 'address', origin, path: '/done' }, { url: `${origin}/done` }],
        ['parent', 'page', { kind: 'text', name: 'shows the button', text: 'SAVE', ignoreCase: true }, { url: `${origin}/done`, found: true }],
        ['parent', 'page', { kind: 'text', text: 'Error', absent: true }, { url: `${origin}/done`, found: false }],
        ['parent', 'page', { kind: 'address', origin, path: { pattern: '^\\/do', flags: '' } }, { url: `${origin}/done` }],
      ],
    )
    assert.ok(passed.every((event) => event.attempts === 1 && event.timeoutMs === 300 && event.testId === saves))
    assert.deepEqual(result.hostChecks?.map((entry) => [entry.status, entry.app]), [['passed', 'page'], ['passed', 'page'], ['passed', 'page'], ['passed', 'page']])
    assert.equal(eventsOfType(record.events, 'host_check.failed').length, 0)
  })

  test('run after the body and before the test finishes, and take no screenshot', () => {
    const types = record.events.map((event) => event.type)
    const firstCheck = types.indexOf('host_check.passed')
    assert.ok(firstCheck > types.lastIndexOf('assertion.passed'))
    assert.ok(firstCheck < types.indexOf('test.finished'))
    assert.deepEqual(result.evidence, [])
  })

  test('the page is only read, and each text check sends its own text', () => {
    const page = record.browsers[0]?.pages[0]
    assert.deepEqual(page?.reads, [[], [{ text: 'SAVE', ignoreCase: true }], [{ text: 'Error', ignoreCase: false }], []])
    assert.equal(page?.clicks, 1)
  })

  test('run.started records what the run was asked to check', () => {
    const recorded = eventsOfType(record.events, 'run.started')[0]?.options.hostChecks
    assert.deepEqual(recorded, {
      [saves]: [
        { kind: 'address', origin, path: '/done' },
        { kind: 'text', name: 'shows the button', text: 'SAVE', ignoreCase: true },
        { kind: 'text', text: 'Error', absent: true },
        { kind: 'address', origin, path: { pattern: '^\\/do', flags: '' } },
      ],
    })
  })
})

describe('a host check that fails', async () => {
  const checks: HostCheck[] = [
    { kind: 'address', origin, path: '/elsewhere' },
    { kind: 'text', text: 'Release checklist' },
    { kind: 'text', text: 'Release', absent: true, timeoutMs: 60, name: 'no task yet' },
  ]
  const record = await runSupportFiles(['host-checks.retest.ts'], { hostChecks: { [saves]: checks }, selection: onlySaves })
  const result = testNamed(record.result, 'saves a task')

  test('fails the test with host_check_failed and exit 1: the first failed check, the others in also, every check run', () => {
    assert.deepEqual([record.result.exitCode, result.status, result.failure?.class], [1, 'failed', 'host_check_failed'])
    assert.match(result.failure?.message ?? '', /^The address check on page failed: the page is on http:\/\/127\.0\.0\.1:4173\/done, expected http:\/\/127\.0\.0\.1:4173\/elsewhere\. Looked \d+ times in 300 ms\.$/)
    assert.match(String(result.failure?.details?.['also']), /^host_check_failed: The host check "no task yet" on page failed: the page shows "Release", which it should not\. Looked \d+ times in 60 ms\.$/)
    assert.deepEqual(result.hostChecks?.map((entry) => [entry.status, entry.failure?.class]), [['failed', 'host_check_failed'], ['passed', undefined], ['failed', 'host_check_failed']])
  })

  test('each failed check looked again until its own time ran out, and says what it saw last', () => {
    const failed = eventsOfType(record.events, 'host_check.failed')
    assert.deepEqual(failed.map((event) => [event.timeoutMs, event.actual]), [[300, { url: `${origin}/done` }], [60, { url: `${origin}/done`, found: true }]])
    assert.ok(failed.every((event) => event.attempts > 1 && event.durationMs >= event.timeoutMs - 5), 'looked more than once, for its whole time')
    assert.deepEqual(failed[0]?.failure.details?.['received'], { text: `${origin}/done`, truncated: false, length: `${origin}/done`.length })
  })

  test('takes a screenshot of the page the check saw', () => {
    const [shot] = result.evidence
    assert.ok(shot !== undefined && existsSync(join(record.folder, shot.path)))
    const types = record.events.map((event) => event.type)
    assert.ok(types.indexOf('evidence.captured') > types.lastIndexOf('host_check.failed'))
  })
})

describe('checks keyed by file', async () => {
  const hostChecks = {
    [saves]: [{ kind: 'address', origin, path: '/done' }],
    [file]: [{ kind: 'text', text: 'Save' }],
  } satisfies Record<string, HostCheck[]>
  const record = await runSupportFiles(['host-checks.retest.ts'], { hostChecks })

  test("apply to every test of the file, and come before the test's own", () => {
    const own = testNamed(record.result, 'saves a task')
    assert.deepEqual(own.hostChecks?.map((entry) => [entry.check.kind, entry.status]), [['text', 'passed'], ['address', 'passed']])
    assert.deepEqual(eventsOfType(record.events, 'host_check.passed').map((event) => event.check.kind), ['text', 'address'])
  })

  test('a test whose body failed lists its checks as not run, and runs none of them', () => {
    const failed = testNamed(record.result, 'fails itself')
    assert.deepEqual([failed.status, failed.failure?.class], ['failed', 'check_failed'])
    assert.deepEqual(failed.hostChecks, [{ check: { kind: 'text', text: 'Save' }, app: 'page', status: 'not_run' }])
    assert.ok(eventsOfType(record.events, 'host_check.passed').every((event) => event.testId === saves))
    assert.equal(record.browsers[0]?.pages[1]?.reads.length, 0)
    assert.equal(record.result.exitCode, 1)
  })
})

describe('checks the run refuses before any browser starts', () => {
  test('a key that names no test the run will run, and no file one comes from', async () => {
    const record = await runSupportFiles(['host-checks.retest.ts'], {
      hostChecks: { [failsItself]: [{ kind: 'text', text: 'Save' }], 'tests/support/files/host-check.retest.ts': [] },
      selection: onlySaves,
    })
    assert.deepEqual([record.result.exitCode, record.result.failure?.class], [2, 'usage'])
    assert.equal(
      record.result.failure?.message,
      [
        'The host checks have 2 problems:',
        `  hostChecks[${JSON.stringify(failsItself)}]: names no test this run will run, and no file one comes from. Keys are test ids, such as ${JSON.stringify(saves)}, or files as the run lists them.`,
        '  hostChecks["tests/support/files/host-check.retest.ts"]: names no test this run will run, and no file one comes from.',
      ].join('\n'),
    )
    assert.equal(record.browsers.length, 0)
    assert.deepEqual(record.result.files[0]?.tests.map((result) => [result.name, result.status]), [['saves a task', 'not_run']])
  })

  test('a check whose app the test does not use', async () => {
    const record = await runSupportFiles(['host-checks.retest.ts'], { hostChecks: { [file]: [{ kind: 'text', text: 'Save', app: 'admin' }] } })
    assert.deepEqual([record.result.exitCode, record.result.failure?.class], [2, 'usage'])
    assert.equal(record.result.failure?.message, `hostChecks[${JSON.stringify(file)}][0].app: "admin" is not an app of ${JSON.stringify(saves)}, which uses page.`)
    assert.equal(record.browsers.length, 0)
    const listed = record.result.files[0]?.tests.map((result) => [result.status, result.hostChecks])
    const notRun = [{ check: { kind: 'text', text: 'Save' }, app: 'admin', status: 'not_run' }]
    assert.deepEqual(listed, [['not_run', notRun], ['not_run', notRun]])
  })

  test('a check of the wrong shape, each named by its key, before any file loads, and run.started records none', async () => {
    const record = await runSupportFiles(['host-checks.retest.ts'], {
      hostChecks: {
        [saves]: [
          { kind: 'address', origin: 'ftp://127.0.0.1' },
          { kind: 'address', origin, path: /done/g },
          { kind: 'text', text: '  ' },
          { kind: 'text', text: 'Save', timeoutMs: 0 },
        ],
      },
    })
    assert.deepEqual([record.result.exitCode, record.result.failure?.class], [2, 'usage'])
    const lines = (record.result.failure?.message ?? '').split('\n')
    assert.equal(lines[0], 'The host checks have 4 problems:')
    assert.deepEqual(lines.slice(1).map((line) => line.trim().split(':')[0]), [0, 1, 2, 3].map((index) => `hostChecks[${JSON.stringify(saves)}][${index}].${['origin', 'path', 'text', 'timeoutMs'][index]}`))
    assert.equal(record.browsers.length, 0)
    assert.equal(record.result.files[0]?.collection, 'failed')
    assert.equal(eventsOfType(record.events, 'run.started')[0]?.options.hostChecks, undefined)
  })
})

describe('a key for a file that could not be collected', () => {
  test("is left to that file's own failure, and the other files' tests run with their checks", async () => {
    const broken = supportFile('import-error.retest.ts')
    const record = await runSupportFiles(['host-checks.retest.ts', 'import-error.retest.ts'], {
      hostChecks: { [broken]: [{ kind: 'text', text: 'Save' }], [testId(broken, 'never collected')]: [], [saves]: [{ kind: 'text', text: 'Save' }] },
      selection: onlySaves,
    })
    assert.equal(record.result.failure, undefined, 'no usage failure names the keys')
    assert.deepEqual(record.result.files.map((entry) => entry.collection), ['ok', 'failed'])
    assert.deepEqual(testNamed(record.result, 'saves a task').hostChecks?.map((entry) => entry.status), ['passed'])
    assert.equal(record.result.exitCode, 2)
  })
})

describe('looking again', () => {
  test('a text the page shows only after the body ended is found by a later look', async () => {
    const record = await runSupportFiles(['host-checks.retest.ts'], {
      hostChecks: { [saves]: [{ kind: 'text', text: 'Release checklist', timeoutMs: 2000 }] },
      selection: onlySaves,
      fake: { saveDelayMs: 250 },
    })
    const [passed] = eventsOfType(record.events, 'host_check.passed')
    assert.equal(record.result.exitCode, 0)
    assert.ok((passed?.attempts ?? 0) > 1, `looked ${passed?.attempts} times`)
  })

  test('a look taken while the frame opens another document judges nothing, and the check waits for that document', async () => {
    const record = await runSupportFiles(['host-checks.retest.ts'], {
      hostChecks: { [saves]: [{ kind: 'address', origin, path: '/done', timeoutMs: 2000 }] },
      selection: onlySaves,
      fake: {
        onRead: (page, earlier) => {
          page.navigating = earlier < 2
        },
      },
    })
    assert.equal(record.result.exitCode, 0)
    assert.equal(eventsOfType(record.events, 'host_check.passed')[0]?.attempts, 3)
  })

  test('a check whose page is still opening another document when its time runs out says so', async () => {
    const record = await runSupportFiles(['host-checks.retest.ts'], {
      hostChecks: { [saves]: [{ kind: 'address', origin, path: '/done', timeoutMs: 80 }] },
      selection: onlySaves,
      fake: { onRead: (page) => void (page.navigating = true) },
    })
    const result = testNamed(record.result, 'saves a task')
    assert.equal(result.failure?.class, 'host_check_failed')
    assert.match(result.failure?.message ?? '', /The page was still opening another document\. Looked \d+ times in 80 ms\.$/)
  })
})

describe('a page the checks could not read', () => {
  test('a browser lost during a check makes the test error with session_lost, and the checks after it do not run', async () => {
    const record = await runSupportFiles(['host-checks.retest.ts'], {
      hostChecks: { [saves]: [{ kind: 'text', text: 'Release checklist' }, { kind: 'address', origin }] },
      selection: onlySaves,
      fake: { onRead: (page) => page.browser.disconnect('The browser process exited.') },
    })
    const result = testNamed(record.result, 'saves a task')
    assert.deepEqual([result.status, result.failure?.class], ['error', 'session_lost'])
    assert.match(result.failure?.message ?? '', /The browser of page was lost during a host check/)
    assert.deepEqual(result.hostChecks?.map((entry) => entry.status), ['failed', 'not_run'])
    assert.deepEqual(eventsOfType(record.events, 'host_check.failed').map((event) => [event.failure.class, event.attempts]), [['session_lost', 1]])
    assert.equal(record.result.exitCode, 2)
  })

  test("a read the browser cannot make stops the check with the browser's own failure", async () => {
    const record = await runSupportFiles(['host-checks.retest.ts'], {
      hostChecks: { [saves]: [{ kind: 'text', text: 'Release checklist' }] },
      selection: onlySaves,
      fake: {
        onRead: () => {
          throw new BrowserError({ class: 'unsupported', message: 'Retest cannot read this page.' })
        },
      },
    })
    const result = testNamed(record.result, 'saves a task')
    assert.deepEqual([result.status, result.failure], ['error', { class: 'unsupported', message: 'Retest cannot read this page.' }])
  })
})

describe('a run interrupted during the checks', () => {
  test('stops them: the test ends interrupted, and the checks it had not finished are not run', async () => {
    const controller = new AbortController()
    const record = await runSupportFiles(['host-checks.retest.ts'], {
      hostChecks: { [saves]: [{ kind: 'text', text: 'Save' }, { kind: 'address', origin, path: '/never', timeoutMs: 5000 }, { kind: 'text', text: 'Save' }] },
      selection: onlySaves,
      signal: controller.signal,
      fake: { onRead: (_page, earlier) => void (earlier === 2 && controller.abort('SIGINT')) },
    })
    const result = testNamed(record.result, 'saves a task')
    assert.deepEqual([record.result.exitCode, result.failure?.class], [130, 'interrupted'])
    assert.deepEqual(result.hostChecks?.map((entry) => entry.status), ['passed', 'not_run', 'not_run'])
    assert.equal(eventsOfType(record.events, 'host_check.failed').length, 0)
    assert.ok(record.result.durationMs < 4000, 'the check did not wait out its time')
  })
})

describe('host checks in a run from a config', async () => {
  const config = `import { chromium, defineConfig } from '@rehearsal-labs/retest'
export default defineConfig({
  apps: {
    web: chromium({ baseUrl: 'http://127.0.0.1:4173', executablePath: '/fake/chromium' }),
    admin: chromium({ baseUrl: 'http://127.0.0.1:4174', executablePath: '/fake/chromium' }),
  },
  defaultApp: 'web',
})
`
  const setup = `import { expect, test } from '@rehearsal-labs/retest'
test.setup('signed-in', async ({ page }) => {
  await page.goto('/login')
  await page.getByTestId('sign-in').click()
  expect(true).toBe(true)
})
`
  const both = `import { expect, test } from '@rehearsal-labs/retest'
test('opens both', { apps: ['web', 'admin'], state: { web: 'signed-in' } }, async ({ web, admin }) => {
  await web.goto('/tasks')
  await admin.goto('/users')
  expect(true).toBe(true)
})
`
  const files = { 'retest.config.ts': config, 'tests/sign-in.retest.ts': setup, 'tests/both.retest.ts': both }
  const run = (setupPath: string) =>
    runProject(tempProject(files), {
      files: ['tests/both.retest.ts', 'tests/sign-in.retest.ts'],
      hostChecks: {
        'tests/sign-in.retest.ts': [{ kind: 'address', origin, path: setupPath, timeoutMs: 60 }],
        'tests/both.retest.ts > opens both': [
          { kind: 'address', origin, path: '/tasks' },
          { kind: 'address', app: 'admin', origin: 'http://127.0.0.1:4174', path: '/users' },
        ],
      },
    })

  test("a file key covers the file's setup, and two checks read two apps of one test", async () => {
    const record = await run('/login')
    assert.equal(record.result.exitCode, 0)
    assert.deepEqual(
      eventsOfType(record.events, 'host_check.passed').map((event) => [event.testId, event.session, event.actual.url, event.variantKey]),
      [
        ['tests/sign-in.retest.ts > signed-in', 'web', `${origin}/login`, 'web=chromium'],
        ['tests/both.retest.ts > opens both', 'web', `${origin}/tasks`, 'admin=chromium,web=chromium'],
        ['tests/both.retest.ts > opens both', 'admin', 'http://127.0.0.1:4174/users', 'admin=chromium,web=chromium'],
      ],
    )
    assert.equal(eventsOfType(record.events, 'state.saved').length, 1)
  })

  test('a setup whose check failed saves no state, and the test that needs it does not run', async () => {
    const record = await run('/elsewhere')
    const [signIn, opens] = [record.result.files[1]?.tests[0], record.result.files[0]?.tests[0]]
    assert.deepEqual([signIn?.status, signIn?.failure?.class], ['failed', 'host_check_failed'])
    assert.equal(eventsOfType(record.events, 'state.saved').length, 0)
    assert.deepEqual([opens?.status, opens?.hostChecks?.map((entry) => [entry.app, entry.status])], [
      'not_run',
      [
        ['web', 'not_run'],
        ['admin', 'not_run'],
      ],
    ])
    assert.equal(record.result.exitCode, 1)
  })
})

// A host writes a check's text itself, and may put a secret in it by mistake. The page is asked for the text as
// written, and everything Retest records reads the secret's name instead.
describe('a host check whose text holds a secret', async () => {
  const password = 'hunter2-7391'
  const config = `import { chromium, defineConfig, env } from '@rehearsal-labs/retest'
export default defineConfig({
  apps: { web: chromium({ baseUrl: 'http://127.0.0.1:4173', executablePath: '/fake/chromium' }) },
  secrets: { password: env('RETEST_UNIT_HOST_CHECK_SECRET') },
})
`
  const tests = `import { expect, test } from '@rehearsal-labs/retest'
test('signs in', async ({ page }) => {
  await page.goto('/done')
  expect(true).toBe(true)
})
`
  const record = await runProject(tempProject({ 'retest.config.ts': config, 'tests/sign-in.retest.ts': tests }), {
    files: ['tests/sign-in.retest.ts'],
    env: { RETEST_UNIT_HOST_CHECK_SECRET: password },
    hostChecks: {
      'tests/sign-in.retest.ts': [
        { kind: 'text', text: `Welcome ${password}` },
        { kind: 'text', text: password, absent: true },
      ],
    },
  })

  test('is looked for as written, and recorded with the name in run.started, its events and the result', () => {
    const asked = record.browsers[0]?.pages[0]?.reads.flat().map((query) => query.text)
    assert.deepEqual([...new Set(asked)], [`Welcome ${password}`, password])
    const recorded = [{ kind: 'text', text: 'Welcome {{password}}' }, { kind: 'text', text: '{{password}}', absent: true }]
    assert.deepEqual(eventsOfType(record.events, 'run.started')[0]?.options.hostChecks, { 'tests/sign-in.retest.ts': recorded })
    const checked = record.events.flatMap((event) => (event.type === 'host_check.passed' || event.type === 'host_check.failed' ? [event.check] : []))
    assert.deepEqual(checked, recorded)
    assert.deepEqual(record.written?.files[0]?.tests[0]?.hostChecks?.map((entry) => [entry.check, entry.status]), [
      [recorded[0], 'failed'],
      [recorded[1], 'passed'],
    ])
    assert.equal(record.result.exitCode, 1)
  })

  test('is in no line of the events and nowhere in result.json', () => {
    assert.deepEqual(record.lines.filter((line) => line.includes(password)), [])
    assert.ok(!readFileSync(join(record.folder, resultFile), 'utf8').includes(password))
  })
})
