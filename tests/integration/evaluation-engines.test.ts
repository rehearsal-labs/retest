import type { TestContext } from 'node:test'
import type { EngineName, TestEngine } from './engines.ts'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { firefoxPlatformProblem } from '../../src/browser/firefox/executable.ts'
import { pngSize } from '../../src/evaluation/evidence.ts'
import { formatSessionId } from '../../src/protocol/evidence.ts'
import { servePages } from './browser-harness.ts'
import { budgets, configSource, eventsOf, repositoryRoot, resultOf, runProject, scratchFolder, testNamed, writeProject } from './cli-harness.ts'
import { engineUnderTest } from './engines.ts'

// AI checks over each engine's own screenshots, through a real `retest run` on Chrome, Firefox and WebKit, with judges
// that call no model: the fake judge answers the verdict its criterion names, and a pixel judge decodes the PNG it is
// sent and fails a page that shows the controlled defect, a magenta banner across the page, which only real pixels can
// show. Each judge names what it takes in `accepts`, and a judge that takes no images is never sent one. Every engine
// is held to the same result contract: the same statuses, failure classes and verdicts, a screenshot frozen in the run
// folder with its identity, the engine that took it, its size and its hash, and the judge given exactly those bytes.
// It proves Retest's
// evidence and verdict path on each engine's captures, not any model's judgement; the live provider gates are in
// evaluation-ai-sdk.test.ts.

type EngineCase = { engine: TestEngine; unavailable: string | undefined }

// engines.ts names one engine per process through RETEST_TEST_ENGINE; this file drives all three in one process, so it
// reads each one's entry by name once, before any test runs, and puts the variable back as it found it.
function engineNamed(name: EngineName): TestEngine {
  const saved = process.env['RETEST_TEST_ENGINE']
  process.env['RETEST_TEST_ENGINE'] = name
  try {
    return engineUnderTest()
  } finally {
    if (saved === undefined) delete process.env['RETEST_TEST_ENGINE']
    else process.env['RETEST_TEST_ENGINE'] = saved
  }
}

const cases: readonly EngineCase[] = [
  { engine: engineNamed('chromium'), unavailable: undefined },
  { engine: engineNamed('firefox'), unavailable: firefoxPlatformProblem() },
  { engine: engineNamed('webkit'), unavailable: process.platform === 'darwin' ? undefined : `Retest runs WebKit on macOS only, and this host is ${process.platform}` },
]

const fakeJudge = fileURLToPath(new URL('../support/fake-evaluator.ts', import.meta.url))
const viewport = { width: 800, height: 600 }

/**
 * The page a check judges: a saved task, and on the broken page a magenta banner over half the viewport that says the
 * save failed. The colour is one nothing else on either page uses.
 */
function taskPage(broken: boolean): string {
  const banner = broken ? '<div data-testid="banner" style="position: fixed; top: 0; left: 0; width: 800px; height: 300px; background: #ff00ff; color: #000">Saving failed</div>' : ''
  return `<!doctype html><html><head><title>Task</title><link rel="icon" href="data:,"></head><body style="margin: 0; font: 16px sans-serif; background: #fff">
<main style="padding: 340px 24px 0"><h1 data-testid="saved-task">Release checklist</h1><p data-testid="status">Saved</p></main>${banner}</body></html>`
}

/**
 * A judge that reads pixels: it decodes each PNG it is sent with Retest's own decoder, counts the pixels of the
 * defect's colour, and fails when they cover more than a twentieth of the image. It writes what it received, by hash,
 * to `options.log`.
 */
function pixelJudge(): string {
  const decoder = pathToFileURL(join(repositoryRoot, 'src/native/png.ts')).href
  return `import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { decodePng } from ${JSON.stringify(decoder)}

export default function makePixelJudge(setup) {
  const log = String(setup.options.log)
  return {
    identity: { provider: 'fake', model: 'pixel-colour', version: 'pixel-judge/1' },
    async evaluate(request) {
      const images = request.evidence.filter((item) => item.kind === 'image')
      const verdicts = images.map((image) => {
        const png = decodePng(image.data)
        let marked = 0
        for (let index = 0; index + 2 < png.pixels.length; index += png.channels) {
          if (png.channels >= 3 && png.pixels[index] > 200 && png.pixels[index + 1] < 60 && png.pixels[index + 2] > 200) marked += 1
        }
        const share = marked / (png.width * png.height)
        appendFileSync(log, JSON.stringify({ id: image.id, app: image.app, sha256: createHash('sha256').update(image.data).digest('hex'), width: png.width, height: png.height, share }) + '\\n')
        return share > 0.05 ? 'fail' : 'pass'
      })
      const verdict = images.length === 0 ? 'inconclusive' : verdicts.includes('fail') ? 'fail' : 'pass'
      return {
        criteria: request.criteria.map(({ id }) => ({ id, verdict, citations: verdict === 'inconclusive' ? [] : images.map((image) => image.id) })),
        justification: verdict === 'fail' ? 'The defect colour covers part of the page.' : 'The defect colour is not on the page.',
      }
    },
  }
}
`
}

