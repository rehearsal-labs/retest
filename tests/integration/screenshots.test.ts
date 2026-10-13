import type { TestContext } from 'node:test'
import type { EventOf, FinishedRun } from './cli-harness.ts'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { startTaskApp } from '../../fixtures/task-app/server.ts'
import { readPng, writePng } from '../../src/shared/png.ts'
import { budgets, configSource, eventsOf, runCli, runProject, testNamed, writeProject } from './cli-harness.ts'
import { engineUnderTest, protocolOnly } from './engines.ts'

// `toHaveScreenshot` end to end, through the command line, on the stable fixture page at 400 by 300 pixels. A first
// run of the matching cases fails for want of baselines and leaves each candidate; a run with --update-screenshots
// writes them and says how many, never from a loading state; an ordinary run of the whole file then passes the matching
// cases and fails each other case by name, with its pictures. The page's cases run on every engine; an element's
// picture, a device scale factor of 2 and a popup are Chromium's.

const engine = engineUnderTest()
const platform = `${process.platform}-${process.arch}`
const timeouts = budgets({ assertion: 3000 })
const matching = ['--grep', '/matches its baseline/']
const update = [...matching, '--update-screenshots']
const swatchColour = [217, 79, 48]

const pageTests = `import { expect, test } from '@rehearsal-labs/retest'

test('the page matches its baseline', { apps: ['web'] }, async ({ web }) => {
  await web.goto('/stable')
  await expect(web).toHaveScreenshot('page')
})

test('a page with a spinner that stops matches its baseline', { apps: ['web'] }, async ({ web }) => {
  await web.goto('/stable?settle=700')
  await expect(web).toHaveScreenshot('page')
})

test('a page that loads for a moment matches its baseline', { apps: ['web'] }, async ({ web }) => {
  await web.goto('/stable?late=700')
  await expect(web).toHaveScreenshot('loaded')
})

test('a page that loads for a moment, then shows another colour, fails', { apps: ['web'] }, async ({ web }) => {
  await web.goto('/stable?late=700&colour=changed')
  await expect(web).toHaveScreenshot('loaded')
})

test('another colour differs by the swatch', { apps: ['web'] }, async ({ web }) => {
  await web.goto('/stable?colour=changed')
  await expect(web).toHaveScreenshot('page')
})

test('enough maxDiffPixels lets the other colour through', { apps: ['web'] }, async ({ web }) => {
  await web.goto('/stable?colour=changed')
  await expect(web).toHaveScreenshot('page', { maxDiffPixels: 9600 })
})

test('with both limits each must hold', { apps: ['web'] }, async ({ web }) => {
  await web.goto('/stable?colour=changed')
  await expect(web).toHaveScreenshot('page', { maxDiffPixels: 9600, maxDiffPixelRatio: 0.05 })
})

test('a page that never stops moving does not settle', { apps: ['web'] }, async ({ web }) => {
  await web.goto('/stable?motion=forever')
  await expect(web).toHaveScreenshot('page', { timeout: 1500 })
})
`

const elementTests = `import { expect, test } from '@rehearsal-labs/retest'

test('the swatch matches its baseline', { apps: ['web'] }, async ({ web }) => {
  await web.goto('/stable')
  await expect(web.getByTestId('swatch')).toHaveScreenshot('swatch.png')
})

test('the page matches its baseline', { apps: ['web'] }, async ({ web }) => {
  await web.goto('/stable')
  await expect(web).toHaveScreenshot('page')
})

test('a popup matches its baseline', { apps: ['web'] }, async ({ web }) => {
  await web.goto('/stable?opener=1')
  const popup = await web.popup(() => web.getByTestId('opener').click())
  await expect(popup).toHaveScreenshot('popup')
})

test('a wider swatch fails by its size', { apps: ['web'] }, async ({ web }) => {
  await web.goto('/stable?size=wide')
  await expect(web.getByTestId('swatch')).toHaveScreenshot('swatch')
})

test('a picture at another scale fails by name', { apps: ['sharp'] }, async ({ sharp }) => {
  await sharp.goto('/stable')
  await expect(sharp).toHaveScreenshot('page')
})
`

