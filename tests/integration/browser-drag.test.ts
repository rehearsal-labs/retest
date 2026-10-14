import type { TestContext } from 'node:test'
import type { OwnedPage } from '../../src/browser/contract.ts'
import type { CommandResult } from '../../src/protocol/commands.ts'
import type { LocatorRecipe } from '../../src/protocol/locator.ts'
import type { DragMove } from '../../fixtures/task-app/drag-page.ts'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { DRAG_PAGE } from '../../fixtures/task-app/drag-page.ts'
import { launchElectron } from '../../src/browser/electron.ts'
import { assertOk, byTestId, byText, click, failureOf, goto, launch, observe, observeUntil, openApp, openPage, scratchFolder, sharedBrowser } from './browser-harness.ts'
import { engineAbsence } from './engines.ts'

// Drag and drop on Chrome, driven at the driver: an HTML drag the page begins is carried by the browser's drag events
// to the page's drop handler, with its data; a list that follows the mouse itself hears every step; a covered target
// or one that is not there fails before anything is sent; a target that leaves the page mid-drag ends the drag
// without a drop that pretends it reached it. drag.test.ts runs a drag through a whole run, events and report.

const browser = sharedBrowser()

type DragPage = { page: OwnedPage; moves: () => Promise<DragMove[]> }

async function dragPage(t: TestContext): Promise<DragPage> {
  const app = await openApp(t)
  const page = await openPage(t, browser(), app.url)
  assertOk(await goto(page, '/drag'))
  const moves = async (): Promise<DragMove[]> => (await (await fetch(`${app.url}/drag/moves`)).json()) as DragMove[]
  return { page, moves }
}

function drag(page: OwnedPage, source: LocatorRecipe, target: LocatorRecipe, options: { steps?: number; timeoutMs?: number } = {}): Promise<CommandResult> {
  const steps = options.steps === undefined ? {} : { steps: options.steps }
  return page.execute({ kind: 'dragTo', locator: source, target, ...steps }, options.timeoutMs ?? 5000)
}

async function textOf(page: OwnedPage, testId: string): Promise<string | null> {
  return (await observe(page, testId)).text
}

test('an HTML drag carries a card to another column, whose drop handler takes it, and the server records the move', async (t) => {
  const { page, moves } = await dragPage(t)
  const result = await drag(page, byText('Write release notes'), byTestId('done-column'))
  assert.equal(result.ok && result.kind === 'dragTo' ? result.through : result, 'drag-events')
  await observeUntil(page, 'board-status', (seen) => seen.text === 'saved notes in done 201')
  assert.equal((await observe(page, { by: 'testId', value: 'card-notes', within: [{ by: 'testId', value: 'done-column' }] })).count, 1)
  assert.equal((await observe(page, { by: 'testId', value: 'card-notes', within: [{ by: 'testId', value: 'todo-column' }] })).count, 0)
  // The drop ends the drag at its source, as a person's drop does, with the effect the page allowed.
  assert.equal(await textOf(page, 'board-ended'), 'ended notes move')
  assert.deepEqual(await moves(), [{ card: 'notes', column: 'done' }])
  assert.equal(await textOf(page, 'presses'), '1')
  assert.equal(await textOf(page, 'releases'), '0', 'the drop ends the drag with no pointerup or mouseup, as a person\'s drop does')
  // One step: the move that begins the drag ends at the target, where the drag enters and drops at once.
  const one = await drag(page, byText('Fix login bug'), byTestId('done-column'), { steps: 1 })
  assert.equal(one.ok && one.kind === 'dragTo' ? one.through : one, 'drag-events')
  await observeUntil(page, 'board-status', (seen) => seen.text === 'saved login in done 201')
  assert.deepEqual(await moves(), [{ card: 'notes', column: 'done' }, { card: 'login', column: 'done' }])
})

test('a drag by the handle moves the mouse through every step with the button held, and the list sorts itself', async (t) => {
  const { page } = await dragPage(t)
  const result = await drag(page, byTestId('handle'), byTestId('slot-3'), { steps: 10 })
  assert.equal(result.ok && result.kind === 'dragTo' ? result.through : result, 'mouse')
  assert.equal(await textOf(page, 'order'), 'alpha in slot-3')
  assert.equal(await textOf(page, 'pointer-moves'), '10')
  const fewer = await drag(page, byTestId('handle'), byTestId('slot-1'))
  assertOk(fewer)
  assert.equal(await textOf(page, 'order'), 'alpha in slot-1')
  assert.equal(await textOf(page, 'pointer-moves'), '5', 'five steps when the test gives none')
})

