import type { BuildInspection, BuildPlatform } from '../../src/browser/builds.ts'
import type { ExecutableHost } from '../../src/browser/executables.ts'
import type { LoadedChromiumTarget, LoadedConfig } from '../../src/config/loaded.ts'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { chmod, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { describe, test } from 'node:test'
import { buildFolder, cacheFolders, describePin, findPin, installedExecutablePath, pinRefusal } from '../../src/browser/builds.ts'
import { LaunchError } from '../../src/browser/contract.ts'
import { headlessShellVariable, isHeadlessShell, resolveExecutable } from '../../src/browser/executables.ts'
import { recordedWindow, sizedWindow } from '../../src/browser/default-window.ts'
import { chromeLanguages, shellParity, shellSwitches } from '../../src/browser/shell-parity.ts'
import { launchBrowser } from '../../src/browser/launch.ts'
import { checkBuilds } from '../../src/cli/install/doctor-rows.ts'
import { describeResult, licenceSummary } from '../../src/cli/install/report.ts'
import { chrome, chromium } from '../../src/config/define.ts'
import { validateConfig } from '../../src/config/validate.ts'
import { createStyle } from '../../src/reporters/style.ts'
import { BrowserPool } from '../../src/runner/browser-pool.ts'
import { executableRequest, runsHeadlessShell } from '../../src/runner/target-executable.ts'
import { fakeLauncher } from '../support/fake-browser.ts'
import { quickTimeouts } from '../support/run-harness.ts'
import { sha256Hex } from '../../src/shared/sha256.ts'
import { tempFolder } from '../support/temp-folder.ts'
import { homeEnvironment, installStandIn, standInPin, temporaryCache } from './builds-fixtures.ts'
import { loadedConfig } from './cli-fixtures.ts'

// Chrome's headless shell as what a headless chromium() target runs: found from its path, RETEST_HEADLESS_SHELL or the
// pinned build in Retest's cache, never Chrome for Testing in its place; pinned and checksummed on the three platforms
// Chromium is; installed with Chromium; named by doctor; and never run as a shown browser.

const linuxShell = '/cache/chrome-headless-shell-linux64/chrome-headless-shell'
const windowsShell = 'C:\\Browsers\\chrome-headless-shell-win64\\chrome-headless-shell.exe'

function host(platform: NodeJS.Platform, installed: readonly string[] = [], env: Record<string, string> = {}, cached: Partial<Record<'chromium' | 'headless-shell', string>> = {}): ExecutableHost {
  return { platform, env: { HOME: '/home/ada', ...env }, exists: (path) => installed.includes(path), installed: (engine) => cached[engine] }
}

const configPath = '/work/retest.config.ts'

function loaded(value: unknown): LoadedConfig {
  const result = validateConfig(value, configPath)
  assert.ok(result.ok, result.ok ? '' : result.failure.message)
  return result.config
}

function problems(value: unknown): string[] {
  const result = validateConfig(value, configPath)
  assert.equal(result.ok, false, 'expected the config to be rejected')
  if (result.ok) return []
  const lines = result.failure.message.split('\n')
  return lines.length === 1 ? [lines[0]?.slice(`${configPath}: `.length) ?? ''] : lines.slice(1).map((line) => line.trim())
}

function webTarget(config: LoadedConfig): LoadedChromiumTarget {
  const target = config.apps.get('web')?.targets.get('chromium')
  assert.ok(target !== undefined && !('platform' in target) && target.browser === 'chromium')
  return target
}

describe('finding the headless shell', () => {
  test('a shell target runs the path it names, or RETEST_HEADLESS_SHELL, and never RETEST_CHROMIUM', () => {
    assert.deepEqual(resolveExecutable({ product: 'headless-shell', executablePath: linuxShell }, host('linux', [linuxShell])), { ok: true, path: linuxShell })
    assert.deepEqual(resolveExecutable({ product: 'headless-shell' }, host('linux', [linuxShell], { [headlessShellVariable]: linuxShell })), { ok: true, path: linuxShell })
    const own = resolveExecutable({ product: 'headless-shell', executablePath: linuxShell }, host('linux', [linuxShell], { [headlessShellVariable]: '/elsewhere/chrome-headless-shell' }))
    assert.deepEqual(own, { ok: true, path: linuxShell }, "the target's own path wins over the variable")
    const chromiumOnly = resolveExecutable({ product: 'headless-shell' }, host('linux', ['/opt/chrome/chrome'], { RETEST_CHROMIUM: '/opt/chrome/chrome', [headlessShellVariable]: '' }, { chromium: '/cache/chromium/chrome' }))
    assert.deepEqual(chromiumOnly, {
      ok: false,
      failure: { class: 'setup_failed', message: "A headless chromium() target runs Chrome's headless shell, which is not installed: run npx retest install chromium." },
      tried: [],
    }, 'Chrome for Testing never stands in for a missing shell')
  })

  test('with no path, each program is the pinned build in Retest\'s cache, after its variable', () => {
    const cached = { chromium: '/cache/chromium/chrome', 'headless-shell': '/cache/shell/chrome-headless-shell' }
    assert.deepEqual(resolveExecutable({ product: 'headless-shell' }, host('linux', [], {}, cached)), { ok: true, path: '/cache/shell/chrome-headless-shell', cached: 'headless-shell' })
    assert.deepEqual(resolveExecutable({ product: 'chromium' }, host('linux', [], {}, cached)), { ok: true, path: '/cache/chromium/chrome', cached: 'chromium' })
    assert.deepEqual(resolveExecutable({ product: 'headless-shell' }, host('linux', [linuxShell], { [headlessShellVariable]: linuxShell }, cached)), { ok: true, path: linuxShell })
    assert.deepEqual(resolveExecutable({ product: 'chromium' }, host('linux', ['/opt/chrome/chrome'], { RETEST_CHROMIUM: '/opt/chrome/chrome' }, cached)), { ok: true, path: '/opt/chrome/chrome' })
  })

  test('a path that names another browser is refused by name, before it is looked for', () => {
    let looked = false
    const machine: ExecutableHost = { platform: 'linux', env: {}, exists: () => (looked = true) }
    const result = resolveExecutable({ product: 'headless-shell', executablePath: '/opt/chrome-linux64/chrome' }, machine)
    assert.deepEqual(result, {
      ok: false,
      failure: { class: 'setup_failed', message: "headlessShell runs Chrome's headless shell, and /opt/chrome-linux64/chrome, the path executablePath gives, is not one: the shell's file is named chrome-headless-shell. Pass the path npx retest install chromium prints for it, or remove headlessShell to run that browser." },
      tried: ['/opt/chrome-linux64/chrome'],
    })
    assert.equal(looked, false)
    const fromVariable = resolveExecutable({ product: 'headless-shell' }, host('linux', [], { [headlessShellVariable]: '/opt/chrome-linux64/chrome' }))
    assert.ok(!fromVariable.ok && fromVariable.failure.message.includes('the path RETEST_HEADLESS_SHELL gives, is not one'))
  })

  test('a shell that is not where the path says fails setup as a missing browser does, and the shell has no channels', () => {
    assert.deepEqual(resolveExecutable({ product: 'headless-shell', executablePath: linuxShell }, host('linux')), {
      ok: false,
      failure: { class: 'setup_failed', message: `No browser at ${linuxShell}, the path executablePath gives. Install one there, or change the path.` },
      tried: [linuxShell],
    })
    const channelled = resolveExecutable({ product: 'headless-shell', channel: 'beta', executablePath: linuxShell }, host('linux', [linuxShell]))
    assert.ok(!channelled.ok && channelled.failure.message.startsWith('The headless shell has no channels.'))
  })

  test('the shell is known by its file name, with .exe in any case on Windows', () => {
    assert.equal(isHeadlessShell(linuxShell, 'linux'), true)
    assert.equal(isHeadlessShell('/Users/ada/Library/Caches/retest/browsers/x/build/chrome-headless-shell-mac-arm64/chrome-headless-shell', 'darwin'), true)
    assert.equal(isHeadlessShell(windowsShell, 'win32'), true)
    assert.equal(isHeadlessShell('C:\\Shell\\CHROME-HEADLESS-SHELL.EXE', 'win32'), true)
    assert.deepEqual(resolveExecutable({ product: 'headless-shell', executablePath: windowsShell }, { platform: 'win32', env: {}, exists: (path) => path === windowsShell }), { ok: true, path: windowsShell })
    for (const [path, platform] of [['/opt/chrome-linux64/chrome', 'linux'], ['/cache/chrome-headless-shell-linux64/chrome-headless-shell.exe', 'linux'], ['/cache/Chrome-Headless-Shell', 'darwin'], ['C:\\chrome-win64\\chrome.exe', 'win32'], ['C:\\shell\\chrome-headless-shell', 'win32']] as const) {
      assert.equal(isHeadlessShell(path, platform), false, `${path} on ${platform}`)
    }
  })

  test('a headless chromium() target runs the shell unless it says headlessShell: false or names a path, and a shown one never does', () => {
    const base = { name: 'web', browser: 'chromium', headless: true } as const
    assert.equal(runsHeadlessShell(base), true)
    assert.deepEqual(executableRequest(base), { product: 'headless-shell' })
    assert.deepEqual(executableRequest({ ...base, headless: false }), { product: 'chromium' }, 'a shown run starts Chrome for Testing')
    assert.deepEqual(executableRequest({ ...base, headlessShell: false }), { product: 'chromium' })
    assert.deepEqual(executableRequest({ ...base, headlessShell: true, executablePath: linuxShell }), { product: 'headless-shell', executablePath: linuxShell })
    assert.deepEqual(executableRequest({ ...base, headlessShell: true, headless: false }), { product: 'chromium' })
    assert.deepEqual(executableRequest({ ...base, executablePath: '/opt/chrome/chrome' }), { product: 'chromium', executablePath: '/opt/chrome/chrome' }, 'a target that names a path runs what it names')
    assert.equal(runsHeadlessShell({ name: 'beta', browser: 'chrome', channel: 'beta', headless: true }), false)
  })

  test('a shown run finds the program for a shown run, which is Chrome for Testing', async () => {
    const asked: boolean[] = []
    const launched = fakeLauncher()
    const pool = new BrowserPool({
      launch: launched.launch,
      findExecutable: async (target) => {
        asked.push(target.headless)
        return { ok: true, path: '/fake/chrome' }
      },
      logFile: (app, target) => `/logs/${app}-${target}.log`,
      headless: false,
      named: true,
      timeouts: quickTimeouts,
      stopped: new Promise(() => {}),
      interruption: () => undefined,
      onStarted: () => {},
      onLost: () => {},
    })
    const target = { name: 'chromium', browser: 'chromium', headless: true } as const
    const ready = await pool.ensure({ name: 'web', targets: new Map([[target.name, target]]) }, target)
    assert.ok(ready.ok)
    assert.deepEqual(asked, [false], 'the target is found as shown, since --headed shows it')
    await pool.close()
  })

  test('a target spread over several browsers finds its program once, since a cached build is checked by reading it whole', async () => {
    let finds = 0
    const launched = fakeLauncher()
    const pool = new BrowserPool({
      launch: launched.launch,
      findExecutable: async () => {
        finds += 1
        return { ok: true, path: '/fake/chrome-headless-shell' }
      },
      logFile: (app, target, instance) => `/logs/${app}-${target}-${instance}.log`,
      headless: true,
      named: true,
      timeouts: quickTimeouts,
      stopped: new Promise(() => {}),
      interruption: () => undefined,
      onStarted: () => {},
      onLost: () => {},
    })
    const target = { name: 'chromium', browser: 'chromium', headless: true } as const
    const app = { name: 'web', targets: new Map([[target.name, target]]) }
    pool.spread(app, target, 4)
    const ready = await Promise.all([0, 1, 2, 3].map((worker) => pool.ensure(app, target, worker)))
    assert.ok(ready.every((opened) => opened.ok))
    assert.equal(launched.browsers.length, 4)
    assert.equal(finds, 1)
    await pool.close()
  })
})

describe('the headlessShell option in a config', () => {
  test('is kept only when the config says it, and the default leaves the target as it was', () => {
    const plain = webTarget(loaded({ apps: { web: chromium({ baseUrl: 'http://127.0.0.1:4173' }) } }))
    assert.equal('headlessShell' in plain, false)
    assert.equal(runsHeadlessShell(plain), true)
    const chrome = webTarget(loaded({ apps: { web: chromium({ baseUrl: 'http://127.0.0.1:4173', headlessShell: false }) } }))
    assert.equal(chrome.browser === 'chromium' ? chrome.headlessShell : undefined, false)
    assert.equal(runsHeadlessShell(chrome), false)
    const shell = webTarget(loaded({ apps: { web: chromium({ baseUrl: 'http://127.0.0.1:4173', headlessShell: true, executablePath: 'shell/chrome-headless-shell' }) } }))
    assert.deepEqual(shell, { name: 'chromium', browser: 'chromium', headless: true, headlessShell: true, executablePath: resolve('/work', 'shell/chrome-headless-shell') })
    assert.equal(runsHeadlessShell(webTarget(loaded({ apps: { web: chromium({ baseUrl: 'http://127.0.0.1:4173', headless: false }) } }))), false)
  })

  test('refuses a shown target, a value that is not true or false, and the option on Chrome', () => {
    assert.deepEqual(problems({ apps: { web: chromium({ baseUrl: 'http://127.0.0.1:4173', headlessShell: true, headless: false }) } }), [
      "apps.web.headless: Chrome's headless shell cannot show a window, so a target with headlessShell: true takes no headless: false",
    ])
    assert.deepEqual(problems({ apps: { web: { browser: 'chromium', baseUrl: 'http://127.0.0.1:4173', headlessShell: 'yes' } } }), ['apps.web.headlessShell: expected boolean, received "yes"'])
    assert.deepEqual(problems({ apps: { web: { ...chrome({ baseUrl: 'http://127.0.0.1:4173' }), headlessShell: true } } }), ['apps.web.headlessShell: unknown key'])
  })
})

describe('the pinned headless shell', () => {
  const platforms: readonly [BuildPlatform, NodeJS.Platform, string][] = [['mac-arm64', 'darwin', 'mac-arm64'], ['linux-x64', 'linux', 'linux64'], ['win-x64', 'win32', 'win64']]

  test('is the shell of the pinned Chromium on each platform Chromium is pinned for, from Google, with every checksum', () => {
    for (const [platform, system, folder] of platforms) {
      const pin = findPin('headless-shell', platform)
      const chromiumPin = findPin('chromium', platform)
      assert.ok(pin?.kind === 'archive' && pin.licences.inspected && chromiumPin !== undefined, `${platform} pins the shell`)
      assert.equal(pin.version, chromiumPin.version, `${platform}: the shell of the pinned Chromium release`)
      assert.equal(pin.archive.url, `https://storage.googleapis.com/chrome-for-testing-public/${pin.version}/${folder}/chrome-headless-shell-${folder}.zip`)
      assert.equal(pin.archive.format, 'zip')
      assert.ok(pin.archive.size !== undefined && pin.archive.size > 90_000_000, `${platform}: the archive's size is pinned`)
      assert.match(pin.archive.sha256 ?? '', /^[0-9a-f]{64}$/)
      assert.match(pin.executable.sha256 ?? '', /^[0-9a-f]{64}$/)
      assert.ok(isHeadlessShell(pin.executable.path, system), `${pin.executable.path} is a shell by name`)
      assert.deepEqual(pin.licences.files.map((file) => file.path), [`chrome-headless-shell-${folder}/ABOUT`, `chrome-headless-shell-${folder}/LICENSE.headless_shell`])
      assert.ok(pin.licences.files.every((file) => file.published && file.bundled === undefined && /^[0-9a-f]{64}$/.test(file.sha256 ?? '')), 'the shell carries its own notices, each with its checksum')
      assert.equal(pinRefusal(pin), undefined, `${platform}: retest install installs it`)
      assert.equal(describePin(pin), 'Chrome Headless Shell 153.0.8010.12')
      assert.equal(licenceSummary(pin), 'BSD, notices kept with the build')
    }
  })

  test('installs into a folder of its own beside Chromium, so the two never share one', () => {
    const folders = cacheFolders({ HOME: '/home/ada' }, 'linux')
    const pin = findPin('headless-shell', 'linux-x64')
    const chromiumPin = findPin('chromium', 'linux-x64')
    assert.ok(folders !== undefined && pin?.kind === 'archive' && chromiumPin !== undefined)
    assert.equal(buildFolder(folders, pin), join('/home/ada/.cache/retest/browsers', 'headless-shell-153.0.8010.12-linux-x64'))
    assert.notEqual(buildFolder(folders, pin), buildFolder(folders, chromiumPin))
  })

  test('an install says how a target runs it', () => {
    const pin = findPin('headless-shell', 'mac-arm64')
    assert.ok(pin?.kind === 'archive')
    const inspection: BuildInspection = { pin, folder: '/cache/shell', state: 'installed', problems: [], executablePath: `/cache/shell/build/${pin.executable.path}`, sha256: 'a'.repeat(64) }
    const lines = describeResult('headless-shell', { ok: true, action: 'installed', inspection }, createStyle(false)).trimEnd().split('\n').map((line) => line.trim())
    assert.match(lines[0] ?? '', /^✓ headless-shell +Chrome Headless Shell 153\.0\.8010\.12 installed$/)
    assert.equal(lines.at(-1), 'A headless chromium() target runs it, unless its executablePath or RETEST_HEADLESS_SHELL names another browser.')
  })
})

describe("doctor's row for a shell target", () => {
  const project = tempFolder('retest-doctor-shell-')
  const archive = { size: 7, sha256: sha256Hex('stand-in archive') }
  const shellPin = standInPin({ sha256: archive.sha256 }, { engine: 'headless-shell', title: 'Chrome Headless Shell' })
  const chromiumPin = standInPin({ sha256: archive.sha256 }, { engine: 'chromium', title: 'Chrome for Testing' })

  test('names the shell for a headless chromium() target, says how to install it, and reads RETEST_HEADLESS_SHELL', async () => {
    const { home, folders } = temporaryCache()
    const config = loadedConfig(project, { apps: { web: chromium() } })
    const env = { ...homeEnvironment(home), RETEST_CHROMIUM: '/elsewhere/chrome' }
    assert.deepEqual(await checkBuilds(config, env, { pins: [chromiumPin, shellPin], platform: 'mac-arm64' }), [
      { group: 'builds', subject: 'headless-shell', ok: false, text: 'Chrome Headless Shell 1.0.0 is not installed, and the target names no build', fix: 'Run npx retest install chromium.' },
    ])
    assert.deepEqual(await checkBuilds(config, homeEnvironment(home), { platform: 'mac-arm64' }), [
      { group: 'builds', subject: 'headless-shell', ok: false, text: 'Chrome Headless Shell 153.0.8010.12 is not installed, and the target names no build', fix: 'Run npx retest install chromium.' },
    ], 'with the real pin')
    const { folder } = await installStandIn(folders, shellPin, archive)
    const executablePath = installedExecutablePath(folder, shellPin)
    assert.deepEqual(await checkBuilds(config, homeEnvironment(home), { pins: [chromiumPin, shellPin], platform: 'mac-arm64' }), [
      { group: 'builds', subject: 'headless-shell', ok: true, text: `Chrome Headless Shell 1.0.0, installed by Retest · sha256 ${archive.sha256.slice(0, 12)}; the target runs it, since it names no executablePath`, detail: executablePath },
    ])
    assert.deepEqual(await checkBuilds(config, { ...homeEnvironment(home), [headlessShellVariable]: executablePath }, { pins: [chromiumPin, shellPin], platform: 'mac-arm64' }), [
      { group: 'builds', subject: 'headless-shell', ok: true, text: `Chrome Headless Shell 1.0.0, installed by Retest · sha256 ${archive.sha256.slice(0, 12)}`, detail: executablePath },
    ])
  })
})

describe('a shown launch of the shell', () => {
  test('is refused before anything starts, since the shell cannot show a window', async () => {
    const folder = tempFolder('retest-shown-shell-')
    const marker = join(folder, 'started')
    const executablePath = join(folder, process.platform === 'win32' ? 'chrome-headless-shell.exe' : 'chrome-headless-shell')
    await writeFile(executablePath, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`)
    await chmod(executablePath, 0o755)
    await assert.rejects(launchBrowser({ executablePath, logFile: join(folder, 'browser.log'), headless: false }), (error: unknown) => {
      assert.ok(error instanceof LaunchError)
      assert.equal(error.message, `${executablePath} is Chrome's headless shell, which cannot show a window. Run it headless, or show Chrome or Chromium instead.`)
      assert.equal(error.failure.class, 'setup_failed')
      return true
    })
    assert.equal(existsSync(marker), false, 'nothing was started')
    assert.equal(existsSync(join(folder, 'browser.log')), false, 'no browser log was begun')
  })
})

