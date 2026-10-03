import type { Readable } from 'node:stream'
import type { BidiDiagnostic } from './bidi-client.ts'
import type { Tab } from './firefox-page.ts'
import type { FirefoxProcess, LaunchedFirefox, LaunchRoute } from './launch-firefox.ts'
import type { ProcessLine } from './process-table.ts'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { startTaskApp } from '../../fixtures/task-app/server.ts'
import { TASK_APP_PASSWORD } from '../../fixtures/task-app/sign-in.ts'
import { signalGroup } from '../../src/browser/chromium-process.ts'
import { s, type Infer, type Schema } from '../../src/protocol/schema.ts'
import { BidiClient, readBidi } from './bidi-client.ts'
import { BidiClosedError, BidiDisconnectedError, BidiError, BidiProtocolError } from './bidi-errors.ts'
import {
  callInPage,
  callInSandbox,
  click,
  createUserContext,
  EventRecorder,
  locateByRole,
  locateByTestId,
  navigate,
  openTab,
  readCookies,
  readText,
  readUntil,
  screenshot,
  typeText,
} from './firefox-page.ts'
import { firefoxPath, launchRoute } from './firefox-session.ts'
import { firefoxPreferences, launchFirefox } from './launch-firefox.ts'
import { readPng } from './png.ts'
import { processTable } from './process-table.ts'

/**
 * Proves stock Firefox can be driven over WebDriver BiDi with no third-party package: launch, an isolated user
 * context, navigation, locators, real input, a screenshot, storage isolation, events, a clean close, a lost
 * connection and a runner killed outright. Each step prints what it saw; a step that fails says which command
 * failed, and the next one runs.
 *
 *   node --conditions=retest-source proofs/firefox/run.ts [--route spawn|launch-services] [--out <folder>]
 */

const viewport = { width: 1280, height: 720 }
const launchMs = 20_000
const commandMs = 10_000
const closeMs = 5000
const orderingRounds = 40
const subscribedEvents = [
  'browsingContext.navigationStarted',
  'browsingContext.fragmentNavigated',
  'browsingContext.domContentLoaded',
  'browsingContext.load',
  'browsingContext.navigationFailed',
  'log.entryAdded',
]
const runnerPath = fileURLToPath(new URL('./launch-and-hold.ts', import.meta.url))

/** A step that could not run because an earlier one failed. It is reported as skipped, never as passed. */
class SkippedStep extends Error {
  override readonly name = 'SkippedStep'
}

const navigationEventSchema = s.object({ context: s.string(), navigation: s.nullable(s.string()), url: s.string() })
const logEntrySchema = s.object({
  type: s.string(),
  level: s.string(),
  text: s.nullable(s.string()),
  method: s.optional(s.string()),
  source: s.object({ realm: s.string(), context: s.optional(s.string()) }),
})
const userContextsSchema = s.object({ userContexts: s.array(s.object({ userContext: s.string() })) })
const treeSchema = s.object({ contexts: s.array(s.object({ context: s.string(), userContext: s.string(), url: s.string() })) })
const probeSchema = s.object({ cookie: s.string(), stored: s.nullable(s.string()), user: s.nullable(s.string()) })
const viewportSchema = s.object({ width: s.number(), height: s.number(), ratio: s.number() })
const realmsSchema = s.object({ realms: s.array(s.object({ realm: s.string(), sandbox: s.optional(s.string()) })) })
const heldSchema = s.object({ pid: s.number({ integer: true }), folder: s.string(), webSocketUrl: s.string() })

const { values } = parseArgs({ options: { route: { type: 'string' }, out: { type: 'string' } } })
const route = readRoute(values.route)
const out = values.out === undefined ? await mkdtemp(join(tmpdir(), 'retest-firefox-proof-')) : resolve(values.out)
await mkdir(out, { recursive: true })

const startedAt = performance.now()
const failures: string[] = []
const skipped: string[] = []
const diagnostics: BidiDiagnostic[] = []
const app = await startTaskApp({ mode: 'noisy' })

let firefox: FirefoxProcess | undefined
let client: BidiClient | undefined
let tabA: Tab | undefined
let recorder: EventRecorder | undefined

say(`Firefox proof over WebDriver BiDi. Scratch folder: ${out}`)
say(`Task app (noisy mode, which logs to the console) at ${app.url}`)