test("the page's drop handler reads every type and value its drag's dataTransfer carries", async (t) => {
  const { page } = await dragPage(t)
  assertOk(await drag(page, byTestId('data-source'), byTestId('data-zone')))
  assert.equal(await textOf(page, 'dropped-data'), 'text/plain=release notes; application/x-task={"id":7}')
})

test('a target under an overlay fails not_actionable, naming the overlay and the target, and nothing is sent', async (t) => {
  const { page } = await dragPage(t)
  const failure = failureOf(await drag(page, byTestId('data-source'), byTestId('locked-slot'), { timeoutMs: 600 }))
  assert.deepEqual(failure, {
    class: 'not_actionable',
    message: `Could not drag getByTestId('data-source') to getByTestId('locked-slot') within 600 ms: another element, <div class="overlay" data-testid="overlay">, covers the centre of getByTestId('locked-slot').`,
    details: { element: 'target', check: 'hit-target', covering: '<div class="overlay" data-testid="overlay">', waitedMs: 600 },
  })
  assert.equal(await textOf(page, 'presses'), '0')
  assert.equal(await textOf(page, 'locked-status'), 'Untouched')
})

test('a source or a target that matches nothing fails not_found, naming it, before anything is sent', async (t) => {
  const { page } = await dragPage(t)
  const noSource = failureOf(await drag(page, byTestId('no-such-card'), byTestId('done-column'), { timeoutMs: 400 }))
  assert.equal(noSource.class, 'not_found')
  assert.equal(noSource.message, "Could not drag getByTestId('no-such-card') to getByTestId('done-column'): no element matched getByTestId('no-such-card') within 400 ms.")
  assert.deepEqual(noSource.details, { element: 'source', waitedMs: 400 })
  const noTarget = failureOf(await drag(page, byTestId('card-notes'), byTestId('no-such-column'), { timeoutMs: 400 }))
  assert.equal(noTarget.message, "Could not drag getByTestId('card-notes') to getByTestId('no-such-column'): no element matched getByTestId('no-such-column') within 400 ms.")
  assert.deepEqual(noTarget.details, { element: 'target', waitedMs: 400 })
  assert.equal(await textOf(page, 'presses'), '0')
})

test('two matches fail at once as ambiguous, naming the locator, and steps out of range fail usage, before anything is sent', async (t) => {
  const { page } = await dragPage(t)
  const ambiguous = failureOf(await drag(page, { by: 'css', selector: '.card' }, byTestId('done-column')))
  assert.equal(ambiguous.class, 'ambiguous')
  assert.equal(ambiguous.message, "Could not drag locator('.card') to getByTestId('done-column'): locator('.card') matches 7 elements, and a locator must match exactly one. Retest did not drag.")
  const steps = failureOf(await drag(page, byTestId('card-notes'), byTestId('done-column'), { steps: 101 }))
  assert.deepEqual(steps, { class: 'usage', message: 'dragTo() takes steps as a whole number from 1 to 100, received 101.', details: { inputSent: false } })
  assert.equal(await textOf(page, 'presses'), '0')
})

test('a target that leaves the page during an HTML drag gets no drop: Retest cancels the drag and says so', async (t) => {
  const { page } = await dragPage(t)
  const failure = failureOf(await drag(page, byTestId('vanish-card'), byTestId('vanishing-zone')))
  assert.deepEqual(failure, {
    class: 'not_actionable',
    message: "Could not drag getByTestId('vanish-card') to getByTestId('vanishing-zone'): getByTestId('vanishing-zone') left the page while Retest dragged. Retest cancelled the drag, so nothing was dropped.",
    details: { element: 'target', check: 'attached', through: 'drag-events', inputSent: true },
  })
  // The page heard the drag end at its source with no drop.
  await observeUntil(page, 'vanish-status', (seen) => seen.text === 'ended none')
})

