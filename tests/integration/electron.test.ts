import type { WindowsRecord } from '../../src/browser/electron.ts'
import type { FinishedRun } from './cli-harness.ts'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { launchElectron } from '../../src/browser/electron.ts'
import { slug, targetBrowserLogFile } from '../../src/protocol/run-folder.ts'
import { parse, s } from '../../src/protocol/schema.ts'
import { variantKey } from '../../src/protocol/variant.ts'
import { budgets, eventsOf, filesHolding, freePort, repositoryRoot, resultOf, runProject, scratchFolder, testNamed, writeProject } from './cli-harness.ts'

// The Electron fixture app driven through the CLI on a real Electron binary: the same locators, actions and checks as
// Chrome, a deliberate failure, the capabilities an Electron app does not have refused by name, every window and
// version recorded, each data folder Retest made gone and one the config named left alone, and nothing of the app left
// running once the run ends.

// One official Electron release, downloaded outside the repository as the proof record says. Never a dependency.
const electronVersion = '44.5.1'
const givenBinary = process.env['RETEST_TEST_ELECTRON']
const electronBinary = givenBinary ?? join(homedir(), 'Library/Caches/retest-proofs/electron', electronVersion, 'dist/Electron.app/Contents/MacOS/Electron')
// On macOS a missing binary fails these tests. Elsewhere Retest has no route to an Electron build yet, so without one
// given they are skipped by name, never in silence.
const unverified =
  process.platform !== 'darwin' && givenBinary === undefined
    ? `unverified: RETEST_TEST_ELECTRON is not set, and Retest has no route yet to an Electron build on ${process.platform}, so no Electron app was run`
    : false
const fixtureApp = join(repositoryRoot, 'fixtures/electron')
// The window's first page, which the app opens before any test asks for it.
const firstPage = pathToFileURL(join(fixtureApp, 'renderer/index.html')).href
const fakeJudge = fileURLToPath(new URL('../support/fake-evaluator.ts', import.meta.url))
const judgeKey = 'judge-key-for-the-electron-run-5c2e'
const password = 'electron-secret-7d41f0'

const names = {
  flow: 'creates tasks and checks them with the locators, actions and checks of a browser',
  hidden: 'the variables Retest hides never reach the app, and others do',
  fresh: 'each test gets a new launch of the app, with none of the tasks before it',
  secondWindow: 'a second window is recorded while the first stays the page',
  wrong: 'the total the app shows wrong on purpose fails its check',
  goto: 'goto is refused by name',
  secret: 'a secret is not typed into a window on a file address',
  closed: 'once the app closes its first window, no other window is reachable',
} as const

const config = `import { defineConfig, electron, env } from '@rehearsal-labs/retest'

export default defineConfig({
  apps: {
    desktop: electron({
      executablePath: ${JSON.stringify(electronBinary)},
      appPath: ${JSON.stringify(fixtureApp)},
      args: ['--show-variables=RETEST_ELECTRON_JUDGE_KEY,RETEST_ELECTRON_VISIBLE,ELECTRON_RUN_AS_NODE'],
    }),
  },
  secrets: { password: env('RETEST_ELECTRON_PASSWORD') },
  evaluation: { judges: { fake: { adapter: ${JSON.stringify(fakeJudge)}, credentials: { apiKey: env('RETEST_ELECTRON_JUDGE_KEY') }, accepts: ['text'] } } },
})
`