try {
  await step('1. Launch Firefox headless with a fresh profile in its own process group, and start the session', async (note) => {
    const executablePath = firefoxPath()
    note(`executable ${executablePath}, route ${route}`)
    note(`user.js: ${Object.entries(firefoxPreferences).map(([name, value]) => `${name}=${JSON.stringify(value)}`).join(', ')}`)
    const launched = await launchOne(join(out, 'firefox.log'))
    firefox = launched.firefox
    client = launched.client
    const { pid, profile } = launched.firefox
    note(`the sweep before launching ended ${launched.sweep.ended.length} orphaned Firefoxes and removed ${launched.sweep.removed.length} stale folders${describeProblems(launched.sweep.problems)}`)
    note(`pid ${pid}, profile ${profile}`)
    note(`printed "WebDriver BiDi listening on ${launched.firefox.webSocketUrl}" after ${launched.firefox.startupMs} ms`)
    const table = await processTable()
    const group = table.filter((line) => line.group === pid)
    note(`process group ${pid}: ${group.map((line) => `${line.pid} ${programName(line.command)}`).join(', ')}`)
    check(group.some((line) => line.pid === pid), 'the main process leads its own process group')
    const outside = table.filter((line) => line.command.includes(profile) && line.group !== pid)
    check(outside.length === 0, `no process names the profile outside the group, yet ${outside.length} do`)
    const { session } = launched
    note(`session.new: ${session.browserName} ${session.browserVersion} on ${session.platformName} ${session.platformVersion}, headless ${session.headless}`)
    note(`the launcher checked that session.new names process ${session.processId} and profile ${session.profile}, the ones it launched`)
    check(session.headless, 'moz:headless is true')
  })

  await step('2. Create an isolated user context and a tab in it', async (note) => {
    const browser = need(client)
    const before = await browser.request('browser.getUserContexts', {}, userContextsSchema)
    note(`browser.getUserContexts before: ${before.userContexts.map((entry) => entry.userContext).join(', ')}`)
    const userContext = await createUserContext(browser, commandMs)
    note(`browser.createUserContext: ${userContext}`)
    tabA = await openTab(browser, userContext, viewport, commandMs)
    note(`browsingContext.create (tab) in it: ${tabA.context}; browsingContext.setViewport ${viewport.width} × ${viewport.height} at ratio 1`)
    const tree = await browser.request('browsingContext.getTree', {}, treeSchema)
    const entry = tree.contexts.find((context) => context.context === tabA?.context)
    note(`browsingContext.getTree: ${tree.contexts.map((context) => `${context.context} in ${context.userContext}`).join('; ')}`)
    check(entry?.userContext === userContext, 'the tab belongs to the new user context')
  })

  await step('7a. Subscribe to navigation events and console messages before navigating', async (note) => {
    const browser = need(client)
    recorder = new EventRecorder(browser, subscribedEvents, startedAt)
    const committed = await browser.send('session.subscribe', { events: ['browsingContext.navigationCommitted'] }, { keepErrorMessage: true }).then(
      () => 'accepted',
      (error: unknown) => `refused: ${describeError(error)}`,
    )
    note(`session.subscribe browsingContext.navigationCommitted: ${committed}`)
    await browser.request('session.subscribe', { events: subscribedEvents }, s.object({}))
    note(`session.subscribe: ${subscribedEvents.join(', ')}`)
  })

  await step('3. Navigate to the task app and wait for the navigation to complete', async (note) => {
    const tab = need(tabA)
    const events = need(recorder)
    const result = await navigate(tab, `${app.url}/`, commandMs)
    note(`browsingContext.navigate (wait complete): navigation ${result.navigation}, url ${result.url}`)
    await events.waitFor('browsingContext.load', (params) => navigationEvent(params)?.navigation === result.navigation, commandMs)
    note('a browsingContext.load event names the same navigation')
    const size = await callInSandbox(tab, '() => ({ width: innerWidth, height: innerHeight, ratio: devicePixelRatio })', [], viewportSchema, commandMs)
    note(`the page's viewport: ${size.width} × ${size.height} at ratio ${size.ratio}`)
    check(size.width === viewport.width && size.height === viewport.height && size.ratio === 1, 'the viewport is the size that was set')
  })

  await step('4. Locate by role and name and by test id, read text, click and type, and read the page again', async (note) => {
    const tab = need(tabA)
    const save = await locateByRole(tab, 'button', 'Save', commandMs)
    const saveText = await readText(tab, save, commandMs)
    note(`browsingContext.locateNodes accessibility {role: button, name: Save}: one node, ${save.sharedId}, text "${saveText}"`)
    check(saveText === 'Save', 'the button reads Save')
    const title = await locateByTestId(tab, 'task-title', commandMs)
    note(`browsingContext.locateNodes css [data-testid="task-title"]: one node, ${title.sharedId}`)
    const fieldPoint = await click(tab, title, commandMs)
    note(`input.performActions mouse move, down, up at (${fieldPoint.x}, ${fieldPoint.y}) on the field`)
    await typeText(tab, 'Release checklist', commandMs)
    const value = await callInSandbox(tab, '(element) => element.value', [title], s.string(), commandMs)
    note(`input.performActions keys "Release checklist"; the field now holds "${value}"`)
    check(value === 'Release checklist', 'the typed text reached the field')
    const savePoint = await click(tab, save, commandMs)
    note(`input.performActions mouse click at (${savePoint.x}, ${savePoint.y}) on Save`)
    const saved = await locateByTestId(tab, 'saved-task', commandMs)
    const shown = await readUntil(() => readText(tab, saved, commandMs), (text) => text === 'Release checklist', 5000)
    note(`read again: saved-task shows "${shown}"; the server accepted ${app.submissions()} save`)
    check(app.submissions() === 1, 'the click sent exactly one save to the server')
    const pageSet = await callInPage(tab, "() => { window.retestPageValue = 'set by the page'; return typeof window.retestPageValue }", [], s.string(), commandMs)
    const sandboxSees = await callInSandbox(tab, '() => typeof window.retestPageValue', [], s.string(), commandMs)
    await callInSandbox(tab, "() => { window.retestSandboxValue = 'set by Retest' }", [], s.literal(null), commandMs)
    const pageSees = await callInPage(tab, '() => typeof window.retestSandboxValue', [], s.string(), commandMs)
    note(`a page global is ${pageSet} in the page and ${sandboxSees} in Retest's sandbox; a sandbox global is ${pageSees} in the page`)
    check(sandboxSees === 'undefined' && pageSees === 'undefined', "the page and Retest's sandbox keep their globals apart")
  })

  await step('5. Take a screenshot, write it as a PNG, and open and check the file', async (note) => {
    const tab = need(tabA)
    const file = join(out, 'viewport.png')
    await writeFile(file, await screenshot(tab, commandMs))
    const bytes = await readFile(file)
    const png = readPng(bytes)
    note(`browsingContext.captureScreenshot (viewport, image/png) written to ${file}, ${bytes.length} bytes`)
    note(`opened: PNG signature and every chunk CRC valid; chunks ${[...new Set(png.chunks)].join(' ')}; ${png.width} × ${png.height}, bit depth ${png.bitDepth}, colour type ${png.colorType}, ${png.distinctColors} distinct colours`)
    check(png.width === viewport.width && png.height === viewport.height, `the PNG is ${viewport.width} × ${viewport.height}, the viewport`)
    check(png.distinctColors > 2, 'the screenshot is not blank')
    note('what it shows is checked by eye, not by this step')
  })

  await step('6. Two user contexts on one origin keep cookies and localStorage apart', async (note) => {
    const browser = need(client)
    const tab = need(tabA)
    const events = need(recorder)
    await navigate(tab, `${app.url}/login`, commandMs)
    await click(tab, await locateByTestId(tab, 'user', commandMs), commandMs)
    await typeText(tab, 'ada', commandMs)
    await click(tab, await locateByTestId(tab, 'password', commandMs), commandMs)
    await typeText(tab, TASK_APP_PASSWORD, commandMs)
    await click(tab, await locateByRole(tab, 'button', 'Sign in', commandMs), commandMs)
    await events.waitFor('browsingContext.load', (params) => isLoadOf(params, tab.context, '/account'), commandMs)
    const signedIn = await readText(tab, await locateByTestId(tab, 'account', commandMs), commandMs)
    note(`user context A signed in through the sign-in page with real input; its account page reads "${signedIn}"`)
    check(signedIn === 'Signed in as ada', 'the server signed A in')
    await setProbe(tab, 'a')

    const userContextB = await createUserContext(browser, commandMs)
    const tabB = await openTab(browser, userContextB, viewport, commandMs)
    await navigate(tabB, `${app.url}/account`, commandMs)
    const signedOut = await readText(tabB, await locateByTestId(tabB, 'account', commandMs), commandMs)
    note(`user context B (${userContextB}) opens the same account page: "${signedOut}"`)
    check(signedOut === 'Signed out', 'the server sees no session from B')
    await setProbe(tabB, 'b')

    const probeA = await readProbe(tab)
    const probeB = await readProbe(tabB)
    note(`A's page reads document.cookie "${probeA.cookie}", localStorage probe ${probeA.stored}, stored user ${probeA.user}`)
    note(`B's page reads document.cookie "${probeB.cookie}", localStorage probe ${probeB.stored}, stored user ${probeB.user}`)
    check(probeA.stored === 'a' && probeA.cookie.includes('retest-probe=a') && !probeA.cookie.includes('retest-probe=b'), 'A sees only its own values')
    check(probeB.stored === 'b' && probeB.cookie === 'retest-probe=b' && probeB.user === null, 'B sees only its own values')

    const cookiesA = await readCookies(browser, tab.userContext, commandMs)
    const cookiesB = await readCookies(browser, userContextB, commandMs)
    const cookiesDefault = await readCookies(browser, 'default', commandMs)
    note(`storage.getCookies for A: ${describeCookies(cookiesA)}`)
    note(`storage.getCookies for B: ${describeCookies(cookiesB)}`)
    note(`storage.getCookies for the default user context: ${describeCookies(cookiesDefault)}`)
    check(cookiesA.some((cookie) => cookie.name === 'task-app-session' && cookie.httpOnly), "A's HttpOnly session cookie is readable over BiDi")
    check(cookiesB.length === 1 && cookiesB[0]?.name === 'retest-probe', 'B holds only its own probe cookie')
    check(cookiesDefault.length === 0, 'the default user context holds none of them')

    const tabA2 = await openTab(browser, tab.userContext, viewport, commandMs)
    await navigate(tabA2, `${app.url}/account`, commandMs)
    const sharedSession = await readText(tabA2, await locateByTestId(tabA2, 'account', commandMs), commandMs)
    const probeA2 = await readProbe(tabA2)
    note(`control: a second tab in A reads "${sharedSession}" and localStorage probe ${probeA2.stored}`)
    check(sharedSession === 'Signed in as ada' && probeA2.stored === 'a', 'tabs of one user context share its state')

    await browser.request('browsingContext.close', { context: tabA2.context }, s.object({}))
    await browser.request('browser.removeUserContext', { userContext: userContextB }, s.object({}))
    const after = await browser.request('browser.getUserContexts', {}, userContextsSchema)
    note('browsingContext.close the control tab; browser.removeUserContext B')
    check(!after.userContexts.some((entry) => entry.userContext === userContextB), 'B is gone once removed')
  })

  await step('7b. Print the navigation events and console messages that arrived', async (note) => {
    const browser = need(client)
    const tab = need(tabA)
    const events = need(recorder)
    await callInPage(tab, "() => { setTimeout(() => { throw new Error('uncaught error the proof threw in the page') }, 0) }", [], s.literal(null), commandMs)
    await events.waitFor('log.entryAdded', (params) => logEntry(params)?.type === 'javascript', 3000)
    const sandboxText = 'console message from the retest sandbox'
    await callInSandbox(tab, `() => { console.log(${JSON.stringify(sandboxText)}) }`, [], s.literal(null), commandMs)
    const fromSandbox = logEntry((await events.waitFor('log.entryAdded', (params) => logEntry(params)?.text === sandboxText, 3000)).params)
    for (const record of events.records) note(describeEvent(record.method, record.params, record.atMs, tab.context))
    const logs = events.records.flatMap((record) => (record.method === 'log.entryAdded' ? [logEntry(record.params)] : []))
    const { realms } = await browser.request('script.getRealms', { context: tab.context }, realmsSchema)
    note(`script.getRealms for tab A: ${realms.map((realm) => `${realm.realm} (${realm.sandbox === undefined ? 'the page' : `sandbox ${realm.sandbox}`})`).join(', ')}`)
    const named = realms.find((realm) => realm.realm === fromSandbox?.source.realm)
    const namedAs = named === undefined ? 'no realm the tab has now' : named.sandbox === undefined ? "the page's own realm" : `the sandbox ${named.sandbox}`
    note(`console.log from Retest's sandbox arrived as log.entryAdded naming ${namedAs}`)
    const scriptNavigation = events.records.find((record) => record.method === 'browsingContext.navigationStarted' && navigationEvent(record.params)?.url.endsWith('/account'))
    note(`the sign-in page's location.assign('/account') ${scriptNavigation === undefined ? 'raised no navigationStarted event' : `raised navigationStarted with navigation ${navigationEvent(scriptNavigation.params)?.navigation}`}`)
    check(logs.some((entry) => entry?.level === 'warn' && entry.method === 'warn'), "the page's console.warn arrived")
    check(logs.some((entry) => entry?.level === 'error' && entry.method === 'error'), "the page's console.error from the Save click arrived")
    check(logs.some((entry) => entry?.type === 'javascript' && entry.level === 'error'), 'the uncaught error arrived')
    check(events.records.some((record) => record.method === 'browsingContext.navigationStarted'), 'navigationStarted arrived')
    check(events.records.some((record) => record.method === 'browsingContext.domContentLoaded'), 'domContentLoaded arrived')
  })

  await step('7c. Count the events that arrive before the response of the command that caused them', async (note) => {
    const tab = need(tabA)
    const events = need(recorder)
    let errorsFirst = 0
    let logsFirst = 0
    for (let round = 1; round <= orderingRounds; round += 1) {
      const thrown = `ordering probe error ${round}`
      await callInPage(tab, `() => { setTimeout(() => { throw new Error(${JSON.stringify(thrown)}) }, 0) }`, [], s.literal(null), commandMs)
      const error = await events.waitFor('log.entryAdded', (params) => logEntry(params)?.text === `Error: ${thrown}`, 3000)
      if (error.commandsWaiting > 0) errorsFirst += 1
      const logged = `ordering probe log ${round}`
      await callInPage(tab, `() => { console.log(${JSON.stringify(logged)}) }`, [], s.literal(null), commandMs)
      const log = await events.waitFor('log.entryAdded', (params) => logEntry(params)?.text === logged, 3000)
      if (log.commandsWaiting > 0) logsFirst += 1
    }
    note(`an error the page threw from a timer the command set: ${errorsFirst} of ${orderingRounds} log.entryAdded events arrived before the script.callFunction response`)
    note(`a console.log the command made while it ran: ${logsFirst} of ${orderingRounds} arrived before the response`)
    await writeFile(join(out, 'events.json'), `${JSON.stringify(events.records, null, 2)}\n`)
    note(`every event the proof received, these included, written to ${join(out, 'events.json')}`)
  })

  await step('8a. Close Firefox with browser.close; the process group and the profile go', async (note) => {
    const browser = need(client)
    const launched = need(firefox)
    const children = childrenOf(await processTable(), launched.pid)
    note(`before closing, ${children.length} child processes name -parentPid ${launched.pid}: ${children.map((line) => `${line.pid} in group ${line.group}`).join(', ')}`)
    check(children.length > 0 && children.every((line) => line.group === launched.pid), 'every child process is in the group')
    const started = performance.now()
    const disconnected = new Promise<string>((resolveReason) => browser.onDisconnect(resolveReason))
    await browser.request('browser.close', {}, s.object({}), { timeoutMs: closeMs })
    const answered = elapsed(started)
    const reason = await within(disconnected, closeMs, 'the WebSocket did not close')
    const closed = elapsed(started)
    const gone = await launched.waitForGroupEnd(closeMs)
    const groupGone = elapsed(started)
    const problems = await launched.stop(0)
    note(`browser.close answered after ${answered} ms; the WebSocket closed after ${closed} ms (${reason})`)
    note(`process group ${launched.pid} ${gone ? `gone after ${groupGone} ms` : `still there after ${closeMs} ms`}; profile folder ${existsSync(launched.folder) ? 'still there' : 'removed'}`)
    const left = childrenOf(await processTable(), launched.pid)
    note(`after closing, ${left.length} child processes are left`)
    check(gone, `the process group went within ${closeMs} ms`)
    check(left.length === 0, 'no child process is left')
    check(problems.length === 0 && !existsSync(launched.folder), problems.join(' ') || 'the profile folder was removed')
  })

  await step('8b. Kill Firefox in the middle of a command; the client reports the loss instead of hanging', async (note) => {
    const second = await launchOne(join(out, 'firefox-killed.log'))
    let original: unknown
    try {
      const tab = await openTab(second.client, await createUserContext(second.client, commandMs), viewport, commandMs)
      const requestsBefore = app.requests()
      const hanging = navigate(tab, `${app.url}/hang`, 60_000).then(
        () => undefined,
        (error: unknown) => error,
      )
      await readUntil(async () => app.requests(), (count) => count > requestsBefore, 5000)
      note('browsingContext.navigate to /hang (a page that never finishes) is waiting; the server has its request')
      const lost = new Promise<string>((resolveReason) => second.client.onDisconnect(resolveReason))
      const killedAt = performance.now()
      second.firefox.kill()
      note(`SIGKILL sent to process group ${second.firefox.pid}`)
      const failure = await within(hanging, closeMs, 'the waiting navigate never settled')
      const settledMs = elapsed(killedAt)
      const reason = await within(lost, closeMs, 'no disconnect was reported')
      note(`the waiting navigate rejected after ${settledMs} ms: ${describeError(failure)}`)
      check(failure instanceof BidiDisconnectedError && failure.written, 'the navigate failed as a lost connection, written, so its outcome is unknown')
      note(`onDisconnect: ${reason}`)
      const later = await second.client.send('session.status', {}).then(
        () => undefined,
        (error: unknown) => error,
      )
      note(`a later session.status: ${describeError(later)}`)
      check(later instanceof BidiClosedError, 'a later command is refused at once')
      check(await second.firefox.waitForGroupEnd(closeMs), `the killed group went within ${closeMs} ms`)
    } catch (error) {
      original = error
    }
    const problems = await second.firefox.stop(0)
    const left = childrenOf(await processTable(), second.firefox.pid)
    if (left.length > 0) problems.push(`${left.length} child processes of ${second.firefox.pid} are left.`)
    if (existsSync(second.firefox.folder)) problems.push(`${second.firefox.folder} is still there.`)
    note(`afterwards: process group ${second.firefox.pid} ${second.firefox.running ? 'still there' : 'gone'}; ${left.length} child processes left; profile folder ${existsSync(second.firefox.folder) ? 'still there' : 'removed'}`)
    settle(original, problems, note)
  })

  await step('8c. A runner killed outright leaves Firefox running with its session taken; the next launch ends it', async (note) => {
    const runner = spawn(process.execPath, ['--conditions=retest-source', runnerPath, join(out, 'firefox-orphan.log')], {
      stdio: ['ignore', 'pipe', 'inherit'],
      env: { ...process.env, RETEST_FIREFOX_ROUTE: route },
    })
    const line = await within(firstLine(runner.stdout), 30_000, 'the runner never named its Firefox')
    const held = readBidi(heldSchema, JSON.parse(line), 'launch-and-hold')
    note(`a runner, process ${runner.pid}, launched Firefox ${held.pid} with a session (proofs/firefox/launch-and-hold.ts)`)
    runner.kill('SIGKILL')
    await once(runner, 'exit')
    await sleep(500)
    let original: unknown
    let next: LaunchedFirefox | undefined
    try {
      const stillRunning = signalGroup(held.pid, 0)
      const profileLeft = existsSync(held.folder)
      const asked = await sessionOutcome(held.webSocketUrl)
      note(`500 ms after SIGKILL of the runner: Firefox ${held.pid} ${stillRunning ? 'still running' : 'gone'}; its profile ${profileLeft ? 'still there' : 'gone'}; session.new on a new connection: ${asked}`)
      check(stillRunning && profileLeft, 'the orphan outlived its runner')
      next = await launchOne(join(out, 'firefox-after-orphan.log'))
      note(`the next launch's sweep ended ${JSON.stringify(next.sweep.ended)} and removed ${JSON.stringify(next.sweep.removed)}${describeProblems(next.sweep.problems)}`)
      check(next.sweep.ended.includes(held.pid) && next.sweep.removed.includes(held.folder), 'the sweep ended the orphan and removed its folder')
      check(!signalGroup(held.pid, 0) && !existsSync(held.folder), 'the orphan and its profile are gone')
    } catch (error) {
      original = error
    }
    const problems: string[] = []
    if (next !== undefined) {
      await next.client.request('browser.close', {}, s.object({}), { timeoutMs: closeMs }).catch((error: unknown) => {
        problems.push(`browser.close failed: ${describeError(error)}`)
      })
      problems.push(...(await next.firefox.stop(closeMs)))
    }
    // Only for a failure before the sweep: the orphan is this step's own.
    signalGroup(held.pid, 'SIGKILL')
    await rm(held.folder, { recursive: true, force: true })
    settle(original, problems, note)
  })
} finally {
  if (firefox !== undefined) {
    const problems = await firefox.stop(0)
    for (const problem of problems) failures.push(`cleanup: ${problem}`)
  }
  await app.close()
}

