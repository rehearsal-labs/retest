import type { BuildEngine, BuildPin } from '../../src/browser/builds.ts'
import assert from 'node:assert/strict'
import { basename, join } from 'node:path'
import { describe, test } from 'node:test'
import { buildEngines, buildFolder, buildPlatform, cacheFolders, cacheVariable, describePin, describePlatform, environmentVariable, findPin, installedExecutablePath, pinnedBuilds, pinRefusal, readBundledLicence, unpinnedMessage } from '../../src/browser/builds.ts'
import { nativePins, pinKey } from '../../src/native/executors.ts'

const hex = /^[0-9a-f]{64}$/
const publishers: Readonly<Record<string, string>> = {
  chromium: 'storage.googleapis.com',
  firefox: 'archive.mozilla.org',
  webkit: 'cdn.playwright.dev',
  electron: 'github.com',
}

function sha256sOf(pin: BuildPin): string[] {
  const licences = pin.licences.inspected ? pin.licences.files.flatMap((file) => (file.sha256 === undefined ? [] : [file.sha256])) : []
  if (pin.kind === 'source') return licences
  return [
    ...(pin.archive.sha256 === undefined ? [] : [pin.archive.sha256]),
    ...(pin.executable.sha256 === undefined ? [] : [pin.executable.sha256]),
    ...(pin.treeSha256 === undefined ? [] : [pin.treeSha256]),
    ...pin.files.map((file) => file.sha256),
    ...licences,
  ]
}

