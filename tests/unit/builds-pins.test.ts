import type { BuildEngine, BuildPin } from '../../src/browser/builds.ts'
import assert from 'node:assert/strict'
import { basename } from 'node:path'
import { describe, test } from 'node:test'
import { buildEngines, buildFolder, buildPlatform, cacheFolders, describePin, findPin, pinnedBuilds, pinRefusal, readBundledLicence } from '../../src/browser/builds.ts'
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
      assert.equal(buildFolder(folders, pin), `/cache/retest/native-executors/${engine}-${native.version}-${pinKey(native, nativePins.toolchain, 'arm64')}`)
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
  })

  test('names a browser build folder after its engine, version and platform', () => {
    const folders = { browsers: '/cache/retest/browsers', executors: '/cache/retest/native-executors' }
    const electron = findPin('electron', 'mac-arm64')
    const linux = findPin('chromium', 'linux-x64')
    assert.ok(electron !== undefined && linux !== undefined)
    assert.equal(buildFolder(folders, electron), '/cache/retest/browsers/electron-44.5.1-mac-arm64')
    assert.equal(buildFolder(folders, linux), '/cache/retest/browsers/chromium-153.0.8010.12-linux-x64')
  })

  test('knows only the two platforms it pins for', () => {
    assert.equal(buildPlatform('darwin', 'arm64'), 'mac-arm64')
    assert.equal(buildPlatform('linux', 'x64'), 'linux-x64')
    assert.equal(buildPlatform('darwin', 'x64'), undefined)
    assert.equal(buildPlatform('linux', 'arm64'), undefined)
    assert.equal(buildPlatform('win32', 'x64'), undefined)
  })
})
