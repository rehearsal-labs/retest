import type { Transport } from '../../src/browser/cdp/transport.ts'
import type { BrowserCommand, DispatchedCommand, NewPageOptions, OwnedPage, PageNavigation, PageReading, SessionIdentity, WebRuntimeIdentity, WebSession } from '../../src/browser/contract.ts'
import type { ElectronLaunchOptions, ElectronRuntime } from '../../src/browser/electron.ts'
import type { LoadedApp, LoadedElectronTarget, LoadedTarget } from '../../src/config/loaded.ts'
import type { DiagnosticCollection } from '../../src/diagnostics/observations.ts'
import type { CommandResult } from '../../src/protocol/commands.ts'
import type { RetestEvent } from '../../src/protocol/events.ts'
import type { StorageState } from '../../src/protocol/storage-state.ts'
import type { StartedTarget } from '../../src/runner/browser-pool.ts'
import type { PagesContext } from '../../src/runner/test-pages.ts'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { describe, test } from 'node:test'
import { BrowserError } from '../../src/browser/browser-error.ts'
import { CdpConnection } from '../../src/browser/cdp/connection.ts'
import { LaunchError } from '../../src/browser/contract.ts'
import {
  AppWindows,
  ElectronWindowSession,
  ElectronLaunchError,
  electronArguments,
  electronPageRefusal,
  electronScope,
  launchElectron,
  observeChanges,
  readElectronVersion,
} from '../../src/browser/electron.ts'
import { profilePrefix } from '../../src/browser/profiles.ts'
import { configFileName, loadConfig } from '../../src/config/load.ts'
import { AttemptDiagnostics } from '../../src/diagnostics/attempt.ts'
import { chromiumScope } from '../../src/diagnostics/chromium-collector.ts'
import { defaultDiagnosticsPolicy } from '../../src/diagnostics/policy.ts'
import { Deadline } from '../../src/protocol/deadline.ts'
import { canonicalJson } from '../../src/protocol/execution.ts'
import { slug } from '../../src/protocol/run-folder.ts'
import { variantKey } from '../../src/protocol/variant.ts'
import { describeBrowser, describeVariant, variantLabel } from '../../src/reporters/targets.ts'
import { BrowserPool } from '../../src/runner/browser-pool.ts'
import { Redactor } from '../../src/runner/redactor.ts'
import { RunSession } from '../../src/runner/run-session.ts'
import { resolveSecrets } from '../../src/runner/secrets.ts'
import { attemptRefusal, targetDriver } from '../../src/runner/target-drivers.ts'
import { openPage, saveState } from '../../src/runner/test-pages.ts'
import { sha256Hex } from '../../src/shared/sha256.ts'
import { RunStore } from '../../src/store/run-store.ts'
import { FakeBrowser, fakeLauncher } from '../support/fake-browser.ts'
import { fakeExecutable, tempProject } from '../support/project.ts'
import { newRunFolder, quickTimeouts, readEvents } from '../support/run-harness.ts'
import { tempFolder } from '../support/temp-folder.ts'
import { mainFrame, protocolError, scriptedSession } from './browser-fixtures.ts'

const desktopTarget: LoadedElectronTarget = {
  name: 'electron',
  browser: 'electron',
  executablePath: '/opt/Electron.app/Contents/MacOS/Electron',
  appPath: '/work/desktop',
  args: ['--tasks=3'],
}
const desktop: LoadedApp = { name: 'desktop', targets: new Map<string, LoadedTarget>([['electron', desktopTarget]]) }
const versions = { version: '44.5.1', chromium: '152.0.7977.130' }

async function scratch(t: TestContext): Promise<string> {
  const folder = tempFolder('electron-')
  t.after(() => rm(folder, { recursive: true, force: true }))
  return folder
}

describe('the driver an Electron target needs', () => {
  test("an Electron target runs on the Chromium driver over the app's own pipe, and no attempt is refused for it", () => {
    assert.deepEqual(targetDriver('desktop', desktopTarget), { ok: true, driver: 'electron', target: desktopTarget })
    const web: LoadedApp = { name: 'web', targets: new Map<string, LoadedTarget>([['chromium', { name: 'chromium', browser: 'chromium', headless: true }]]) }
    assert.equal(attemptRefusal({ desktop: 'electron', web: 'chromium' }, new Map([['desktop', desktop], ['web', web]])), undefined)
  })
})