// A test file that sends the parent raw looks the test's own API never sends, and writes down what came back.
const rawTests = `import { writeFileSync } from 'node:fs'
import { test } from '@rehearsal-labs/retest'

let ids = {}
process.on('message', (message) => { if (message && message.type === 'run') ids = { testId: message.testId, attemptId: message.attemptId } })

test('raw looks', { apps: ['web'] }, async ({ web }) => {
  await web.goto('/stable')
  const answers = new Map()
  process.on('message', (message) => { if (message && message.type === 'command-result' && message.id >= 900001) answers.set(message.id, message.result) })
  const send = (id, command) => process.send({ type: 'command', ...ids, id, app: 'web', command: { kind: 'observeScreenshot', check: true, ...command }, timeoutMs: 2000 })
  send(900001, { name: '../../../../../../tmp/elsewhere' })
  await new Promise((resolve) => setTimeout(resolve, 500))
  send(900002, { name: 'page', threshold: 5 })
  await new Promise((resolve) => setTimeout(resolve, 500))
  writeFileSync('answers.json', JSON.stringify([answers.get(900001), answers.get(900002)]))
})
`

async function project(t: TestContext, file: string, tests: string, config: { sharp?: boolean; pixels?: string } = {}): Promise<string> {
  const app = await startTaskApp()
  t.after(() => app.close())
  const base = `baseUrl: ${JSON.stringify(app.url)}`
  const web = engine.target(`${base}, viewport: { width: 400, height: 300 }`)
  const sharp = config.sharp === true ? `, sharp: ${engine.target(`${base}, emulate: { viewport: { width: 400, height: 300 }, deviceScaleFactor: 2, touch: false }`)}` : ''
  const pixels = config.pixels === undefined ? '' : `, pixels: ${config.pixels}`
  return writeProject(t, { 'retest.config.ts': configSource(`{ apps: { web: ${web}${sharp} }${pixels} }`), [file]: tests })
}

function failed(run: FinishedRun, name: string): EventOf<'assertion.failed'> {
  const found = testNamed(run, name)
  const event = eventsOf(run.events, 'assertion.failed').find((each) => each.testId === found.testId)
  assert.ok(event !== undefined, `${name} has a failed assertion`)
  return event
}

function picture(root: string, path: string) {
  return readPng(readFileSync(join(root, path)))
}

function rgb(image: { width: number; data: Uint8Array }, x: number, y: number): number[] {
  const at = (y * image.width + x) * 4
  return [...image.data.subarray(at, at + 3)]
}

function baseline(file: string, name: string): string {
  return `tests/__screenshots__/${file.slice('tests/'.length)}/${name}-${engine.name}-${platform}.png`
}

function assertPassed(run: FinishedRun, names: readonly string[]): void {
  for (const name of names) assert.equal(testNamed(run, name).status, 'passed', `${name}: ${JSON.stringify(testNamed(run, name).failure)}`)
}

