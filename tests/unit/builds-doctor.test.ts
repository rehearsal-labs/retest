import type { BuildPin } from '../../src/browser/builds.ts'
import type { LoadedConfig } from '../../src/config/loaded.ts'
import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { buildPlatform, installedExecutablePath } from '../../src/browser/builds.ts'
import { runChecks } from '../../src/cli/doctor/checks.ts'
import { checkBuilds } from '../../src/cli/install/doctor-rows.ts'
import { app, chrome, chromium, electron } from '../../src/config/define.ts'
import { defaultTimeouts } from '../../src/protocol/timeouts.ts'
import { sha256Hex } from '../../src/shared/sha256.ts'
import { tempFolder } from '../support/temp-folder.ts'
import { installStandIn, standInPin, temporaryCache } from './builds-fixtures.ts'
import { fakeBrowser, loadedConfig } from './cli-fixtures.ts'
import { fakeTools } from './native-fake-tools.ts'

// The builds rows of doctor read the cache and nothing else: the global fetch fails the test if anything reaches for
// the network.
let fetches = 0
const realFetch = globalThis.fetch
beforeEach(() => {
  fetches = 0
  globalThis.fetch = async () => {
    fetches += 1
    throw new Error('doctor must not touch the network')
  }
})
afterEach(() => {
  globalThis.fetch = realFetch
  assert.equal(fetches, 0, 'nothing was fetched')
})

const project = tempFolder('retest-doctor-builds-')
const archive = { size: 7, sha256: sha256Hex('stand-in archive') }

// Stand-in pins for each engine a target can name, on macOS arm64, so the rows can be shown on any machine.
function pinsFor(): BuildPin[] {
  return [
    standInPin({ sha256: archive.sha256 }, { engine: 'chromium', title: 'Chrome for Testing' }),
    standInPin({ sha256: archive.sha256 }, { engine: 'electron', title: 'Electron' }),
    standInPin({ sha256: archive.sha256 }, { engine: 'firefox', title: 'Firefox' }),
    standInPin({}, { engine: 'webkit', title: 'WebKit', licences: { inspected: true, files: [{ path: 'licenses/NOTICE.txt', title: 'a notice the build lacks', licence: 'LGPL-2.1', published: false }] } }),
  ]
}

function rows(config: LoadedConfig, env: Record<string, string>, pins = pinsFor(), driven?: () => boolean) {
  return checkBuilds(config, env, { pins, platform: 'mac-arm64', ...(driven === undefined ? {} : { driven }) })
}

