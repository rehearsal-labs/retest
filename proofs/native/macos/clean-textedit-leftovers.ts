/**
 * Discards TextEdit documents that a failed macOS proof run left autosaved. TextEdit is launched without
 * `-ApplePersistenceIgnoreState`, so it reopens the autosaved documents it restores; only windows whose title is
 * named with `--title` are looked at, and each is discarded only when its text is exactly the proof's text or
 * empty. The executor is asked for those titles alone, so no other window's title or text is ever read.
 *
 *   node --conditions=retest-source proofs/native/macos/clean-textedit-leftovers.ts --title "Untitled 3" [--title …] [--port 10100]
 *
 * A document TextEdit does not reopen on launch is out of its reach; it reports which titles did not appear.
 * Exit 0 when every window it found was discarded, 2 when the machine blocked it, 1 when a step failed.
 */
import type { ParseArgsConfig } from 'node:util'
import type { Locator } from '../shared/webdriver.ts'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { createRunFolders, ProofRecord, StepStopped } from '../shared/evidence.ts'
import { processIds, RunnerProcess } from '../shared/processes.ts'
import { observe } from '../shared/source.ts'
import { describeError, WebDriverClient, WebDriverSession } from '../shared/webdriver.ts'
import { APP_NAME, BUNDLE_ID, checkMachine, findXctestrun, HOST, launchTextEdit, startRunner, tearDown, TYPED_TEXT, waitUntilSteady } from './mac2.ts'

const USAGE = `Usage: node --conditions=retest-source proofs/native/macos/clean-textedit-leftovers.ts --title "Untitled 3" [--title …] [--port 10100]

  --title <name>    A window title this discards when its text is the proof's text or empty. Repeat for more.
  --port <number>   Port for the runner's HTTP server. Default 10100.
`

const OPTIONS = { options: { title: { type: 'string', multiple: true }, port: { type: 'string', default: '10100' }, help: { type: 'boolean', default: false } } } as const satisfies ParseArgsConfig

function readOptions(): ReturnType<typeof parseArgs<typeof OPTIONS>> | string {
  try {
    return parseArgs(OPTIONS)
  } catch (error) {
    return describeError(error)
  }
}

function windowsTitled(titles: readonly string[]): Locator {
  return { using: 'predicate string', value: `elementType == 4 AND title IN {${titles.map((title) => JSON.stringify(title)).join(', ')}}` }
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
  const titles = values.title ?? []
  const port = Number(values.port)
  if (titles.length === 0 || !Number.isInteger(port) || port < 1 || port > 65535) {
    process.stderr.write(`Name at least one --title, and a --port from 1 to 65535\n\n${USAGE}`)
    return 2
  }
  const folders = await createRunFolders('macos')
  const client = new WebDriverClient(`http://${HOST}:${port}`, 60_000)
  const record = new ProofRecord('Discard TextEdit documents a failed macOS proof left autosaved')
  record.facts['titles'] = [...titles]

  let runner: RunnerProcess | undefined
  let session: WebDriverSession | undefined
  let launchedPid: number | undefined
  let appMayBeRunning = false

  try {
    const xcodeHelper = await record.step('check the machine', (note) => checkMachine(record, note, port))
    await record.step('find the built runner', async (note) => {
      const existing = await findXctestrun()
      if (existing === undefined) throw new Error('no built runner; run proofs/native/macos/run.ts first')
      note(existing)
    })
    runner = await record.step('start the runner', (note) => startRunner({ record, note, client, port, logPath: join(folders.logs, `mac2-clean-textedit-leftovers-${folders.stamp}.log`), xcodeHelper }))
    session = await record.step(`launch ${APP_NAME} so it reopens its autosaved documents`, async (note) => {
      appMayBeRunning = true
      const launched = await launchTextEdit(client, { bundleId: BUNDLE_ID, arguments: ['-NSShowAppCentricOpenPanelInsteadOfUntitledFile', 'NO'], environment: {}, noReset: false, skipAppKill: false })
      launchedPid = launched.pid
      note(`${APP_NAME} pid ${launched.pid}`)
      return launched.session
    })
    const active = session

    for (const title of titles) {
      await record.step(`discard ${JSON.stringify(title)} if it reopened`, async (note) => {
        const found = await observe(() => active.findAll(windowsTitled([title])), (ids) => ids.length > 0, 5000)
        const [window] = found.value
        if (window === undefined) {
          note('did not reopen; out of reach of this script')
          return
        }
        if (found.value.length > 1) throw new Error(`${found.value.length} windows titled ${JSON.stringify(title)}; exactly one is required`)
        const content = await active.text(await active.findOneWithin(window, { using: 'class name', value: 'XCUIElementTypeTextView' }))
        if (content !== '' && content !== TYPED_TEXT) {
          note(`holds ${content.length} characters that are not the proof's; left alone`)
          return
        }
        await active.click(await active.findOneWithin(window, { using: 'accessibility id', value: '_XCUI:CloseWindow' }))
        const sheet = await observe(() => active.findAllWithin(window, { using: 'accessibility id', value: 'DontSaveButton' }), (ids) => ids.length > 0, 3000)
        const [discard] = sheet.value
        if (sheet.value.length > 1) throw new Error(`${sheet.value.length} DontSaveButton elements; exactly one is required`)
        if (discard !== undefined) {
          if (!(await waitUntilSteady(active, discard, 5000))) throw new Error('the discard button never stopped moving or became hittable')
          await active.click(discard)
        }
        const closed = await observe(async () => (await active.findAll(windowsTitled([title]))).length, (count) => count === 0, 5000)
        note(`held ${JSON.stringify(content)}; ${discard === undefined ? 'closed without a sheet' : 'discarded with Delete'}; ${closed.met ? 'window gone' : 'window still open'}`)
        if (!closed.met) throw new Error('the window is still open')
      })
    }

    await record.step(`terminate the ${APP_NAME} this script launched`, async (note) => {
      const running = await processIds({ name: APP_NAME })
      if (running.length !== 1 || running[0] !== launchedPid) throw new Error(`the running ${APP_NAME} is not only pid ${String(launchedPid)}; not terminating by bundle id`)
      const terminated = await active.terminateApp(BUNDLE_ID)
      const gone = await observe(() => processIds({ name: APP_NAME }), (pids) => !pids.includes(launchedPid ?? -1), 5000)
      note(`terminate answered ${String(terminated)}; pid ${String(launchedPid)} ${gone.met ? 'gone' : 'still running'}`)
      if (!terminated || !gone.met) throw new Error(`${APP_NAME} is still running`)
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