test('a target that leaves the page during a drag by the handle: Retest releases where the moves ended, and says so', async (t) => {
  const { page } = await dragPage(t)
  const failure = failureOf(await drag(page, byTestId('vanish-handle'), byTestId('vanishing-slot')))
  assert.equal(failure.class, 'not_actionable')
  assert.match(failure.message, /^Could not drag getByTestId\('vanish-handle'\) to getByTestId\('vanishing-slot'\): getByTestId\('vanishing-slot'\) left the page while Retest dragged\. Retest released the mouse where the moves ended, at \(\d+, \d+\), and the page may have taken that as a drop\.$/)
  assert.deepEqual(failure.details, { element: 'target', check: 'attached', through: 'mouse', inputSent: true })
  // The release is what the page made of it: the slot it was dragged to had gone.
  assert.equal(await textOf(page, 'order'), 'vanish dropped nowhere')
})

test('Firefox and WebKit refuse dragTo by name, and send nothing', async (t) => {
  for (const [engine, label] of [['firefox', 'Firefox'], ['webkit', 'WebKit']] as const) {
    await t.test(label, async (t) => {
      const absent = engineAbsence(engine)
      if (absent !== undefined) {
        t.skip(absent)
        return
      }
      // The harness launches the engine RETEST_TEST_ENGINE names, read as it launches.
      const previous = process.env['RETEST_TEST_ENGINE']
      process.env['RETEST_TEST_ENGINE'] = engine
      const owned = await launch(t).finally(() => {
        if (previous === undefined) delete process.env['RETEST_TEST_ENGINE']
        else process.env['RETEST_TEST_ENGINE'] = previous
      })
      const page = await openPage(t, owned)
      assert.deepEqual(failureOf(await drag(page, byTestId('card-notes'), byTestId('done-column'), { timeoutMs: 1000 })), {
        class: 'unsupported',
        message: `dragTo() is not available on ${label} yet. Retest drags on Chrome, Chromium, Edge and Electron.`,
        details: { inputSent: false },
      })
    })
  }
})

test('a cover the mouse brings up over the source takes the press: Retest stops the press and its release, and fails not_actionable', async (t) => {
  const { page } = await dragPage(t)
  const failure = failureOf(await drag(page, byTestId('shy-handle'), byTestId('slot-2')))
  assert.deepEqual(failure, {
    class: 'not_actionable',
    message: `Could not drag getByTestId('shy-handle') to getByTestId('slot-2'): another element, <div class="overlay" data-testid="shy-cover">, was on top of getByTestId('shy-handle') when Retest pressed. Retest stopped the press and its release before the page received them.`,
    details: { check: 'hit-target', interceptedBy: '<div class="overlay" data-testid="shy-cover">', event: 'pointerdown' },
  })
  assert.equal(await textOf(page, 'cover-status'), 'Untouched', 'the cover heard no press, release or click')
  assert.equal(await textOf(page, 'presses'), '0')
  // The button was let go of, so the next drag starts as any other.
  assertOk(await drag(page, byTestId('handle'), byTestId('slot-2')))
  assert.equal(await textOf(page, 'order'), 'alpha in slot-2')
})

// The official Electron release the Electron tests use, downloaded outside the repository. On macOS a missing binary
// fails this test; elsewhere Retest has no route to an Electron build yet, so without one given it is skipped by name.
const electronBinary = process.env['RETEST_TEST_ELECTRON'] ?? join(homedir(), 'Library/Caches/retest-proofs/electron/44.5.1/dist/Electron.app/Contents/MacOS/Electron')
const noElectron = process.platform !== 'darwin' && process.env['RETEST_TEST_ELECTRON'] === undefined ? 'unverified: RETEST_TEST_ELECTRON is not set, and Retest has no route yet to an Electron build here' : false

// A window as large as a browser's page, which loads the drag page from a file of the app's own.
const ELECTRON_DRAG_MAIN = `import { app, BrowserWindow } from 'electron'
import { fileURLToPath } from 'node:url'
app.whenReady().then(() => {
  const window = new BrowserWindow({ width: 800, height: 600, x: 40, y: 40, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } })
  void window.loadFile(fileURLToPath(new URL('./index.html', import.meta.url)))
})
app.on('window-all-closed', () => app.quit())
`