const judgedTests = `import { expect, test } from '@rehearsal-labs/retest'

async function open(page, path) {
  await page.goto(path)
  await expect(page.getByTestId('status')).toHaveText('Saved')
}

test('the page without the defect', async ({ page }) => {
  await open(page, '/fixed')
  await test.evaluate({ judge: 'pixels', requirement: { 'no-banner': 'No error banner covers the page.' }, evidence: { capture: 'screenshot' } })
})

test('the page with the defect', async ({ page }) => {
  await open(page, '/broken')
  await test.evaluate({ judge: 'pixels', requirement: { 'no-banner': 'No error banner covers the page.' }, evidence: { capture: 'screenshot' } })
})

test('scripted pass', async ({ page }) => {
  await open(page, '/fixed')
  await test.evaluate({ judge: 'fake', requirement: { pass: 'The page shows the saved task.' }, evidence: { capture: 'screenshot' } })
})

test('scripted fail', async ({ page }) => {
  await open(page, '/fixed')
  await test.evaluate({ judge: 'fake', requirement: { fail: 'The page shows the saved task.' }, evidence: { app: 'web', capture: 'screenshot' } })
})

test('scripted inconclusive', async ({ page }) => {
  await open(page, '/fixed')
  await test.evaluate({ judge: 'fake', requirement: { inconclusive: 'The page shows the saved task.' }, evidence: { capture: 'screenshot' } })
})

test('a judge that takes no images', async ({ page }) => {
  await open(page, '/fixed')
  await test.evaluate({ judge: 'words', requirement: { pass: 'The page shows the saved task.' }, evidence: { capture: 'screenshot' } })
})
`

/** Each test's name, status, failure class and check verdict, which every engine must give alike. */
const contract = [
  ['the page without the defect', 'passed', undefined, 'pass'],
  ['the page with the defect', 'failed', 'evaluation_failed', 'fail'],
  ['scripted pass', 'passed', undefined, 'pass'],
  ['scripted fail', 'failed', 'evaluation_failed', 'fail'],
  ['scripted inconclusive', 'inconclusive', 'evaluation_inconclusive', 'inconclusive'],
  ['a judge that takes no images', 'error', 'evaluation_error', 'error'],
] as const

/** A JSON value at a path of keys and indexes, or undefined when the path leads nowhere. */
function at(value: unknown, path: readonly (string | number)[]): unknown {
  let current: unknown = value
  for (const step of path) {
    if (typeof current !== 'object' || current === null) return undefined
    current = Reflect.get(current, step)
  }
  return current
}

function jsonLines(file: string): unknown[] {
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter((line) => line !== '').map((line): unknown => JSON.parse(line)) : []
}

