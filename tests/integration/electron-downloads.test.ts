import type { TestContext } from 'node:test'
import type { FinishedRun } from './cli-harness.ts'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { launchElectron } from '../../src/browser/electron.ts'
import { slug, targetBrowserLogFile } from '../../src/protocol/run-folder.ts'
import { defaultTimeouts } from '../../src/protocol/timeouts.ts'
import { variantKey } from '../../src/protocol/variant.ts'
import { assertOk, click, observeUntil } from './browser-harness.ts'
import { budgets, eventsOf, filesHolding, repositoryRoot, runProject, scratchFolder, testNamed, waitFor, writeProject } from './cli-harness.ts'

// Downloads in an Electron app's first window, on a real Electron binary: a link's download and one the app's main
// process starts for the window are kept in the run folder as on Chrome, and a download holding a secret is withheld.
// The app's own will-download handler runs as it would without Retest, and each way it can handle a download is run:
// a path or a save dialog of its own does not take effect and the download is kept, a cancelled or prevented one fails
// path() as stopped, and a paused one is not saved in time, each failure saying what the app can do that Retest cannot
// see. A download the main process starts for no window is told of to nobody, and Retest removes its file once the app
// has quit. A window in a session of its own is refused page.download() by name, and a window given no downloads
// folder refuses every download, whatever the app's handler asks.

const electronVersion = '44.5.1'
const givenBinary = process.env['RETEST_TEST_ELECTRON']
const electronBinary = givenBinary ?? join(homedir(), 'Library/Caches/retest-proofs/electron', electronVersion, 'dist/Electron.app/Contents/MacOS/Electron')
// On macOS a missing binary fails these tests. Elsewhere, without one given, they are skipped by name, never in silence.
const unverified =
  process.platform !== 'darwin' && givenBinary === undefined
    ? `unverified: RETEST_TEST_ELECTRON is not set, and Retest has no route yet to an Electron build on ${process.platform}, so no Electron app was run`
    : false
const missingBinary = `No Electron binary at ${electronBinary}. Unpack the darwin-arm64 release of Electron ${electronVersion} into its dist folder with ditto -x -k, or set RETEST_TEST_ELECTRON to an Electron binary, such as the one retest install electron prints.`
const fixtureApp = join(repositoryRoot, 'fixtures/electron-downloads')
const csv = 'id,title\nt1,Release checklist\nt2,Write notes\n'
const token = 'tok-electron-download-3b9e71c4'
const downloadId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\.crdownload)?$/

/**
 * A loopback server of the files the fixture's window downloads, each an attachment with a name of its own. `slow.csv`
 * sends its first thousand bytes of a hundred thousand and holds the rest until the app breaks it off.
 */
async function fileServer(t: TestContext): Promise<string> {
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    const attachment = (name: string, type: string) => ({ 'content-type': type, 'content-disposition': `attachment; filename="${name}"` })
    if (path === '/files/tasks.csv') return void response.writeHead(200, attachment('retest-electron-tasks.csv', 'text/csv')).end(csv)
    if (path === '/files/session.csv') return void response.writeHead(200, attachment('retest-electron-session.csv', 'text/csv')).end(csv)
    if (path === '/files/key.txt') return void response.writeHead(200, attachment('retest-electron-key.txt', 'text/plain')).end(`key ${token}\n`)
    if (path === '/files/slow.csv') {
      response.writeHead(200, { ...attachment('retest-electron-slow.csv', 'text/csv'), 'content-length': '100000' })
      response.write('x'.repeat(1000))
      return
    }
    response.writeHead(404).end()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => {
    server.closeAllConnections()
    server.close()
  })
  const address = server.address()
  assert.ok(address !== null && typeof address === 'object')
  return `http://127.0.0.1:${address.port}`
}

const names = {
  link: 'keeps a download a link in the window starts, and gives its path and a copy',
  forWindow: "keeps a download the app's main process starts for the window",
  savePath: "keeps a download in the run folder when the app's handler gives it a path of the app's own",
  saveDialog: "keeps a download when the app's handler asks for a save dialog, and shows none",
  cancel: "a download the app's handler cancels fails path() as stopped, saying the app can cancel one",
  prevent: "a download the app's handler prevents fails path() as stopped",
  pause: "a download the app's handler pauses is not saved in time, and path() says the app can pause one",
  session: 'a download the main process starts for no window is told of to nobody, and page.download() says why it may be',
  secret: 'a download that holds the value of a secret is not kept',
  partition: 'a window in a session of its own is refused page.download() by name',
} as const