if (diagnostics.length > 0) say(`Client diagnostics: ${diagnostics.map((diagnostic) => diagnostic.kind).join(', ')}`)
if (failures.length === 0 && skipped.length === 0) say(`All steps passed in ${elapsed(startedAt)} ms.`)
if (failures.length > 0) say(`${failures.length} failed:\n  ${failures.join('\n  ')}`)
if (skipped.length > 0) say(`${skipped.length} skipped because an earlier step failed: ${skipped.map((name) => name.split(' ')[0]).join(' ')}`)
process.exitCode = failures.length === 0 && skipped.length === 0 ? 0 : 1

function launchOne(logFile: string): Promise<LaunchedFirefox> {
  const onDiagnostic = (diagnostic: BidiDiagnostic): void => {
    diagnostics.push(diagnostic)
  }
  return launchFirefox({ executablePath: firefoxPath(), logFile, headless: true, route, timeoutMs: launchMs, commandTimeoutMs: commandMs, onDiagnostic })
}

async function step(name: string, body: (note: (line: string) => void) => Promise<void>): Promise<void> {
  say(`\n${name}`)
  try {
    await body((line) => say(`  ${line}`))
    say('  passed')
  } catch (error) {
    if (error instanceof SkippedStep) {
      skipped.push(name)
      say(`  skipped: ${error.message}`)
      return
    }
    failures.push(`${name}: ${describeError(error)}`)
    say(`  failed: ${describeError(error)}`)
  }
}