test('a page\'s baseline is missing, then written by --update-screenshots, then compared pixel by pixel', async (t) => {
  const file = 'tests/pages.retest.ts'
  const root = await project(t, file, pageTests)
  const page = baseline(file, 'page')
  const loaded = baseline(file, 'loaded')
  const matchingNames = ['the page matches its baseline', 'a page with a spinner that stops matches its baseline', 'a page that loads for a moment matches its baseline']

  // No baseline yet: each check fails, names the file it looked for, and leaves its picture as the candidate.
  const first = await runProject(t, root, { timeouts, args: matching })
  assert.equal(first.exit.code, 1, first.stderr)
  for (const name of matchingNames) assert.equal(testNamed(first, name).status, 'failed', name)
  const missing = failed(first, 'the page matches its baseline')
  assert.equal(missing.failure.class, 'check_failed')
  assert.match(missing.failure.message, new RegExp(`^No baseline named "page" exists at ${page.replaceAll('.', '\\.')}\\. Run with --update-screenshots to save this picture as the baseline\\. Looked \\d+ times in \\d+ ms\\.$`))
  assert.equal(missing.screenshot?.baselineState, 'missing')
  assert.deepEqual(missing.attachments?.map((attachment) => attachment.name), ['actual'])
  const candidate = missing.attachments?.[0]?.path ?? ''
  assert.match(candidate, /^artifacts\/[a-z0-9]+\/web-[a-z0-9-]+\/page-o\d+-actual\.png$/)
  assert.deepEqual([picture(first.output, candidate).width, picture(first.output, candidate).height], [400, 300])
  assert.equal(existsSync(join(root, page)), false, 'a failing run writes no baseline')

  // The update run writes each baseline once, never from the grey the loading page shows first, and says how many.
  const updated = await runProject(t, root, { timeouts, args: update, reporter: 'human' })
  assert.equal(updated.exit.code, 0, updated.stdout + updated.stderr)
  assert.equal(updated.result?.baselinesWritten, 2)
  assert.deepEqual(eventsOf(updated.events, 'baseline.written').map((event) => [event.name, event.path, event.width, event.height, event.replaced]).sort(), [['loaded', loaded, 400, 300, false], ['page', page, 400, 300, false]])
  assert.match(updated.stdout, /Baselines\s+2 written by --update-screenshots/)
  const saved = picture(root, page)
  assert.deepEqual([saved.width, saved.height], [400, 300])
  assert.deepEqual(rgb(picture(root, loaded), 80, 100), swatchColour, 'the loading page\'s baseline is its final state, not its grey')

  // An ordinary run of the whole file: the matching cases pass, and each other case fails by name with its pictures.
  const run = await runProject(t, root, { timeouts })
  assert.equal(run.exit.code, 1, run.stderr)
  assertPassed(run, [...matchingNames, 'enough maxDiffPixels lets the other colour through'])
  const passed = eventsOf(run.events, 'assertion.passed').filter((event) => event.matcher === 'toHaveScreenshot')
  assert.deepEqual(passed.map((event) => [event.screenshot?.baselineState, event.screenshot?.differentPixels]), [['compared', 0], ['compared', 0], ['compared', 0], ['compared', 9600]])
  assert.equal(eventsOf(run.events, 'baseline.written').length, 0, 'an ordinary run writes no baseline')
  assert.equal(run.result?.baselinesWritten, undefined)

  const regressed = failed(run, 'a page that loads for a moment, then shows another colour, fails')
  assert.match(regressed.failure.message, /^9600 pixels differ from the baseline "loaded", a ratio of 0\.08 of its 120000 pixels\. At most 0 may differ\. Looked/)

  const colour = failed(run, 'another colour differs by the swatch')
  assert.equal(colour.failure.class, 'check_failed')
  assert.match(colour.failure.message, /^9600 pixels differ from the baseline "page", a ratio of 0\.08 of its 120000 pixels\. At most 0 may differ\. Looked/)
  assert.deepEqual([colour.screenshot?.differentPixels, colour.screenshot?.allowedPixels], [9600, 0])
  assert.deepEqual(colour.attachments?.map((attachment) => attachment.name), ['expected', 'actual', 'diff'])
  const [expected, actual, diff] = (colour.attachments ?? []).map((attachment) => picture(run.output, attachment.path))
  assert.ok(expected !== undefined && actual !== undefined && diff !== undefined)
  assert.ok(Buffer.from(expected.data).equals(Buffer.from(saved.data)), 'the expected picture is the baseline')
  assert.deepEqual(rgb(diff, 80, 100), [255, 0, 0], 'a pixel of the swatch is marked')
  assert.notDeepEqual(rgb(diff, 10, 10), [255, 0, 0], 'a pixel of the bar is not')

  const both = failed(run, 'with both limits each must hold')
  assert.match(both.failure.message, /^9600 pixels differ from the baseline "page", a ratio of 0\.08 of its 120000 pixels\. At most 6000 may differ\./)

  const moving = failed(run, 'a page that never stops moving does not settle')
  assert.match(moving.failure.message, /^The page never settled\. No two pictures in a row were the same, so Retest compared none with the baseline "page"\. An animation that never stops cannot be compared\. Looked \d+ times in 1500 ms\.$/)
  assert.equal(moving.screenshot?.settled, false)
  assert.ok(moving.attempts > 2, 'it kept looking')
  assert.deepEqual(moving.attachments?.map((attachment) => attachment.name), ['actual'])

  // The HTML report shows each failure's pictures side by side, and every one of them is named by a record.
  const report = await runCli(t, ['report', run.output])
  assert.equal(report.exit.code, 0, report.stderr)
  const html = readFileSync(join(run.output, 'report.html'), 'utf8')
  const unnamed = html.indexOf('named by no record')
  for (const attachment of colour.attachments ?? []) {
    assert.ok(html.includes(`<img src="${attachment.path}"`), `the report shows ${attachment.path}`)
    assert.ok(unnamed === -1 || !html.slice(unnamed).includes(attachment.path), `the report lists ${attachment.path} as named by no record`)
  }

  // A baseline whose image data a byte has changed in cannot be read, and the check fails with that, naming the file.
  const good = readFileSync(join(root, page))
  const damaged = Buffer.from(good)
  const data = damaged.indexOf(Buffer.from('IDAT')) + 8
  damaged[data] = (damaged[data] ?? 0) ^ 0x55
  writeFileSync(join(root, page), damaged)
  const broken = await runProject(t, root, { timeouts, args: ['--grep', 'the page matches its baseline'] })
  assert.equal(broken.exit.code, 2, broken.stderr)
  const unreadable = failed(broken, 'the page matches its baseline')
  assert.equal(unreadable.failure.class, 'setup_failed')
  assert.equal(unreadable.failure.message, `The baseline at ${page} is not a picture Retest reads: The PNG's IDAT chunk fails its checksum, so the file is damaged.`)
  assert.equal(unreadable.failure.details?.['also'], undefined, 'nothing else leads it')
  assert.deepEqual([unreadable.screenshot?.settled, unreadable.screenshot?.baselineState], [true, 'unreadable'])
})