describe('launching an Electron binary', () => {
  test("starts with Retest's pipe and the app's data folder, then the app's path and its own arguments", () => {
    const options = { appPath: '/work/desktop', args: ['--tasks=3', '--theme', 'dark'], userDataDir: '/run/electron/1/user-data' }
    assert.deepEqual(electronArguments(options, 'darwin'), [
      '--remote-debugging-pipe',
      '--user-data-dir=/run/electron/1/user-data',
      '--use-mock-keychain',
      '/work/desktop',
      '--tasks=3',
      '--theme',
      'dark',
    ])
    assert.deepEqual(electronArguments(options, 'linux'), ['--remote-debugging-pipe', '--user-data-dir=/run/electron/1/user-data', '/work/desktop', '--tasks=3', '--theme', 'dark'])
  })

  // A shell script stands in for Electron: it gets the same group, pipes and environment, writes down what it was given,
  // leaves a file in its data folder and ends without answering, as a binary that is not a browser would.
  async function standIn(folder: string): Promise<{ binary: string; record: string; app: string }> {
    const record = join(folder, 'record.txt')
    const binary = join(folder, 'Electron')
    const script = [
      '#!/bin/sh',
      // The launcher records ownership before sending CDP. An instant exit could finish before that reading.
      'dd bs=1 count=1 <&3 >/dev/null 2>&1',
      `{ printf 'arg %s\\n' "$@"; echo "hidden \${RETEST_UNIT_JUDGE_KEY-absent}"; echo "run-as-node \${ELECTRON_RUN_AS_NODE-absent}"; echo "logging \${ELECTRON_ENABLE_LOGGING-absent} \${ELECTRON_LOG_FILE-absent}"; echo "kept \${RETEST_UNIT_VISIBLE-absent}"; } > '${record}'`,
      // What an app's main process prints of what it was given, on both of its outputs.
      'echo "typed: the-typed-secret-41"',
      'echo "also typed: the-typed-secret-41" >&2',
      'for argument in "$@"; do case "$argument" in --user-data-dir=*) folder="${argument#--user-data-dir=}"; mkdir -p "$folder"; echo app-data > "$folder/Local State";; esac; done',
      '',
    ].join('\n')
    await writeFile(binary, script)
    await chmod(binary, 0o755)
    const app = join(folder, 'desktop')
    await mkdir(app)
    await writeFile(join(app, 'package.json'), '{ "main": "main.js" }\n')
    return { binary, record, app }
  }

  function launchOptions(folder: string, binary: string, app: string, named: { userDataDir?: string } = {}): ElectronLaunchOptions {
    return {
      executablePath: binary,
      appPath: app,
      args: ['--tasks=3'],
      ...named,
      windowsFile: join(folder, 'run', 'electron', '1', 'windows.json'),
      logFile: join(folder, 'run', 'logs', 'electron.log'),
      hiddenVariables: ['RETEST_UNIT_JUDGE_KEY'],
      app: 'desktop',
      target: 'electron',
      launch: 1,
    }
  }

  async function failedLaunch(options: ElectronLaunchOptions): Promise<void> {
    await assert.rejects(launchElectron(options, 5000), (error: unknown) => {
      assert.ok(error instanceof LaunchError)
      assert.equal(error.failure.class, 'setup_failed')
      assert.match(error.message, new RegExp(`^${options.executablePath.replaceAll('/', '\\/')} (exited with exit code 0|closed its debugging pipe) before the app opened a window\\. Its output is in `))
      return true
    })
  }

  test('gives the process those arguments, withholds the hidden variables and ELECTRON_RUN_AS_NODE, and removes the data folder it made', async (t) => {
    const folder = await scratch(t)
    const { binary, record, app } = await standIn(folder)
    const names = ['RETEST_UNIT_JUDGE_KEY', 'ELECTRON_RUN_AS_NODE', 'ELECTRON_ENABLE_LOGGING', 'ELECTRON_LOG_FILE', 'RETEST_UNIT_VISIBLE'] as const
    const saved = names.map((name) => [name, process.env[name]] as const)
    Object.assign(process.env, { RETEST_UNIT_JUDGE_KEY: 'judge-key-value', ELECTRON_RUN_AS_NODE: '1', ELECTRON_ENABLE_LOGGING: '1', ELECTRON_LOG_FILE: '/tmp/electron.log', RETEST_UNIT_VISIBLE: 'yes' })
    t.after(() => {
      for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    })
    const options = launchOptions(folder, binary, app)
    await failedLaunch(options)
    const lines = readFileSync(record, 'utf8').trim().split('\n')
    const args = lines.filter((line) => line.startsWith('arg ')).map((line) => line.slice(4))
    const dataFolder = args.find((argument) => argument.startsWith('--user-data-dir='))?.slice('--user-data-dir='.length) ?? ''
    assert.ok(basename(dataFolder).startsWith(profilePrefix(process.pid)), `Retest made the data folder as a browser profile is made: ${dataFolder}`)
    assert.deepEqual(args, electronArguments({ ...options, userDataDir: dataFolder }))
    assert.deepEqual(lines.filter((line) => !line.startsWith('arg ')), ['hidden absent', 'run-as-node absent', 'logging absent absent', 'kept yes'])
    assert.equal(existsSync(dataFolder), false, 'the folder Retest made, with what the app wrote in it, is gone with the app')
    assert.equal(existsSync(options.windowsFile), false, 'an app that never ran opened no window to record')
  })

  test('leaves a data folder the config named as the app left it', async (t) => {
    const folder = await scratch(t)
    const { binary, record, app } = await standIn(folder)
    const named = join(folder, 'kept', 'desktop-data')
    await mkdir(named, { recursive: true })
    await writeFile(join(named, 'mine.txt'), 'the tester put this here\n')
    await failedLaunch(launchOptions(folder, binary, app, { userDataDir: named }))
    assert.ok(readFileSync(record, 'utf8').includes(`arg --user-data-dir=${named}\n`), 'the app was given the folder the config named')
    assert.equal(readFileSync(join(named, 'mine.txt'), 'utf8'), 'the tester put this here\n')
    assert.equal(readFileSync(join(named, 'Local State'), 'utf8'), 'app-data\n', 'what the app wrote stays')
  })

  test("redacts every line of the app's output before it reaches the log, and writes the output raw only without a redactor", async (t) => {
    const folder = await scratch(t)
    const { binary, app } = await standIn(folder)
    const redact = (text: string) => text.replaceAll('the-typed-secret-41', '{{password}}')
    const redacted = { ...launchOptions(folder, binary, app), logFile: join(folder, 'redacted.log'), redact }
    await failedLaunch(redacted)
    const log = readFileSync(redacted.logFile, 'utf8')
    assert.match(log, /^typed: \{\{password\}\}$/m)
    assert.match(log, /^also typed: \{\{password\}\}$/m)
    assert.equal(log.includes('the-typed-secret-41'), false, 'the value is in no line of the log')
    const raw = { ...launchOptions(folder, binary, app), logFile: join(folder, 'raw.log') }
    await failedLaunch(raw)
    assert.match(readFileSync(raw.logFile, 'utf8'), /typed: the-typed-secret-41/, 'without a redactor the output is written as it came')
  })

  test('a binary or app that is not there, or cannot run, is refused before anything starts', async (t) => {
    const folder = await scratch(t)
    const app = join(folder, 'desktop')
    await mkdir(app)
    await writeFile(join(app, 'package.json'), '{}\n')
    const bundle = join(folder, 'Electron.app')
    await mkdir(join(bundle, 'Contents', 'MacOS'), { recursive: true })
    const notExecutable = join(folder, 'plain')
    await writeFile(notExecutable, '')
    const empty = join(folder, 'empty')
    await mkdir(empty)
    const executable = join(folder, 'Electron')
    await writeFile(executable, '#!/bin/sh\nexit 0\n')
    await chmod(executable, 0o755)
    const options = (executablePath: string, appPath: string): ElectronLaunchOptions => ({
      executablePath,
      appPath,
      args: [],
      userDataDir: join(folder, 'user-data'),
      windowsFile: join(folder, 'windows.json'),
      logFile: join(folder, 'electron.log'),
      app: 'desktop',
      target: 'electron',
      launch: 1,
    })
    const refusals: [ElectronLaunchOptions, RegExp][] = [
      [options(join(folder, 'missing'), app), /^No Electron binary at .*\/missing\. Give the Electron binary, inside Electron\.app on macOS: Electron\.app\/Contents\/MacOS\/Electron\.$/],
      [options(bundle, app), /Electron\.app is a folder\. Give the executable inside it: .*Electron\.app\/Contents\/MacOS\/Electron for Electron's own build\.$/],
      [options(notExecutable, app), /plain is not executable\. Allow it to run, or give another Electron binary\.$/],
      [options(executable, join(folder, 'nowhere')), /^No Electron app at .*\/nowhere: give the app's folder, which holds its package\.json, or its entry file\.$/],
      [options(executable, empty), /empty holds no package\.json or index\.js, so Electron would not find an app in it\.$/],
    ]
    for (const [given, message] of refusals) {
      await assert.rejects(launchElectron(given, 5000), (error: unknown) => error instanceof LaunchError && message.test(error.message))
    }
    assert.equal(existsSync(join(folder, 'user-data')), false, 'nothing was started or made for a refused launch')
    assert.equal(existsSync(join(folder, 'electron.log')), false)
  })

  test("reads the release from the framework's bundle, the version file, or the user agent, and refuses a binary none of them names", async (t) => {
    const folder = await scratch(t)
    const bundleBinary = join(folder, 'Tasks.app', 'Contents', 'MacOS', 'Tasks')
    const resources = join(folder, 'Tasks.app', 'Contents', 'Frameworks', 'Electron Framework.framework', 'Resources')
    await mkdir(resources, { recursive: true })
    await writeFile(join(resources, 'Info.plist'), '<plist><dict><key>CFBundleName</key><string>Electron Framework</string><key>CFBundleVersion</key>\n\t<string>44.5.1</string></dict></plist>\n')
    const linuxBinary = join(folder, 'dist', 'electron')
    await mkdir(join(folder, 'dist'))
    await writeFile(join(folder, 'dist', 'version'), '43.0.2\n')
    const chrome = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.7977.130 Safari/537.36'
    const packaged = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) tasks/1.4.0 Chrome/150.0.0.0 Electron/42.1.0 Safari/537.36'
    assert.equal(await readElectronVersion(bundleBinary, chrome), '44.5.1')
    assert.equal(await readElectronVersion(linuxBinary, chrome), '43.0.2')
    assert.equal(await readElectronVersion(join(folder, 'packaged', 'tasks'), packaged), '42.1.0')
    assert.equal(await readElectronVersion(join(folder, 'chrome', 'Google Chrome'), chrome), undefined)
  })
})

/** A window that answers every command it gets with `answer`, and keeps each command. */
class FakeWindow implements WebSession {
  url: string | undefined = 'file:///work/desktop/index.html'
  readonly commands: BrowserCommand[] = []
  stops = 0
  answer: DispatchedCommand = { result: { ok: true, kind: 'click', page: { url: 'file:///work/desktop/index.html' } }, input: 'sent' }
  disposed = 0

  async dispatch(command: BrowserCommand): Promise<DispatchedCommand> {
    this.commands.push(command)
    return this.answer
  }

  async execute(command: BrowserCommand): Promise<CommandResult> {
    return (await this.dispatch(command)).result
  }

  async screenshot(): Promise<Uint8Array> {
    return new Uint8Array([0x89])
  }

  async readPage(): Promise<PageReading> {
    return { url: this.url, navigating: false, found: [] }
  }

  onNavigation(_listener: (navigation: PageNavigation) => void): () => void {
    return () => undefined
  }

  async captureState(): Promise<StorageState> {
    return { cookies: [], origins: [] }
  }

  async dispose(): Promise<void> {
    this.disposed += 1
  }

  async collectDiagnostics(): Promise<DiagnosticCollection> {
    return { scope: chromiumScope, stop: () => void (this.stops += 1) }
  }
}

type Showing = { shows: boolean | 'unreadable' }

function electronPage(options: { firstClosed?: boolean; showing?: Showing } = {}): { page: ElectronWindowSession; window: FakeWindow; quits: number[] } {
  const window = new FakeWindow()
  const quits: number[] = []
  const showing = options.showing ?? { shows: true }
  const page = new ElectronWindowSession({
    window,
    app: 'desktop',
    target: 'electron',
    showsPage: async () => {
      if (showing.shows === 'unreadable') throw new Error('the window did not answer')
      return showing.shows
    },
    firstClosed: () => options.firstClosed === true,
    quit: async (timeoutMs) => {
      quits.push(timeoutMs)
    },
  })
  return { page, window, quits }
}

describe('the page of an Electron app', () => {
  test('goto is refused by name, naming the app and target, and nothing reaches the window', async () => {
    const { page, window } = electronPage()
    const answer = await page.dispatch({ kind: 'goto', url: 'https://example.test/' }, 1000)
    assert.deepEqual(answer, {
      input: 'not_sent',
      result: {
        ok: false,
        failure: {
          class: 'unsupported',
          message: "goto() is not available on the Electron app desktop (target electron): the app has no address, and the test's page is the first window the app opened.",
          details: { app: 'desktop', target: 'electron', command: 'goto' },
        },
      },
    })
    assert.deepEqual(await page.execute({ kind: 'goto', url: '/' }, 1000), answer.result)
    assert.deepEqual(window.commands, [])
  })

  test('reload, goBack, goForward and every action go to the window as they go to a browser page', async () => {
    const { page, window } = electronPage()
    const commands: BrowserCommand[] = [
      { kind: 'reload' },
      { kind: 'goBack' },
      { kind: 'goForward' },
      { kind: 'click', locator: { by: 'testId', value: 'add-task' } },
      { kind: 'fill', locator: { by: 'label', text: 'Title' }, value: 'Release checklist' },
    ]
    for (const command of commands) assert.deepEqual(await page.dispatch(command, 1000), window.answer)
    assert.deepEqual(window.commands, commands)
    assert.equal(page.url, window.url)
  })

  test('a sign-in state is not saved from the app, and closing the page quits the app instead of closing the window', async () => {
    const { page, window, quits } = electronPage()
    await assert.rejects(page.captureState(1000), (error: unknown) => {
      assert.ok(error instanceof BrowserError)
      assert.deepEqual(error.failure, {
        class: 'unsupported',
        message: "Retest cannot save a sign-in state from the Electron app desktop: the app keeps its own storage. Set userDataDir to keep the app's data from one launch to the next.",
        details: { app: 'desktop', target: 'electron' },
      })
      return true
    })
    await page.dispose(4000)
    assert.deepEqual(quits, [4000])
    assert.equal(window.disposed, 0)
  })

  test('a window lost after the app closed it says no other window is reachable; any other failure is left as it is', async () => {
    const lost = { class: 'session_lost' as const, message: 'Could not click getByTestId(\'add-task\'): the page is gone.' }
    const closed = electronPage({ firstClosed: true })
    closed.window.answer = { result: { ok: false, failure: lost }, input: 'not_sent' }
    assert.deepEqual((await closed.page.dispatch({ kind: 'click', locator: { by: 'testId', value: 'add-task' } }, 1000)).result, {
      ok: false,
      failure: { ...lost, message: `${lost.message} The Electron app closed its first window, and a test reaches no other window of it.` },
    })
    const open = electronPage()
    open.window.answer = { result: { ok: false, failure: lost }, input: 'not_sent' }
    assert.deepEqual((await open.page.dispatch({ kind: 'click', locator: { by: 'testId', value: 'add-task' } }, 1000)).result, { ok: false, failure: lost })
    const missing = { class: 'not_found' as const, message: 'No element matched.' }
    closed.window.answer = { result: { ok: false, failure: missing }, input: 'not_sent' }
    assert.deepEqual((await closed.page.dispatch({ kind: 'click', locator: { by: 'testId', value: 'add-task' } }, 1000)).result, { ok: false, failure: missing })
  })

  test("a window already showing its page when capture begins makes the session's capture partial, saying why", async () => {
    const reason = "the app's window was already showing its page when capture began, so what the page logged or loaded before then was not captured"
    const showing: Showing = { shows: true }
    const { page, window } = electronPage({ showing })
    const sink = { observe: () => undefined, unreadable: () => undefined, lost: () => undefined }
    const collection = await page.collectDiagnostics(sink, 1000)
    assert.equal(collection.startedLate, reason)
    assert.deepEqual(collection.scope, electronScope)
    for (const kind of [collection.scope.console, collection.scope.network]) assert.deepEqual(kind.notCovered.slice(-2), ['main_process', 'other_windows'])
    assert.match(collection.scope.reason ?? '', /main process runs outside its windows, and Retest reaches only the first window/)
    collection.stop()
    assert.equal(window.stops, 1, 'stopping goes to the window\'s own collector')
    showing.shows = 'unreadable'
    assert.match((await page.collectDiagnostics(sink, 1000)).startedLate ?? '', /^Retest could not read whether the app's window was already showing its page/, 'a window that cannot say is not taken as blank')
    showing.shows = false
    assert.equal((await page.collectDiagnostics(sink, 1000)).startedLate, undefined, 'a window still blank has done nothing to miss')
    showing.shows = true

    const events: string[] = []
    const diagnostics = new AttemptDiagnostics({
      policy: defaultDiagnosticsPolicy,
      redactor: new Redactor(),
      writeArtifact: () => undefined,
      emit: (body) => void events.push(body.type),
      testId: 'tests/desktop.retest.ts > adds a task',
      attemptId: 'k3v9q0x2mb',
      variant: { desktop: 'electron' },
      named: true,
    })
    const session: SessionIdentity = { sessionId: 'k3v9q0x2mb:desktop', owner: { runId: 'run', testId: 'tests/desktop.retest.ts > adds a task', attemptId: 'k3v9q0x2mb', app: 'desktop' }, runtime: new FakeElectron(launchOptionsOf('desktop'), 7001).identity }
    await diagnostics.start([{ app: 'desktop', page, session }], 1000)
    const [summary] = diagnostics.finish('attempt_ended').summaries
    assert.equal(summary?.console.state, 'partial')
    assert.equal(summary?.network.state, 'partial')
    assert.deepEqual([summary?.console, summary?.network].map((capture) => (capture?.state === 'partial' ? capture.reason : undefined)), [reason, reason])
    assert.deepEqual(events, ['diagnostics.started', 'diagnostics.finished'])
  })

  test('the page takes no base URL, emulated screen, proxy or saved state, each refused by name', () => {
    assert.equal(electronPageRefusal({}), undefined)
    assert.match(electronPageRefusal({ baseUrl: 'http://127.0.0.1:4173' }) ?? '', /^has no address, so it takes no base URL/)
    assert.match(electronPageRefusal({ emulation: { viewport: { width: 400, height: 800 }, deviceScaleFactor: 2, touch: true, isMobile: true } }) ?? '', /emulates no screen/)
    assert.match(electronPageRefusal({ proxy: { server: 'http://127.0.0.1:8080', bypass: [] } }) ?? '', /gives it no proxy/)
    assert.match(electronPageRefusal({ storageState: { cookies: [], origins: [] } }) ?? '', /cannot restore a saved sign-in state into it\. Set userDataDir/)
  })
})

/** An Electron app as the pool holds it, which records how it was launched and can be lost. Its page is the fake task app. */
class FakeElectron implements ElectronRuntime {
  readonly product = 'Electron'
  readonly version = versions.version
  readonly userAgent = `Mozilla/5.0 tasks/1.0.0 Chrome/${versions.chromium} Electron/${versions.version} Safari/537.36`
  readonly electron = versions
  readonly options: ElectronLaunchOptions
  readonly pid: number
  readonly executablePath: string
  connected = true
  closeRequested = false
  readonly #listeners = new Set<(reason: string) => void>()
  readonly #window: FakeBrowser
  readonly #gone = Promise.withResolvers<void>()
  readonly gone: Promise<void> = this.#gone.promise

  constructor(options: ElectronLaunchOptions, pid: number) {
    this.options = options
    this.pid = pid
    this.executablePath = options.executablePath
    this.#window = new FakeBrowser({}, { executablePath: options.executablePath, logFile: options.logFile, headless: false }, pid)
  }

  get identity(): WebRuntimeIdentity {
    return { kind: 'web', engine: 'chromium', product: this.product, version: this.version, executablePath: this.executablePath, processIds: [this.pid] }
  }

  newPage(options: NewPageOptions, timeoutMs: number): Promise<OwnedPage> {
    return this.#window.newPage(options, timeoutMs)
  }

  onDisconnect(listener: (reason: string) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  async close(): Promise<void> {
    this.closeRequested = true
    this.lose('Retest quit the Electron app')
    this.exit()
  }

  /** The pipe closes: the app is no longer reachable, though its processes may still be exiting. */
  lose(reason: string): void {
    if (!this.connected) return
    this.connected = false
    for (const listener of this.#listeners) listener(reason)
  }

  /** The last of the app's processes has gone. */
  exit(): void {
    this.#gone.resolve()
  }
}

function launchOptionsOf(app: string): ElectronLaunchOptions {
  return { executablePath: desktopTarget.executablePath, appPath: desktopTarget.appPath, args: [], windowsFile: '/run/windows.json', logFile: '/run/electron.log', app, target: 'electron', launch: 1 }
}

type PoolSetup = { fails?: (launch: number) => string | undefined; launchError?: (launch: number) => Error | undefined; setupMs?: number; target?: LoadedElectronTarget }

function electronPool(setup: PoolSetup = {}) {
  const apps: FakeElectron[] = []
  const announced: StartedTarget[] = []
  const lost: [FakeElectron | undefined, string][] = []
  const browsers = fakeLauncher()
  const executables: string[] = []
  const target = setup.target ?? desktopTarget
  const app: LoadedApp = { name: 'desktop', targets: new Map<string, LoadedTarget>([[target.name, target]]) }
  const pool = new BrowserPool({
    launch: browsers.launch,
    findExecutable: async (found) => {
      executables.push(found.name)
      return { ok: true, path: '/fake/chromium' }
    },
    logFile: (appName, targetName) => `/run/logs/browser-${appName}-${targetName}.log`,
    headless: true,
    named: true,
    timeouts: { ...quickTimeouts, setup: setup.setupMs ?? quickTimeouts.setup },
    stopped: new Promise(() => {}),
    interruption: () => undefined,
    onStarted: (started) => void announced.push(started),
    onLost: (browser, reason) => void lost.push([apps.find((entry) => entry === browser), reason]),
    hiddenVariables: ['RETEST_JUDGE_KEY'],
    launchElectron: async (options) => {
      const launchError = setup.launchError?.(options.launch)
      if (launchError !== undefined) throw launchError
      const problem = setup.fails?.(options.launch)
      if (problem !== undefined) throw new LaunchError(problem)
      const started = new FakeElectron(options, 7000 + options.launch)
      apps.push(started)
      return started
    },
  })
  return { pool, app, target, apps, announced, lost, browsers: browsers.browsers, executables }
}

describe('the pool and an Electron target', () => {
  test('a rejected cleanup proof keeps the folder held and is reported when the pool closes', async () => {
    const gone = Promise.withResolvers<void>()
    const shared: LoadedElectronTarget = { ...desktopTarget, userDataDir: '/home/tester/.tasks-data' }
    const { pool, app, target } = electronPool({ target: shared, launchError: () => new ElectronLaunchError('The app opened no window.', gone.promise, []) })
    const opened = await pool.ensure(app, target)
    assert.ok(!opened.ok)
    let free = false
    void pool.folderSettled(shared.userDataDir ?? '').then(() => { free = true })
    gone.reject(new Error('Reading the owned process after cleanup failed.'))
    await assert.rejects(pool.close(), /Reading the owned process after cleanup failed/)
    assert.equal(free, false)
  })

  test('a rejected later launch holds its data folder until its owned processes are actually gone', async () => {
    const gone = Promise.withResolvers<void>()
    const shared: LoadedElectronTarget = { ...desktopTarget, userDataDir: '/home/tester/.tasks-data' }
    const { pool, app, target, apps } = electronPool({ target: shared, setupMs: 1000, launchError: (launch) => launch === 2 ? new ElectronLaunchError('The app opened no window. Cleaning up also failed.', gone.promise, ['The app is still running.']) : undefined })
    const first = await pool.ensure(app, target)
    assert.ok(first.ok)
    await first.value.browser.close(100)
    const failed = await pool.ensure(app, target)
    assert.ok(!failed.ok)
    assert.equal(failed.failure.class, 'cleanup_failed')
    const waiting = pool.ensure(app, target)
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(apps.length, 1)
    let free = false
    void pool.folderSettled(shared.userDataDir ?? '').then(() => { free = true })
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(free, false)
    gone.resolve()
    assert.ok((await waiting).ok)
    assert.deepEqual(apps.map(({ options }) => options.launch), [1, 3])
    await pool.close()
  })
  test('the first launch is the setup, every later test gets a launch of its own, and each launch is told', async () => {
    const { pool, app, target, apps, announced, browsers, executables } = electronPool()
    pool.warm(app, target)
    const first = await pool.ensure(app, target)
    assert.ok(first.ok)
    assert.equal(apps.length, 1, 'the first test gets the app the setup launched')
    const second = await pool.ensure(app, target, 3)
    assert.ok(second.ok)
    assert.equal(apps.length, 2)
    assert.notEqual(first.value.browser, second.value.browser)
    assert.deepEqual(second.value.runtime, { kind: 'web', engine: 'chromium', product: 'Electron', version: '44.5.1', executablePath: target.executablePath, processIds: [7002] })

    const folder = `/run/electron/${slug(variantKey({ desktop: 'electron' }))}`
    assert.deepEqual(
      apps.map(({ options }) => options),
      [1, 2].map((launch) => ({
        executablePath: target.executablePath,
        appPath: target.appPath,
        args: ['--tasks=3'],
        windowsFile: `${folder}/${launch}/windows.json`,
        logFile: '/run/logs/browser-desktop-electron.log',
        app: 'desktop',
        target: 'electron',
        launch,
        hiddenVariables: ['RETEST_JUDGE_KEY'],
      })),
    )
    const info = { product: 'Electron', version: '44.5.1', executablePath: target.executablePath, app: 'desktop', target: { name: 'electron', electron: versions } }
    assert.deepEqual(announced, [
      { info, userAgent: apps[0]?.userAgent, pid: 7001 },
      { info, userAgent: apps[1]?.userAgent, pid: 7002, instance: 2 },
    ])
    assert.deepEqual(pool.started, [announced[0]], 'the result lists the target once')
    assert.deepEqual([browsers.length, executables.length], [0, 0], 'no browser stands in, and no browser executable is looked for')
    assert.equal(pool.connected(first.value.browser), true)
  })

  test('a first launch that fails refuses every test of the target, and is not tried again', async () => {
    const { pool, app, target, apps } = electronPool({ fails: () => 'No Electron binary at /opt/Electron.app/Contents/MacOS/Electron.' })
    pool.warm(app, target)
    for (const attempt of [1, 2]) {
      const ensured = await pool.ensure(app, target)
      assert.ok(!ensured.ok, `attempt ${attempt}`)
      assert.deepEqual(ensured.failure, { class: 'setup_failed', message: 'No Electron binary at /opt/Electron.app/Contents/MacOS/Electron.' })
    }
    assert.equal(apps.length, 0)
  })

  test('a later launch that fails fails only its own test, and the next test launches again', async () => {
    const { pool, app, target, apps } = electronPool({ fails: (launch) => (launch === 2 ? 'The Electron app opened no window within 2000 ms.' : undefined) })
    assert.ok((await pool.ensure(app, target)).ok)
    const failed = await pool.ensure(app, target)
    assert.ok(!failed.ok)
    assert.equal(failed.failure.message, 'The Electron app opened no window within 2000 ms.')
    assert.ok((await pool.ensure(app, target)).ok)
    assert.deepEqual(apps.map(({ options }) => options.launch), [1, 3])
  })

  test("an app lost during a test is that test's loss alone, an app Retest quit is no loss, and the next test gets a new app", async () => {
    const { pool, app, target, apps, lost } = electronPool()
    const first = await pool.ensure(app, target)
    assert.ok(first.ok)
    apps[0]?.lose('the Electron app ended with signal SIGSEGV')
    assert.deepEqual(lost, [[apps[0], 'the Electron app ended with signal SIGSEGV']])
    assert.equal(pool.connected(first.value.browser), false)
    const second = await pool.ensure(app, target)
    assert.ok(second.ok)
    await second.value.browser.close(1000)
    assert.equal(lost.length, 1, 'quitting the app at the end of its test is not a loss')
    assert.ok((await pool.ensure(app, target)).ok)
    assert.equal(apps.length, 3)
  })

  test('closing the pool quits every app, a spare one included, and launches nothing afterwards', async () => {
    const { pool, app, target, apps } = electronPool()
    assert.ok((await pool.ensure(app, target)).ok)
    assert.ok((await pool.ensure(app, target)).ok)
    await pool.close()
    assert.deepEqual(apps.map((started) => started.closeRequested), [true, true])
    const after = await pool.ensure(app, target)
    assert.ok(!after.ok)
    assert.equal(apps.length, 2)
  })

  test('launches on a data folder the config named take turns: the next waits for the app before it to go', async () => {
    const shared: LoadedElectronTarget = { ...desktopTarget, userDataDir: '/home/tester/.tasks-data' }
    const { pool, app, target, apps } = electronPool({ target: shared, setupMs: 300 })
    const first = await pool.ensure(app, target)
    assert.ok(first.ok)
    const waiting = pool.ensure(app, target)
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(apps.length, 1, 'the second launch waits while the first app runs on the folder')
    apps[0]?.lose('Retest quit the Electron app')
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(apps.length, 1, 'and while the first app is still exiting, though its pipe has closed')
    apps[0]?.exit()
    const second = await waiting
    assert.ok(second.ok)
    assert.deepEqual(apps.map(({ options }) => options.userDataDir), ['/home/tester/.tasks-data', '/home/tester/.tasks-data'])

    const refused = await pool.ensure(app, target)
    assert.ok(!refused.ok, 'a folder still held when the setup budget runs out is refused by name')
    assert.match(refused.failure.message, /^Another test's launch of the Electron app desktop still held its data folder \/home\/tester\/\.tasks-data after 300 ms\. The folder holds one running app at a time/)
    assert.equal(apps.length, 2)
  })
})

describe('how reports name an Electron target', () => {
  const electronInfo = { product: 'Electron', version: '44.5.1', executablePath: desktopTarget.executablePath, app: 'desktop', target: { name: 'electron', electron: versions } }
  const browsers = new Map([['desktop=electron', electronInfo]])

  test('the browser line gives the Electron release and the Chromium it embeds', () => {
    assert.equal(describeBrowser(electronInfo), 'Electron 44.5.1 · Chromium 152.0.7977.130')
  })

  test('a test line and a failure card always name an Electron target, though its app has one target', () => {
    assert.equal(variantLabel({ desktop: 'electron' }, { browsers, apps: new Map([['desktop', new Set(['electron'])]]) }), 'desktop=electron (Electron)')
    assert.equal(describeVariant({ desktop: 'electron', web: 'chromium' }, { browsers }), 'desktop=electron (Electron), web=chromium')
  })
})

describe('the execution record of an attempt on an Electron app', () => {
  const tests = `import { expect, test } from '@rehearsal-labs/retest'

test('reads the app', async ({ page }) => {
  await expect(page.getByTestId('saved-task')).toHaveText('')
})
`

  // A whole run on the fake task app, as the replay tests run one, with every Electron launch a fake.
  async function recordedRun(target: string): Promise<RetestEvent[]> {
    const root = tempProject({
      'retest.config.ts': `import { defineConfig, electron } from '@rehearsal-labs/retest'\nexport default defineConfig({ apps: { desktop: electron(${target}) } })\n`,
      'tests/desktop.retest.ts': tests,
    })
    const loaded = await loadConfig(join(root, configFileName))
    assert.ok(loaded.ok, loaded.ok ? '' : loaded.failure.message)
    const secrets = resolveSecrets(loaded.config, {})
    assert.ok(secrets.ok)
    const folder = newRunFolder()
    const store = RunStore.create(folder)
    const options = { files: ['tests/desktop.retest.ts'], rootDir: root, apps: { kind: 'config' as const, config: loaded.config, secrets: secrets.secrets }, timeouts: quickTimeouts, outputDir: folder, headless: true, workers: 1, signal: new AbortController().signal }
    const launchApp = async (launched: ElectronLaunchOptions) => new FakeElectron(launched, 7000 + launched.launch)
    try {
      const result = await new RunSession({ options, reporters: [], launch: fakeLauncher().launch, findExecutable: fakeExecutable, store, launchElectron: launchApp }).run()
      assert.equal(result.exitCode, 0, JSON.stringify(result.files))
    } finally {
      store.close()
    }
    return readEvents(folder).events
  }

  function executionOf(events: readonly RetestEvent[]) {
    const started = events.find((event) => event.type === 'test.started')
    assert.ok(started?.type === 'test.started' && started.execution !== undefined, 'the attempt recorded what it ran')
    return started.execution
  }

  test('says the app started from the data folder its target names, never fresh, and records its arguments', async () => {
    const execution = executionOf(await recordedRun(`{ executablePath: '/opt/Electron', appPath: 'desktop', args: ['--tasks=3'], userDataDir: '.data/desktop' }`))
    assert.deepEqual(execution.startingState, [{ app: 'desktop', browserStorage: 'reused', backendData: 'unavailable' }])
    assert.deepEqual(execution.configuration.settings.apps, { desktop: { target: 'electron', kind: 'web', browser: 'electron', args: { count: 1, sha256: sha256Hex(canonicalJson(['--tasks=3'])) } } })
    assert.equal(JSON.stringify(execution).includes('--tasks=3'), false, 'no argument is written as it was given')
    assert.deepEqual(execution.sessions.map(({ engine, product, version }) => ({ engine, product, version })), [{ engine: 'chromium', product: 'Electron', version: '44.5.1' }])
  })

  test('says a launch in a folder of its own started fresh', async () => {
    const execution = executionOf(await recordedRun(`{ executablePath: '/opt/Electron', appPath: 'desktop' }`))
    assert.deepEqual(execution.startingState, [{ app: 'desktop', browserStorage: 'fresh', backendData: 'unavailable' }])
    assert.deepEqual(execution.configuration.settings.apps, { desktop: { target: 'electron', kind: 'web', browser: 'electron' } })
  })
})

describe('what the driver records of an Electron app', () => {
  // A transport that delivers what a test hands it, as the browser's messages.
  function fedConnection(): { connection: CdpConnection; feed: (message: object) => void } {
    let deliver: ((text: string) => void) | undefined
    const transport: Transport = {
      listen: (handlers) => {
        deliver = handlers.message
      },
      send: () => ({ written: true, withdraw: () => {} }),
      close: () => {},
    }
    const connection = new CdpConnection(transport, { timeoutMs: 1000, onDiagnostic: () => {} })
    return { connection, feed: (message) => deliver?.(JSON.stringify(message)) }
  }

  const created = (targetId: string, type = 'page') => ({ method: 'Target.targetCreated', params: { targetInfo: { targetId, type, browserContextId: 'C1' } } })

  test('windows are numbered as Retest learned of them, and those open before it watched are marked so', () => {
    const { connection, feed } = fedConnection()
    const windows = new AppWindows(connection, performance.now(), () => {})
    windows.alreadyOpen(['T2', 'T1'])
    feed(created('T2'))
    feed(created('W1', 'service_worker'))
    feed(created('T1'))
    feed(created('T3'))
    assert.deepEqual(
      windows.records.map(({ window, reachable, existing }) => ({ window, reachable, existing })),
      [
        { window: 1, reachable: true, existing: true },
        { window: 2, reachable: false, existing: true },
        { window: 3, reachable: false, existing: undefined },
      ],
    )
  })

  test('a change observer the window refuses is noted, never passed over in silence', async () => {
    const scripted = scriptedSession(async (method) => {
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: mainFrame, url: 'file:///work/desktop/index.html' } } }
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 7 }
      throw protocolError(method, 'Cannot find context with specified id')
    })
    const notes: string[] = []
    await observeChanges(scripted.session, new Deadline(1000), (note) => notes.push(note))
    assert.deepEqual(notes, [
      "Retest could not start its change observer in the first window's document (Runtime.evaluate failed: Cannot find context with specified id (-32000)), so checks there wait out their timers until the window opens another document",
    ])
  })
})

describe('what an Electron app does not do is refused as unsupported', () => {
  class RefusingElectron extends FakeElectron {
    override newPage(): Promise<OwnedPage> {
      return Promise.reject(new BrowserError({ class: 'unsupported', message: 'The Electron app desktop keeps its own storage, so Retest cannot restore a saved sign-in state into it.' }))
    }
  }

  function pagesContext(t: TestContext): PagesContext {
    const folder = newRunFolder()
    const store = RunStore.create(folder)
    t.after(() => store.close())
    return {
      store,
      timeouts: quickTimeouts,
      stopped: new Promise(() => {}),
      interruption: () => undefined,
      connected: () => true,
      release: () => {},
      named: true,
      emit: () => {},
      redact: (text) => text,
      testId: 'tests/desktop.retest.ts > signs in',
      attemptId: 'k3v9q0x2mb',
    }
  }

  test('a page the app cannot give with the options asked of it', async (t) => {
    const opened = await openPage(pagesContext(t), new RefusingElectron(launchOptionsOf('desktop'), 7001), { storageState: { cookies: [], origins: [] } })
    assert.ok(!opened.ok)
    assert.equal(opened.failure.class, 'unsupported')
    assert.match(opened.failure.message, /^Retest could not open a page: The Electron app desktop keeps its own storage/)
  })

  test("a setup's sign-in state the app cannot give", async (t) => {
    const { page } = electronPage()
    const app = new FakeElectron(launchOptionsOf('desktop'), 7001)
    const session: SessionIdentity = { sessionId: 'k3v9q0x2mb:desktop', owner: { runId: 'run', testId: 'tests/desktop.retest.ts > signs in', attemptId: 'k3v9q0x2mb', app: 'desktop' }, runtime: app.identity }
    const unsaved = await saveState(pagesContext(t), { app: 'desktop', page, browser: app, touch: false, session }, 'signed-in', 'electron')
    assert.equal(unsaved?.class, 'unsupported')
    assert.match(unsaved?.message ?? '', /^Retest could not save the state "signed-in": Retest cannot save a sign-in state from the Electron app desktop/)
  })
})