describe('what the shell is given to act as Chrome', () => {
  const version = { product: 'HeadlessChrome', version: '153.0.8010.12', userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/153.0.8010.12 Safari/537.36' }

  test('nothing for any other browser', () => {
    assert.equal(shellParity({ ...version, product: 'Chrome' }, { platform: 'linux', arch: 'x64', env: {} }), undefined)
  })

  test('on Linux, the languages, user agent and client hints Chrome for Testing 153 sends, its fonts, window and default grants', () => {
    const parity = shellParity(version, { platform: 'linux', arch: 'x64', env: { LANG: 'C.UTF-8' } })
    assert.deepEqual(parity?.userAgent, {
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/153.0.0.0 Safari/537.36',
      acceptLanguage: 'en-US,en',
      userAgentMetadata: {
        brands: [{ brand: 'Chromium', version: '153' }, { brand: 'Not_A Brand', version: '8' }],
        fullVersionList: [{ brand: 'Chromium', version: '153.0.8010.12' }, { brand: 'Not_A Brand', version: '8.0.0.0' }],
        platform: 'Linux', platformVersion: '', architecture: 'x86', model: '', mobile: false, bitness: '64', wow64: false, formFactors: ['Desktop'],
      },
    })
    assert.equal(parity?.fonts.fontFamilies['fixed'], 'Monospace')
    assert.deepEqual(parity?.permissions, ['clipboard-write', 'background-sync', 'screen-wake-lock'])
    assert.deepEqual(shellSwitches('linux', { LANG: 'C.UTF-8' }), ['--site-per-process', '--accept-lang=en-US,en', '--window-size=780,580', '--screen-info={0,0 800x600}'])
  })

  test('on macOS, Chrome\'s user agent and client hints with the system\'s version in three parts, and Menlo for monospace', () => {
    const mac = { ...version, userAgent: version.userAgent.replace('X11; Linux x86_64', 'Macintosh; Intel Mac OS X 10_15_7') }
    const parity = shellParity(mac, { platform: 'darwin', arch: 'arm64', env: {}, macosVersion: '27.2' })
    assert.deepEqual(parity?.userAgent, {
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/153.0.0.0 Safari/537.36',
      acceptLanguage: parity?.userAgent.acceptLanguage,
      userAgentMetadata: {
        brands: [{ brand: 'Chromium', version: '153' }, { brand: 'Not_A Brand', version: '8' }],
        fullVersionList: [{ brand: 'Chromium', version: '153.0.8010.12' }, { brand: 'Not_A Brand', version: '8.0.0.0' }],
        platform: 'macOS', platformVersion: '27.2.0', architecture: 'arm', model: '', mobile: false, bitness: '64', wow64: false, formFactors: ['Desktop'],
      },
    })
    assert.equal(shellParity(mac, { platform: 'darwin', arch: 'arm64', env: {}, macosVersion: '26.1.2' })?.userAgent.userAgentMetadata?.platformVersion, '26.1.2')
    assert.equal(parity?.fonts.fontFamilies['fixed'], 'Menlo')
    assert.deepEqual(shellSwitches('darwin', {}).slice(2), ['--window-size=756,556', '--screen-info={0,0 800x600}'])
  })

  test('on macOS with no system version to read, the shell keeps its own user agent and client hints', () => {
    const mac = { ...version, userAgent: version.userAgent.replace('X11; Linux x86_64', 'Macintosh; Intel Mac OS X 10_15_7') }
    assert.equal(shellParity(mac, { platform: 'darwin', arch: 'arm64', env: {} })?.userAgent.userAgent, '')
    assert.equal(shellParity(mac, { platform: 'darwin', arch: 'arm64', env: {}, macosVersion: 'unknown' })?.userAgent.userAgentMetadata, undefined)
  })

  test('on Windows, the languages and fonts alone, since Retest has read neither Chrome\'s window nor its client hints there', () => {
    const parity = shellParity({ ...version, userAgent: version.userAgent.replace('X11; Linux x86_64', 'Windows NT 10.0; Win64; x64') }, { platform: 'win32', arch: 'x64', env: {} })
    assert.equal(parity?.userAgent.userAgent, '')
    assert.equal(parity?.userAgent.userAgentMetadata, undefined)
    assert.equal(parity?.fonts.fontFamilies['fixed'], 'Consolas')
    assert.equal(shellSwitches('win32', {}).some((entry) => entry.startsWith('--window-size')), false)
  })

  test('the languages Chrome sends, from the locale it reads on Linux', () => {
    assert.equal(chromeLanguages('linux', { LANG: 'C.UTF-8' }), 'en-US,en')
    assert.equal(chromeLanguages('linux', { LANG: 'en_US.UTF-8' }), 'en-US,en')
    assert.equal(chromeLanguages('linux', { LANG: 'fr_FR.UTF-8' }), 'fr-FR,fr,en-US,en')
    assert.equal(chromeLanguages('linux', { LANGUAGE: 'de_DE:en', LANG: 'fr_FR.UTF-8' }), 'de-DE,de,en-US,en', 'LANGUAGE comes first')
    assert.equal(chromeLanguages('linux', { LC_ALL: 'POSIX' }), 'en-US,en')
    assert.equal(chromeLanguages('linux', {}), 'en-US,en')
  })
})

describe('the window Retest 0.4.2 gave a page with no viewport', () => {
  const chrome = { product: 'Chrome', version: '153.0.8010.12', userAgent: '' }

  test('is given to Chrome for Testing and its headless shell of the pinned release, on Linux and macOS', () => {
    assert.deepEqual(recordedWindow(chrome, 'linux'), { window: { width: 780, height: 580 }, screen: { width: 800, height: 600 }, page: { viewport: { width: 780, height: 437 }, position: { x: 20, y: 20 } }, tab: { viewport: { width: 780, height: 493 }, position: { x: 20, y: 20 } } })
    assert.deepEqual(recordedWindow({ ...chrome, product: 'HeadlessChrome' }, 'linux'), recordedWindow(chrome, 'linux'))
    assert.deepEqual(recordedWindow(chrome, 'darwin')?.page, { viewport: { width: 756, height: 413 }, position: { x: 44, y: 44 } })
  })

  test('keeps the page view at the window size on macOS only, where the shell reports the view as its window', () => {
    assert.equal(recordedWindow(chrome, 'darwin')?.keepView, true)
    assert.equal(recordedWindow(chrome, 'linux')?.keepView, undefined)
  })

  test('is given to no other browser, release or platform, since no other was recorded', () => {
    assert.equal(recordedWindow({ ...chrome, version: '157.0.8103.52' }, 'linux'), undefined)
    assert.equal(recordedWindow({ ...chrome, product: 'Edg' }, 'linux'), undefined)
    assert.equal(recordedWindow(chrome, 'win32'), undefined)
  })

  test('a window a page opens with a size keeps its own', () => {
    assert.equal(sizedWindow(['popup', 'width=300', 'height=200']), true)
    assert.equal(sizedWindow(['menubar', 'toolbar', 'status', 'scrollbars', 'resizable']), false)
    assert.equal(sizedWindow(['noopener']), false)
  })
})
