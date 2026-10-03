import type { Transport } from '../../src/browser/cdp/transport.ts'
import type { HelperProcess, StopReport } from './launch-webkit.ts'
import type { KeyStroke } from './keys.ts'
import type { PageEvent, WkContext, WkPage } from './wk-page.ts'
import { execFile } from 'node:child_process'
import { appendFileSync, existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { TASK_APP_PASSWORD } from '../../fixtures/task-app/sign-in.ts'
import { startTaskApp } from '../../fixtures/task-app/server.ts'
import { isRecord } from '../../src/browser/cdp/message.ts'
import { PipeTransport } from '../../src/browser/cdp/transport.ts'
import { errorMessage } from '../../src/protocol/failures.ts'
import { describeExit } from '../../src/shared/process-exit.ts'
import { findWebKitBuild, listBuildProcesses, matchesPin, parseLaunchdServices, PINNED_BUILD, readWebKitVersion, stillRunning, WebKitProcess, webKitArguments } from './launch-webkit.ts'
import { inspectPng } from './png.ts'
import { WkCommandError, WkConnection, WkDisconnectedError } from './wk-client.ts'
import { WkBrowser } from './wk-page.ts'

export type StepResult = {
  readonly name: string
  readonly ok: boolean
  readonly facts: readonly string[]
  /** What failed, naming the protocol command and where it went when a command failed. */
  readonly failure: string | undefined
}

/** Every protocol method the proof sent or heard, by where it went or came from. */
export type ProtocolUse = {
  readonly commands: readonly string[]
  readonly events: readonly string[]
}

export type ProofReport = {
  readonly ok: boolean
  readonly build: {
    readonly directory: string
    /** From the build folder's name; undefined when the name carries none. */
    readonly revision: string | undefined
    readonly protocolSha256: string
    /** True only when the revision and the protocol's sha256 are the pinned ones. */
    readonly matchesPin: boolean
    /** Where the pinned build is downloaded from, given only when the build matches the pin. */
    readonly url: string | undefined
  }
  readonly flags: readonly string[]
  readonly userAgent: string | undefined
  readonly steps: readonly StepResult[]
  readonly protocol: ProtocolUse
  readonly artifacts: { readonly folder: string; readonly screenshot: string | undefined; readonly browserLog: string; readonly disconnectLog: string }
}

export type ProofOptions = {
  /** Where the screenshot, the browser logs and the report go. */
  outputFolder: string
  /** An unpacked build; the pinned one in the Playwright cache by default. */
  buildDirectory?: string
  /** Called as each step ends, so a caller can print progress. */
  onStep?: (step: StepResult) => void
}

const VIEWPORT = { width: 1280, height: 720 }
const commandTimeoutMs = 10_000
const externalCommandMs = 5000
const loadTimeoutMs = 15_000
const closeGraceMs = 5000
const disconnectNoticeMs = 3000
const helperExitMs = 5000
const execFileAsync = promisify(execFile)
// A key with no text, so pressing it with Control or Meta held types nothing.
const PROBE_KEY: KeyStroke = { key: 'q', code: 'KeyQ', keyCode: 81, text: '', shift: false }
// What each modifier bit should set, as Playwright's WebKit input code sends them. protocol.json documents another order.
const MODIFIER_BITS: readonly { bit: number; flag: 'shiftKey' | 'ctrlKey' | 'altKey' | 'metaKey' }[] = [
  { bit: 1, flag: 'shiftKey' },
  { bit: 2, flag: 'ctrlKey' },
  { bit: 4, flag: 'altKey' },
  { bit: 8, flag: 'metaKey' },
]

/**
 * Drives the pinned WebKit build through Retest's own client from launch to a killed browser, against the task app
 * started in this process. Each step records what it saw; a failed step names the command that failed, and the
 * steps after it still run where they can.
 *
 * @example const report = await runWebKitProof({ outputFolder: '.retest/proofs/webkit/now' })
 */
export async function runWebKitProof(options: ProofOptions): Promise<ProofReport> {
  const build = await findWebKitBuild(options.buildDirectory)
  await mkdir(options.outputFolder, { recursive: true })
  const browserLog = join(options.outputFolder, 'browser.log')
  const disconnectLog = join(options.outputFolder, 'browser-disconnect.log')
  const steps: StepResult[] = []
  const used = { commands: new Set<string>(), events: new Set<string>() }
  const state: State = { consoleMessages: [], network: [], diagnostics: [], samplingProblems: [] }
  const step = async (name: string, action: (facts: string[]) => Promise<void>): Promise<boolean> => {
    const facts: string[] = []
    let failure: string | undefined
    try {
      await action(facts)
    } catch (error) {
      failure = describeFailure(error)
    }
    const result = { name, ok: failure === undefined, facts, failure }
    steps.push(result)
    options.onStep?.(result)
    return result.ok
  }
  // Records helpers now, while they run. A failure is kept for step 8 rather than thrown into a cleanup path.
  const sample = async (): Promise<void> => {
    await state.process?.recordHelpers().catch((error: unknown) => state.samplingProblems.push(errorMessage(error)))
  }
  // cfprefsd writes preferences under the account's real home, whatever HOME says.
  const preferences = join(userInfo().homedir, 'Library', 'Preferences', 'org.webkit.Playwright.plist')
  const preferencesBefore = existsSync(preferences)
  const app = await startTaskApp()
  try {
    await step('1. Launch the build headless over the inspector pipe', async (facts) => {
      state.process = await WebKitProcess.start({ build, logFile: browserLog, headless: true })
      const transport = recordingTransport(new PipeTransport(state.process.pipe), used)
      const connection = new WkConnection(transport, { timeoutMs: commandTimeoutMs, onDiagnostic: (problem) => state.diagnostics.push(problem) })
      state.browser = await WkBrowser.connect(connection, { viewport: VIEWPORT, onDiagnostic: (problem) => state.diagnostics.push(problem) })
      const info = await connection.send('Playwright.getInfo')
      const group = (await execFileAsync('ps', ['-o', 'pgid=', '-p', String(state.process.pid)], { timeout: externalCommandMs, killSignal: 'SIGKILL' })).stdout.trim()
      facts.push(`${build.executable} ${webKitArguments({ headless: true }).join(' ')}`)
      facts.push(`build folder ${build.directory}; revision from its name ${build.revision ?? 'none'}; WebKit ${await readWebKitVersion(build)}`)
      facts.push(`protocol.json sha256 ${build.protocolSha256}, ${matchesPin(build) ? `the pinned file of revision ${PINNED_BUILD.revision}` : `not the pinned revision ${PINNED_BUILD.revision} with sha256 ${PINNED_BUILD.protocolSha256}`}`)
      facts.push(`pid ${state.process.pid}, process group ${group}, temporary home ${state.process.home}`)
      facts.push(`Playwright.getInfo says the host is ${readText(info, 'os')}`)
      if (group !== String(state.process.pid)) throw new Error(`The browser is in process group ${group}, not its own group ${state.process.pid}`)
      if (!matchesPin(build)) throw new Error('This is not the pinned build, so the run proves nothing about it')
    })

    await step('2. Create an isolated context and a page, and load the task app', async (facts) => {
      const browser = required(state.browser, 'the browser')
      state.contextA = await browser.createContext()
      state.pageA = await state.contextA.newPage(loadTimeoutMs)
      collectConsoleAndNetwork(state.pageA, state)
      const loaded = await state.pageA.goto(`${app.url}/login`, loadTimeoutMs)
      const readyState = await state.pageA.evaluate('document.readyState')
      facts.push(`context ${state.contextA.id}, page proxy ${state.pageA.pageProxyId}, target ${state.pageA.targetId}`)
      facts.push(`loaded ${loaded.url} (loader ${loaded.loaderId}), document.readyState ${String(readyState)}`)
      if (readyState !== 'complete') throw new Error(`document.readyState is ${String(readyState)} after the load event`)
      const helpers = await required(state.process, 'the browser process').recordHelpers()
      facts.push(`helpers recorded so far: ${describeHelpers(helpers)}`)
    })

    await step('3. Evaluate script, locate by role and name and by test id, read text', async (facts) => {
      const page = required(state.pageA, 'the first page')
      state.userAgent = String(await page.evaluate('navigator.userAgent'))
      const title = await page.evaluate('document.title')
      const heading = await page.getByRole('heading', 'Sign in')
      const button = await page.getByRole('button', 'Sign in')
      const status = await page.getByTestId('sign-in-status')
      const user = await page.getByTestId('user')
      facts.push(`navigator.userAgent ${state.userAgent}`)
      facts.push(`document.title ${JSON.stringify(title)}`)
      facts.push(`getByRole('heading', 'Sign in') text ${JSON.stringify(await page.text(heading))}`)
      facts.push(`getByRole('button', 'Sign in') text ${JSON.stringify(await page.text(button))}`)
      facts.push(`getByTestId('sign-in-status') text ${JSON.stringify(await page.text(status))}, getByTestId('user') value ${JSON.stringify(await page.value(user))}`)
      if (title !== 'Sign in') throw new Error(`document.title is ${JSON.stringify(title)}`)
      if ((await page.text(button)) !== 'Sign in') throw new Error('The button found by role does not read Sign in')
      await expectRefusal(() => page.getByRole('button', 'Sign out'), 'matched 0 elements', facts)
    })

    await step('4. Click and type with real input, and read the page again', async (facts) => {
      const page = required(state.pageA, 'the first page')
      const user = await page.getByTestId('user')
      facts.push(`clicked the user name field at ${point(await page.click(user))}`)
      await page.type('ada')
      const password = await page.getByTestId('password')
      facts.push(`clicked the password field at ${point(await page.click(password))}`)
      await page.type(TASK_APP_PASSWORD)
      const typedUser = await page.value(user)
      const typedPasswordLength = (await page.value(password)).length
      facts.push(`the user name field holds ${JSON.stringify(typedUser)}; the password field holds ${typedPasswordLength} characters`)
      if (typedUser !== 'ada' || typedPasswordLength !== TASK_APP_PASSWORD.length) throw new Error('The fields do not hold what was typed')
      const signIn = await page.getByRole('button', 'Sign in')
      const account = await page.waitForNavigation(async () => facts.push(`clicked Sign in at ${point(await page.click(signIn))}`), (url) => new URL(url).pathname === '/account', loadTimeoutMs)
      const signedIn = await page.text(await page.getByTestId('account'))
      facts.push(`the click navigated to ${account.url}, which reads ${JSON.stringify(signedIn)}`)
      if (signedIn !== 'Signed in as ada') throw new Error(`The account page reads ${JSON.stringify(signedIn)}`)
      await page.goto(`${app.url}/`, loadTimeoutMs)
      // Only watches: the page records each input event and whether the browser marked it as coming from the user.
      await page.evaluate(`window.retestInput = []; for (const type of ['mousedown', 'mouseup', 'click', 'keydown', 'keyup', 'input']) document.addEventListener(type, (event) => window.retestInput.push([event.type, event.isTrusted, event.key ?? '']), true)`)
      const title = await page.getByTestId('task-title')
      await page.click(title)
      await page.type('Release checklist')
      await page.click(await page.getByRole('button', 'Save'))
      await page.waitForFunction(`document.querySelector('[data-testid="saved-task"]').textContent === 'Release checklist'`, loadTimeoutMs)
      const saved = await page.text(await page.getByTestId('saved-task'))
      facts.push(`typed a title and clicked Save; saved-task reads ${JSON.stringify(saved)}; the server accepted ${app.submissions()} save`)
      if (app.submissions() !== 1) throw new Error(`The server accepted ${app.submissions()} saves, not 1`)
      const heard = readInputEvents(await page.evaluate('JSON.stringify(window.retestInput)'))
      const typedKeys = heard.filter((event) => event.type === 'keydown' && event.key !== 'Shift').map((event) => event.key).join('')
      const counts = ['mousedown', 'click', 'keydown', 'input'].map((type) => `${heard.filter((event) => event.type === type).length} ${type}`).join(', ')
      facts.push(`the page heard ${heard.length} input events (${counts}), ${heard.every((event) => event.trusted) ? 'every one' : 'not every one'} marked isTrusted; the keys typed were ${JSON.stringify(typedKeys)}`)
      if (!heard.every((event) => event.trusted)) throw new Error('The page heard input events that were not marked as coming from the user')
      if (typedKeys !== 'Release checklist' || heard.filter((event) => event.type === 'click').length !== 2) throw new Error('The page did not hear the key presses and the two clicks that were sent')
      await checkModifiers(page, facts)
      await sample()
    })

    await step('4b. Refuse to click a button something covers', async (facts) => {
      const contextA = required(state.contextA, 'the first context')
      const covered = await startTaskApp({ mode: 'overlay' })
      const page = await contextA.newPage(loadTimeoutMs)
      try {
        await page.goto(`${covered.url}/`, loadTimeoutMs)
        await page.evaluate(`window.retestMouse = []; for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click']) window.addEventListener(type, (event) => window.retestMouse.push(event.type), true)`)
        const save = await page.getByRole('button', 'Save')
        const hit = await page.hitTarget(save)
        const top = hit.top === null ? 'nothing' : `a ${hit.top.tag} with position ${hit.top.position}${hit.top.testId === null ? '' : ` and test id ${hit.top.testId}`}`
        facts.push(`at Save's centre ${point(hit.point)} the page reports ${top}, which ${hit.hitsElement ? 'is' : 'is not'} the button or inside it`)
        if (hit.hitsElement || hit.top?.tag !== 'DIV' || hit.top.position !== 'fixed') throw new Error('The overlay is not what lies at the button\'s centre')
        const refusal = await page.click(save).then(() => undefined, (error: unknown) => errorMessage(error))
        const mouseEvents = await page.evaluate('JSON.stringify(window.retestMouse)')
        facts.push(`clicking Save was refused: ${refusal ?? 'it was clicked'}; the page heard these mouse events: ${String(mouseEvents)}; the server accepted ${covered.submissions()} saves`)
        if (refusal === undefined || !refusal.includes('is covered')) throw new Error('A covered button was clicked')
        if (mouseEvents !== '[]') throw new Error('The page heard mouse events from a click that was refused')
      } finally {
        await sample()
        await page.close()
        await covered.close()
      }
    })

    await step('5. Screenshot the viewport to a PNG and check the file', async (facts) => {
      const page = required(state.pageA, 'the first page')
      const file = join(options.outputFolder, 'webkit-task-app.png')
      await writeFile(file, await page.screenshot())
      const bytes = await readFile(file)
      const png = inspectPng(bytes)
      state.screenshot = file
      facts.push(`${file}: ${bytes.length} bytes, ${png.width}×${png.height}, colour type ${png.colorType}, ${png.distinctColors} distinct colours`)
      if (png.width !== VIEWPORT.width || png.height !== VIEWPORT.height) throw new Error(`The PNG is ${png.width}×${png.height}, not ${VIEWPORT.width}×${VIEWPORT.height}`)
      if (png.distinctColors < 16) throw new Error(`The PNG has ${png.distinctColors} distinct colours, too few for a page with text`)
    })

    await step('6. Keep two contexts apart: cookies and localStorage', async (facts) => {
      const browser = required(state.browser, 'the browser')
      const contextA = required(state.contextA, 'the first context')
      const pageA = required(state.pageA, 'the first page')
      state.contextB = await browser.createContext()
      state.pageB = await state.contextB.newPage(loadTimeoutMs)
      await state.pageB.goto(`${app.url}/account`, loadTimeoutMs)
      const accountB = await state.pageB.text(await state.pageB.getByTestId('account'))
      const storageB = await state.pageB.evaluate(`JSON.stringify([localStorage.getItem('signed-in-user'), localStorage.getItem('last-saved'), document.cookie])`)
      const cookiesA = await contextA.cookies()
      const cookiesB = await state.contextB.cookies()
      facts.push(`context A cookies: ${describeCookies(cookiesA)}; context B cookies: ${describeCookies(cookiesB)}`)
      facts.push(`context B's account page reads ${JSON.stringify(accountB)}; its signed-in-user, last-saved and document.cookie are ${String(storageB)}`)
      if (!cookiesA.some((cookie) => cookie.name === 'task-app-session' && cookie.httpOnly)) throw new Error('Context A has no HTTP-only session cookie after signing in')
      if (cookiesB.length !== 0) throw new Error('Context B holds cookies it never set')
      if (accountB !== 'Signed out' || storageB !== '[null,null,""]') throw new Error('Context B sees context A\'s session or storage')
      await state.pageB.evaluate(`localStorage.setItem('context-b-only', 'yes'); document.cookie = 'context-b=yes; path=/'`)
      const fromA = await pageA.evaluate(`JSON.stringify([localStorage.getItem('context-b-only'), document.cookie.includes('context-b')])`)
      const namesA = (await contextA.cookies()).map((cookie) => cookie.name)
      const namesB = (await state.contextB.cookies()).map((cookie) => cookie.name)
      facts.push(`context B set a localStorage key and a cookie; context A reads ${String(fromA)} for them and its cookies are ${namesA.join(', ')}; context B's are ${namesB.join(', ')}`)
      if (fromA !== '[null,false]' || namesA.includes('context-b') || !namesB.includes('context-b')) throw new Error('Context A sees what context B set')
      await sample()
    })

    await step('7. Receive console and network events', async (facts) => {
      const page = required(state.pageA, 'the first page')
      await page.evaluate(`console.log('retest proof: a log line'); console.warn('retest proof: a warning'); console.error('retest proof: an error'); setTimeout(() => { throw new Error('retest proof: an uncaught error') }, 0)`)
      const status = await page.evaluateAwaiting(`fetch('/missing').then((response) => response.status)`, loadTimeoutMs)
      await waitUntil(() => state.consoleMessages.some((message) => message.text.includes('an uncaught error')), loadTimeoutMs)
      const levels = state.consoleMessages.map((message) => message.level)
      facts.push(`fetch('/missing') answered ${String(status)} in the page`)
      facts.push(`${state.consoleMessages.length} Console.messageAdded events; the last four: ${state.consoleMessages.slice(-4).map((message) => `${message.level}/${message.source} ${JSON.stringify(message.text)}`).join('; ')}`)
      const requests = state.network.filter((entry) => entry.event === 'Network.requestWillBeSent')
      const responses = state.network.filter((entry) => entry.event === 'Network.responseReceived')
      facts.push(`${requests.length} Network.requestWillBeSent and ${responses.length} Network.responseReceived events; some: ${responses.slice(0, 6).map((entry) => `${entry.method ?? ''} ${entry.path} ${entry.status ?? ''}`.trim()).join('; ')}`)
      const missing = responses.find((entry) => entry.path === '/missing')
      facts.push(`the /missing response event: status ${String(missing?.status)}, ${missing?.mimeType ?? 'no MIME type'}`)
      for (const level of ['log', 'warning', 'error']) if (!levels.includes(level)) throw new Error(`No console message at level ${level} arrived`)
      if (!state.consoleMessages.some((message) => message.text.includes('an uncaught error'))) throw new Error('The uncaught error did not arrive as a console message')
      if (missing?.status !== 404) throw new Error('No Network.responseReceived with status 404 arrived for /missing')
      if (!requests.some((entry) => entry.method === 'POST' && entry.path === '/api/sign-in')) throw new Error('The sign-in request did not arrive as Network.requestWillBeSent')
    })

    await step('7b. Follow a cross-site navigation into a new web process', async (facts) => {
      const page = required(state.pageA, 'the first page')
      const before = page.targetId
      const swapsBefore = page.processSwaps.length
      const crossSite = app.url.replace('127.0.0.1', 'localhost')
      const loaded = await page.goto(`${crossSite}/login`, loadTimeoutMs)
      const title = await page.evaluate('document.title')
      const swaps = page.processSwaps.slice(swapsBefore)
      facts.push(`loaded ${loaded.url}; target ${before} then ${page.targetId}; process swaps during this navigation: ${swaps.map((swap) => `${swap.from} → ${swap.to}`).join(', ') || 'none'}; title ${JSON.stringify(title)}`)
      if (swaps.length === 0 || page.targetId === before) throw new Error('The cross-site navigation did not move the page to a new target')
      if (title !== 'Sign in') throw new Error(`The page reads ${JSON.stringify(title)} after the cross-site navigation`)
      await sample()
    })

    await step('8. Close cleanly and prove every browser process is gone', async (facts) => {
      const browser = required(state.browser, 'the browser')
      const webkit = required(state.process, 'the browser process')
      await sample()
      await required(state.pageB, 'the second page').close()
      await sample()
      await required(state.contextB, 'the second context').close()
      await sample()
      await required(state.pageA, 'the first page').close()
      await sample()
      await required(state.contextA, 'the first context').close()
      await sample()
      const recorded = webkit.buildHelpers
      facts.push(`build helpers recorded over the run, sampled after steps 2, 4, 6 and 7b and before every close: ${describeHelpers(recorded)}`)
      await browser.close(closeGraceMs)
      const exit = await webkit.waitForExit(closeGraceMs)
      const stopped = await webkit.stop(closeGraceMs)
      facts.push(`Playwright.close answered; the main process ended with ${exit === undefined ? 'nothing within the grace period' : describeExit(exit)}`)
      facts.push(...describeStop(stopped))
      facts.push(`outside the temporary home: ${preferences} ${preferencesBefore ? 'existed before the run' : 'did not exist before the run'} and ${existsSync(preferences) ? 'exists now' : 'does not exist now'}`)
      for (const problem of state.samplingProblems) facts.push(`sampling problem: ${problem}`)
      if (recorded.length === 0) throw new Error('No helper from the build was recorded, so the check below would prove nothing')
      if (state.samplingProblems.length > 0) throw new Error('Recording the helpers failed at least once')
      if (exit === undefined || !stopped.groupEnded || stopped.helpersKilled.length > 0 || stopped.buildProcessesLeft.length > 0 || stopped.problems.length > 0) {
        throw new Error('The browser did not end cleanly on its own')
      }
    })

    await step('9. Kill the browser mid-session and report the loss', async (facts) => {
      const webkit = await WebKitProcess.start({ build, logFile: disconnectLog, headless: true })
      const outcome = await killMidSession(webkit, app.url, state, facts).then(() => undefined, (error: unknown) => error)
      const stopped = await webkit.stop(closeGraceMs)
      facts.push(...describeStop(stopped))
      // The failure that happened first is the one to report; cleanup only adds to it.
      if (outcome !== undefined) throw outcome
      if (!stopped.groupEnded || stopped.buildProcessesLeft.length > 0 || stopped.problems.length > 0) throw new Error('Processes of the killed browser are still running')
    })
  } finally {
    await state.process?.stop(0)
    await app.close()
  }
  for (const problem of state.diagnostics) appendFileSync(browserLog, `[retest proof] ${problem}\n`)
  const pinned = matchesPin(build)
  return {
    ok: steps.every((step) => step.ok),
    build: { directory: build.directory, revision: build.revision, protocolSha256: build.protocolSha256, matchesPin: pinned, url: pinned ? PINNED_BUILD.url : undefined },
    flags: webKitArguments({ headless: true }),
    userAgent: state.userAgent,
    steps,
    protocol: { commands: [...used.commands].sort(), events: [...used.events].sort() },
    artifacts: { folder: options.outputFolder, screenshot: state.screenshot, browserLog, disconnectLog },
  }
}

/**
 * Clicks the heading and presses a key with each modifier bit alone, and reads which of `shiftKey`, `ctrlKey`,
 * `altKey` and `metaKey` the page saw on each click and key down.
 */
async function checkModifiers(page: WkPage, facts: string[]): Promise<void> {
  await page.evaluate(`window.retestModifiers = []; for (const type of ['click', 'keydown']) document.addEventListener(type, (event) => window.retestModifiers.push([event.type, event.shiftKey, event.ctrlKey, event.altKey, event.metaKey]), true)`)
  const heading = await page.getByRole('heading', 'Tasks')
  for (const { bit } of MODIFIER_BITS) {
    await page.click(heading, { modifiers: bit })
    await page.press(PROBE_KEY, bit)
  }
  const seen = readModifierEvents(await page.evaluate('JSON.stringify(window.retestModifiers)'))
  const flags = ['shiftKey', 'ctrlKey', 'altKey', 'metaKey'] as const
  const observed = seen.map((event) => `${event.type} ${flags.filter((flag) => event[flag]).join('+') || 'none'}`)
  facts.push(`modifier bits 1, 2, 4 and 8, one at a time on a click and a key down, gave: ${observed.join('; ')}`)
  const expected = MODIFIER_BITS.flatMap(({ flag }) => [`click ${flag}`, `keydown ${flag}`])
  if (observed.join('; ') !== expected.join('; ')) throw new Error(`The page saw ${observed.join('; ')}, not Shift 1, Control 2, Alt 4 and Meta 8`)
}

function readModifierEvents(text: unknown): { type: string; shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean }[] {
  const events: unknown = typeof text === 'string' ? JSON.parse(text) : undefined
  if (!Array.isArray(events)) throw new Error('The page kept no modifier events')
  return events.map((event: unknown) => {
    if (!Array.isArray(event)) throw new Error('The page kept a modifier event in an unexpected form')
    const [type, shiftKey, ctrlKey, altKey, metaKey] = event
    return { type: String(type), shiftKey: shiftKey === true, ctrlKey: ctrlKey === true, altKey: altKey === true, metaKey: metaKey === true }
  })
}

async function killMidSession(webkit: WebKitProcess, appUrl: string, state: State, facts: string[]): Promise<void> {
  const connection = new WkConnection(new PipeTransport(webkit.pipe), { timeoutMs: commandTimeoutMs, onDiagnostic: (problem) => state.diagnostics.push(problem) })
  const lost = new Promise<string>((resolve) => connection.onDisconnect(resolve))
  const browser = await WkBrowser.connect(connection, { viewport: VIEWPORT, onDiagnostic: (problem) => state.diagnostics.push(problem) })
  const context = await browser.createContext()
  const page = await context.newPage(loadTimeoutMs)
  await page.goto(`${appUrl}/`, loadTimeoutMs)
  await webkit.recordHelpers()
  const helpers = webkit.buildHelpers
  facts.push(`build helpers recorded before the kill: ${describeHelpers(helpers)}`)
  if (helpers.length === 0) throw new Error('No helper from the build was recorded before the kill, so the check after it would prove nothing')
  const waiting = page.evaluateAwaiting('new Promise(() => {})', 30_000).then(
    () => new Error('A promise that never settles was answered'),
    (error: unknown) => error,
  )
  // Answered after the wait above was written, since a target answers in order.
  await page.evaluate('1')
  process.kill(webkit.pid, 'SIGKILL')
  const reason = await within(lost, disconnectNoticeMs, 'the client to notice the lost browser')
  facts.push(`killed pid ${webkit.pid} with SIGKILL; the client reported the connection lost: ${reason}`)
  const pending = await waiting
  if (!(pending instanceof WkDisconnectedError) || !pending.written) throw new Error(`The waiting command ended with ${errorMessage(pending)}, not a lost connection after it was written`)
  facts.push(`the command waiting at the time failed with ${pending.name}, written ${pending.written}, so its outcome is unknown: ${pending.message}`)
  const afterPage = await page.evaluate('2').then(() => undefined, (error: unknown) => error)
  if (afterPage === undefined || !errorMessage(afterPage).includes('was not sent')) throw new Error(`A page command after the loss ended with ${afterPage === undefined ? 'an answer' : errorMessage(afterPage)}`)
  facts.push(`a page command after the loss was refused: ${errorMessage(afterPage)}`)
  const afterBrowser = await connection.send('Playwright.getInfo').then(() => undefined, (error: unknown) => error)
  if (!(afterBrowser instanceof WkDisconnectedError) || afterBrowser.written) throw new Error('A browser command after the loss was not refused before it was written')
  facts.push(`a browser command after the loss was refused unwritten: ${afterBrowser.message}`)
  const exit = await webkit.waitForExit(closeGraceMs)
  facts.push(`the main process ended with ${exit === undefined ? 'nothing yet' : describeExit(exit)}`)
  facts.push(`right after the exit, launchctl print pid/${webkit.pid} ${await askLaunchd(webkit.pid)}`)
  const started = performance.now()
  // Running out of time here is a finding, not a failure: the lines below name every process still running.
  await waitUntilAsync(async () => (await listBuildProcesses(webkit.build, externalCommandMs)).every((entry) => !helpers.some((helper) => helper.pid === entry.pid)), helperExitMs).catch(() => undefined)
  const after = Math.round(performance.now() - started)
  const running = (await Promise.all(helpers.map(async (helper) => ((await stillRunning(helper)) ? [helper] : [])))).flat()
  facts.push(`${helpers.length - running.length} of ${helpers.length} recorded build helpers had ended ${after} ms after the client saw the main process exit, found by path${running.length > 0 ? `; still running: ${running.map((helper) => helper.label).join(', ')}` : ''}`)
  facts.push(`then launchctl print pid/${webkit.pid} ${await askLaunchd(webkit.pid)}`)
}

// What launchd says about a process that has exited: whether it still answers, and which running services it lists.
async function askLaunchd(pid: number): Promise<string> {
  try {
    const { stdout } = await execFileAsync('launchctl', ['print', `pid/${pid}`], { timeout: externalCommandMs, killSignal: 'SIGKILL', encoding: 'utf8' })
    const services = parseLaunchdServices(stdout)
    return `still answers and lists ${services.length} running services${services.length > 0 ? `: ${services.map((service) => `${service.label} (pid ${service.pid})`).join(', ')}` : ''}`
  } catch (error) {
    return `fails: ${firstLine(errorMessage(error))}`
  }
}

async function waitUntilAsync(condition: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const started = performance.now()
  while (!(await condition())) {
    if (performance.now() - started >= timeoutMs) throw new Error(`Waited ${timeoutMs} ms`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

function firstLine(text: string): string {
  return text.split('\n').find((line) => line.trim() !== '')?.trim() ?? text
}

function describeHelpers(helpers: readonly HelperProcess[]): string {
  if (helpers.length === 0) return 'none'
  return helpers.map((helper) => `${helper.label} (pid ${helper.pid}, by ${helper.foundBy})`).join(', ')
}

async function waitUntil(condition: () => boolean, timeoutMs: number): Promise<void> {
  const started = performance.now()
  while (!condition()) {
    if (performance.now() - started >= timeoutMs) throw new Error(`Waited ${timeoutMs} ms`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

type ConsoleEntry = { level: string; source: string; text: string }
type NetworkEntry = { event: string; path: string; method: string | undefined; status: number | undefined; mimeType: string | undefined }

type State = {
  samplingProblems: string[]
  process?: WebKitProcess
  browser?: WkBrowser
  contextA?: WkContext
  pageA?: WkPage
  contextB?: WkContext
  pageB?: WkPage
  userAgent?: string
  screenshot?: string
  consoleMessages: ConsoleEntry[]
  network: NetworkEntry[]
  diagnostics: string[]
}

function readInputEvents(text: unknown): { type: string; trusted: boolean; key: string }[] {
  const events: unknown = typeof text === 'string' ? JSON.parse(text) : undefined
  if (!Array.isArray(events)) throw new Error('The page kept no input events')
  return events.map((event: unknown) => {
    if (!Array.isArray(event)) throw new Error('The page kept an input event in an unexpected form')
    const [type, trusted, key] = event
    return { type: String(type), trusted: trusted === true, key: String(key) }
  })
}

function collectConsoleAndNetwork(page: WkPage, state: State): void {
  page.onEvent((event: PageEvent) => {
    if (event.method === 'Console.messageAdded') {
      const message = isRecord(event.params) ? event.params['message'] : undefined
      state.consoleMessages.push({ level: readText(message, 'level'), source: readText(message, 'source'), text: readText(message, 'text').slice(0, 120) })
    } else if (event.method === 'Network.requestWillBeSent') {
      const request = isRecord(event.params) ? event.params['request'] : undefined
      state.network.push({ event: event.method, path: pathOf(readText(request, 'url')), method: readText(request, 'method'), status: undefined, mimeType: undefined })
    } else if (event.method === 'Network.responseReceived') {
      const response = isRecord(event.params) ? event.params['response'] : undefined
      const status = isRecord(response) && typeof response['status'] === 'number' ? response['status'] : undefined
      state.network.push({ event: event.method, path: pathOf(readText(response, 'url')), method: undefined, status, mimeType: readText(response, 'mimeType') })
    }
  })
}

/** A transport that notes the method of every command and event that passes, never the parameters. */
function recordingTransport(inner: Transport, used: { commands: Set<string>; events: Set<string> }): Transport {
  return {
    listen(handlers) {
      inner.listen({
        ...handlers,
        message(text) {
          noteIncoming(text, used.events)
          handlers.message(text)
        },
      })
    },
    send(text) {
      noteOutgoing(text, used.commands)
      return inner.send(text)
    },
    close: () => inner.close(),
  }
}

function noteOutgoing(text: string, commands: Set<string>): void {
  const message = parse(text)
  const method = readText(message, 'method')
  const params = isRecord(message) ? message['params'] : undefined
  if (method === 'Target.sendMessageToTarget') {
    commands.add(`page proxy: ${method}`)
    commands.add(`page target: ${readText(parse(readText(params, 'message')), 'method')}`)
  } else {
    commands.add(`${isRecord(message) && message['pageProxyId'] !== undefined ? 'page proxy' : 'browser'}: ${method}`)
  }
}

function noteIncoming(text: string, events: Set<string>): void {
  const message = parse(text)
  const method = readText(message, 'method')
  if (method === '') return
  const params = isRecord(message) ? message['params'] : undefined
  if (method === 'Target.dispatchMessageFromTarget') {
    events.add(`page proxy: ${method}`)
    const inner = readText(parse(readText(params, 'message')), 'method')
    if (inner !== '') events.add(`page target: ${inner}`)
  } else {
    events.add(`${isRecord(message) && message['pageProxyId'] !== undefined ? 'page proxy' : 'browser'}: ${method}`)
  }
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function readText(value: unknown, key: string): string {
  const field = isRecord(value) ? value[key] : undefined
  return typeof field === 'string' ? field : ''
}

// Origin and path only: a query or fragment can carry a token.
function pathOf(url: string): string {
  try {
    return new URL(url).pathname
  } catch {
    return '(not a URL)'
  }
}

function describeFailure(error: unknown): string {
  if (error instanceof WkCommandError) return `${error.name}: ${error.method} on the ${error.scope}: ${error.message}`
  return errorMessage(error)
}

function describeCookies(cookies: readonly { name: string; domain: string; httpOnly: boolean }[]): string {
  if (cookies.length === 0) return 'none'
  return cookies.map((cookie) => `${cookie.name} on ${cookie.domain}${cookie.httpOnly ? ' (HTTP only)' : ''}`).join(', ')
}

function describeStop(stopped: StopReport): string[] {
  const facts = [
    `process group ${stopped.groupEnded ? 'gone' : 'still there'}; killed after the grace period: ${stopped.helpersKilled.map((helper) => helper.label).join(', ') || 'none'}; processes from the build started since launch and running at the end, by ps: ${stopped.buildProcessesLeft.map((helper) => `${helper.label} (pid ${helper.pid})`).join(', ') || 'none'}`,
  ]
  if (stopped.othersUnderBuild.length > 0) facts.push(`running from the build since before this browser, never signalled: ${stopped.othersUnderBuild.map((helper) => `${helper.label} (pid ${helper.pid})`).join(', ')}`)
  for (const { helper, ended } of stopped.systemServices) facts.push(`system service ${helper.label} (pid ${helper.pid}, ${helper.command}) ${ended ? 'ended' : 'is still running; the proof never signals system services'}`)
  for (const problem of stopped.problems) facts.push(`problem: ${problem}`)
  return facts
}

function point(value: { x: number; y: number }): string {
  return `(${value.x}, ${value.y})`
}

function required<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new Error(`Not run: ${name} is missing because an earlier step failed`)
  return value
}

async function expectRefusal(action: () => Promise<unknown>, expected: string, facts: string[]): Promise<void> {
  const outcome = await action().then(() => undefined, (error: unknown) => errorMessage(error))
  if (outcome === undefined || !outcome.includes(expected)) throw new Error(`A locator that matches nothing was not refused: ${outcome ?? 'it matched'}`)
  facts.push(`a role and name that match nothing are refused: ${outcome}`)
}

async function within<T>(promise: Promise<T>, timeoutMs: number, waitingFor: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Waited ${timeoutMs} ms for ${waitingFor}`)), timeoutMs)
  })
  try {
    return await Promise.race([promise, expired])
  } finally {
    clearTimeout(timer)
  }
}