function check(condition: boolean, claim: string): asserts condition {
  if (!condition) throw new Error(`Not so: ${claim}`)
}

function need<T>(value: T | undefined): T {
  if (value === undefined) throw new SkippedStep('an earlier step did not produce what this one needs')
  return value
}

// Keeps a step's own failure, and says beside it what cleaning up could not do.
function settle(original: unknown, cleanupProblems: readonly string[], note: (line: string) => void): void {
  if (cleanupProblems.length > 0) note(`cleaning up failed: ${cleanupProblems.join(' ')}`)
  if (original !== undefined) throw original
  check(cleanupProblems.length === 0, 'cleaning up left nothing behind')
}

// Asks a new connection for a session, keeping Firefox's own message: the arguments hold nothing secret.
async function sessionOutcome(webSocketUrl: string): Promise<string> {
  const other = await BidiClient.connect(`${webSocketUrl}/session`, { timeoutMs: commandMs, onDiagnostic: () => {} })
  try {
    return await other.send('session.new', { capabilities: {} }, { keepErrorMessage: true }).then(
      () => 'accepted',
      (error: unknown) => `refused: ${describeError(error)}`,
    )
  } finally {
    other.close()
  }
}

function setProbe(tab: Tab, value: string): Promise<null> {
  const set = "(value) => { document.cookie = 'retest-probe=' + value + '; path=/'; localStorage.setItem('retest-probe', value) }"
  return callInPage(tab, set, [value], s.literal(null), commandMs)
}