describe("doctor's builds rows", () => {
  test('name a build Retest installed that a target runs, with its version and checksum', async () => {
    const { home, folders } = temporaryCache()
    const pins = pinsFor()
    const [chromiumPin] = pins
    assert.ok(chromiumPin?.kind === 'archive')
    const { folder } = await installStandIn(folders, chromiumPin, archive)
    const executablePath = installedExecutablePath(folder, chromiumPin)
    const config = loadedConfig(project, { apps: { web: chromium({ executablePath }) } })
    assert.deepEqual(await rows(config, { HOME: home }, pins), [
      { group: 'builds', subject: 'chromium', ok: true, text: `Chrome for Testing 1.0.0, installed by Retest · sha256 ${archive.sha256.slice(0, 12)}`, detail: executablePath },
    ])
    assert.deepEqual(await rows(config, { HOME: home, RETEST_CHROMIUM: '/elsewhere' }, pins), await rows(config, { HOME: home }, pins), "the target's own path wins over RETEST_CHROMIUM")
    const fromVariable = loadedConfig(project, { apps: { web: chromium() } })
    assert.equal((await rows(fromVariable, { HOME: home, RETEST_CHROMIUM: executablePath }, pins))[0]?.text, `Chrome for Testing 1.0.0, installed by Retest · sha256 ${archive.sha256.slice(0, 12)}`)
  })

  test('say a configured path wins over an installed build, and say nothing of one when none is installed', async () => {
    const { home, folders } = temporaryCache()
    const elsewhere = join(tempFolder('retest-own-browser-'), 'chrome')
    await writeFile(elsewhere, 'a browser of my own')
    const config = loadedConfig(project, { apps: { web: chromium({ executablePath: elsewhere }) } })
    assert.deepEqual(await rows(config, { HOME: home }), [], 'nothing installed, nothing to say')
    const pins = pinsFor()
    const [chromiumPin] = pins
    assert.ok(chromiumPin?.kind === 'archive')
    await installStandIn(folders, chromiumPin, archive)
    assert.deepEqual(await rows(config, { HOME: home }, pins), [{ group: 'builds', subject: 'chromium', ok: true, text: 'found at a configured path, which wins over the installed Chrome for Testing 1.0.0', detail: elsewhere }])
    const missingPath = loadedConfig(project, { apps: { web: chromium({ executablePath: '/nonexistent/chrome' }) } })
    assert.deepEqual(await rows(missingPath, { HOME: home }, pins), [], "a path with nothing at it is left to the target's own row")
  })

  test('point a chromium() target with no path at the installed build, or say it is not installed and how to install it', async () => {
    const { home, folders } = temporaryCache()
    const config = loadedConfig(project, { apps: { web: chromium() } })
    assert.deepEqual(await rows(config, { HOME: home }), [
      { group: 'builds', subject: 'chromium', ok: false, text: 'Chrome for Testing 1.0.0 is not installed, and the target names no build', fix: 'Run npx retest install chromium, then give the target its executablePath or set RETEST_CHROMIUM.' },
    ])
    const real = await checkBuilds(config, { HOME: home }, { platform: 'mac-arm64' })
    assert.deepEqual(real, [
      { group: 'builds', subject: 'chromium', ok: false, text: 'Chrome for Testing 153.0.8010.12 is not installed, and the target names no build', fix: 'Run npx retest install chromium, then give the target its executablePath or set RETEST_CHROMIUM.' },
    ], 'with the real pin, the row names the usable install command')
    const pins = pinsFor()
    const [chromiumPin] = pins
    assert.ok(chromiumPin?.kind === 'archive')
    const { folder } = await installStandIn(folders, chromiumPin, archive)
    assert.deepEqual(await rows(config, { HOME: home }, pins), [
      { group: 'builds', subject: 'chromium', ok: true, text: `Chrome for Testing 1.0.0, installed by Retest · sha256 ${archive.sha256.slice(0, 12)}; the target runs it once its executablePath, or RETEST_CHROMIUM, names this path`, detail: installedExecutablePath(folder, chromiumPin) },
    ])
    assert.deepEqual(await rows(config, {}, pins), [], 'without a home folder there is no cache to read')
  })

  test('name what no longer matches in an installed build a target runs, with the fix', async () => {
    const { home, folders } = temporaryCache()
    const pins = pinsFor()
    const electronPin = pins[1]
    assert.ok(electronPin?.kind === 'archive')
    const { folder } = await installStandIn(folders, electronPin, archive)
    await rm(join(folder, 'build/LICENSE'))
    const config = loadedConfig(project, { apps: { desk: electron({ executablePath: installedExecutablePath(folder, electronPin), appPath: '/work/app' }) } })
    const [row] = await rows(config, { HOME: home }, pins)
    assert.equal(row?.ok, false)
    assert.match(row?.text ?? '', /^Electron 1\.0\.0 in .+ does not match its record: .+LICENSE is missing\.$/)
    assert.equal(row?.fix, `Remove ${folder} and run npx retest install electron again.`)
  })

  test('leave a Firefox target with no path to its driver, and give a WebKit one with no build the reason install refuses it', async () => {
    const { home, folders } = temporaryCache()
    const config = loadedConfig(project, { apps: { web: app({ targets: { firefox: { browser: 'firefox' }, webkit: { browser: 'webkit' } } }) } })
    const driven = (): boolean => true
    assert.deepEqual(await rows(config, { HOME: home }, pinsFor(), driven), [
      { group: 'builds', subject: 'webkit', ok: false, text: 'WebKit 1.0.0 is not installed, and the target names no build', fix: 'npx retest install webkit refuses it: WebKit 1.0.0 for macOS arm64 is published without these licence notices: licenses/NOTICE.txt (a notice the build lacks). Retest installs it only once they ship with it. Give the target an executablePath instead.' },
    ])
    const pins = pinsFor()
    const firefoxPin = pins[2]
    assert.ok(firefoxPin?.kind === 'archive')
    const { folder } = await installStandIn(folders, firefoxPin, archive)
    assert.deepEqual((await rows(config, { HOME: home }, pins, driven))[0], { group: 'builds', subject: 'firefox', ok: true, text: `Firefox 1.0.0, installed by Retest · sha256 ${archive.sha256.slice(0, 12)}; the target runs it, since it names no executablePath`, detail: installedExecutablePath(folder, firefoxPin) })
    assert.deepEqual(await checkBuilds(config, { HOME: home }, { pins, platform: 'linux-x64', driven }), [], 'no row for an engine with no pin on this platform')
  })

  test('read a WebKit build named by RETEST_WEBKIT_BUILD, the folder or the executable, as a configured path', async () => {
    const { home, folders } = temporaryCache()
    const webkit = standInPin({ sha256: archive.sha256 }, { engine: 'webkit', title: 'WebKit' })
    const { folder } = await installStandIn(folders, webkit, archive)
    const config = loadedConfig(project, { apps: { web: app({ targets: { webkit: { browser: 'webkit' } } }) } })
    const expected = [{ group: 'builds', subject: 'webkit', ok: true, text: `WebKit 1.0.0, installed by Retest · sha256 ${archive.sha256.slice(0, 12)}`, detail: installedExecutablePath(folder, webkit) }]
    assert.deepEqual(await rows(config, { HOME: home, RETEST_WEBKIT_BUILD: join(folder, 'build') }, [webkit], () => true), expected)
    assert.deepEqual(await rows(config, { HOME: home, RETEST_WEBKIT_BUILD: installedExecutablePath(folder, webkit) }, [webkit], () => true), expected)
  })

  test('never call a build of a pin install refuses installed, and give it a fix the install accepts', async () => {
    const { home, folders } = temporaryCache()
    // The folders hold every file their records name, as a hand-filled cache can; the pins are ones install refuses.
    const chromiumPin = standInPin({}, { engine: 'chromium', title: 'Chrome for Testing' })
    const webkitPin = standInPin({ sha256: archive.sha256 }, { engine: 'webkit', title: 'WebKit', licences: { inspected: true, files: [{ path: 'LICENSE', title: 'a notice the published build lacks', licence: 'LGPL-2.1', published: false }] } })
    const pins = [chromiumPin, webkitPin]
    const chromiumFolder = (await installStandIn(folders, chromiumPin, archive)).folder
    const webkitFolder = (await installStandIn(folders, webkitPin, archive)).folder
    const webkitPath = installedExecutablePath(webkitFolder, webkitPin)
    const config = loadedConfig(project, { apps: { web: app({ targets: { chromium: chromium(), webkit: { browser: 'webkit', executablePath: webkitPath } } }) } })
    const checks = await rows(config, { HOME: home }, pins, () => true)
    assert.deepEqual(checks, [
      { group: 'builds', subject: 'chromium', ok: false, text: `Chrome for Testing 1.0.0 is not installed: ${chromiumFolder} holds a build Retest did not install or check, and no run launches it`, fix: `Remove ${chromiumFolder}. npx retest install chromium refuses it: No checksum is pinned for the archive of Chrome for Testing 1.0.0 for macOS arm64, so Retest has nothing to check a download against and downloads nothing. Give the target an executablePath instead.` },
      { group: 'builds', subject: 'webkit', ok: true, text: `found at a configured path in ${webkitFolder}, which holds a build Retest does not install and never checked`, detail: webkitPath },
    ])
    for (const check of checks) assert.ok(!check.text.includes('installed by Retest'), check.text)
    await rm(join(chromiumFolder, 'build/LICENSE'))
    const [damaged] = await rows(config, { HOME: home }, pins, () => true)
    assert.ok(!(damaged?.fix ?? '').includes('install chromium again'), 'no fix runs an install that refuses')
  })

  test('give no row to Chrome or Edge, which run the browser the machine has, or to a target doctor refuses', async () => {
    const { home } = temporaryCache()
    const branded = loadedConfig(project, { apps: { web: app({ targets: { chrome: chrome(), beta: chrome({ channel: 'beta' }) } }) } })
    assert.deepEqual(await rows(branded, { HOME: home }, pinsFor(), () => true), [])
    const firefox = loadedConfig(project, { apps: { web: app({ targets: { firefox: { browser: 'firefox' } } }) } })
    assert.deepEqual(await rows(firefox, { HOME: home }, pinsFor(), () => false), [], 'a target with no driver is refused by its own row, and nothing is added for it')
  })

  test('check a native target as a run drives it, by the executor build in the cache, and start nothing', async (t) => {
    if (buildPlatform() !== 'mac-arm64') {
      t.skip(`unverified here: the executors are pinned for macOS arm64, and this machine is ${process.platform} ${process.arch}`)
      return
    }
    const { home } = temporaryCache()
    // The apps are there, so each row is about its executor, which this home's cache does not hold.
    const appPath = join(tempFolder('retest-native-app-'), 'Tasks.app')
    await mkdir(join(appPath, 'Contents'), { recursive: true })
    const config = loadedConfig(project, {
      apps: {
        phone: { platform: 'ios-simulator', appPath, device: 'iPhone 17', runtime: '26.0' },
        desk: { platform: 'macos', appPath },
      },
    })
    const launched: string[] = []
    const fake = await fakeTools(t)
    const checks = await runChecks(config, {
      tools: fake.tools,
      dependencies: {
        resolveExecutable: () => assert.fail('a native target resolves no browser'),
        launchBrowser: async (options) => {
          launched.push(options.executablePath)
          return fakeBrowser(options.executablePath)
        },
        probeReady: async () => true,
        startAppServer: () => Promise.reject(new Error('no server is started')),
        env: { HOME: home },
        signal: new AbortController().signal,
      },
      timeouts: defaultTimeouts,
      logFolder: join(project, '.retest', 'doctor'),
    })
    assert.deepEqual(checks, [
      { group: 'phone', subject: "{ platform: 'ios-simulator', device: 'iPhone 17', runtime: '26.0' }", ok: false, text: "WebDriverAgent 16.13.6 is not built in Retest's cache", fix: 'Run npx retest install webdriveragent to build it from its pinned commit; otherwise the first run builds it.' },
      { group: 'desk', subject: "{ platform: 'macos' }", ok: false, text: "WebDriverAgentMac (appium-mac2-driver) 4.3.6 is not built in Retest's cache", fix: 'Run npx retest install mac2 to build it from its pinned commit; otherwise the first run builds it.' },
      { group: 'macos', subject: 'Screen Recording', ok: true, text: "on for the terminal or agent that runs Retest, which the capture of a macOS app's window needs" },
    ])
    assert.deepEqual(launched, [], 'nothing was started')
  })

  test('add nothing to a doctor run whose targets use no pinned build, and fetch nothing', async () => {
    const { home } = temporaryCache()
    const config = loadedConfig(project, { apps: { web: chrome() } })
    const checks = await runChecks(config, {
      dependencies: {
        resolveExecutable: () => ({ ok: true, path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' }),
        launchBrowser: async (options) => fakeBrowser(options.executablePath),
        probeReady: async () => true,
        startAppServer: () => Promise.reject(new Error('no server is started')),
        env: { HOME: home },
        signal: new AbortController().signal,
      },
      timeouts: defaultTimeouts,
      logFolder: join(project, '.retest', 'doctor'),
    })
    assert.deepEqual(checks.map((check) => check.group), ['web'])

  })
})