const config = (files: string, saveDir: string) => `import { defineConfig, electron, env } from '@rehearsal-labs/retest'

export default defineConfig({
  apps: {
    desk: electron({ executablePath: ${JSON.stringify(electronBinary)}, appPath: ${JSON.stringify(fixtureApp)}, args: [${JSON.stringify(`--files=${files}`)}, ${JSON.stringify(`--save-dir=${saveDir}`)}] }),
    parted: electron({ executablePath: ${JSON.stringify(electronBinary)}, appPath: ${JSON.stringify(fixtureApp)}, args: [${JSON.stringify(`--files=${files}`)}, '--partition=retest-downloads'] }),
  },
  secrets: { token: env('RETEST_ELECTRON_DOWNLOAD_TOKEN') },
})
`

const tests = `import { readFile } from 'node:fs/promises'
import { expect, test } from '@rehearsal-labs/retest'

const csv = ${JSON.stringify(csv)}

// Tells the app's main process how to handle the next download, and waits until it says so.
async function handled(desk, handling) {
  await desk.getByTestId('handle-' + handling).click()
  await expect(desk.getByTestId('handling')).toHaveText(handling)
}

test(${JSON.stringify(names.link)}, { apps: ['desk'] }, async ({ desk }) => {
  const download = await desk.download(() => desk.getByRole('link', { name: 'Export CSV' }).click())
  expect(download.suggestedFilename).toBe('retest-electron-tasks.csv')
  expect(await readFile(await download.path(), 'utf8')).toBe(csv)
  await download.saveAs('../out/tasks.csv')
  expect(await readFile(new URL('../out/tasks.csv', import.meta.url), 'utf8')).toBe(csv)
})

test(${JSON.stringify(names.forWindow)}, { apps: ['desk'] }, async ({ desk }) => {
  const download = await desk.download(() => desk.getByRole('button', { name: 'Download for the window' }).click())
  expect(download.suggestedFilename).toBe('retest-electron-tasks.csv')
  expect(await readFile(await download.path(), 'utf8')).toBe(csv)
})

test(${JSON.stringify(names.savePath)}, { apps: ['desk'] }, async ({ desk }) => {
  await handled(desk, 'save-path')
  const download = await desk.download(() => desk.getByTestId('export-csv').click())
  expect(await readFile(await download.path(), 'utf8')).toBe(csv)
})

test(${JSON.stringify(names.saveDialog)}, { apps: ['desk'] }, async ({ desk }) => {
  await handled(desk, 'save-dialog')
  const download = await desk.download(() => desk.getByTestId('export-csv').click())
  expect(await readFile(await download.path(), 'utf8')).toBe(csv)
})

test(${JSON.stringify(names.cancel)}, { apps: ['desk'] }, async ({ desk }) => {
  await handled(desk, 'cancel')
  const download = await desk.download(() => desk.getByTestId('export-csv').click())
  await download.path()
})

test(${JSON.stringify(names.prevent)}, { apps: ['desk'] }, async ({ desk }) => {
  await handled(desk, 'prevent')
  const download = await desk.download(() => desk.getByTestId('export-csv').click())
  await download.path()
})

test(${JSON.stringify(names.pause)}, { apps: ['desk'] }, async ({ desk }) => {
  await handled(desk, 'pause')
  const download = await desk.download(() => desk.getByTestId('export-slow').click())
  expect(download.suggestedFilename).toBe('retest-electron-slow.csv')
  await download.path({ timeout: 1500 })
})

test(${JSON.stringify(names.session)}, { apps: ['desk'] }, async ({ desk }) => {
  await desk.download(() => desk.getByRole('button', { name: 'Download for no window' }).click(), { timeout: 1500 })
})

test(${JSON.stringify(names.secret)}, { apps: ['desk'] }, async ({ desk }) => {
  const download = await desk.download(() => desk.getByTestId('export-key').click())
  await download.path()
})

test(${JSON.stringify(names.partition)}, { apps: ['parted'] }, async ({ parted }) => {
  await parted.download(() => parted.getByTestId('export-csv').hover())
})
`

// The windows records of every launch of one app, as each quit wrote them, in launch order.
function windowsRecords(run: FinishedRun, app: string): { launch: number; notes?: string[] }[] {
  const folder = join(run.output, 'electron', slug(variantKey({ [app]: 'electron' })))
  return readdirSync(folder)
    .map((launch) => join(folder, launch, 'windows.json'))
    .filter((file) => existsSync(file))
    .map((file): { launch: number; notes?: string[] } => JSON.parse(readFileSync(file, 'utf8')))
    .sort((first, second) => first.launch - second.launch)
}