test('an element\'s picture is clipped to it, a popup is a page, and a picture at another size or scale fails by name', async (t) => {
  if (!protocolOnly(t, 'chromium', 'an element\'s picture, a device scale factor of 2 and a popup are taken through DevTools')) return
  const file = 'tests/elements.retest.ts'
  const root = await project(t, file, elementTests, { sharp: true })

  const updated = await runProject(t, root, { timeouts, args: update })
  assert.equal(updated.exit.code, 0, updated.stderr)
  const written = eventsOf(updated.events, 'baseline.written')
  assert.deepEqual(written.map((event) => [event.name, event.width, event.height, event.scale]), [['swatch', 120, 80, 1], ['page', 400, 300, 1], ['popup', written[2]?.width ?? 0, written[2]?.height ?? 0, 1]])
  assert.match(written[2]?.session ?? '', /^web\/popup-\d+$/, 'the popup\'s baseline came from the popup\'s own page')
  assert.equal(picture(root, baseline(file, 'swatch')).text['retest:scale'], '1')

  const run = await runProject(t, root, { timeouts })
  assert.equal(run.exit.code, 1, run.stderr)
  assertPassed(run, ['the swatch matches its baseline', 'the page matches its baseline', 'a popup matches its baseline'])
  const swatch = eventsOf(run.events, 'assertion.passed').find((event) => event.locator !== undefined && event.matcher === 'toHaveScreenshot')
  assert.deepEqual(swatch?.screenshot?.picture, { width: 120, height: 80, scale: 1 })

  const wide = failed(run, 'a wider swatch fails by its size')
  assert.match(wide.failure.message, /^The picture is 160 by 80 pixels, and the baseline "swatch" is 120 by 80 pixels\. Looked/)
  assert.deepEqual(wide.attachments?.map((attachment) => attachment.name), ['expected', 'actual', 'diff'])

  const scale = failed(run, 'a picture at another scale fails by name')
  assert.match(scale.failure.message, /^The picture is 800 by 600 pixels, and the baseline "page" is 400 by 300 pixels\. The picture was taken at a device scale factor of 2, and the baseline "page" at 1\. Looked/)
  assert.deepEqual([scale.screenshot?.picture?.scale, scale.screenshot?.expected?.scale], [2, 1])

  // A baseline that records no device scale factor cannot be told from one taken at another, so it fails by name.
  const page = join(root, baseline(file, 'page'))
  const plain = readPng(readFileSync(page))
  writeFileSync(page, writePng({ width: plain.width, height: plain.height, data: plain.data }))
  const unscaled = await runProject(t, root, { timeouts, args: ['--grep', 'the page matches its baseline'] })
  assert.equal(unscaled.exit.code, 1, unscaled.stderr)
  assert.match(failed(unscaled, 'the page matches its baseline').failure.message, /^The baseline "page" records no device scale factor, and the picture was taken at 1\. Rewrite it with --update-screenshots\. Looked/)
})