describe('the pinned builds', () => {
  test('pin every engine on macOS arm64, and only Chromium on Linux x64', () => {
    for (const engine of buildEngines) assert.ok(findPin(engine, 'mac-arm64') !== undefined, `${engine} has a macOS arm64 pin`)
    assert.deepEqual(pinnedBuilds.filter((pin) => pin.platform === 'linux-x64').map((pin) => pin.engine), ['chromium'])
    for (const engine of ['firefox', 'webkit', 'electron', 'webdriveragent', 'mac2'] satisfies BuildEngine[]) assert.equal(findPin(engine, 'linux-x64'), undefined, `${engine} is not pinned for Linux`)
    const keys = pinnedBuilds.map((pin) => `${pin.engine} ${pin.platform}`)
    assert.equal(new Set(keys).size, keys.length, 'one pin per engine and platform')
  })

  test('pin Chromium, Firefox and Electron on Windows x64, and no WebKit build or native executor', () => {
    assert.deepEqual(pinnedBuilds.filter((pin) => pin.platform === 'win-x64').map((pin) => pin.engine), ['chromium', 'firefox', 'electron'])
    for (const engine of ['webkit', 'webdriveragent', 'mac2'] satisfies BuildEngine[]) assert.equal(findPin(engine, 'win-x64'), undefined, `${engine} is not pinned for Windows`)
    assert.equal(unpinnedMessage('webkit', 'win-x64'), 'Retest does not run WebKit on Windows, so there is no WebKit build to install.')
    assert.equal(unpinnedMessage('mac2', 'win-x64'), 'Retest pins no mac2 build for Windows x64.')
    assert.equal(unpinnedMessage('firefox', 'linux-x64'), 'Retest pins no firefox build for Linux x64.')
  })

  test('make the three Windows x64 pins installable from the releases the other platforms pin, with measured checksums and notices', () => {
    const expected = {
      chromium: { version: '153.0.8010.12', format: 'zip', url: 'https://storage.googleapis.com/chrome-for-testing-public/153.0.8010.12/win64/chrome-win64.zip', size: 205_123_748, sha256: '415968b02065d4a9e2c10b85f0ae9f489b8fba500e94d9d0a7b7c4852a7234c1', executable: 'chrome-win64/chrome.exe', executableSha256: '9b07943f834485b43c9d54caea2951c78715f9f07070a80ab6658465ebd3e711', licences: [['chrome-win64/ABOUT', '122b32f3ee3f1e8d65c774f5257fc6cc2127b666148ced0ce2efa3ea57e1d93c']] },
      firefox: { version: '158.0.1', format: 'exe', url: 'https://archive.mozilla.org/pub/firefox/releases/158.0.1/win64/en-US/Firefox%20Setup%20158.0.1.exe', size: 94_890_968, sha256: '3259a2f8508e58cf2e383b6c99bfc64d6ddc86d1407b7c2f86f660af955b5d10', executable: 'core/firefox.exe', executableSha256: '76732d4e43c864194660c671c52ecf4bad89e43b666d9a0acf89cd4b692ced9b', licences: [['core/omni.ja', '42f976ac57103698320728a9c134ec8e710ab9a3c48d127ea3e115e1b3b211c3']] },
      electron: { version: '44.5.1', format: 'zip', url: 'https://github.com/electron/electron/releases/download/v44.5.1/electron-v44.5.1-win32-x64.zip', size: 157_998_329, sha256: '9b382492dcfee91f8f9e92c91f7972550a1b95d2299cac72279dab33a600d7db', executable: 'electron.exe', executableSha256: '49b61a030a520fc36a4b8fa5cce53fb4e935a7bdbbe4b80e9222f598e49cc7fa', licences: [['LICENSE', '5154e165bd6c2cc0cfbcd8916498c7abab0497923bafcd5cb07673fe8480087d'], ['LICENSES.chromium.html', '7b328b8c7463ac9bfc7dc648c751533517c8441a0b5b21047d6c0b2620e60d70']] },
    } as const
    for (const [engine, facts] of Object.entries(expected)) {
      const pin = findPin(engine as BuildEngine, 'win-x64')
      assert.ok(pin?.kind === 'archive' && pin.licences.inspected, `${engine} has a Windows x64 archive pin`)
      assert.equal(pinRefusal(pin), undefined, `${engine} can be installed`)
      assert.equal(pin.version, findPin(engine as BuildEngine, 'mac-arm64')?.version, `${engine} is the release macOS pins`)
      assert.deepEqual([pin.version, pin.archive.format, pin.archive.url, pin.archive.size, pin.archive.sha256], [facts.version, facts.format, facts.url, facts.size, facts.sha256], engine)
      assert.deepEqual([pin.executable.path, pin.executable.sha256], [facts.executable, facts.executableSha256], engine)
      assert.deepEqual(pin.licences.files.map((file) => [file.path, file.sha256]), facts.licences, engine)
      assert.ok(pin.licences.files.every((file) => file.published && file.bundled === undefined), `${engine} carries its own notices`)
      assert.equal(installedExecutablePath(join('/cache', 'browsers', 'build-folder'), pin), join('/cache', 'browsers', 'build-folder', 'build', ...facts.executable.split('/')))
    }
    const firefox = findPin('firefox', 'win-x64')
    assert.ok(firefox?.kind === 'archive' && firefox.archive.format === 'exe')
    assert.equal(firefox.archive.folder, 'core', 'only the core folder of the installer is unpacked')
    assert.equal(firefox.build, '20261019185856')
    const electron = findPin('electron', 'win-x64')
    assert.equal(electron?.kind === 'archive' ? electron.treeSha256 : undefined, '0a50669f7461801821ab9d01ee2193748d36f45b6235bcfd648ed9a44a175e30', 'the tree checksum read on Windows')
  })

  test("fetch each archive from its publisher's own address, over https", () => {
    for (const pin of pinnedBuilds) {
      if (pin.kind !== 'archive') continue
      const url = new URL(pin.archive.url)
      assert.equal(url.protocol, 'https:', pin.archive.url)
      assert.equal(url.host, publishers[pin.engine], pin.archive.url)
      if (pin.archive.checksums !== undefined) assert.equal(new URL(pin.archive.checksums).protocol, 'https:')
      assert.ok(pin.provenance.length > 0, `${describePin(pin)} says where its facts come from`)
    }
  })

  test('hold every checksum as 64 lowercase hex digits, and every licence path inside the build', () => {
    for (const pin of pinnedBuilds) {
      for (const sha256 of sha256sOf(pin)) assert.match(sha256, hex, describePin(pin))
      if (!pin.licences.inspected) continue
      for (const file of pin.licences.files) {
        assert.ok(!file.path.startsWith('/') && !file.path.split('/').includes('..'), file.path)
        assert.ok(file.title.length > 0 && file.licence.length > 0, file.path)
      }
    }
  })

  test('make the four macOS archive pins installable with measured checksums, and retain all nine inspected WebKit notices', () => {
    const electron = findPin('electron', 'mac-arm64')
    assert.ok(electron?.kind === 'archive')
    assert.equal(pinRefusal(electron), undefined)
    assert.equal(electron.archive.sha256, '1d75703019bb16461ae65f3081d7e6f5c0b11e901d0ccb5c343bcf7bcdd6435c')
    assert.equal(electron.archive.size, 130_259_261)
    for (const engine of ['chromium', 'firefox', 'webkit'] satisfies BuildEngine[]) {
      const pin = findPin(engine, 'mac-arm64')
      assert.ok(pin?.kind === 'archive')
      assert.equal(pinRefusal(pin), undefined, `${engine} can be installed`)
      assert.match(pin.archive.sha256 ?? '', hex)
      assert.ok(pin.archive.size !== undefined && pin.archive.size > 0)
    }
    const linux = findPin('chromium', 'linux-x64')
    assert.ok(linux !== undefined)
    assert.ok(linux.kind === 'archive' && linux.licences.inspected)
    assert.equal(pinRefusal(linux), undefined)
    assert.equal(linux.archive.sha256, '8aac35011c18f6e2d10696154af89a5728ac2ddd6dc6fad24ffdf243c3fcfd5a')
    assert.equal(linux.archive.size, 195_836_009)
    assert.equal(linux.executable.sha256, '8c599d43aec53f2460a31ae2f4af6bd863f8258b34ff519564bc5d4726bfaa1e')
    assert.deepEqual(linux.licences.files.map(file => file.path), ['chrome-linux64/ABOUT', 'chrome-linux64/WidevineCdm/LICENSE'])
    const webkit = findPin('webkit', 'mac-arm64')
    assert.ok(webkit !== undefined)
    const refusal = pinRefusal(webkit)
    const missing = ['WebKit-LGPL-2.1.txt', 'WebKit-BSD-2-Clause.txt', 'ANGLE-LICENSE.txt', 'WebRTC-LICENSE.txt', 'BoringSSL-LICENSE.txt', 'abseil-cpp-LICENSE.txt', 'libvpx-LICENSE.txt', 'swiftCompatibilitySpan-LICENSE.txt', 'SOURCE.txt'].map((name) => `licenses/${name}`)
    assert.equal(refusal, undefined)
    assert.ok(webkit.licences.inspected)
    assert.deepEqual(webkit.licences.files.filter((file) => file.bundled !== undefined).map((file) => file.path), missing)
    for (const file of webkit.licences.files.filter((file) => file.bundled !== undefined)) {
      const reading = readBundledLicence(file)
      assert.ok(reading.ok, `${file.path}: ${reading.ok ? '' : reading.problem}`)
      assert.equal(reading.sha256, file.sha256)
      assert.ok(reading.bytes.length > 100, file.path)
    }
    assert.equal(pinRefusal(webkit)?.lead, undefined)
  })

  test('a missing bundled WebKit notice refuses the checksummed pin by installed file name', () => {
    const webkit = findPin('webkit', 'mac-arm64')
    assert.ok(webkit?.kind === 'archive' && webkit.licences.inspected)
    const files = webkit.licences.files.map((file) => file.path === 'licenses/ANGLE-LICENSE.txt' ? { ...file, bundled: 'webkit/missing-notice.txt' } : file)
    const refusal = pinRefusal({ ...webkit, licences: { inspected: true, files } })
    assert.deepEqual(refusal?.missing.map((file) => file.path), ['licenses/ANGLE-LICENSE.txt'])
    assert.match(refusal?.message ?? '', /licenses\/ANGLE-LICENSE\.txt.*bundled notice is missing/)
    assert.doesNotMatch(refusal?.message ?? '', /No checksum is pinned/)
  })

  test('pin the WebKit build together with its protocol, as the proof did', () => {
    const webkit = findPin('webkit', 'mac-arm64')
    assert.ok(webkit?.kind === 'archive')
    assert.equal(webkit.build, '2359')
    assert.deepEqual(webkit.files.map((file) => [file.path, file.sha256]), [['protocol.json', '5962bc790bde7750ce127029962a6c1bd93aed884cbcf832da8393c2a12c106c']])
    assert.equal(webkit.executable.sha256, '7ba0926c43809db8753af995978a340316fe3fddcbf9a21648fe934994ceaf9f')
    assert.deepEqual(webkit.sourceCode, { repository: 'https://github.com/WebKit/WebKit', revision: '4d05d732e5a84f32675bef4cc135a2e7a9269a87', patches: 'https://github.com/microsoft/playwright/tree/v1.63.0/browser_patches/webkit' })
    assert.equal(webkit.archive.sha256, 'f0c43ff8a566ef9cf57b5c0e349d985c60e6ffeb7416e8aac34a5c911bbb8ca7')
    assert.equal(webkit.archive.size, 81_853_194)
  })

  test('take the native executors from the executor pin, with the licence files their build step copies', () => {
    for (const engine of ['webdriveragent', 'mac2'] as const) {
      const pin = findPin(engine, 'mac-arm64')
      const native = nativePins.executors[engine]
      assert.ok(pin?.kind === 'source')
      assert.deepEqual([pin.version, pin.commit, pin.repository, pin.xcode], [native.version, native.commit, native.repository, nativePins.toolchain.xcode])
      const expected = [...native.licenses.map((license) => license.copiedAs), ...native.headerNotices.map((notice) => notice.copiedAs), ...(engine === 'mac2' ? ['appium-mac2-driver-FACEBOOK-BSD-NOTICE.txt'] : [])]
      assert.deepEqual(pin.licences.files.map((file) => basename(file.path)), expected)
      for (const license of native.licenses) assert.equal(pin.licences.files.find((file) => file.path === `licenses/${license.copiedAs}`)?.sha256, license.sha256)
      const folders = { browsers: '/cache/retest/browsers', executors: '/cache/retest/native-executors' }
      assert.equal(buildFolder(folders, pin), join('/cache/retest/native-executors', `${engine}-${native.version}-${pinKey(native, nativePins.toolchain, 'arm64')}`))
      assert.equal(pinRefusal(pin), undefined)
    }
  })
})