function readProbe(tab: Tab): Promise<{ cookie: string; stored: string | null; user: string | null }> {
  const read = "() => ({ cookie: document.cookie, stored: localStorage.getItem('retest-probe'), user: localStorage.getItem('signed-in-user') })"
  return callInSandbox(tab, read, [], probeSchema, commandMs)
}

// Cookie values are left out, except the proof's own probe: a session cookie is a credential.
function describeCookies(cookies: readonly { name: string; value: string; httpOnly: boolean }[]): string {
  if (cookies.length === 0) return 'none'
  return cookies.map((cookie) => `${cookie.name}${cookie.name === 'retest-probe' ? `=${cookie.value}` : ''}${cookie.httpOnly ? ' (HttpOnly)' : ''}`).join(', ')
}

function describeProblems(problems: readonly string[]): string {
  return problems.length === 0 ? '' : `; problems: ${problems.join(' ')}`
}

function describeEvent(method: string, params: unknown, atMs: number, mainContext: string): string {
  const at = `+${atMs} ms`
  if (method === 'log.entryAdded') {
    const entry = logEntry(params)
    if (entry === undefined) return `${at} log.entryAdded that could not be read`
    const where = entry.source.context === mainContext ? 'tab A' : (entry.source.context ?? 'no context')
    const consoleMethod = entry.method === undefined ? '' : ` console.${entry.method}`
    return `${at} log.entryAdded ${entry.type} ${entry.level}${consoleMethod} in ${where}: ${(entry.text ?? '').slice(0, 100)}`
  }
  const navigation = navigationEvent(params)
  if (navigation === undefined) return `${at} ${method} that could not be read`
  const where = navigation.context === mainContext ? 'tab A' : navigation.context
  return `${at} ${method} in ${where}: navigation ${navigation.navigation}, ${pathOf(navigation.url)}`
}