test("an Electron window takes an HTML drag with its data and a drag by the handle, as a Chrome page does", { skip: noElectron }, async (t) => {
  const folder = await scratchFolder(t)
  const appPath = join(folder, 'app')
  mkdirSync(appPath)
  writeFileSync(join(appPath, 'package.json'), JSON.stringify({ name: 'retest-drag-electron', private: true, main: 'main.mjs' }))
  writeFileSync(join(appPath, 'main.mjs'), ELECTRON_DRAG_MAIN)
  writeFileSync(join(appPath, 'index.html'), DRAG_PAGE)
  const electron = await launchElectron({ executablePath: electronBinary, appPath, args: [], windowsFile: join(folder, 'windows.json'), logFile: join(folder, 'electron.log'), app: 'desk', target: 'electron', launch: 1 })
  t.after(() => electron.close(5000))
  const page = await electron.newPage({}, 10_000)
  await observeUntil(page, 'data-zone', (observation) => observation.count === 1)
  const carried = await drag(page, byTestId('data-source'), byTestId('data-zone'))
  assert.equal(carried.ok && carried.kind === 'dragTo' ? carried.through : carried, 'drag-events')
  assert.equal(await textOf(page, 'dropped-data'), 'text/plain=release notes; application/x-task={"id":7}')
  const sorted = await drag(page, byTestId('handle'), byTestId('slot-3'), { steps: 4 })
  assert.equal(sorted.ok && sorted.kind === 'dragTo' ? sorted.through : sorted, 'mouse')
  assert.equal(await textOf(page, 'order'), 'alpha in slot-3')
  assert.equal(await textOf(page, 'pointer-moves'), '4')
})

test('a target the page moves aside during the drag gets the drop where it stands, by the handle and by an HTML drag', async (t) => {
  const { page } = await dragPage(t)
  assertOk(await drag(page, byTestId('moving-handle'), byTestId('moving-slot')))
  assert.equal(await textOf(page, 'order'), 'moving in moving-slot')
  const fresh = await dragPage(t)
  assertOk(await drag(fresh.page, byTestId('moving-card'), byTestId('moving-slot')))
  assert.equal(await textOf(fresh.page, 'moving-status'), 'dropped moving')
})

test('a cover the page shows over the target once the drag begins gets no drop: Retest cancels the drag, names the cover, and the page takes input again', async (t) => {
  const { page } = await dragPage(t)
  const failure = failureOf(await drag(page, byTestId('cover-card'), byTestId('covered-zone')))
  assert.deepEqual(failure, {
    class: 'not_actionable',
    message: `Could not drag getByTestId('cover-card') to getByTestId('covered-zone'): another element, <div class="overlay" data-testid="drop-cover">, covered the centre of getByTestId('covered-zone') when Retest was to drop. Retest cancelled the drag, so nothing was dropped.`,
    details: { element: 'target', check: 'hit-target', covering: '<div class="overlay" data-testid="drop-cover">', through: 'drag-events', inputSent: true },
  })
  await observeUntil(page, 'cover-ended', (seen) => seen.text === 'ended none')
  assert.equal(await textOf(page, 'covered-status'), 'Untouched')
  assertOk(await click(page, 'after'))
  assert.equal(await textOf(page, 'after-status'), 'clicked')
})

test('a page that stops every dragstart from going further still has its HTML drag carried to the drop, and takes input after', async (t) => {
  const { page } = await dragPage(t)
  assertOk(await goto(page, '/drag/stopped'))
  const result = await drag(page, byTestId('stopped-card'), byTestId('stopped-zone'))
  assert.equal(result.ok && result.kind === 'dragTo' ? result.through : result, 'drag-events')
  assert.equal(await textOf(page, 'stopped-status'), 'dropped')
  assertOk(await click(page, 'after'))
  assert.equal(await textOf(page, 'after-status'), 'clicked')
})

test('an HTML drag whose time runs out on a busy page is cancelled, so the page takes input again', async (t) => {
  const { page } = await dragPage(t)
  const failure = failureOf(await drag(page, byTestId('busy-card'), byTestId('busy-zone'), { timeoutMs: 700 }))
  assert.equal(failure.class, 'timeout')
  assert.equal(failure.details?.['inputSent'], true)
  await observeUntil(page, 'busy-status', (seen) => seen.text === 'ended')
  assertOk(await click(page, 'after'))
  assert.equal(await textOf(page, 'after-status'), 'clicked')
})
