/**
 * Drives one native macOS window through WebDriverAgentMac, the XCTest executor in appium-mac2-driver, over its
 * own HTTP API. No Appium server and no npm package: Node's fetch talks to the runner that xcodebuild hosts.
 *
 * It launches TextEdit, reads the tree of its window, finds elements by role, accessibility identifier and label
 * with exactly one match each, clicks the Bold control, types into the document with key presses, reads the text
 * back, compares window captures from before and after typing, closes the document without saving, terminates the
 * TextEdit it launched, ends the session, shuts the runner down and checks that neither process is left. It reads
 * the system log to say whether macOS asked an administrator to enable UI automation.
 *
 *   node --conditions=retest-source proofs/native/macos/run.ts [--port 10100] [--keep-display-screenshot]
 *
 * Exit 0 when every step passed, 2 when the machine blocked it (a permission, a busy port, TextEdit already
 * open), 1 when a step failed. Builds, logs and artifacts go under ~/Library/Caches/retest-proofs. Saved trees
 * hold only TextEdit's window, never the menu bar.
 */
import type { ParseArgsConfig } from 'node:util'
import type { DecodedPng } from '../shared/evidence.ts'
import type { JsonValue, Locator } from '../shared/webdriver.ts'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { countChangedPixels, createRunFolders, decodePng, inspectPng, ProofRecord, StepStopped } from '../shared/evidence.ts'
import { describeExit, processIds, RunnerProcess, runLogged } from '../shared/processes.ts'
import { countTypes, observe, ownedWindowSource, readSource } from '../shared/source.ts'
import { APP_STATE, describeError, WebDriverClient, WebDriverSession } from '../shared/webdriver.ts'
import { APP_NAME, BUNDLE_ID, checkMachine, COMMAND_KEY, DERIVED_DATA, findXctestrun, HOST, launchTextEdit, PROJECT, PROJECT_ROOT, SHIFT_KEY, startRunner, tearDown, TYPED_TEXT, waitUntilSteady } from './mac2.ts'

// Launch arguments land in TextEdit's argument domain for this launch only. The first opens an untitled document
// instead of the open panel, the second skips restoring windows from an earlier run.
const LAUNCH_ARGUMENTS = ['-NSShowAppCentricOpenPanelInsteadOfUntitledFile', 'NO', '-ApplePersistenceIgnoreState', 'YES']
// Typing 22 characters changes well over a thousand pixels on the first line; the insertion point moving changes
// about 60. Captures of the same content minutes apart differed only under a system tooltip and in the rounded
// corners, so the comparison covers the first line alone, where the typed text lands.
const MINIMUM_CHANGED_PIXELS = 500
const FIRST_LINE_POINTS = 30

const USAGE = `Usage: node --conditions=retest-source proofs/native/macos/run.ts [--port 10100] [--keep-display-screenshot]

  --port <number>              Port for the runner's HTTP server. Default 10100.
  --keep-display-screenshot    Also write the whole-display capture. It is checked either way; it is not
                               written by default because it shows every window on the screen.
`

const OPTIONS = { options: { port: { type: 'string', default: '10100' }, 'keep-display-screenshot': { type: 'boolean', default: false }, help: { type: 'boolean', default: false } } } as const satisfies ParseArgsConfig

function readOptions(): ReturnType<typeof parseArgs<typeof OPTIONS>> | string {
  try {
    return parseArgs(OPTIONS)
  } catch (error) {
    return describeError(error)
  }
}

function role(type: string): Locator {
  return { using: 'class name', value: type }
}

function predicate(value: string): Locator {
  return { using: 'predicate string', value }
}

function text(value: JsonValue): string {
  return typeof value === 'string' ? value : ''
}

function colours(count: number): string {
  return count >= 4096 ? '4096 or more colours' : `${count} colours`
}

/**
 * The key presses that type `text` on a US layout: lower-case letters, digits and spaces as they are, capitals as
 * the lower-case key with Shift. Anything else is refused rather than typed some other way.
 *
 * @example keyPresses('Hi') // [{ key: 'h', modifierFlags: 2 }, { key: 'i', modifierFlags: 0 }]
 */
