import type { SourcePin } from '../../src/browser/builds.ts'
import type { LoadedNativeTarget } from '../../src/config/loaded.ts'
import type { ExecutorBuild } from '../../src/native/executors.ts'
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { buildFolder, findPin } from '../../src/browser/builds.ts'
import { checkNativeTarget, checkScreenRecording } from '../../src/cli/install/doctor-rows.ts'
import { chromium } from '../../src/config/define.ts'
import { folderChecksum } from '../../src/native/executors.ts'
import { sha256Hex } from '../../src/shared/sha256.ts'
import { tempFolder } from '../support/temp-folder.ts'
import { temporaryCache, writeEntries } from './builds-fixtures.ts'
import { loadedConfig } from './cli-fixtures.ts'
import { fakeTools } from './native-fake-tools.ts'

// The row doctor gives a native target, from the executor build recorded in the cache and nothing else. The real pins'
// folders and commits, with licence files of the test's own, since only a real build has the real texts.

// An app bundle is a folder; the row checks only that it is there.
const appPath = join(tempFolder('retest-native-app-'), 'Tasks.app')
mkdirSync(join(appPath, 'Contents'), { recursive: true })
const iphone: LoadedNativeTarget = { name: 'ios-simulator', platform: 'ios-simulator', appPath, device: 'iPhone 17', runtime: '26.0' }
const mac: LoadedNativeTarget = { name: 'macos', platform: 'macos', appPath }

function standIn(engine: 'webdriveragent' | 'mac2'): SourcePin {
  const real = findPin(engine, 'mac-arm64')
  assert.ok(real?.kind === 'source')
  return { ...real, licences: { inspected: true, files: [{ path: 'licenses/Stand-in-LICENSE.txt', title: 'a licence text', licence: 'BSD-3-Clause', sha256: sha256Hex('licence text\n'), published: true }] } }
}

async function writeBuild(folders: { browsers: string; executors: string }, pin: SourcePin): Promise<string> {
  const folder = buildFolder(folders, pin)
  await writeEntries(folder, { 'licenses/Stand-in-LICENSE.txt': 'licence text\n', 'derived/Build/Products/Debug/Runner.app/runner': 'runner', 'derived/Build/Products/runner.xctestrun': 'xctestrun' })
  const products = join(folder, 'derived/Build/Products/Debug')
  const build: ExecutorBuild = {
    schemaVersion: 1,
    executor: pin.engine,
    version: pin.version,
    commit: pin.commit,
    key: 'key',
    xcode: pin.xcode,
    sdk: 'macosx26.5',
    architecture: 'arm64',
    origin: 'built',
    derivedDataPath: join(folder, 'derived'),
    xctestrun: join(folder, 'derived/Build/Products/runner.xctestrun'),
    products,
    productsSha256: await folderChecksum(products),
    xctestrunSha256: sha256Hex('xctestrun'),
    recordedAt: '2026-10-03T19:01:55.011Z',
    licenses: [{ path: join(folder, 'licenses/Stand-in-LICENSE.txt'), spdx: 'BSD-3-Clause', sha256: sha256Hex('licence text\n') }],
    notices: [],
  }
  await writeFile(join(folder, 'build.json'), JSON.stringify(build))
  return folder
}