function navigationEvent(params: unknown): Infer<typeof navigationEventSchema> | undefined {
  return readEvent(navigationEventSchema, params)
}

function logEntry(params: unknown): Infer<typeof logEntrySchema> | undefined {
  return readEvent(logEntrySchema, params)
}

function isLoadOf(params: unknown, context: string, path: string): boolean {
  const navigation = navigationEvent(params)
  return navigation?.context === context && pathOf(navigation.url) === path
}

// An event of another shape is simply not the one being looked for.
function readEvent<T>(schema: Schema<T>, params: unknown): T | undefined {
  try {
    return readBidi(schema, params, 'event')
  } catch {
    return undefined
  }
}

// The path of a web address, which is all that tells the task app's pages apart; any other address in full.
function pathOf(url: string): string {
  if (!/^https?:/.test(url)) return url
  return new URL(url).pathname
}

// Firefox starts each child process with -parentPid naming the main process.
function childrenOf(table: readonly ProcessLine[], pid: number): ProcessLine[] {
  return table.filter((line) => line.command.includes(` -parentPid ${pid} `))
}

// The program's own name, such as firefox or plugin-container, from a command line.
function programName(command: string): string {
  const executable = command.split(' ')[0] ?? command
  return executable.slice(executable.lastIndexOf('/') + 1)
}