const tests = `import { setTimeout as sleep } from 'node:timers/promises'
import { expect, secret, test } from '@rehearsal-labs/retest'

test(${JSON.stringify(names.flow)}, async ({ page }) => {
  await expect(page).toHaveURL(${JSON.stringify(firstPage)})
  await expect(page).toHaveTitle('Tasks')
  await page.getByLabel('Title').fill('Release checklist')
  await page.getByRole('button', { name: 'Add task' }).click()
  await page.getByTestId('task-title').fill('Write notes')
  await page.getByTestId('task-title').press('Enter')
  await expect(page.getByTestId('task-item')).toHaveCount(2)
  await expect(page.getByTestId('task-name').first()).toHaveText('Release checklist')
  await expect(page.getByTestId('task-id').nth(1)).toHaveText('t2')
  await page.getByRole('checkbox', { name: 'Done: Release checklist' }).check()
  await expect(page.getByRole('checkbox', { name: 'Done: Release checklist' })).toBeChecked()
  await expect(page.getByRole('checkbox', { name: 'Done: Write notes' })).not.toBeChecked()
  await expect(page.getByTestId('task-total')).toHaveText('2 tasks')
  await page.reload()
  await expect(page.getByTestId('task-item')).toHaveCount(2)
  await page.getByText('About').click()
  await expect(page.getByTestId('about-text')).toBeVisible()
  await expect(page).toHaveTitle('About')
  await page.goBack()
  await expect(page.getByTestId('task-total')).toHaveText('2 tasks')
  await page.goForward()
  await expect(page).toHaveTitle('About')
})

test(${JSON.stringify(names.hidden)}, async ({ page }) => {
  await expect(page.getByTestId('variable-RETEST_ELECTRON_JUDGE_KEY')).toHaveText('absent')
  await expect(page.getByTestId('variable-ELECTRON_RUN_AS_NODE')).toHaveText('absent')
  await expect(page.getByTestId('variable-RETEST_ELECTRON_VISIBLE')).toHaveText('present')
})

test(${JSON.stringify(names.fresh)}, async ({ page }) => {
  await expect(page.getByTestId('task-total')).toHaveText('0 tasks')
  await expect(page.getByTestId('task-item')).toHaveCount(0)
})

test(${JSON.stringify(names.secondWindow)}, async ({ page }) => {
  await page.getByTestId('open-second-window').click()
  await sleep(500)
  await page.getByLabel('Title').fill('After the second window')
  await page.getByRole('button', { name: 'Add task' }).click()
  await expect(page.getByTestId('task-name')).toHaveText('After the second window')
})

test(${JSON.stringify(names.wrong)}, async ({ page }) => {
  await page.getByLabel('Title').fill('Release checklist')
  await page.getByRole('button', { name: 'Add task' }).click()
  await expect(page.getByTestId('task-total')).toHaveText('1 task')
  await expect(page.getByTestId('wrong-total')).toHaveText('1 task')
})

test(${JSON.stringify(names.goto)}, async ({ page }) => {
  await page.goto('https://example.test/')
})

test(${JSON.stringify(names.secret)}, async ({ page }) => {
  await page.getByLabel('Title').fill(secret('password'))
})

test(${JSON.stringify(names.closed)}, async ({ page }) => {
  await page.getByTestId('open-second-window').click()
  await page.getByTestId('close-window').click()
  await sleep(1000)
  await page.getByRole('button', { name: 'Add task' }).click()
})
`

const environment = {
  RETEST_ELECTRON_JUDGE_KEY: judgeKey,
  RETEST_ELECTRON_VISIBLE: 'yes',
  RETEST_ELECTRON_PASSWORD: password,
  // Set on purpose: with it, the Electron binary runs as plain Node and never opens the app, so the run passing at all
  // shows Retest withholds it.
  ELECTRON_RUN_AS_NODE: '1',
}

/** What the binary itself says it is, read by running it as Node, which is what `ELECTRON_RUN_AS_NODE` makes it. */
function binaryVersions(): { electron: string; chrome: string } {
  const printed = execFileSync(electronBinary, ['-p', 'JSON.stringify({ electron: process.versions.electron, chrome: process.versions.chrome })'], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
    timeout: 20_000,
  })
  const parsed: unknown = JSON.parse(printed)
  assert.ok(typeof parsed === 'object' && parsed !== null && 'electron' in parsed && 'chrome' in parsed)
  const { electron, chrome } = parsed
  assert.ok(typeof electron === 'string' && typeof chrome === 'string')
  return { electron, chrome }
}

function launchesFolder(run: FinishedRun): string {
  return join(run.output, 'electron', slug(variantKey({ desktop: 'electron' })))
}

const count = s.number({ integer: true, min: 0 })
const windowsSchema = s.object({
  app: s.string(),
  target: s.string(),
  launch: count,
  pid: count,
  windows: s.array(s.object({ window: count, reachable: s.boolean(), openedMs: count, existing: s.optional(s.literal(true)), closedMs: s.optional(count) })),
  notes: s.optional(s.array(s.string())),
})

