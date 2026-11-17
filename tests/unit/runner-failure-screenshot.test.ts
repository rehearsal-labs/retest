import type { TestContext } from 'node:test'
import type { SessionIdentity } from '../../src/browser/contract.ts'
import type { EventBody } from '../../src/protocol/events.ts'
import type { Evidence } from '../../src/protocol/result.ts'
import type { FailureEnding, PagesContext } from '../../src/runner/test-pages.ts'
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { defaultTimeouts } from '../../src/protocol/timeouts.ts'
import { abortGraceMs } from '../../src/runner/running-test.ts'
import { captureFailure } from '../../src/runner/test-pages.ts'
import { RunStore } from '../../src/store/run-store.ts'
import { FakeBrowser } from '../support/fake-browser.ts'
import { newRunFolder } from '../support/run-harness.ts'

// A failure screenshot on timers the test moves itself, of a page whose capture never answers, as Chromium's can while its
// page is between documents, or answers at once. A capture that never answers holds the attempt for the cleanup budget,
// as an ordinary failure's always has, unless the test ran out of its time while the page was still opening another
// document: then it is given the second a stopped test's process gets to answer.

const testId = 'tests/orders.retest.ts > opens the order'
const attemptId = 'k3v9q0x2mb'
const cleanupMs = defaultTimeouts.cleanup
const openingMessage = `The page was still opening another document when the test ran out of time, and gave no picture within ${abortGraceMs} ms.`

type Capturing = { evidence: Promise<Evidence[]>; settled: () => boolean; messages: () => string[]; captured: () => number }
type Case = { ending: FailureEnding; opening: boolean; hangs: boolean }

// Lets the capture's promises and the events they emit settle, on the real event loop: only setTimeout is mocked.
async function settle(): Promise<void> {
  for (let turn = 0; turn < 10; turn++) await new Promise((resolve) => setImmediate(resolve))
}

async function capturing(t: TestContext, { ending, opening, hangs }: Case): Promise<Capturing> {
  const store = RunStore.create(newRunFolder())
  t.after(() => store.close())
  const browser = new FakeBrowser({ screenshotHangs: hangs }, { executablePath: '/fake/chromium', logFile: '/dev/null', headless: true })
  const page = await browser.newPage({}, defaultTimeouts.setup)
  page.navigating = opening
  const emitted: EventBody[] = []
  const context: PagesContext = {
    store,
    timeouts: { ...defaultTimeouts },
    stopped: new Promise(() => {}),
    interruption: () => undefined,
    connected: () => true,
    release: () => {},
    named: false,
    emit: (body) => {
      emitted.push(body)
    },
    redact: (text) => text,
    testId,
    attemptId,
  }
  const runtime = { kind: 'web', engine: 'chromium', product: browser.product, version: browser.version, executablePath: browser.executablePath, processIds: [browser.pid] } as const
  const session: SessionIdentity = { sessionId: `${attemptId}:page`, owner: { runId: 'run', testId, attemptId, app: 'page' }, runtime }
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let settled = false
  const evidence = captureFailure(context, [{ app: 'page', page, browser, touch: false, session }], ending).finally(() => {
    settled = true
  })
  await settle()
  const messages = (): string[] => emitted.flatMap((body) => (body.type === 'evidence.failed' ? [body.message] : []))
  const captured = (): number => emitted.filter((body) => body.type === 'evidence.captured').length
  return { evidence, settled: () => settled, messages, captured }
}

// Moves the mocked clock to a moment before the screenshot's wait is over, then to its end.
async function waitsTheBudget(t: TestContext, capture: Capturing): Promise<void> {
  assert.equal(capture.settled(), false, 'the capture waits for its picture')
  t.mock.timers.tick(cleanupMs + abortGraceMs - 1)
  await settle()
  assert.equal(capture.settled(), false, 'it is still waiting a millisecond before the cleanup budget and its grace are over')
  t.mock.timers.tick(1)
  await settle()
  assert.equal(capture.settled(), true)
  assert.deepEqual(await capture.evidence, [])
  assert.deepEqual(capture.messages(), [`Taking a screenshot took longer than ${cleanupMs} ms.`])
}

describe('the failure screenshot', () => {
  test('a test out of time whose page is still opening another document waits a second for its picture, then says why it has none', async (t) => {
    const capture = await capturing(t, { ending: 'timed_out', opening: true, hangs: true })
    t.mock.timers.tick(abortGraceMs - 1)
    await settle()
    assert.equal(capture.settled(), false, 'it is still waiting a millisecond before the second is over')
    t.mock.timers.tick(1)
    await settle()
    assert.equal(capture.settled(), true, 'it ended when the second was over')
    assert.deepEqual(await capture.evidence, [])
    assert.deepEqual(capture.messages(), [openingMessage])
  })

  test('a test out of time whose page is still opening another document keeps the picture the page gives within the second', async (t) => {
    const capture = await capturing(t, { ending: 'timed_out', opening: true, hangs: false })
    assert.equal(capture.settled(), true, 'the picture came before the clock moved')
    assert.equal((await capture.evidence).length, 1)
    assert.deepEqual([capture.captured(), capture.messages()], [1, []])
  })

  test('an ordinary failure on a page still opening another document waits for its picture within the cleanup budget', async (t) => {
    await waitsTheBudget(t, await capturing(t, { ending: 'failed', opening: true, hangs: true }))
  })

  test('a test out of time whose page holds the document it shows waits for its picture within the cleanup budget', async (t) => {
    await waitsTheBudget(t, await capturing(t, { ending: 'timed_out', opening: false, hangs: true }))
  })
})