// A protocol error carries the browser's own message only when the command asked for it.
function describeError(error: unknown): string {
  if (error === undefined) return 'no error'
  if (error instanceof BidiProtocolError) return `${error.name}: ${error.message}`
  if (error instanceof BidiError) return `${error.name} from ${error.method}: ${error.message}`
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return String(error)
}

function elapsed(since: number): number {
  return Math.round(performance.now() - since)
}

async function within<T>(work: Promise<T>, timeoutMs: number, failure: string): Promise<T> {
  const timer = new AbortController()
  const expired = sleep(timeoutMs, undefined, { signal: timer.signal }).then(
    () => {
      throw new Error(`${failure} within ${timeoutMs} ms`)
    },
    () => undefined,
  )
  try {
    const settled = await Promise.race([work.then((value) => ({ value })), expired])
    if (settled === undefined) throw new Error(`${failure} within ${timeoutMs} ms`)
    return settled.value
  } finally {
    timer.abort()
  }
}

function readRoute(value: string | undefined): LaunchRoute {
  if (value === undefined) return launchRoute()
  if (value === 'spawn' || value === 'launch-services') return value
  throw new Error(`--route must be spawn or launch-services, received ${value}`)
}

function say(line: string): void {
  process.stdout.write(`${line}\n`)
}

// The first line a runner prints, which names the Firefox it launched.
async function firstLine(input: Readable): Promise<string> {
  for await (const line of createInterface({ input })) return line
  throw new Error('the runner ended without naming its Firefox')
}