// Each launch's windows, as the app's quit wrote them, checked against the shape the driver writes.
function windowsRecords(run: FinishedRun): WindowsRecord[] {
  const folder = launchesFolder(run)
  const records = readdirSync(folder)
    .map((launch) => join(folder, launch, 'windows.json'))
    .filter((file) => existsSync(file))
    .map((file) => {
      const value: unknown = JSON.parse(readFileSync(file, 'utf8'))
      const parsed = parse(windowsSchema, value)
      assert.ok(parsed.ok, `${file} holds a windows record: ${parsed.ok ? '' : JSON.stringify(parsed.issues)}`)
      return parsed.value
    })
  return records.sort((first, second) => first.launch - second.launch)
}

// Every process whose command line names a path: an Electron app on that data folder, or one of the app's helpers,
// which are given the same folder.
function processesNaming(path: string): string {
  try {
    return execFileSync('pgrep', ['-fl', path], { encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

// The data folder of each launch, as the fixture app printed it to the browser log when it was ready.
function dataFolders(run: FinishedRun): string[] {
  const log = readFileSync(join(run.output, targetBrowserLogFile(variantKey({ desktop: 'electron' }))), 'utf8')
  return [...log.matchAll(/^user data in (.+)$/gm)].map((match) => match[1] ?? '')
}

test('an Electron app is driven through the same locators, actions and checks as Chrome, and nothing of it is left running', { timeout: 240_000, skip: unverified }, async (t) => {
  assert.ok(
    existsSync(electronBinary),
    `No Electron binary at ${electronBinary}. Unpack the darwin-arm64 release of Electron ${electronVersion} into its dist folder with ditto -x -k, or set RETEST_TEST_ELECTRON to an Electron binary, such as the one retest install electron prints.`,
  )
  const versions = binaryVersions()
  assert.equal(versions.electron, electronVersion)
  const root = await writeProject(t, { 'retest.config.ts': config, 'tests/desktop.retest.ts': tests })
  const run = await runProject(t, root, { env: environment, timeouts: budgets({ assertion: 3000, test: 20_000 }) })

  const outcomes = Object.fromEntries(Object.values(names).map((name) => [name, [testNamed(run, name).status, testNamed(run, name).failure?.class ?? null]]))
  assert.deepEqual(outcomes, {
    [names.flow]: ['passed', null],
    [names.hidden]: ['passed', null],
    [names.fresh]: ['passed', null],
    [names.secondWindow]: ['passed', null],
    [names.wrong]: ['failed', 'check_failed'],
    // An operation the target does not have is an error of the test, as it is on a browser.
    [names.goto]: ['error', 'unsupported'],
    [names.secret]: ['failed', 'not_actionable'],
    [names.closed]: ['error', 'session_lost'],
  })
  assert.equal(run.exit.code, 1, `a failed check decides the exit code before the errors do. ${run.stderr}`)

  // Diagnostics are collected from the window as from a browser's page: the console lines the window wrote once capture
  // ran, and the files it loaded on the reload and the link. The app had opened its page before capture began, so
  // both kinds are partial and say why, never complete.
  const late = "the app's window was already showing its page when capture began, so what the page logged or loaded before then was not captured"
  const [captured] = testNamed(run, names.flow).diagnostics ?? []
  assert.ok(captured !== undefined && captured.console.state === 'partial' && captured.network.state === 'partial', JSON.stringify(captured))
  assert.deepEqual([captured.console.reason, captured.network.reason], [late, late])
  assert.deepEqual([captured.app, captured.console.entries, captured.console.errors], ['desktop', 2, 0])
  assert.ok(captured.network.requests > 0, 'the reload and the link loaded files the network capture saw')
  // The capture says what it cannot reach: the app's main process and its other windows, and why.
  for (const kind of [captured.scope?.console, captured.scope?.network]) assert.deepEqual(kind?.notCovered.slice(-2), ['main_process', 'other_windows'])
  const [startLine] = readFileSync(join(run.output, captured.path ?? ''), 'utf8').split('\n')
  const captureStart: unknown = JSON.parse(startLine ?? '')
  assert.ok(typeof captureStart === 'object' && captureStart !== null && 'scope' in captureStart, 'the artifact begins with what the capture covers')
  assert.deepEqual(captureStart.scope, captured.scope, 'and the artifact says the same')
  assert.match(captured.scope?.reason ?? '', /^An Electron app's main process runs outside its windows/)

  // The page knew the window's first address before anything navigated: the first check records it.
  const flow = testNamed(run, names.flow)
  const [firstLook] = eventsOf(run.events, 'assertion.passed').filter((event) => event.testId === flow.testId && event.matcher === 'toHaveURL')
  assert.equal(firstLook?.pageUrl, firstPage, 'the first check of the window recorded the page it read')
  const firstNavigation = eventsOf(run.events, 'navigation').find((event) => event.testId === flow.testId)
  assert.ok(firstNavigation === undefined || firstNavigation.sequence > (firstLook?.sequence ?? Infinity), 'and nothing had navigated before it')

  // The deliberate failure names its check, what it expected and what the app showed, with a screenshot of the window.
  const wrong = testNamed(run, names.wrong)
  const wrongFailure = eventsOf(run.events, 'assertion.failed').find((event) => event.testId === wrong.testId)
  assert.ok(wrongFailure !== undefined)
  assert.deepEqual(
    [wrongFailure.matcher, wrongFailure.expected, wrongFailure.actual],
    ['toHaveText', { text: '1 task', truncated: false, length: 6 }, { text: '2 tasks', truncated: false, length: 7 }],
  )
  const [screenshot] = wrong.evidence
  assert.ok(screenshot !== undefined, 'the failure has a screenshot of the window')
  assert.deepEqual([...readFileSync(join(run.output, screenshot.path)).subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47])

  assert.match(testNamed(run, names.goto).failure?.message ?? '', /^goto\(\) is not available on the Electron app desktop \(target electron\): the app has no address/)
  assert.match(testNamed(run, names.secret).failure?.message ?? '', /^Retest did not type the secret "password"/)
  assert.deepEqual(filesHolding(run.output, password), [], 'the secret reached no file of the run, the app data included')
  assert.match(testNamed(run, names.closed).failure?.message ?? '', /The Electron app closed its first window, and a test reaches no other window of it\.$/)

  // Each test launched the app afresh, and each launch is told with the Electron release and the Chromium it embeds,
  // as the binary itself states them.
  const started = eventsOf(run.events, 'browser.started')
  assert.equal(started.length, 8, 'one launch for each test')
  assert.deepEqual(
    started.map((event) => event.instance),
    [undefined, 2, 3, 4, 5, 6, 7, 8],
  )
  for (const event of started) {
    assert.deepEqual([event.product, event.version, event.app, event.executablePath], ['Electron', electronVersion, 'desktop', electronBinary])
    assert.deepEqual(event.target, { name: 'electron', electron: { version: versions.electron, chromium: versions.chrome } })
    assert.match(event.userAgent, new RegExp(`Electron/${electronVersion.replaceAll('.', '\\.')}`))
  }
  assert.equal(new Set(started.map((event) => event.pid)).size, 8, 'every launch is a process of its own')
  assert.deepEqual(resultOf(run).browsers, [
    { product: 'Electron', version: electronVersion, executablePath: electronBinary, app: 'desktop', target: { name: 'electron', electron: { version: versions.electron, chromium: versions.chrome } } },
  ])
  for (const event of eventsOf(run.events, 'test.started')) {
    assert.deepEqual(
      event.execution?.sessions.map(({ app, engine, product, version }) => ({ app, engine, product, version })),
      [{ app: 'desktop', engine: 'chromium', product: 'Electron', version: electronVersion }],
    )
  }

  // Every window the app opened is recorded with the launch it belongs to; only the first was a page a test reached.
  const records = windowsRecords(run)
  assert.deepEqual(
    records.map((record) => [record.launch, record.pid]),
    started.map((event, index) => [index + 1, event.pid]),
    'every launch recorded its windows once the app quit',
  )
  const withSecond = records.filter((record) => record.windows.length === 2)
  assert.equal(withSecond.length, 2, 'two tests opened a second window')
  for (const record of withSecond) {
    assert.deepEqual(
      record.windows.map(({ window, reachable }) => ({ window, reachable })),
      [
        { window: 1, reachable: true },
        { window: 2, reachable: false },
      ],
    )
  }
  const closedFirst = records.find((record) => record.windows[0]?.closedMs !== undefined)
  assert.ok(closedFirst !== undefined, "the launch whose first window closed recorded when it closed")
  assert.equal(closedFirst.windows.length, 2)
  const log = readFileSync(join(run.output, targetBrowserLogFile(variantKey({ desktop: 'electron' }))), 'utf8')
  assert.match(log, /\[retest\] the app opened window 2; a test reaches only the app's first window/)
  assert.match(log, /\[retest\] the app closed its first window, which was the test's page/)

  // Each launch had a data folder of its own, which Retest made and removed once the app quit; none is in the run
  // folder, and nothing of the app is left running.
  const folders = dataFolders(run)
  assert.equal(new Set(folders).size, 8, `each launch used a folder of its own: ${folders.join(', ')}`)
  for (const folder of folders) {
    // The app prints the folder with links resolved, and its processes name it as Retest made it, so the folder's own
    // name, unique to it, is what a process would carry.
    const name = basename(folder)
    assert.match(name, /^retest-profile-\d+-/, 'Retest made the folder, named as a browser profile is')
    assert.equal(existsSync(folder), false, `the folder ${folder} went with its app`)
    assert.equal(processesNaming(name), '', `no process of the app on ${folder} is left`)
  }
  for (const record of records) assert.deepEqual(readdirSync(join(launchesFolder(run), String(record.launch))), ['windows.json'])
  for (const { pid } of started) {
    assert.throws(() => process.kill(pid, 0), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ESRCH', `launch ${pid} is gone`)
  }
  for (const event of eventsOf(run.events, 'test.started')) {
    assert.deepEqual(event.execution?.startingState.map(({ app, browserStorage }) => ({ app, browserStorage })), [{ app: 'desktop', browserStorage: 'fresh' }])
  }

  // A person reading the run sees the Electron target named on its line and in the failure's card.
  const human = await runProject(t, root, { env: environment, reporter: 'human', args: ['--grep', names.wrong], timeouts: budgets({ assertion: 3000 }) })
  assert.equal(human.exit.code, 1, human.stderr)
  assert.match(human.stdout, new RegExp(`started desktop=electron  Electron ${electronVersion.replaceAll('.', '\\.')} · Chromium ${versions.chrome.replaceAll('.', '\\.')}`))
  assert.match(human.stdout, /desktop=electron \(Electron\)/)
  assert.match(human.stdout, /Check failed\s+toHaveText/)
  for (const folder of dataFolders(human)) {
    assert.equal(existsSync(folder), false, `the second run's folder ${folder} went with its app`)
    assert.equal(processesNaming(basename(folder)), '', 'no Electron process of the second run is left')
  }
})

test('a data folder the config names is the app\'s from one launch to the next: Retest leaves it, and records it as reused', { timeout: 120_000, skip: unverified }, async (t) => {
  assert.ok(existsSync(electronBinary), `No Electron binary at ${electronBinary}. Unpack the darwin-arm64 release of Electron ${electronVersion} into its dist folder with ditto -x -k, or set RETEST_TEST_ELECTRON to an Electron binary, such as the one retest install electron prints.`)
  const named = join(await scratchFolder(t, 'retest-electron-data-'), 'kept', 'desktop-data')
  mkdirSync(named, { recursive: true })
  writeFileSync(join(named, 'mine.txt'), 'the tester put this here\n')
  // The app reports the folder with links resolved, as macOS's temporary folder is one.
  const reported = realpathSync(named)
  const root = await writeProject(t, {
    'retest.config.ts': config.replace(`appPath: ${JSON.stringify(fixtureApp)},`, `appPath: ${JSON.stringify(fixtureApp)},\n      userDataDir: ${JSON.stringify(named)},`),
    'tests/desktop.retest.ts': `import { expect, test } from '@rehearsal-labs/retest'

test('opens on the named folder', async ({ page }) => {
  await expect(page.getByTestId('task-total')).toHaveText('0 tasks')
})

test('opens on it again', async ({ page }) => {
  await expect(page.getByTestId('task-total')).toHaveText('0 tasks')
})
`,
  })
  const run = await runProject(t, root, { env: environment })
  assert.equal(run.exit.code, 0, run.stderr)
  assert.deepEqual(dataFolders(run), [reported, reported], 'both launches used the folder the config named, one after the other')
  assert.equal(existsSync(join(named, 'Local State')), true, 'the app wrote its data there')
  assert.equal(readFileSync(join(named, 'mine.txt'), 'utf8'), 'the tester put this here\n', 'what was in the folder before stays')
  for (const event of eventsOf(run.events, 'test.started')) {
    assert.deepEqual(event.execution?.startingState.map(({ app, browserStorage }) => ({ app, browserStorage })), [{ app: 'desktop', browserStorage: 'reused' }])
  }
  assert.equal(processesNaming(named), '', 'no process of the app is left')
  // A second run finds the folder as the first left it.
  // A database's journal comes and goes as the app's own database writes; everything else the first run left stays.
  const lasting = (entry: string) => !/-(wal|shm|journal)$/.test(entry)
  const entries = readdirSync(named).filter(lasting).sort()
  const again = await runProject(t, root, { env: environment, args: ['--grep', 'opens on it again'] })
  assert.equal(again.exit.code, 0, again.stderr)
  assert.deepEqual(readdirSync(named).filter((entry) => entries.includes(entry)).sort(), entries, 'the folder still holds what the first run left')
  assert.equal(readFileSync(join(named, 'mine.txt'), 'utf8'), 'the tester put this here\n')
  assert.equal(processesNaming(named), '', 'no process of the app is left after the second run')
})

test('an Electron target whose binary is missing fails setup by name, and no browser stands in', { timeout: 60_000 }, async (t) => {
  const missing = join(fixtureApp, 'no-such-binary', 'Electron')
  const root = await writeProject(t, {
    'retest.config.ts': config.replace(JSON.stringify(electronBinary), JSON.stringify(missing)),
    'tests/desktop.retest.ts': `import { expect, test } from '@rehearsal-labs/retest'

test('needs the app', async ({ page }) => {
  await expect(page.getByTestId('task-total')).toHaveText('0 tasks')
})
`,
  })
  const run = await runProject(t, root, { env: environment })
  assert.equal(run.exit.code, 2, run.stderr)
  const needed = testNamed(run, 'needs the app')
  assert.equal(needed.status, 'not_run')
  assert.deepEqual(needed.failure, {
    class: 'setup_failed',
    message: `No Electron binary at ${missing}. Give the Electron binary, inside Electron.app on macOS: Electron.app/Contents/MacOS/Electron.`,
  })
  assert.deepEqual(eventsOf(run.events, 'browser.started'), [], 'nothing was launched in its place')
})

test("the window's first address is known from the start, and a secret is typed on the origin secretOrigins names", { timeout: 120_000, skip: unverified }, async (t) => {
  assert.ok(existsSync(electronBinary), `No Electron binary at ${electronBinary}. Unpack the darwin-arm64 release of Electron ${electronVersion} into its dist folder with ditto -x -k, or set RETEST_TEST_ELECTRON to an Electron binary, such as the one retest install electron prints.`)
  // A secret is bound to http and https origins, so the fixture serves its pages from loopback for this test.
  const port = await freePort()
  const origin = `http://127.0.0.1:${port}`
  const served = config
    .replace("args: ['--show-variables=", `args: ['--serve=${port}', '--show-variables=`)
    .replace("secrets: { password: env('RETEST_ELECTRON_PASSWORD') },", `secrets: { password: env('RETEST_ELECTRON_PASSWORD') },\n  secretOrigins: { password: [${JSON.stringify(origin)}] },`)
  assert.notEqual(served, config)
  const name = 'types the secret on the window it opened'
  const root = await writeProject(t, {
    'retest.config.ts': served,
    'tests/desktop.retest.ts': `import { expect, secret, test } from '@rehearsal-labs/retest'

test(${JSON.stringify(name)}, async ({ page }) => {
  await page.getByLabel('Title').fill(secret('password'))
  await expect(page).toHaveURL('${origin}/index.html')
  expect(await page.url()).toBe('${origin}/index.html')
  await page.getByRole('button', { name: 'Add task' }).click()
  await expect(page.getByTestId('task-total')).toHaveText('1 task')
})
`,
  })
  const run = await runProject(t, root, { env: environment })
  assert.equal(run.exit.code, 0, `${run.stdout}\n${run.stderr}`)
  const typed = testNamed(run, name)
  assert.equal(typed.status, 'passed')
  const look = eventsOf(run.events, 'assertion.passed').find((event) => event.matcher === 'toHaveURL')
  assert.equal(look?.pageUrl, `${origin}/index.html`, 'the check recorded the window\'s address')
  assert.deepEqual(eventsOf(run.events, 'navigation'), [], 'the window never navigated, so its address came from the page itself')
  assert.equal(eventsOf(run.events, 'action.completed')[0]?.command, 'fill', 'the first action types the secret before a URL check could wait for an initial load')
  assert.deepEqual(eventsOf(run.events, 'action.completed').filter(event => ['goto', 'reload', 'goBack', 'goForward'].includes(event.command)), [], 'the test never asks the window to navigate')
  const fill = eventsOf(run.events, 'action.completed').find((event) => event.command === 'fill')
  assert.ok(fill !== undefined, 'the secret was typed')
  assert.ok(look !== undefined && fill.sequence < look.sequence, 'secret input succeeds before any URL assertion can wait for the app load')
  assert.deepEqual(filesHolding(run.output, password), [], 'and its value reached no file of the run')
  for (const folder of dataFolders(run)) assert.equal(processesNaming(basename(folder)), '', 'no process of the app is left')
})

test("what the app prints of a typed secret reaches its log as the placeholder, and Electron's own logging is withheld", { timeout: 60_000, skip: unverified }, async (t) => {
  assert.ok(existsSync(electronBinary), `No Electron binary at ${electronBinary}. Unpack the darwin-arm64 release of Electron ${electronVersion} into its dist folder with ditto -x -k, or set RETEST_TEST_ELECTRON to an Electron binary, such as the one retest install electron prints.`)
  const folder = await scratchFolder(t, 'retest-electron-redact-')
  const typed = 'typed-secret-value-6c1d'
  // With this set the app would print every console line of its windows into its output, raw.
  const saved = process.env['ELECTRON_ENABLE_LOGGING']
  process.env['ELECTRON_ENABLE_LOGGING'] = '1'
  t.after(() => {
    if (saved === undefined) delete process.env['ELECTRON_ENABLE_LOGGING']
    else process.env['ELECTRON_ENABLE_LOGGING'] = saved
  })
  const logFile = join(folder, 'electron.log')
  const app = await launchElectron(
    {
      executablePath: electronBinary,
      appPath: fixtureApp,
      args: ['--echo-typed'],
      windowsFile: join(folder, 'windows.json'),
      logFile,
      app: 'desktop',
      target: 'electron',
      launch: 1,
      redact: (text) => text.replaceAll(typed, '{{password}}'),
    },
    15_000,
  )
  try {
    const page = await app.newPage({}, 5000)
    const filled = await page.execute({ kind: 'fill', locator: { by: 'testId', value: 'task-title' }, value: typed }, 5000)
    assert.equal(filled.ok, true, JSON.stringify(filled))
    const clicked = await page.execute({ kind: 'click', locator: { by: 'testId', value: 'add-task' } }, 5000)
    assert.equal(clicked.ok, true, JSON.stringify(clicked))
    let total: string | null = null
    for (let look = 0; look < 30 && total !== '1 task'; look += 1) {
      const shown = await page.execute({ kind: 'observe', locator: { by: 'testId', value: 'task-total' } }, 5000)
      total = shown.ok && shown.kind === 'observe' ? shown.observation.text : null
      if (total !== '1 task') await delay(100)
    }
    assert.equal(total, '1 task', 'the app added the task')
  } finally {
    await app.close(5000)
  }
  const log = readFileSync(logFile, 'utf8')
  assert.match(log, /^typed: \{\{password\}\}$/m, 'the app printed what it was given, and the log holds the placeholder')
  assert.equal(log.includes(typed), false, 'the value is in no line of the log')
  assert.equal(log.includes('The list holds 1 task.'), false, "the window's console line was never printed, since Electron's logging was withheld")
})