test('a config that allows no screenshots of an app refuses its comparison, with the pixel policy\'s sentence', async (t) => {
  const file = 'tests/never.retest.ts'
  const root = await project(t, file, pageTests.slice(0, pageTests.indexOf("test('a page with a spinner")), { pixels: "{ web: { screenshots: 'never' } }" })
  const run = await runProject(t, root, { timeouts, args: ['--update-screenshots'] })
  assert.equal(run.exit.code, 2, run.stderr)
  const refused = failed(run, 'the page matches its baseline')
  assert.equal(refused.failure.class, 'unsupported')
  assert.match(refused.failure.message, /^The config does not allow screenshots of web, so Retest took none\./)
  assert.equal(refused.attachments, undefined)
  assert.equal(eventsOf(run.events, 'baseline.written').length, 0)
  assert.equal(existsSync(join(root, baseline(file, 'page'))), false, 'no picture was taken, so no baseline was written')
})

test('the parent refuses a look whose name leaves the baseline\'s folder or whose threshold is not a distance', async (t) => {
  const root = await project(t, 'tests/raw.retest.ts', rawTests)
  const run = await runProject(t, root, { timeouts })
  assert.equal(testNamed(run, 'raw looks').status, 'failed', JSON.stringify(testNamed(run, 'raw looks').failure))
  const answers: unknown = JSON.parse(readFileSync(join(root, 'answers.json'), 'utf8'))
  assert.deepEqual(answers, [
    { ok: false, failure: { class: 'usage', message: "toHaveScreenshot() received the name '../../../../../../tmp/elsewhere'. A screenshot's name is lowercase letters, digits, dots, dashes and underscores, starting with a letter or a digit, such as 'dashboard' or 'chart-empty'." } },
    { ok: false, failure: { class: 'usage', message: 'The threshold option of toHaveScreenshot() is a colour distance from 0 to 1, received 5.' } },
  ])
  assert.equal(testNamed(run, 'raw looks').failure?.class, 'usage', 'the refusal fails the test whatever its file says')
})

/**
 * Runs one check of an element's picture on the engine under test and gives its failed assertion: for an engine that
 * takes no picture of one element, which its own file checks is refused by name.
 */
export async function elementRefusal(t: TestContext): Promise<EventOf<'assertion.failed'>> {
  const file = 'tests/element.retest.ts'
  const root = await project(t, file, elementTests.slice(0, elementTests.indexOf("test('the page matches")))
  const run = await runProject(t, root, { timeouts })
  assert.equal(run.exit.code, 2, run.stderr)
  return failed(run, 'the swatch matches its baseline')
}