async function judged(t: TestContext, engine: TestEngine): Promise<void> {
  const site = await servePages(t, { '/fixed': taskPage(false), '/broken': taskPage(true) })
  const logs = await scratchFolder(t, 'retest-judge-')
  const fakeLog = join(logs, 'fake.jsonl')
  const pixelLog = join(logs, 'pixels.jsonl')
  const target = engine.target(`baseUrl: ${JSON.stringify(site.url)}, viewport: ${JSON.stringify(viewport)}`)
  const root = await writeProject(t, {
    'retest.config.ts': configSource(`{
  apps: { web: ${target} },
  evaluation: {
    judges: {
      fake: { adapter: ${JSON.stringify(fakeJudge)}, options: { log: ${JSON.stringify(fakeLog)} }, accepts: ['text', 'images'] },
      pixels: { adapter: './judges/pixels.ts', options: { log: ${JSON.stringify(pixelLog)} }, accepts: ['images'] },
      words: { adapter: ${JSON.stringify(fakeJudge)}, options: { log: ${JSON.stringify(fakeLog)}, tag: 'words' }, accepts: ['text'] },
    },
    timeoutMs: 20000,
  },
}`),
    'judges/pixels.ts': pixelJudge(),
    'tests/judged.retest.ts': judgedTests,
  })
  const finished = await runProject(t, root, { env: engine.environment, timeouts: budgets({ assertion: 10_000, action: 5000, test: 30_000 }) })
  assert.equal(finished.exit.code, 1, `${finished.stdout}\n${finished.stderr}`)

  // The same statuses, failure classes and verdicts on every engine.
  const outcomes = contract.map(([name]) => {
    const result = testNamed(finished, name)
    return [name, result.status, result.failure?.class, result.evaluations?.[0]?.verdict]
  })
  assert.deepEqual(outcomes, contract.map((row) => [...row]))
  assert.deepEqual(resultOf(finished).counts, { passed: 2, failed: 2, error: 1, notRun: 0, inconclusive: 1 })
  assert.equal(eventsOf(finished.events, 'evaluation.finished').length, contract.length)

  // Each screenshot check froze one PNG of this attempt's session of web in the run folder, at the viewport's size,
  // and named the judge that took it.
  const shots = contract.slice(0, 5).map(([name]) => {
    const result = testNamed(finished, name)
    const [evaluation] = result.evaluations ?? []
    assert.equal(evaluation?.judge, name.startsWith('scripted') ? 'fake' : 'pixels', name)
    assert.equal(evaluation?.evidence.length, 1, `${name} has one piece of evidence`)
    const [shot] = evaluation?.evidence ?? []
    assert.ok(shot !== undefined && shot.kind === 'screenshot' && shot.path !== undefined, name)
    assert.deepEqual([shot.app, shot.sessionId, shot.attemptId, shot.testId], ['web', formatSessionId(result.attemptId, 'web'), result.attemptId, result.testId], `${name}: the screenshot's identity`)
    const bytes = readFileSync(join(finished.output, shot.path))
    assert.equal(createHash('sha256').update(bytes).digest('hex'), shot.sha256, `${name}: the file is what the record names`)
    assert.equal(bytes.byteLength, shot.bytes)
    assert.deepEqual(pngSize(bytes), { width: shot.width, height: shot.height }, `${name}: the record's size is the PNG's own`)
    assert.deepEqual({ width: shot.width, height: shot.height }, viewport, `${name}: a capture of the viewport at a pixel ratio of 1`)
    assert.ok(shot.capturedElapsedMs !== undefined && shot.capturedElapsedMs >= 0, `${name}: the capture is placed on the run's clock`)
    assert.equal(shot.source, engine.name, `${name}: the record names the engine that took the capture`)
    return { name, sha256: shot.sha256, bytes: shot.bytes, width: shot.width, height: shot.height }
  })

  // The judges were given exactly the bytes the run folder keeps, and the pixel judge saw the defect only on the page
  // that has it.
  const pixelCalls = jsonLines(pixelLog)
  assert.equal(pixelCalls.length, 2, 'the pixel judge was asked twice')
  const fixedShot = shots[0]
  const brokenShot = shots[1]
  assert.deepEqual(pixelCalls.map((call) => [at(call, ['sha256']), at(call, ['app']), at(call, ['width']), at(call, ['height'])]), [fixedShot, brokenShot].map((shot) => [shot?.sha256, 'web', viewport.width, viewport.height]))
  const [fixedShare, brokenShare] = pixelCalls.map((call) => Number(at(call, ['share'])))
  assert.ok(fixedShare !== undefined && fixedShare < 0.001, `no defect colour on the fixed page: ${fixedShare}`)
  assert.ok(brokenShare !== undefined && brokenShare > 0.3, `the banner covers about half the broken page: ${brokenShare}`)
  const fakeCalls = jsonLines(fakeLog).flatMap((entry) => at(entry, ['call']) ?? [])
  assert.equal(fakeCalls.length, 3, 'the fake judge was asked for the three scripted checks and never for the text judge')
  for (const [index, call] of fakeCalls.entries()) {
    const shot = shots[index + 2]
    assert.deepEqual(['kind', 'app', 'width', 'height', 'bytes'].map((field) => at(call, ['evidence', 0, field])), ['image', 'web', shot?.width, shot?.height, shot?.bytes], `the fake judge received ${shot?.name}'s capture`)
    assert.equal(at(call, ['tag']), undefined, 'only the judge that takes images was called')
  }

  // A judge that takes no images is never sent one, and nothing is captured for it.
  const refused = testNamed(finished, 'a judge that takes no images').evaluations?.[0]
  assert.match(refused?.reason ?? '', /The judge "words" does not accept images: its accepts lists text\./)
  assert.deepEqual(refused?.evidence, [])
  t.diagnostic(`${engine.label} screenshots: ${JSON.stringify({ source: testNamed(finished, 'scripted pass').evaluations?.[0]?.evidence[0]?.source ?? null, shares: [fixedShare, brokenShare] })}`)
}

for (const { engine, unavailable } of cases) {
  test(`${engine.label}: AI checks over the engine's own screenshots keep the same result contract, judge a controlled visible defect from real pixels, and send images only to a judge that takes them`, async (t) => {
    if (unavailable !== undefined) {
      t.skip(unavailable)
      return
    }
    await judged(t, engine)
  })
}