describe("doctor's row for a native target", () => {
  test('names the executor built in the cache and the app, says it starts nothing, and names a damaged one with its fix', async () => {
    const { home, folders } = temporaryCache()
    const pin = standIn('mac2')
    const options = { platform: 'mac-arm64' as const, pins: [pin] }
    const request = { app: 'desk', subject: "{ platform: 'macos' }", target: mac, env: { HOME: home } }
    assert.deepEqual(await checkNativeTarget(request, options), { group: 'desk', subject: "{ platform: 'macos' }", ok: false, text: "WebDriverAgentMac (appium-mac2-driver) 4.3.6 is not built in Retest's cache", fix: 'Run npx retest install mac2 to build it from its pinned commit; otherwise the first run builds it.' })
    const folder = await writeBuild(folders, pin)
    const products = await folderChecksum(join(folder, 'derived/Build/Products/Debug'))
    assert.deepEqual(await checkNativeTarget(request, options), { group: 'desk', subject: "{ platform: 'macos' }", ok: true, text: `WebDriverAgentMac (appium-mac2-driver) 4.3.6 built in Retest's cache · products sha256 ${products.slice(0, 12)}, and the app is there; doctor starts neither`, detail: folder })
    const elsewhere = join(tempFolder('retest-native-app-'), 'Gone.app')
    assert.deepEqual(await checkNativeTarget({ ...request, target: { ...mac, appPath: elsewhere } }, options), { group: 'desk', subject: "{ platform: 'macos' }", ok: false, text: `No app at ${elsewhere}, the path appPath gives.`, fix: 'Build the app there, or change the path.' })
    await rm(join(folder, 'licenses/Stand-in-LICENSE.txt'))
    assert.deepEqual(await checkNativeTarget(request, options), { group: 'desk', subject: "{ platform: 'macos' }", ok: false, text: `WebDriverAgentMac (appium-mac2-driver) 4.3.6 in ${folder} does not match its record: ${join(folder, 'licenses/Stand-in-LICENSE.txt')} is missing.`, fix: `Remove ${folder} and run npx retest install mac2 again; a macOS runner built again needs its permissions granted again.` })
  })

  test('reads WebDriverAgent for an iOS simulator app, and says why there is nothing to read without a cache or a pin', async () => {
    const { home, folders } = temporaryCache()
    const pin = standIn('webdriveragent')
    const request = { app: 'phone', subject: 'phone', target: iphone, env: { HOME: home } }
    const folder = await writeBuild(folders, pin)
    const row = await checkNativeTarget(request, { platform: 'mac-arm64', pins: [pin] })
    assert.equal(row.ok, true)
    assert.equal(row.detail, folder)
    assert.match(row.text, /^WebDriverAgent 16\.13\.6 built in Retest's cache/)
    assert.deepEqual(await checkNativeTarget({ ...request, env: {} }, { platform: 'mac-arm64', pins: [pin] }), { group: 'phone', subject: 'phone', ok: false, text: 'HOME is not set to an absolute folder, so Retest has no cache to read the WebDriverAgent 16.13.6 build from.' })
    assert.deepEqual(await checkNativeTarget(request, { platform: 'linux-x64', pins: [pin] }), { group: 'phone', subject: 'phone', ok: false, text: 'Retest builds the webdriveragent executor only on macOS arm64, and this machine is Linux x64, so the target ios-simulator of the app phone cannot start.' })
  })
})

describe("doctor's Screen Recording row", () => {
  const darwinOnly = { skip: process.platform === 'darwin' ? false : 'the row is read only on a Mac' }
  const grant = 'macOS grants it in System Settings, Privacy & Security, Screen & System Audio Recording, and that app may need a relaunch.'

  test('says whether the terminal or agent that runs Retest may record the screen, for a config with a macOS app', darwinOnly, async (t) => {
    const fake = await fakeTools(t)
    const config = loadedConfig(tempFolder('retest-doctor-screen-'), { apps: { desk: { platform: 'macos', appPath }, phone: { platform: 'ios-simulator', appPath, device: 'iPhone 17', runtime: '26.0' } } })
    const row = { group: 'macos', subject: 'Screen Recording' }
    await fake.configure({ screenRecording: 'on' })
    assert.deepEqual(await checkScreenRecording(config, { tools: fake.tools }), [{ ...row, ok: true, text: "on for the terminal or agent that runs Retest, which the capture of a macOS app's window needs" }])
    await fake.configure({ screenRecording: 'off' })
    assert.deepEqual(await checkScreenRecording(config, { tools: fake.tools }), [{ ...row, ok: false, text: "Screen Recording is off for the terminal or agent that runs Retest, so Retest cannot capture a macOS app's window.", fix: grant }])
    await fake.configure({ screenRecording: 'unreadable' })
    assert.deepEqual(await checkScreenRecording(config, { tools: fake.tools }), [{ ...row, ok: false, text: 'Retest could not read whether the terminal or agent that runs Retest may record the screen (osascript ended with exit code 1: execution error: Error: the CoreGraphics bridge did not answer (-2700)).', fix: grant }])
    const asked = (await fake.calls()).filter((call) => call.tool === 'osascript')
    assert.equal(asked.length, 3)
    assert.ok(asked.every((call) => call.args.join(' ').includes('CGPreflightScreenCaptureAccess')), 'only the preflight is read, never a capture')
  })

  test('is not read for a config whose apps are an iOS simulator app and a browser', darwinOnly, async (t) => {
    const fake = await fakeTools(t)
    const config = loadedConfig(tempFolder('retest-doctor-screen-'), { apps: { phone: { platform: 'ios-simulator', appPath, device: 'iPhone 17', runtime: '26.0' }, web: chromium() } })
    assert.deepEqual(await checkScreenRecording(config, { tools: fake.tools }), [])
    assert.deepEqual(await fake.calls(), [])
  })
})