test("an Electron window's downloads are kept in the run folder, and what the app's own handler did to one is reported, never guessed", { timeout: 240_000, skip: unverified }, async (t) => {
  assert.ok(existsSync(electronBinary), missingBinary)
  const files = await fileServer(t)
  const saveDir = join(await scratchFolder(t, 'retest-electron-saves-'), 'saves')
  mkdirSync(saveDir)
  const root = await writeProject(t, { 'retest.config.ts': config(files, saveDir), 'tests/downloads.retest.ts': tests })
  const run = await runProject(t, root, { env: { RETEST_ELECTRON_DOWNLOAD_TOKEN: token }, timeouts: budgets() })

  const outcome = (name: string) => {
    const result = testNamed(run, name)
    return [result.status, result.failure?.class ?? null]
  }
  assert.deepEqual(Object.fromEntries(Object.values(names).map((name) => [name, outcome(name)])), {
    [names.link]: ['passed', null],
    [names.forWindow]: ['passed', null],
    [names.savePath]: ['passed', null],
    [names.saveDialog]: ['passed', null],
    [names.cancel]: ['failed', 'not_actionable'],
    [names.prevent]: ['failed', 'not_actionable'],
    [names.pause]: ['failed', 'timeout'],
    [names.session]: ['failed', 'timeout'],
    [names.secret]: ['error', 'unsupported'],
    [names.partition]: ['error', 'unsupported'],
  }, `${run.stdout}\n${run.stderr}`)
  assert.equal(run.exit.code, 1, `a failed test decides the exit code before the errors do. ${run.stderr}`)
  assert.equal(readFileSync(join(root, 'out', 'tasks.csv'), 'utf8'), csv, 'saveAs() copied the file')

  // Each download the window or the main process began for the window is recorded as the window's own, and the run
  // folder keeps each one that completed under the name the app's server suggested.
  const downloads = eventsOf(run.events, 'download')
  const downloadOf = (name: string) => {
    const { testId } = testNamed(run, name)
    return downloads.filter((event) => event.testId === testId)
  }
  for (const name of [names.link, names.forWindow, names.savePath, names.saveDialog]) {
    const [kept, ...others] = downloadOf(name)
    assert.ok(kept !== undefined && others.length === 0, JSON.stringify(downloadOf(name)))
    assert.deepEqual([kept.state, kept.suggestedFilename, kept.url, kept.size, kept.awaited, kept.startedIn], ['completed', 'retest-electron-tasks.csv', `${files}/files/tasks.csv`, Buffer.byteLength(csv), true, undefined])
    assert.match(kept.path ?? '', /^artifacts\/[a-z0-9]+\/desk-[a-z0-9]+\/downloads\/retest-electron-tasks\.csv$/)
    assert.equal(readFileSync(join(run.output, kept.path ?? ''), 'utf8'), csv)
  }

  // The app's handler ran each time, and believed what Electron told it: the download it gave a path of its own
  // completed at that path, though the file is in the run folder and not there.
  const log = readFileSync(join(run.output, targetBrowserLogFile(variantKey({ desk: 'electron' }))), 'utf8')
  for (const handling of ['save-path', 'save-dialog', 'cancel', 'prevent', 'pause']) assert.match(log, new RegExp(`^will-download retest-electron-(tasks|slow)\\.csv: ${handling}$`, 'm'))
  assert.ok(log.includes(`\ndone retest-electron-tasks.csv: completed, save path ${JSON.stringify(join(saveDir, 'retest-electron-tasks.csv'))}\n`), log)
  assert.deepEqual(readdirSync(saveDir), [], "nothing was saved at the app's own path")

  // A handler that cancels or prevents a download is told to Retest only as a stop with no reason, and the failure
  // says the app can do that, never that it did.
  const stopped = "The download of retest-electron-tasks.csv stopped after 0 bytes had arrived, and Chromium gives no reason. The Electron app's main process can cancel a download in its will-download handler, and Retest cannot see whether it did. Retest saved nothing."
  for (const name of [names.cancel, names.prevent]) {
    assert.equal(testNamed(run, name).failure?.message, stopped)
    assert.deepEqual(downloadOf(name).map((event) => [event.state, event.receivedBytes, event.failure?.class]), [['canceled', 0, 'not_actionable']])
  }
  assert.equal([...log.matchAll(/^done retest-electron-tasks\.csv: cancelled, save path ""$/gm)].length, 2, 'the app heard both downloads it stopped end as cancelled')

  // A paused download never finishes, and the test is told that the app can pause one.
  assert.match(
    testNamed(run, names.pause).failure?.message ?? '',
    /^The download of retest-electron-slow\.csv was not saved within 1500 ms: \d+ of 100000 bytes had arrived\. The Electron app's main process can pause a download in its will-download handler, and Retest cannot see whether it did\.$/,
  )
  assert.deepEqual(downloadOf(names.pause).map((event) => [event.state, event.totalBytes]), [['unfinished', 100000]])

  // A download the main process starts for no window: the app saw it complete, Chromium told Retest nothing of it,
  // and the launch's record says Retest removed what it saved.
  assert.equal(
    testNamed(run, names.session).failure?.message,
    "No download began within 1500 ms of page.download(). Check that its action starts one, as a link to a file does. A download the Electron app's main process starts with session.downloadURL() belongs to no window, and Chromium tells Retest nothing of it.",
  )
  assert.deepEqual(downloadOf(names.session), [], 'no event tells of it')
  assert.match(log, /^done retest-electron-session\.csv: completed, save path ""$/m)
  const unseen = windowsRecords(run, 'desk').flatMap((record) => (record.notes ?? []).filter((note) => note.includes('session.downloadURL()')))
  assert.equal(unseen.length, 1, JSON.stringify(windowsRecords(run, 'desk')))
  assert.match(unseen[0] ?? '', /^a download Chromium told nothing of, as one the app's main process starts with session\.downloadURL\(\), was saved in the downloads folder as [0-9a-f-]{36}; Retest removed it, since no record names it and nothing read it for secrets$/)

  // A download holding a secret is withheld, as on Chrome.
  assert.equal(testNamed(run, names.secret).failure?.message, 'Retest did not keep the download of retest-electron-key.txt: it holds the value of a secret, and a secret never reaches a file of the run. Retest removed the file.')
  assert.deepEqual(downloadOf(names.secret).map((event) => [event.state, event.path, event.failure?.class]), [['withheld', undefined, 'unsupported']])
  assert.deepEqual(filesHolding(run.output, token), [], 'the secret reached no file of the run')

  // A window in a session of its own: refused by name, and its launch's record says its downloads go the app's way.
  assert.equal(testNamed(run, names.partition).failure?.message, "The first window of the Electron app parted is in a session of its own, as a partition makes, and Retest sets where downloads go only in the app's default session, so it waited for none.")
  const [parted] = windowsRecords(run, 'parted')
  assert.deepEqual(parted?.notes?.filter((note) => note.includes('session')), ["the first window is not in the app's default session, so Retest neither saves nor refuses its downloads: they go the app's own way"])

  // Once each app quit, nothing Chromium saved under a download's id is left in the run folder.
  const left = readdirSync(run.output, { recursive: true, encoding: 'utf8' }).filter((path) => path.includes('/downloads/') && downloadId.test(path.split('/').at(-1) ?? ''))
  assert.deepEqual(left, [])
})

test("a window given no downloads folder refuses every download, whatever the app's handler asks", { timeout: 60_000, skip: unverified }, async (t) => {
  assert.ok(existsSync(electronBinary), missingBinary)
  const files = await fileServer(t)
  const folder = await scratchFolder(t, 'retest-electron-refused-')
  // The handler gives the download a path of the app's own, so a download Retest failed to refuse lands there, never in
  // the person's own Downloads folder.
  const saveDir = join(folder, 'saves')
  mkdirSync(saveDir)
  const logFile = join(folder, 'electron.log')
  const options = { executablePath: electronBinary, appPath: fixtureApp, args: [`--files=${files}`, `--save-dir=${saveDir}`], windowsFile: join(folder, 'windows.json'), logFile, app: 'desk', target: 'electron', launch: 1 }
  const app = await launchElectron(options, defaultTimeouts.setup)
  t.after(() => app.close(defaultTimeouts.cleanup))
  const page = await app.newPage({}, defaultTimeouts.setup)
  assert.equal(page.files?.onDownload, undefined, 'no test can wait for a download there')
  assert.equal(page.files?.downloadsRefused, undefined, 'and none is refused by name: the window is in the default session')
  assertOk(await click(page, 'handle-save-path'))
  await observeUntil(page, 'handling', (observation) => observation.text === 'save-path')
  assertOk(await click(page, 'export-csv'))
  await waitFor('the app to hear how its download ended', () => readFileSync(logFile, 'utf8').includes('done retest-electron-tasks.csv'))
  assert.match(readFileSync(logFile, 'utf8'), /^done retest-electron-tasks\.csv: cancelled, save path /m)
  assert.deepEqual(readdirSync(saveDir), [], 'the download was refused, not saved where the app asked')
})