function keyPresses(typed: string): JsonValue[] {
  return [...typed].map((character, index) => {
    if (/^[A-Z]$/.test(character)) return { key: character.toLowerCase(), modifierFlags: SHIFT_KEY }
    if (/^[a-z0-9 ]$/.test(character)) return { key: character, modifierFlags: 0 }
    throw new Error(`character ${index} is not a letter, digit or space`)
  })
}

async function main(): Promise<number> {
  const parsed = readOptions()
  if (typeof parsed === 'string') {
    process.stderr.write(`${parsed}\n\n${USAGE}`)
    return 2
  }
  const { values } = parsed
  if (values.help) {
    process.stdout.write(USAGE)
    return 0
  }
  const port = Number(values.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    process.stderr.write(`--port must be a whole number from 1 to 65535\n\n${USAGE}`)
    return 2
  }
  const folders = await createRunFolders('macos')
  const runnerLog = join(folders.logs, `mac2-runner-${folders.stamp}.log`)
  const client = new WebDriverClient(`http://${HOST}:${port}`, 60_000)
  const record = new ProofRecord('Native macOS window through WebDriverAgentMac (appium-mac2-driver)')
  record.facts['port'] = port
  record.facts['runnerLog'] = runnerLog
  record.facts['artifacts'] = folders.artifacts

  let runner: RunnerProcess | undefined
  let session: WebDriverSession | undefined
  let launchedPid: number | undefined
  let appMayBeRunning = false

  const saveWindowTree = async (active: WebDriverSession, name: string): Promise<ReturnType<typeof readSource>> => {
    const owned = ownedWindowSource(await active.source())
    if (owned === undefined) throw new Error('the tree has no window')
    const path = join(folders.artifacts, name)
    await writeFile(path, owned.xml)
    record.artifact(path)
    return readSource(owned.xml)
  }

  try {
    const xcodeHelper = await record.step('check the machine', (note) => checkMachine(record, note, port))

    await record.step('build the runner for testing', async (note) => {
      const existing = await findXctestrun()
      if (existing !== undefined) {
        // Each ad hoc signed build gets a new code hash, and macOS ties an Accessibility grant to the old one.
        note(`reused ${existing}; delete ${DERIVED_DATA} to rebuild`)
        return
      }
      const logPath = join(folders.logs, `mac2-build-for-testing-${folders.stamp}.log`)
      const args = ['build-for-testing', '-project', PROJECT, '-scheme', 'WebDriverAgentRunner', '-derivedDataPath', DERIVED_DATA, 'COMPILER_INDEX_STORE_ENABLE=NO']
      const exit = await runLogged('xcodebuild', args, { logPath, cwd: PROJECT_ROOT, timeoutMs: 15 * 60_000 })
      if (exit.exitCode !== 0) throw new Error(`xcodebuild build-for-testing ended with ${describeExit(exit)}; see ${logPath}`)
      note(`built; log ${logPath}`)
    })

    runner = await record.step('start the runner', (note) => startRunner({ record, note, client, port, logPath: runnerLog, xcodeHelper }))

    session = await record.step(`create a session that launches ${APP_NAME}`, async (note) => {
      appMayBeRunning = true
      const launched = await launchTextEdit(client, { bundleId: BUNDLE_ID, arguments: LAUNCH_ARGUMENTS, environment: {}, noReset: false, skipAppKill: false })
      launchedPid = launched.pid
      note(`session ${launched.session.id}; ${APP_NAME} pid ${launched.pid}, checked absent right before the launch`)
      return launched.session
    })
    const active = session

    await record.step(`activate ${APP_NAME} and read its state`, async (note) => {
      await active.activateApp(BUNDLE_ID)
      const state = await observe(() => active.appState(BUNDLE_ID), (value) => value === 4, 5000)
      note(`state ${state.value} (${APP_STATE[state.value] ?? 'unknown'})`)
      if (!state.met) throw new Error(`${APP_NAME} is not in the foreground`)
    })

    await record.step('open a document window', async (note) => {
      const newDocument = await active.findAll(predicate("elementType == 9 AND (title ==[c] 'New Document' OR label ==[c] 'New Document')"))
      const [only] = newDocument
      if (newDocument.length > 1) throw new Error(`${newDocument.length} New Document buttons; exactly one is required`)
      if (only === undefined) {
        note('no open panel: the launch arguments opened an untitled document')
      } else {
        await active.click(only)
        note('clicked New Document in the open panel')
      }
      const windows = await observe(() => active.findAll(role('XCUIElementTypeWindow')), (ids) => ids.length > 0, 10_000)
      note(`${windows.value.length} window(s) after ${windows.attempts} look(s)`)
      if (windows.value.length !== 1) throw new Error(`${windows.value.length} windows; exactly one is required`)
    })

    const tree = await record.step("read the window's tree", async (note) => {
      const elements = await saveWindowTree(active, 'window-before.xml')
      note(`${elements.length} elements in the window; ${countTypes(elements).slice(0, 5).map(([type, count]) => `${type.replace('XCUIElementType', '')} ${count}`).join(', ')}; menu bar not kept`)
      if (!elements.some((element) => element.type === 'XCUIElementTypeTextView')) throw new Error('the window has no text view')
      return elements
    })

    const { window, textView, title } = await record.step('find by role, and scoped inside the window', async (note) => {
      const onlyWindow = await active.findOne(role('XCUIElementTypeWindow'))
      const textViews = await active.findAllWithin(onlyWindow, role('XCUIElementTypeTextView'))
      const buttons = await active.findAllWithin(onlyWindow, role('XCUIElementTypeButton'))
      const windowTitle = text(await active.attribute(onlyWindow, 'title'))
      note(`1 window titled ${JSON.stringify(windowTitle)}; inside it ${textViews.length} text view(s) and ${buttons.length} button(s)`)
      const [onlyTextView] = textViews
      if (onlyTextView === undefined || textViews.length !== 1) throw new Error(`${textViews.length} text views in the window; exactly one is required`)
      return { window: onlyWindow, textView: onlyTextView, title: windowTitle }
    })

    await record.step('find by accessibility identifier', async (note) => {
      const counts = new Map<string, number>()
      for (const element of tree) {
        const identifier = element.attributes['identifier'] ?? ''
        if (identifier.length > 0) counts.set(identifier, (counts.get(identifier) ?? 0) + 1)
      }
      const unique = [...counts].filter(([, count]) => count === 1).map(([identifier]) => identifier)
      // TextEdit names its document view First Text View; AppKit's generated _NS: identifiers are not stable.
      const identifier = unique.includes('First Text View') ? 'First Text View' : unique.find((candidate) => !candidate.startsWith('_NS:'))
      if (identifier === undefined) throw new Error('no element in the window has a unique, stable identifier')
      const found = await active.findOneWithin(window, { using: 'accessibility id', value: identifier })
      const read = await active.attribute(found, 'identifier')
      note(`${JSON.stringify(identifier)} matched exactly 1 element in the window, elementType ${JSON.stringify(await active.attribute(found, 'elementType'))}, identifier read back ${JSON.stringify(read)}`)
      if (read !== identifier) throw new Error(`the element found reports identifier ${JSON.stringify(read)}`)
    })

    const { bold, style } = await record.step('find by label', async (note) => {
      const boldControl = await active.findOneWithin(window, predicate("label ==[c] 'bold' AND (elementType == 12 OR elementType == 9)"))
      // macOS 27 labels the format bar's weight pop-up "style"; the release Mac2's tests were written on said "type face".
      const styleMenu = await active.findOneWithin(window, predicate("elementType == 14 AND (label ==[c] 'style' OR label ==[c] 'type face')"))
      note(`exactly one Bold control (elementType ${JSON.stringify(await active.attribute(boldControl, 'elementType'))}) and one ${JSON.stringify(await active.attribute(styleMenu, 'label'))} pop-up`)
      return { bold: boldControl, style: styleMenu }
    })

    await record.step('click the Bold control', async (note) => {
      await active.click(textView)
      const boldBefore = await active.attribute(bold, 'value')
      const styleBefore = await active.attribute(style, 'value')
      await active.click(bold)
      const styleAfter = await observe(() => active.attribute(style, 'value'), (value) => value === 'Bold' && value !== styleBefore, 3000)
      const boldAfter = await active.attribute(bold, 'value')
      note(`Bold value ${JSON.stringify(boldBefore)} then ${JSON.stringify(boldAfter)}; style ${JSON.stringify(styleBefore)} then ${JSON.stringify(styleAfter.value)}`)
      if (!styleAfter.met) throw new Error('the style did not change to Bold')
      if (boldAfter === boldBefore) throw new Error("the Bold control's value did not change")
    })

    const scale = await record.step('capture the display and read the screen scale', async (note) => {
      const png = await active.screenshot()
      const image = decodePng(png)
      const screen = await active.mainScreenRect()
      const ratio = image.width / screen.width
      if (values['keep-display-screenshot']) {
        const path = join(folders.artifacts, 'display.png')
        await writeFile(path, png)
        record.artifact(path)
      }
      note(`${image.width}x${image.height} PNG, ${colours(inspectPng(png).distinctColors)}; main screen ${screen.width}x${screen.height} points, scale ${ratio}; ${values['keep-display-screenshot'] ? 'written' : 'checked in memory and not written'}`)
      if (!Number.isInteger(ratio) || Math.round(screen.height * ratio) !== image.height) throw new Error('the display capture is not the main screen at a whole-number scale')
      return ratio
    })

    const captureWindow = async (name: string, note: (fact: string) => void): Promise<DecodedPng> => {
      const png = await active.elementScreenshot(window)
      const image = decodePng(png)
      const rect = await active.rect(window)
      const expected = `${Math.round(rect.width * scale)}x${Math.round(rect.height * scale)}`
      const path = join(folders.artifacts, name)
      await writeFile(path, png)
      record.artifact(path)
      note(`${image.width}x${image.height} PNG for a ${rect.width}x${rect.height}-point window at scale ${scale} (expected ${expected}), ${colours(inspectPng(png).distinctColors)}`)
      if (`${image.width}x${image.height}` !== expected) throw new Error('the capture is not the window at the screen scale')
      return image
    }

    await record.step('focus the document', async (note) => {
      await active.click(textView)
      note('clicked the text view once')
    })

    const before = await record.step('capture the window before typing', (note) => captureWindow('window-before.png', note))

    await record.step('type into the document with key presses', async (note) => {
      await active.pressKeys(keyPresses(TYPED_TEXT))
      const typed = await observe(() => active.text(textView), (value) => value === TYPED_TEXT, 3000)
      note(`${TYPED_TEXT.length} key presses sent once; text reads ${JSON.stringify(typed.value)} after ${typed.attempts} look(s)`)
      if (!typed.met) throw new Error('the document does not hold exactly the typed text')
    })

    await record.step('capture the window after typing and compare', async (note) => {
      const after = await captureWindow('window-after.png', note)
      const windowRect = await active.rect(window)
      const viewRect = await active.rect(textView)
      const firstLine = { x: (viewRect.x - windowRect.x) * scale, y: (viewRect.y - windowRect.y) * scale, width: viewRect.width * scale, height: FIRST_LINE_POINTS * scale }
      const onFirstLine = countChangedPixels(before, after, firstLine)
      const whole = countChangedPixels(before, after, { x: 0, y: 0, width: after.width, height: after.height })
      note(`${onFirstLine} pixels changed on the text view's first ${FIRST_LINE_POINTS} points, ${whole - onFirstLine} elsewhere in the window`)
      if (onFirstLine < MINIMUM_CHANGED_PIXELS) throw new Error(`only ${onFirstLine} pixels changed where the text was typed; at least ${MINIMUM_CHANGED_PIXELS} are required`)
    })

    await record.step("read the window's tree again and find the typed text", async (note) => {
      const elements = await saveWindowTree(active, 'window-after.xml')
      const holders = elements.filter((element) => element.type === 'XCUIElementTypeTextView' && element.attributes['value'] === TYPED_TEXT)
      note(`${holders.length} text view(s) in the window hold the typed text`)
      if (holders.length !== 1) throw new Error('exactly one text view must hold the typed text')
    })

    await record.step('clear the document with key presses', async (note) => {
      // Select all, then one delete: sent once and read back, never repeated.
      await active.pressKeys([{ key: 'a', modifierFlags: COMMAND_KEY }, 'XCUIKeyboardKeyDelete'])
      const cleared = await observe(() => active.text(textView), (value) => value === '', 3000)
      note(`Command-A and Delete sent once; text reads ${JSON.stringify(cleared.value)}`)
      if (!cleared.met) throw new Error('the document still holds text')
    })

    await record.step('close the document without saving', async (note) => {
      await active.pressKeys([{ key: 'w', modifierFlags: COMMAND_KEY }])
      // An edited untitled document asks whether to keep it. DontSaveButton is AppKit's identifier for the button
      // that discards it, titled Delete here; the sheet holds a second, unidentified set of the same buttons.
      const settled = await observe(async () => ({ windows: (await active.findAll(role('XCUIElementTypeWindow'))).length, discard: await active.findAll({ using: 'accessibility id', value: 'DontSaveButton' }) }), (value) => value.windows === 0 || value.discard.length > 0, 3000)
      const { windows, discard } = settled.value
      const [button] = discard
      if (discard.length > 1) throw new Error(`${discard.length} DontSaveButton elements; exactly one is required`)
      if (button !== undefined) {
        if (!(await waitUntilSteady(active, button, 5000))) throw new Error('the discard button never stopped moving or became hittable')
        const buttonTitle = text(await active.attribute(button, 'title'))
        await active.click(button)
        note(`the keep-this-document sheet appeared; clicked ${JSON.stringify(buttonTitle)} (DontSaveButton) once it settled`)
      } else if (windows === 0) {
        note('the window closed and no sheet appeared')
      } else {
        note(`within 3 s no discard button appeared and ${windows} window(s) stayed open`)
      }
      const left = await observe(async () => (await active.findAll(role('XCUIElementTypeWindow'))).length, (count) => count === 0, 5000)
      note(`${left.value} window(s) left`)
      if (!left.met) {
        // Keep what the window showed at the failure, so the next attempt starts from facts.
        await saveWindowTree(active, 'window-at-close.xml').catch(() => [])
        throw new Error('the document window is still open')
      }
    })

    await record.step('count menu items that name the closed document', async (note) => {
      // Only items titled exactly like this run's document come back, so no other recent item is read.
      const named = await active.findAll(predicate(`elementType == 54 AND title == ${JSON.stringify(title)}`))
      record.facts['menuItemsNamingTheDocument'] = named.length
      note(`${named.length} menu item(s) titled ${JSON.stringify(title)} after the document was discarded`)
    })

    await record.step(`terminate the ${APP_NAME} this proof launched`, async (note) => {
      const running = await processIds({ name: APP_NAME })
      if (running.length !== 1 || running[0] !== launchedPid) throw new Error(`the running ${APP_NAME} is not only pid ${String(launchedPid)} (found ${running.join(', ') || 'none'}); not terminating by bundle id`)
      const terminated = await active.terminateApp(BUNDLE_ID)
      const state = await observe(() => active.appState(BUNDLE_ID), (value) => value === 1, 5000)
      const gone = await observe(() => processIds({ name: APP_NAME }), (pids) => !pids.includes(launchedPid ?? -1), 5000)
      note(`terminate answered ${String(terminated)}; state ${state.value} (${APP_STATE[state.value] ?? 'unknown'}); pid ${String(launchedPid)} ${gone.met ? 'gone' : 'still running'}`)
      if (!terminated || !state.met || !gone.met) throw new Error(`${APP_NAME} is still running`)
      appMayBeRunning = false
    })
  } catch (error) {
    if (!(error instanceof StepStopped)) {
      process.stderr.write(`Unexpected error outside a step: ${describeError(error)}\n`)
      record.facts['unexpectedError'] = describeError(error)
    }
  } finally {
    await tearDown({ record, client, port, runner, session, launchedPid, appMayBeRunning })
  }
  await record.finish(folders.artifacts)
  return record.exitCode
}

process.exitCode = await main()