describe('the cache', () => {
  test('lives under the user cache folder of each system', () => {
    assert.deepEqual(cacheFolders({ HOME: '/Users/ada' }, 'darwin'), { browsers: '/Users/ada/Library/Caches/retest/browsers', executors: '/Users/ada/Library/Caches/retest/native-executors' })
    assert.deepEqual(cacheFolders({ HOME: '/home/ada' }, 'linux'), { browsers: '/home/ada/.cache/retest/browsers', executors: '/home/ada/.cache/retest/native-executors' })
    assert.equal(cacheFolders({ HOME: '/home/ada', XDG_CACHE_HOME: '/var/cache/ada' }, 'linux')?.browsers, '/var/cache/ada/retest/browsers')
    assert.equal(cacheFolders({ HOME: '/home/ada', XDG_CACHE_HOME: 'relative/cache' }, 'linux')?.browsers, '/home/ada/.cache/retest/browsers', 'a relative XDG_CACHE_HOME is ignored, as the specification says')
    assert.equal(cacheFolders({ HOME: '/Users/ada', XDG_CACHE_HOME: '/elsewhere' }, 'darwin')?.browsers, '/Users/ada/Library/Caches/retest/browsers')
    assert.equal(cacheFolders({}, 'darwin'), undefined)
    assert.equal(cacheFolders({ HOME: 'relative' }, 'linux'), undefined)
    assert.deepEqual(cacheFolders({ LOCALAPPDATA: 'C:\\Users\\ada\\AppData\\Local' }, 'win32'), { browsers: 'C:\\Users\\ada\\AppData\\Local\\retest\\browsers', executors: 'C:\\Users\\ada\\AppData\\Local\\retest\\native-executors' })
    assert.equal(cacheFolders({ LocalAppData: 'D:\\Profiles\\ada' }, 'win32')?.browsers, 'D:\\Profiles\\ada\\retest\\browsers', 'Windows reads a variable by any spelling of its name')
    assert.equal(cacheFolders({ HOME: 'C:\\Users\\ada' }, 'win32'), undefined, 'Windows keeps caches under the local application data, not HOME')
    assert.equal(cacheFolders({ LOCALAPPDATA: 'AppData\\Local' }, 'win32'), undefined)
    assert.equal(cacheFolders({ LocalAppData: '/home/ada' }, 'linux'), undefined, 'names differ by case on macOS and Linux')
    assert.deepEqual([cacheVariable('win32'), cacheVariable('darwin'), cacheVariable('linux')], ['LOCALAPPDATA', 'HOME', 'HOME'])
  })

  test('reads an environment variable by its exact name, and on Windows by any spelling of it', () => {
    assert.equal(environmentVariable({ ProgramFiles: 'C:\\Program Files' }, 'PROGRAMFILES', 'win32'), 'C:\\Program Files')
    assert.equal(environmentVariable({ PROGRAMFILES: 'C:\\Program Files', ProgramFiles: 'D:\\Programs' }, 'ProgramFiles', 'win32'), 'D:\\Programs', 'the exact spelling wins')
    assert.equal(environmentVariable({ ProgramFiles: '/opt' }, 'PROGRAMFILES', 'linux'), undefined)
    assert.equal(environmentVariable({}, 'HOME', 'win32'), undefined)
  })

  test('names a browser build folder after its engine, version and platform', () => {
    const folders = { browsers: '/cache/retest/browsers', executors: '/cache/retest/native-executors' }
    const electron = findPin('electron', 'mac-arm64')
    const linux = findPin('chromium', 'linux-x64')
    assert.ok(electron !== undefined && linux !== undefined)
    assert.equal(buildFolder(folders, electron), join('/cache/retest/browsers', 'electron-44.5.1-mac-arm64'))
    assert.equal(buildFolder(folders, linux), join('/cache/retest/browsers', 'chromium-153.0.8010.12-linux-x64'))
    const windows = findPin('firefox', 'win-x64')
    assert.ok(windows !== undefined)
    assert.equal(buildFolder(folders, windows), join('/cache/retest/browsers', 'firefox-158.0.1-win-x64'))
  })

  test('knows the three platforms it pins for, and names each', () => {
    assert.equal(buildPlatform('darwin', 'arm64'), 'mac-arm64')
    assert.equal(buildPlatform('linux', 'x64'), 'linux-x64')
    assert.equal(buildPlatform('win32', 'x64'), 'win-x64')
    assert.equal(buildPlatform('darwin', 'x64'), undefined)
    assert.equal(buildPlatform('linux', 'arm64'), undefined)
    assert.equal(buildPlatform('win32', 'arm64'), undefined, 'Windows on Arm is not pinned')
    assert.deepEqual([describePlatform('mac-arm64'), describePlatform('linux-x64'), describePlatform('win-x64')], ['macOS arm64', 'Linux x64', 'Windows x64'])
  })
})
