import type { ExecutorBuild, ExecutorName } from '../native/executors.ts'
import type { Schema } from '../protocol/schema.ts'
import type { FileReading } from '../shared/regular-file.ts'
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { access, lstat, readdir, readlink } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { folderChecksum, nativePins, pinKey, readBuildRecord } from '../native/executors.ts'
import { errorMessage } from '../protocol/failures.ts'
import { parse, s } from '../protocol/schema.ts'
import { isMissingFile } from '../shared/error-code.ts'
import { entryKind, readFileSha256 as readRegularFileSha256, readRecordText } from '../shared/regular-file.ts'

// The browser, Electron and native executor builds Retest was tested with, as data, and the cache they are installed
// into. Nothing here touches the network: `retest install` downloads a pinned archive only when it is asked to, and
// every reading of the cache below is of files already on disk.

/** An engine Retest pins a build of: three browsers, Electron, and the two native executors. */
export type BuildEngine = 'chromium' | 'firefox' | 'webkit' | 'electron' | 'webdriveragent' | 'mac2'

/** The engines whose build is a published archive Retest downloads; the native executors are built from source. */
export type ArchiveEngine = Exclude<BuildEngine, ExecutorName>

/** A machine a build is pinned for. */
export type BuildPlatform = 'mac-arm64' | 'linux-x64'

/** Every engine, in the order lists show them. */
export const buildEngines: readonly BuildEngine[] = ['chromium', 'firefox', 'webkit', 'electron', 'webdriveragent', 'mac2']

/**
 * A licence text or notice a build must carry before Retest installs it. `path` is where it sits in the installed
 * build. When `published` is false, Retest must supply a checksummed bundled copy or refuse the build by file name.
 */
export type LicenceFile = {
  readonly path: string
  /** What the file is, in words. */
  readonly title: string
  /** The licence it carries, as an SPDX identifier where one applies. */
  readonly licence: string
  /** Its SHA-256, when the pin knows it. */
  readonly sha256?: string
  readonly published: boolean
  /** A notice Retest supplies when the published archive omits it, relative to the installer's licences folder. */
  readonly bundled?: string
}

/** Public source pointers retained beside a build. They do not assert a verified binary-to-source correspondence. */
export type BuildSourceCode = { repository: string; revision: string; patches: string }

/** What a pin knows of a build's licence notices: the files it must carry, or that nobody has looked yet. */
export type PinnedLicences = { readonly inspected: true; readonly files: readonly LicenceFile[] } | { readonly inspected: false; readonly reason: string }

/** How a published archive is packed: a zip, or a macOS disk image holding one app bundle that is copied out. */
export type ArchiveFormat = { readonly format: 'zip' } | { readonly format: 'dmg'; readonly app: string }

/** A file of an installed build whose bytes are pinned, beside its executable and licences, and why. */
export type PinnedFile = { readonly path: string; readonly sha256: string; readonly why: string }

/** A browser or Electron build Retest downloads as its publisher's archive, and what the installed build must hold. */
export type ArchivePin = {
  readonly kind: 'archive'
  readonly engine: ArchiveEngine
  readonly title: string
  readonly version: string
  /** The publisher's build number or revision, when it has one beside the version. */
  readonly build?: string
  readonly platform: BuildPlatform
  readonly archive: ArchiveFormat & {
    /** The publisher's own address for the archive. */
    readonly url: string
    readonly size?: number
    /** The archive's SHA-256. Without it Retest has nothing to check a download against, and downloads nothing. */
    readonly sha256?: string
    /** Where the publisher lists its own checksums, when it does. */
    readonly checksums?: string
  }
  /** The binary a target launches, relative to the installed build. */
  readonly executable: { readonly path: string; readonly sha256?: string }
  readonly files: readonly PinnedFile[]
  readonly licences: PinnedLicences
  /** The SHA-256 of the whole unpacked build, as `folderChecksum` reads it, when it was taken from a verified unpack. */
  readonly treeSha256?: string
  /** Where each fact of this pin was read. */
  readonly provenance: string
  readonly sourceCode?: BuildSourceCode
}

/** A native executor Retest builds on this Mac from a pinned commit, with the licence files the build keeps beside it. */
export type SourcePin = {
  readonly kind: 'source'
  readonly engine: ExecutorName
  readonly title: string
  readonly version: string
  readonly platform: 'mac-arm64'
  readonly repository: string
  readonly commit: string
  readonly xcode: { readonly version: string; readonly build: string }
  readonly licences: { readonly inspected: true; readonly files: readonly LicenceFile[] }
  readonly provenance: string
}

export type BuildPin = ArchivePin | SourcePin

const chromiumVersion = '153.0.8010.12'
const chromeForTesting = 'https://storage.googleapis.com/chrome-for-testing-public'
const macChrome = 'chrome-mac-arm64/Google Chrome for Testing.app'

// Authorized Linux archive observations, retained beside the pin table without adding unsupported install pins.
// Firefox 133.0.3: https://archive.mozilla.org/pub/firefox/releases/133.0.3/linux-x86_64/en-US/firefox-133.0.3.tar.bz2
// 89_495_132 bytes; SHA-256 43713e238d0153fdbf1ab46dd76c6b01ab83fae197b5dc3a95087f51907ba44d.
// WebKit build 2359: https://cdn.playwright.dev/dbazure/download/playwright/builds/webkit/2359/webkit-debian-13.zip
// 99_959_260 bytes; SHA-256 6c402e84b829a5f0bdee7c86dd0725a21ace8801340542d6422deb0f3a40c4eb.
// Neither platform has an implemented Retest pin here. Commands, contents and limits are in the checksum report.

// WebKit's own licence texts and the notices of the libraries compiled into it, which Playwright's build does not
// carry, and the source revision and patches named by the proof. Retest supplies them, checked against the pin.
// The installed build keeps such files in `licenses/`, as the native
// executor builds keep theirs.
const webkitNotices: readonly LicenceFile[] = [
  { path: 'licenses/WebKit-LGPL-2.1.txt', bundled: 'webkit/WebKit-LGPL-2.1.txt', sha256: 'b634ab5640e258563c536e658cad87080553df6f34f62269a21d554844e58bfe', title: "WebKit's LGPL-2.1 licence text", licence: 'LGPL-2.1', published: false },
  { path: 'licenses/WebKit-BSD-2-Clause.txt', bundled: 'webkit/WebKit-BSD-2-Clause.txt', sha256: '9508673c7ddfdd28d574d536ef2e8a98d38ca1597f9c5a86a247d2210dd45942', title: "WebKit's BSD-2-Clause licence text", licence: 'BSD-2-Clause', published: false },
  { path: 'licenses/ANGLE-LICENSE.txt', bundled: 'webkit/ANGLE-LICENSE.txt', sha256: 'bf4da21bd20bcfb5b60b7ecc67fa864a79be049e21d6178076887f178dd6c71a', title: 'the notice of ANGLE, in libANGLE-shared.dylib', licence: 'BSD-3-Clause', published: false },
  { path: 'licenses/WebRTC-LICENSE.txt', bundled: 'webkit/WebRTC-LICENSE.txt', sha256: 'ab00a482b6a3902e40211b43c5d0441962ea99b6cc7c25c0f243fa270b78d482', title: 'the notice of WebRTC, in libwebrtc.dylib', licence: 'BSD-3-Clause', published: false },
  { path: 'licenses/BoringSSL-LICENSE.txt', bundled: 'webkit/BoringSSL-LICENSE.txt', sha256: '046ec2a8cf1915f1f354489a2031532f78dc3e023f3a5be4751c9938c73b4920', title: 'the notice of BoringSSL, in libwebrtc.dylib', licence: 'Apache-2.0 AND OpenSSL AND ISC AND BSD-3-Clause', published: false },
  { path: 'licenses/abseil-cpp-LICENSE.txt', bundled: 'webkit/abseil-cpp-LICENSE.txt', sha256: '34cb75d73943f10a7f9a3b0e3e7bf8ef271065eedcb0d47481e7c831b637aeae', title: 'the notice of abseil-cpp, in libwebrtc.dylib', licence: 'Apache-2.0', published: false },
  { path: 'licenses/libvpx-LICENSE.txt', bundled: 'webkit/libvpx-LICENSE.txt', sha256: 'b80a23ff7619a3b5c150cf718b43af5a5b9a2339ff019c562c9938d91303d08c', title: 'the notice of libvpx, in libwebrtc.dylib', licence: 'BSD-3-Clause', published: false },
  { path: 'licenses/swiftCompatibilitySpan-LICENSE.txt', bundled: 'webkit/swiftCompatibilitySpan-LICENSE.txt', sha256: '99d47dad251d8d1e0ce2f26d019f2a8cfd5ca66263084b6f2cf452a86f89b7f2', title: 'the notice of the Swift compatibility library, libswiftCompatibilitySpan.dylib', licence: 'Apache-2.0 WITH Swift-exception', published: false },
  { path: 'licenses/SOURCE.txt', bundled: 'webkit/SOURCE.txt', sha256: '81ea2bf2f192ef3e1975007d5323468f31ccfaa7a2a4353af124fd9f3e7ea270', title: 'where the WebKit revision and the Playwright patches that built this revision are published', licence: 'LGPL-2.1', published: false },
]

const inspectorLicences: readonly LicenceFile[] = [
  ['CodeMirror', 'MIT', '168a4becc968f5001e2ee2e0291b6e4daabafc1894a11ade1e11d56e96096e07'],
  ['three.js', 'MIT', '551f06ddc3dc36b56610aa23db680826ba9d9a02e8f89f7bec05d7fa27401a2b'],
  ['Esprima', 'BSD-2-Clause', '94bcb9959136723aa4fb36e1a6c4d5c662a2369978cfae344dabfb83ae619e79'],
  ['CSSDocumentation', 'MIT', 'b5179f780ec212a434efcc989a2295a140deb0bdb17182d2bf9c5f6f1f1a01c4'],
].map(([name = '', licence = '', sha256 = '']) => ({
  path: `WebInspectorUI.framework/Versions/A/Resources/External/${name}/LICENSE`,
  title: `the licence of ${name}, in the Web Inspector`,
  licence,
  sha256,
  published: true,
}))

// The licence files the executor build step copies beside every build (`src/native/executors.ts`): the pinned licence
// texts, the header notices of files under another licence, and for the macOS runner the BSD notice it writes.
function executorLicences(engine: ExecutorName): LicenceFile[] {
  const pin = nativePins.executors[engine]
  const texts = pin.licenses.map((license) => ({ path: `licenses/${license.copiedAs}`, title: `the licence of ${license.from === 'mac2' ? 'appium-mac2-driver' : 'WebDriverAgent'}`, licence: license.spdx, sha256: license.sha256, published: true }))
  const headers = pin.headerNotices.map((notice) => ({ path: `licenses/${notice.copiedAs}`, title: `the header of ${notice.path}, compiled into the build`, licence: notice.spdx, published: true }))
  const bsd = engine === 'mac2' ? [{ path: `licenses/${macRunnerBsdNotice}`, title: 'the BSD header appium-mac2-driver keeps from WebDriverAgent, with the files that carry it', licence: 'BSD-3-Clause', published: true }] : []
  return [...texts, ...headers, ...bsd]
}

/** The name the executor build step writes the macOS runner's BSD notice under. */
const macRunnerBsdNotice = 'appium-mac2-driver-FACEBOOK-BSD-NOTICE.txt'

function executorPin(engine: ExecutorName): SourcePin {
  const pin = nativePins.executors[engine]
  return {
    kind: 'source',
    engine,
    title: pin.title,
    version: pin.version,
    platform: 'mac-arm64',
    repository: pin.repository,
    commit: pin.commit,
    xcode: nativePins.toolchain.xcode,
    licences: { inspected: true, files: executorLicences(engine) },
    provenance: 'The executor pin in src/native/executors.ts: the commit, Xcode build and licence checksums recorded when the native lane built it.',
  }
}

/**
 * The tested set. Chromium is Chrome for Testing, from Google; Firefox is Mozilla's release; WebKit is Playwright's
 * automation build, the only WebKit build with the inspector pipe Retest drives; Electron is the release its fixture app
 * runs on; the two native executors are built from their pinned commits. Only Chromium is pinned for Linux x64; its archive has been inspected, without a Linux browser execution claim.
 */
export const pinnedBuilds: readonly BuildPin[] = [
  {
    kind: 'archive',
    engine: 'chromium',
    title: 'Chrome for Testing',
    version: chromiumVersion,
    platform: 'mac-arm64',
    archive: { format: 'zip', url: `${chromeForTesting}/${chromiumVersion}/mac-arm64/chrome-mac-arm64.zip`, size: 190_970_181, sha256: '930e2a2c15addbaca1fe9b07bfa520667bced556d7988707186819cb4279ef3b' },
    executable: { path: `${macChrome}/Contents/MacOS/Google Chrome for Testing`, sha256: '8319963f6625accf51c0dd4f55091ceaf9f09ed39e7a52fed4fae12b2a6b668a' },
    files: [],
    licences: {
      inspected: true,
      files: [
        { path: 'chrome-mac-arm64/ABOUT', title: "the build's notice, which names chrome://credits, where the licences compiled into the browser are listed", licence: 'BSD-3-Clause and the licences at chrome://credits', sha256: '34d078ce3003087a8374e7c6156fda374769b8047d6ddaf419d66414aa48edfb', published: true },
        { path: `${macChrome}/Contents/Frameworks/Google Chrome for Testing Framework.framework/Versions/${chromiumVersion}/Libraries/WidevineCdm/LICENSE`, title: "the licence of Google's Widevine module", licence: 'LicenseRef-Widevine', sha256: '20de375707692099b3132084695377ce5fec0aec05813dedcce094b8eda44386', published: true },
      ],
    },
    provenance: 'Version, executable and licence checksums originally read from Playwright revision 1243. The founder-authorized Google publisher download has the pinned executable and both licence files byte for byte. Its measured size and archive checksum are recorded in docs/plans/public-beta/reviews/fix-reports/pin-checksums-report.md.',
  },
  {
    kind: 'archive',
    engine: 'chromium',
    title: 'Chrome for Testing',
    version: chromiumVersion,
    platform: 'linux-x64',
    archive: { format: 'zip', url: `${chromeForTesting}/${chromiumVersion}/linux64/chrome-linux64.zip`, size: 195_836_009, sha256: '8aac35011c18f6e2d10696154af89a5728ac2ddd6dc6fad24ffdf243c3fcfd5a' },
    executable: { path: 'chrome-linux64/chrome', sha256: '8c599d43aec53f2460a31ae2f4af6bd863f8258b34ff519564bc5d4726bfaa1e' },
    files: [],
    licences: {
      inspected: true,
      files: [
        { path: 'chrome-linux64/ABOUT', title: "the build's notice, which names chrome://credits, where the licences compiled into the browser are listed", licence: 'BSD-3-Clause and the licences at chrome://credits', sha256: '34d078ce3003087a8374e7c6156fda374769b8047d6ddaf419d66414aa48edfb', published: true },
        { path: 'chrome-linux64/WidevineCdm/LICENSE', title: "the licence of Google's Widevine module", licence: 'LicenseRef-Widevine', sha256: '20de375707692099b3132084695377ce5fec0aec05813dedcce094b8eda44386', published: true },
      ],
    },
    provenance: 'Archive size and checksum, executable and both licence files read from the founder-authorized Google publisher download. Linux browser execution and installation remain unverified. Exact commands and checksums are in docs/plans/public-beta/reviews/fix-reports/pin-checksums-report.md.',
  },
  {
    kind: 'archive',
    engine: 'firefox',
    title: 'Firefox',
    version: '133.0.3',
    build: '20241209150345',
    platform: 'mac-arm64',
    archive: { format: 'dmg', app: 'Firefox.app', url: 'https://archive.mozilla.org/pub/firefox/releases/133.0.3/mac/en-US/Firefox%20133.0.3.dmg', size: 154_008_053, sha256: '9ceb4fa2120228f287e6c654cef7898b4cce0a659270056276b8884581267d3b', checksums: 'https://archive.mozilla.org/pub/firefox/releases/133.0.3/SHA256SUMS' },
    executable: { path: 'Firefox.app/Contents/MacOS/firefox', sha256: '363eae026f4f5b3a8549f6a9c96a269754094ef12afc5f02cdffbcb4bcbf389c' },
    files: [],
    licences: {
      inspected: true,
      files: [
        { path: 'Firefox.app/Contents/Resources/omni.ja', title: "the archive that holds Firefox's about:license page, chrome/toolkit/content/global/license.html", licence: 'MPL-2.0 and the licences at about:license', sha256: '1ecdc0a4f6de9f562b24417cdaff4d2f17474d51572e65bbc4c7489cf4025c38', published: true },
      ],
    },
    provenance: 'Version, build id, executable and omni.ja checksums originally read from the signed en-US Firefox 133.0.3 in /Applications. The founder-authorized Mozilla disk-image download carries the same executable and omni.ja. The image holds Firefox.app at its root, copied to Firefox.app under the installed build. Archive size, checksum and unpack results are recorded in docs/plans/public-beta/reviews/fix-reports/pin-checksums-report.md. Mozilla SHA256SUMS was not fetched in this pass.',
  },
  {
    kind: 'archive',
    engine: 'webkit',
    title: 'WebKit (Playwright build)',
    version: '26.6',
    build: '2359',
    platform: 'mac-arm64',
    archive: { format: 'zip', url: 'https://cdn.playwright.dev/dbazure/download/playwright/builds/webkit/2359/webkit-mac-26-arm64.zip', size: 81_853_194, sha256: 'f0c43ff8a566ef9cf57b5c0e349d985c60e6ffeb7416e8aac34a5c911bbb8ca7' },
    executable: { path: 'Playwright.app/Contents/MacOS/Playwright', sha256: '7ba0926c43809db8753af995978a340316fe3fddcbf9a21648fe934994ceaf9f' },
    files: [{ path: 'protocol.json', sha256: '5962bc790bde7750ce127029962a6c1bd93aed884cbcf832da8393c2a12c106c', why: 'the protocol Retest\'s WebKit client was written against; another protocol is another build' }],
    licences: { inspected: true, files: [...inspectorLicences, ...webkitNotices] },
    sourceCode: { repository: 'https://github.com/WebKit/WebKit', revision: '4d05d732e5a84f32675bef4cc135a2e7a9269a87', patches: 'https://github.com/microsoft/playwright/tree/v1.63.0/browser_patches/webkit' },
    provenance: 'The founder authorized keeping the nine standard notices. Their texts are retained under src/cli/install/licences/webkit with SHA-256 pins and their sources in SOURCE.txt. The source pointers name the revision in Playwright v1.63.0 UPSTREAM_CONFIG.sh, not a proven binary-to-source correspondence. Revision and original file checksums come from the WebKit proof. The founder-authorized Playwright CDN download has the same executable, protocol and four published inspector notices. Its size and archive checksum are recorded in docs/plans/public-beta/reviews/fix-reports/pin-checksums-report.md.',
  },
  {
    kind: 'archive',
    engine: 'electron',
    title: 'Electron',
    version: '44.5.1',
    platform: 'mac-arm64',
    archive: {
      format: 'zip',
      url: 'https://github.com/electron/electron/releases/download/v44.5.1/electron-v44.5.1-darwin-arm64.zip',
      size: 130_259_261,
      sha256: '1d75703019bb16461ae65f3081d7e6f5c0b11e901d0ccb5c343bcf7bcdd6435c',
      checksums: 'https://github.com/electron/electron/releases/download/v44.5.1/SHASUMS256.txt',
    },
    executable: { path: 'Electron.app/Contents/MacOS/Electron', sha256: 'ca7e3290800255f5018160cff99cf6ecc58eae299c66148de1374a70e2715c83' },
    files: [],
    licences: {
      inspected: true,
      files: [
        { path: 'LICENSE', title: "Electron's licence", licence: 'MIT', sha256: '5154e165bd6c2cc0cfbcd8916498c7abab0497923bafcd5cb07673fe8480087d', published: true },
        { path: 'LICENSES.chromium.html', title: 'the licences of Chromium and the libraries compiled into it', licence: 'BSD-3-Clause and the licences it lists', sha256: 'a62dabd1c6ef1327365b2a3fdffb806222684a746dcb8f4afd1c1f690eba5535', published: true },
      ],
    },
    treeSha256: 'f94a2b748b5f3e41b0ff1938ebd02052bb8af4cf037c2d24d21ffd51c5f7d7b4',
    provenance: "Archive size and checksum from the Electron proof's download (docs/plans/public-beta/proofs/electron.md), which matched the release's SHASUMS256.txt; executable, licence and tree checksums read from that archive unpacked with ditto in ~/Library/Caches/retest-proofs/electron/44.5.1.",
  },
  executorPin('webdriveragent'),
  executorPin('mac2'),
]

/**
 * The platform this machine is, as builds are pinned, or undefined for one Retest pins nothing for.
 *
 * @example buildPlatform('darwin', 'arm64') // 'mac-arm64'
 */
export function buildPlatform(platform: NodeJS.Platform = process.platform, arch: string = process.arch): BuildPlatform | undefined {
  if (platform === 'darwin' && arch === 'arm64') return 'mac-arm64'
  if (platform === 'linux' && arch === 'x64') return 'linux-x64'
  return undefined
}

/** @example describePlatform('linux-x64') // 'Linux x64' */
export function describePlatform(platform: BuildPlatform): string {
  return platform === 'mac-arm64' ? 'macOS arm64' : 'Linux x64'
}

/**
 * The pin of one engine for one platform, if Retest pins one.
 *
 * @example findPin('webkit', 'linux-x64') // undefined
 */
export function findPin(engine: BuildEngine, platform: BuildPlatform, pins: readonly BuildPin[] = pinnedBuilds): BuildPin | undefined {
  return pins.find((pin) => pin.engine === engine && pin.platform === platform)
}

/** @example describePin(findPin('electron', 'mac-arm64')) // 'Electron 44.5.1' */
export function describePin(pin: BuildPin): string {
  const build = pin.kind === 'archive' && pin.build !== undefined ? ` (build ${pin.build})` : ''
  return `${pin.title} ${pin.version}${build}`
}

/**
 * Why Retest refuses to install a pin. `message` names every missing notice; `lead` introduces them when they are
 * listed one to a line.
 */
export type PinRefusal = { readonly message: string; readonly missing: readonly LicenceFile[]; readonly lead?: string }

/**
 * Why Retest does not install a pin, before anything is fetched or built, or undefined when it may: a build whose
 * notices were never looked at, one without the published or bundled notices it must carry, which are named, or an
 * archive with no pinned checksum to check a download against.
 *
 * @example pinRefusal({ ...pin, archive: { format: 'zip', url } })?.message // no archive checksum is pinned
 */
export function pinRefusal(pin: BuildPin): PinRefusal | undefined {
  const name = `${describePin(pin)} for ${describePlatform(pin.platform)}`
  if (!pin.licences.inspected) return { message: `${pin.licences.reason} Retest does not install ${name} until its licence notices are known.`, missing: [] }
  const missing = pin.licences.files.flatMap((file) => {
    if (file.bundled !== undefined) {
      const reading = readBundledLicence(file)
      return reading.ok ? [] : [{ ...file, title: `${file.title}: ${reading.problem}` }]
    }
    return file.published ? [] : [file]
  })
  if (missing.length > 0) {
    const named = missing.map((file) => `${file.path} (${file.title})`).join('; ')
    const lead = `${name} is published without these licence notices, and Retest installs it only once they ship with it:`
    return { message: `${name} is published without these licence notices: ${named}. Retest installs it only once they ship with it.`, missing, lead }
  }
  if (pin.kind === 'archive' && pin.archive.sha256 === undefined) {
    return { message: `No checksum is pinned for the archive of ${name}, so Retest has nothing to check a download against and downloads nothing.`, missing: [] }
  }
  return undefined
}

/** The same package-relative location in source and compiled execution. The release package must retain these files. */
export const bundledLicenceRoot: string = fileURLToPath(new URL('../../src/cli/install/licences/', import.meta.url))

export type BundledLicenceReading = { readonly ok: true; readonly path: string; readonly bytes: Buffer; readonly sha256: string } | { readonly ok: false; readonly problem: string }

/** Read a small pinned notice through a checked, non-following descriptor. Missing or changed notices refuse the pin. */
export function readBundledLicence(file: LicenceFile): BundledLicenceReading {
  if (file.bundled === undefined || !/^[a-z0-9-]+\/[A-Za-z0-9.-]+$/.test(file.bundled)) return { ok: false, problem: 'no portable bundled notice path' }
  if (file.sha256 === undefined) return { ok: false, problem: 'no notice checksum is pinned' }
  const path = join(bundledLicenceRoot, file.bundled)
  let descriptor: number | undefined
  try {
    if (!lstatSync(dirname(path)).isDirectory()) return { ok: false, problem: 'the bundled notice folder is not a directory' }
    const before = lstatSync(path)
    if (!before.isFile() || before.nlink !== 1 || before.size > 256 * 1024) return { ok: false, problem: 'the bundled notice is not a bounded regular file with one name' }
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const opened = fstatSync(descriptor)
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) return { ok: false, problem: 'the bundled notice changed while opened' }
    const buffer = Buffer.alloc(256 * 1024 + 1)
    let length = 0
    while (length < buffer.length) {
      const count = readSync(descriptor, buffer, length, buffer.length - length, length)
      if (count === 0) break
      length += count
    }
    if (length > 256 * 1024) return { ok: false, problem: 'the bundled notice exceeds its byte bound' }
    const bytes = buffer.subarray(0, length)
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    return sha256 === file.sha256 ? { ok: true, path, bytes, sha256 } : { ok: false, problem: `the bundled notice has SHA-256 ${sha256}, not the pinned ${file.sha256}` }
  } catch (error) {
    return { ok: false, problem: isMissingFile(error) ? 'the bundled notice is missing' : `the bundled notice cannot be read: ${errorMessage(error)}` }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
}

/** Where installed builds live: browsers and Electron, and the native executors. */
export type CacheFolders = { readonly browsers: string; readonly executors: string }

/**
 * The cache folders under the user's cache folder: `~/Library/Caches/retest` on macOS, `$XDG_CACHE_HOME/retest` or
 * `~/.cache/retest` on Linux. Undefined without an absolute `HOME`, since there is then no user cache folder.
 *
 * @example cacheFolders({ HOME: '/Users/ada' }, 'darwin')?.browsers // '/Users/ada/Library/Caches/retest/browsers'
 */
export function cacheFolders(env: Readonly<Record<string, string | undefined>>, platform: NodeJS.Platform = process.platform): CacheFolders | undefined {
  const home = env['HOME']
  if (home === undefined || !isAbsolute(home)) return undefined
  const xdg = env['XDG_CACHE_HOME']
  const root = platform === 'darwin' ? join(home, 'Library', 'Caches') : xdg !== undefined && isAbsolute(xdg) ? xdg : join(home, '.cache')
  return { browsers: join(root, 'retest', 'browsers'), executors: join(root, 'retest', 'native-executors') }
}

/**
 * The folder one pin's build is installed in. A browser or Electron build is named after its engine, version and
 * platform; an executor build after its name, version and the key of the tested set, as its build step names it.
 *
 * @example buildFolder(folders, findPin('electron', 'mac-arm64')) // '…/retest/browsers/electron-44.5.1-mac-arm64'
 */
export function buildFolder(folders: CacheFolders, pin: BuildPin): string {
  if (pin.kind === 'source') return join(folders.executors, `${pin.engine}-${pin.version}-${pinKey(nativePins.executors[pin.engine], nativePins.toolchain, 'arm64')}`)
  return join(folders.browsers, `${pin.engine}-${pin.version}-${pin.platform}`)
}

/** The record of an installed build, beside its files. */
export const recordFile = 'build.json'

/** The folder inside a build's folder that holds the unpacked build itself. */
export const treeFolder = 'build'

/**
 * The binary an installed archive build launches. Its path stays the same for as long as the build is installed, so a
 * target's `executablePath` can name it.
 *
 * @example installedExecutablePath(folder, pin) // '…/electron-44.5.1-mac-arm64/build/Electron.app/Contents/MacOS/Electron'
 */
export function installedExecutablePath(folder: string, pin: ArchivePin): string {
  return join(folder, treeFolder, pin.executable.path)
}

/** What `retest install` writes beside an archive build once every check passed. Paths are relative to the build. */
export type InstalledBuildRecord = {
  schemaVersion: 1
  engine: ArchiveEngine
  version: string
  platform: BuildPlatform
  /** The publisher's address the pin names. */
  source: string
  sourceCode?: BuildSourceCode
  /** Where the archive was fetched from, without credentials: the publisher, or a mirror. */
  fetchedFrom: string
  archive: { size: number; sha256: string }
  executable: { path: string; sha256: string }
  files: { path: string; sha256: string }[]
  licences: { path: string; licence: string; sha256: string }[]
  tree: { sha256: string }
  installedAt: string
  installedBy: string
}

const installedRecordSchema: Schema<InstalledBuildRecord> = s.object({
  schemaVersion: s.literal(1),
  engine: s.enum(['chromium', 'firefox', 'webkit', 'electron']),
  version: s.string(),
  platform: s.enum(['mac-arm64', 'linux-x64']),
  source: s.string(),
  sourceCode: s.optional(s.object({ repository: s.string(), revision: s.string(), patches: s.string() })),
  fetchedFrom: s.string(),
  archive: s.object({ size: s.number({ integer: true, min: 0 }), sha256: s.string() }),
  executable: s.object({ path: s.string(), sha256: s.string() }),
  files: s.array(s.object({ path: s.string(), sha256: s.string() })),
  licences: s.array(s.object({ path: s.string(), licence: s.string(), sha256: s.string() })),
  tree: s.object({ sha256: s.string() }),
  installedAt: s.string(),
  installedBy: s.string(),
})

/** A record read from a build folder: found, absent, or present but not one Retest wrote. */
export type RecordReading<T> = { readonly kind: 'found'; readonly record: T } | { readonly kind: 'missing' } | { readonly kind: 'unreadable'; readonly problem: string }

/**
 * The record of the archive build installed in `folder`, if it has one. It is read as `readFileSha256` reads a file:
 * only a regular file no larger than a record Retest writes, never through a link and never waiting on a FIFO.
 *
 * @example (await readInstalledRecord(folder)).kind // 'found'
 */
export async function readInstalledRecord(folder: string): Promise<RecordReading<InstalledBuildRecord>> {
  const reading = await readRecordText(join(folder, recordFile))
  if (reading.kind !== 'text') return reading
  let value: unknown
  try {
    value = JSON.parse(reading.text)
  } catch (error) {
    return { kind: 'unreadable', problem: errorMessage(error) }
  }
  const parsed = parse(installedRecordSchema, value)
  if (!parsed.ok) return { kind: 'unreadable', problem: `it is not a record retest install wrote (${parsed.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ')})` }
  return { kind: 'found', record: parsed.value }
}

export type { FileReading }

/**
 * The SHA-256 of a regular file's bytes, or why there is none. Only a regular file is read: a link is never followed,
 * and a FIFO, socket or device is named without being read, so nothing can wait on one.
 *
 * @example await readFileSha256('/…/Electron.app/Contents/MacOS/Electron') // { kind: 'file', sha256: 'ca7e…' }
 */
export async function readFileSha256(path: string): Promise<FileReading> {
  return readRegularFileSha256(path)
}

/**
 * The SHA-256 of a regular file's bytes. Rejects for anything else, as `readFileSha256` reads it.
 *
 * @example await fileSha256('/…/Electron.app/Contents/MacOS/Electron') // 'ca7e…'
 */
export async function fileSha256(path: string): Promise<string> {
  const reading = await readFileSha256(path)
  if (reading.kind === 'file') return reading.sha256
  throw new Error(reading.kind === 'missing' ? `${path} is missing.` : reading.problem)
}

/** One licence file of an installed build, as a check found it. `problem` says why an unreadable one was not read. */
export type LicenceReading = { readonly file: LicenceFile; readonly state: 'present' | 'missing' | 'changed' | 'unreadable'; readonly sha256?: string; readonly problem?: string }

/**
 * Reads each licence file a build must carry under `root`: present with the pinned checksum, missing, changed, or
 * something other than a file. A file the pin has no checksum for is present when it is a readable file.
 *
 * @example (await readLicences(root, pin.licences.files)).filter((reading) => reading.state !== 'present')
 */
export async function readLicences(root: string, files: readonly LicenceFile[]): Promise<LicenceReading[]> {
  const readings: LicenceReading[] = []
  for (const file of files) {
    const reading = await readFileSha256(join(root, file.path))
    if (reading.kind === 'missing') readings.push({ file, state: 'missing' })
    else if (reading.kind === 'other') readings.push({ file, state: 'unreadable', problem: reading.problem })
    else readings.push({ file, state: file.sha256 === undefined || file.sha256 === reading.sha256 ? 'present' : 'changed', sha256: reading.sha256 })
  }
  return readings
}

// The set-user-id and set-group-id bits of a file's mode, which Node's `fs.constants` does not name.
const setIdBits = 0o4000 | 0o2000

/** What a walk of a build's tree found that no build Retest installs may hold, each entry by its path in the build. */
export type TreeProblems = { readonly leaving: readonly string[]; readonly special: readonly string[]; readonly setId: readonly string[] }

/**
 * Walks a build's tree without following a link and names what no installed build may hold: a link that leads outside
 * it, unless `links` is `any`; an entry that is neither a folder, a file nor a link, such as a FIFO, a socket or a
 * device; and a file with its set-user-id or set-group-id bit. A folder may carry the set-group-id bit, which Linux
 * gives every folder made under one that has it, and which lets nothing run as anyone else.
 *
 * @example (await scanTree('/…/electron-44.5.1-mac-arm64/build')).special // []
 */
export async function scanTree(root: string, options: { readonly links: 'inside' | 'any' } = { links: 'inside' }): Promise<TreeProblems> {
  const leaving: string[] = []
  const special: string[] = []
  const setId: string[] = []
  const walk = async (folder: string): Promise<void> => {
    for (const name of (await readdir(folder)).sort()) {
      const path = join(folder, name)
      const stats = await lstat(path)
      if (stats.isDirectory()) await walk(path)
      else if (stats.isSymbolicLink()) {
        if (options.links === 'any') continue
        const target = await readlink(path)
        const inside = relative(root, isAbsolute(target) ? target : resolve(folder, target))
        if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) leaving.push(`${relative(root, path)} -> ${target}`)
      } else if (!stats.isFile()) special.push(`${relative(root, path)} (${entryKind(stats)})`)
      else if ((stats.mode & setIdBits) !== 0) setId.push(relative(root, path))
    }
  }
  await walk(root)
  return { leaving, special, setId }
}

/**
 * The problems a tree walk found, as one sentence per kind naming the first five entries of each, the first with
 * `subject`, or undefined when it found none.
 *
 * @example describeTreeProblems({ leaving: [], special: ['LICENSE (a FIFO)'], setId: [] }) // 'It holds entries that are not files, folders or links: LICENSE (a FIFO).'
 */
export function describeTreeProblems(problems: TreeProblems, subject = 'It'): string | undefined {
  const sentences = [
    problems.leaving.length === 0 ? undefined : `holds links that lead outside the build: ${problems.leaving.slice(0, 5).join(', ')}.`,
    problems.special.length === 0 ? undefined : `holds entries that are not files, folders or links: ${problems.special.slice(0, 5).join(', ')}.`,
    problems.setId.length === 0 ? undefined : `holds files that would run as their owner or group: ${problems.setId.slice(0, 5).join(', ')}.`,
  ].filter((sentence) => sentence !== undefined)
  return sentences.length === 0 ? undefined : sentences.map((sentence, index) => `${index === 0 ? subject : 'It'} ${sentence}`).join(' ')
}

/**
 * How one pin stands in the cache: installed and matching its pin and record; missing; there but not as recorded; or
 * there for a pin `retest install` refuses, which no install of Retest's put there and nothing checks.
 */
export type BuildInspection = {
  readonly pin: BuildPin
  readonly folder: string
  readonly state: 'installed' | 'missing' | 'damaged' | 'unverifiable'
  /** What does not match, for a damaged build, or why nothing was checked, for an unverifiable one. */
  readonly problems: readonly string[]
  /** The binary a target launches, for an installed browser or Electron build. */
  readonly executablePath?: string
  /** What identifies the installed build: the archive's SHA-256, or an executor's products checksum. */
  readonly sha256?: string
  readonly installedAt?: string
}

/**
 * Options of an inspection. `verify` reads every file of each installed build again and compares the whole with the
 * pin's tree checksum, or the record's where the pin has none, and walks the tree for entries no build may hold.
 */
export type InspectOptions = { readonly verify?: boolean }

/**
 * Reads how a pin stands in the cache, from the files on disk alone. A folder for a pin `retest install` refuses is
 * unverifiable, whatever it holds: nothing in it is read. An archive build is installed when its record names the pin,
 * with the pin's archive and tree checksums where the pin has them, and its executable, pinned files and every licence
 * file the pin names are regular files with their pinned and recorded checksums; an executor build when its build
 * step's record names the pinned commit and its licence files are there as recorded. With `verify`, every file of the
 * build is read again and the whole compared with the pin's tree checksum, or the record's where the pin has none,
 * and a link leading outside the build, a FIFO, socket or device, or a file with a set-id bit makes it damaged.
 *
 * @example (await inspectBuild(findPin('electron', 'mac-arm64'), folders)).state // 'missing'
 */
export async function inspectBuild(pin: BuildPin, folders: CacheFolders, options: InspectOptions = {}): Promise<BuildInspection> {
  const folder = buildFolder(folders, pin)
  const present = await lstat(folder).then((stats) => (stats.isDirectory() ? 'folder' : 'other'), (error: unknown) => (isMissingFile(error) ? 'missing' : `unreadable (${errorMessage(error)})`))
  if (present === 'missing') return { pin, folder, state: 'missing', problems: [] }
  // A record anyone could have written proves nothing about a build `retest install` refuses, since no install of
  // Retest's checked it against the pin; so it is not read at all.
  const refusal = pinRefusal(pin)
  if (refusal !== undefined) return { pin, folder, state: 'unverifiable', problems: [`Retest does not install ${describePin(pin)}, so nothing in ${folder} was installed or checked by Retest: ${refusal.message}`] }
  if (present !== 'folder') return { pin, folder, state: 'damaged', problems: [present === 'other' ? `${folder} is not a folder.` : `${folder} is ${present}.`] }
  return pin.kind === 'archive' ? inspectArchiveBuild(pin, folder, options) : inspectExecutorBuild(pin, folder, options)
}

/**
 * Every pin for a platform, each as `inspectBuild` reads it.
 *
 * @example await inspectBuilds('mac-arm64', folders)
 */
export async function inspectBuilds(platform: BuildPlatform, folders: CacheFolders, options: InspectOptions = {}, pins: readonly BuildPin[] = pinnedBuilds): Promise<BuildInspection[]> {
  const inspections: BuildInspection[] = []
  for (const pin of pins) if (pin.platform === platform) inspections.push(await inspectBuild(pin, folders, options))
  return inspections
}

/** Where `installedBuild` and `installedExecutable` look: this machine's platform and the pinned set, unless given. */
export type InstalledBuildOptions = { readonly platform?: BuildPlatform | undefined; readonly pins?: readonly BuildPin[] }

/**
 * The pinned build of an engine in this user's cache, as a driver needs to know it: installed, with the binary a
 * target launches; missing, when there is no folder for it, no pin for this machine or no cache; or damaged, when its
 * folder holds something a run must not launch: a build that no longer matches its pin and record, or one for a pin
 * `retest install` refuses. The message names the folder, what is wrong and how to fix it. Nothing is downloaded,
 * and nothing is thrown: a folder that cannot be read is damaged.
 *
 * @example await installedBuild('firefox', process.env) // { state: 'damaged', message: 'Firefox 133.0.3 … in … is not usable: …' }
 */
export async function installedBuild(engine: ArchiveEngine, env: Readonly<Record<string, string | undefined>>, options: InstalledBuildOptions = {}): Promise<InstalledBuild> {
  const platform = 'platform' in options ? options.platform : buildPlatform()
  const folders = cacheFolders(env)
  const pin = platform === undefined ? undefined : findPin(engine, platform, options.pins)
  if (folders === undefined || pin === undefined) return { state: 'missing' }
  let inspection: BuildInspection
  try {
    inspection = await inspectBuild(pin, folders)
  } catch (error) {
    const folder = buildFolder(folders, pin)
    return { state: 'damaged', folder, message: `The pinned ${describePin(pin)} in ${folder} cannot be read: ${errorMessage(error)}. Remove ${folder}, or give the target an executablePath.` }
  }
  if (inspection.state === 'missing') return { state: 'missing' }
  if (inspection.state === 'installed' && inspection.executablePath !== undefined) return { state: 'installed', executablePath: inspection.executablePath }
  const { folder } = inspection
  return { state: 'damaged', folder, message: `The pinned ${describePin(pin)} in ${folder} is not usable: ${inspection.problems.join(' ')} Remove ${folder}, or give the target an executablePath.` }
}

/** A pinned build as a driver reads it; see `installedBuild`. */
export type InstalledBuild = { readonly state: 'installed'; readonly executablePath: string } | { readonly state: 'missing' } | { readonly state: 'damaged'; readonly folder: string; readonly message: string }

/**
 * The executable of the pinned build of an engine installed in this user's cache for this machine, when it is
 * installed as its pin and record say; undefined otherwise, which a damaged build is too. A driver that must tell a
 * damaged build from a missing one asks `installedBuild`. A target's own `executablePath` always wins over it.
 *
 * @example await installedExecutable('firefox', process.env) // '/Users/ada/Library/Caches/retest/browsers/firefox-133.0.3-mac-arm64/build/Firefox.app/Contents/MacOS/firefox'
 */
export async function installedExecutable(engine: ArchiveEngine, env: Readonly<Record<string, string | undefined>>, options: InstalledBuildOptions = {}): Promise<string | undefined> {
  const build = await installedBuild(engine, env, options)
  return build.state === 'installed' ? build.executablePath : undefined
}

async function inspectArchiveBuild(pin: ArchivePin, folder: string, options: InspectOptions): Promise<BuildInspection> {
  const reading = await readInstalledRecord(folder)
  if (reading.kind === 'missing') return damaged(pin, folder, [`${folder} holds no ${recordFile}, so nothing records what is in it.`])
  if (reading.kind === 'unreadable') return damaged(pin, folder, [`Its ${recordFile} cannot be read: ${reading.problem}.`])
  const { record } = reading
  const problems: string[] = []
  if (record.engine !== pin.engine || record.version !== pin.version || record.platform !== pin.platform) {
    problems.push(`Its record names ${record.engine} ${record.version} for ${record.platform}, not the pinned build.`)
  }
  if (pin.sourceCode !== undefined && (record.sourceCode?.repository !== pin.sourceCode.repository || record.sourceCode.revision !== pin.sourceCode.revision || record.sourceCode.patches !== pin.sourceCode.patches)) problems.push('Its record does not retain the pinned source revision and patches.')
  if (pin.archive.sha256 !== undefined && record.archive.sha256 !== pin.archive.sha256) problems.push(`It was installed from an archive with SHA-256 ${record.archive.sha256}, not the pinned ${pin.archive.sha256}.`)
  if (pin.treeSha256 !== undefined && record.tree.sha256 !== pin.treeSha256) problems.push(`Its record holds the tree checksum ${record.tree.sha256}, not the pinned ${pin.treeSha256}.`)
  const root = join(folder, treeFolder)
  const executablePath = installedExecutablePath(folder, pin)
  if (record.executable.path !== pin.executable.path) problems.push(`Its record names the executable ${record.executable.path}, not ${pin.executable.path}.`)
  if (pin.executable.sha256 !== undefined && record.executable.sha256 !== pin.executable.sha256) problems.push(`Its record holds the executable with SHA-256 ${record.executable.sha256}, not the pinned ${pin.executable.sha256}.`)
  const executable = await checkRecordedFile(root, record.executable)
  problems.push(...executable)
  if (executable.length === 0 && !(await access(executablePath, constants.X_OK).then(() => true, () => false))) problems.push(`${executablePath} cannot be executed.`)
  for (const file of pin.files) {
    const recorded = record.files.find((entry) => entry.path === file.path)
    if (recorded === undefined || recorded.sha256 !== file.sha256) problems.push(`Its record does not hold ${file.path} with the pinned SHA-256 ${file.sha256}.`)
    else problems.push(...(await checkRecordedFile(root, recorded)))
  }
  if (pin.licences.inspected) {
    for (const file of pin.licences.files) {
      const recorded = record.licences.find((entry) => entry.path === file.path)
      if (recorded === undefined) problems.push(`Its record lists no ${file.path} (${file.title}).`)
      else if (file.sha256 !== undefined && recorded.sha256 !== file.sha256) problems.push(`Its record holds ${file.path} with SHA-256 ${recorded.sha256}, not the pinned ${file.sha256}.`)
      else problems.push(...(await checkRecordedFile(root, recorded)))
    }
  }
  if (options.verify === true && problems.length === 0) problems.push(...(await verifyTree(root, pin.treeSha256 === undefined ? { sha256: record.tree.sha256, from: 'recorded at install' } : { sha256: pin.treeSha256, from: 'pinned' })))
  if (problems.length > 0) return damaged(pin, folder, problems)
  return { pin, folder, state: 'installed', problems: [], executablePath, sha256: record.archive.sha256, installedAt: record.installedAt }
}

// A full check of an unpacked build: nothing in it a build may not hold, then the whole read again. The walk comes
// first because the tree checksum passes over FIFOs, sockets, devices and file modes without a word.
async function verifyTree(root: string, expected: { readonly sha256: string; readonly from: 'pinned' | 'recorded at install' }): Promise<string[]> {
  const unsafe = await scanTree(root).then(describeTreeProblems, (error: unknown) => `Its files cannot be walked: ${errorMessage(error)}.`)
  if (unsafe !== undefined) return [unsafe]
  const tree = await folderChecksum(root).catch((error: unknown) => `unreadable (${errorMessage(error)})`)
  return tree === expected.sha256 ? [] : [`Its files read as ${tree}, not the ${expected.sha256} ${expected.from}.`]
}

async function inspectExecutorBuild(pin: SourcePin, folder: string, options: InspectOptions): Promise<BuildInspection> {
  const reading = await readBuildRecord(folder)
  if (reading.kind === 'missing') return damaged(pin, folder, [`${folder} holds no ${recordFile}, so nothing records a finished build in it.`])
  if (reading.kind === 'unreadable') return damaged(pin, folder, [`Its ${recordFile} cannot be read: ${reading.problem}.`])
  const build: ExecutorBuild = reading.build
  const problems: string[] = []
  if (build.executor !== pin.engine || build.commit !== pin.commit || build.version !== pin.version) problems.push(`Its record names ${build.executor} ${build.version} at ${build.commit}, not the pinned ${pin.commit}.`)
  if (build.xcode.build !== pin.xcode.build) problems.push(`It was built with Xcode build ${build.xcode.build}, not the pinned ${pin.xcode.build}.`)
  const recorded = [...build.licenses, ...build.notices]
  for (const file of pin.licences.files) {
    const entry = recorded.find((candidate) => basename(candidate.path) === basename(file.path))
    if (entry === undefined) problems.push(`Its record lists no ${file.path} (${file.title}).`)
    else if (file.sha256 !== undefined && entry.sha256 !== file.sha256) problems.push(`Its record holds ${file.path} with SHA-256 ${entry.sha256}, not the pinned ${file.sha256}.`)
    else problems.push(...(await checkRecordedFile(folder, { path: relativeTo(folder, entry.path), sha256: entry.sha256 })))
  }
  if (options.verify === true && problems.length === 0) {
    // Xcode's products hold links of their own, so only the entries no build may hold are refused here.
    const unsafe = await scanTree(build.products, { links: 'any' }).then(describeTreeProblems, (error: unknown) => `Its products cannot be walked: ${errorMessage(error)}.`)
    const products = unsafe === undefined ? await folderChecksum(build.products).catch((error: unknown) => `unreadable (${errorMessage(error)})`) : undefined
    if (unsafe !== undefined) problems.push(`In its products at ${build.products}: ${unsafe}`)
    else if (products !== build.productsSha256) problems.push(`Its products at ${build.products} read as ${products}, not the recorded ${build.productsSha256}.`)
    const xctestrun = await readFileSha256(build.xctestrun)
    if (xctestrun.kind !== 'file') problems.push(xctestrun.kind === 'missing' ? `Its test run file ${build.xctestrun} is missing.` : xctestrun.problem)
    else if (xctestrun.sha256 !== build.xctestrunSha256) problems.push(`Its test run file ${build.xctestrun} is changed.`)
  }
  if (problems.length > 0) return damaged(pin, folder, problems)
  return { pin, folder, state: 'installed', problems: [], sha256: build.productsSha256, installedAt: build.recordedAt }
}

function damaged(pin: BuildPin, folder: string, problems: readonly string[]): BuildInspection {
  return { pin, folder, state: 'damaged', problems }
}

// The executor build step records absolute paths; one outside the build's folder is read where it is.
function relativeTo(folder: string, path: string): string {
  const inside = relative(folder, path)
  return inside.startsWith(`..${sep}`) || inside === '..' || isAbsolute(inside) ? path : inside
}

async function checkRecordedFile(root: string, entry: { readonly path: string; readonly sha256: string }): Promise<string[]> {
  const path = isAbsolute(entry.path) ? entry.path : join(root, entry.path)
  const reading = await readFileSha256(path)
  if (reading.kind === 'missing') return [`${path} is missing.`]
  if (reading.kind === 'other') return [reading.problem]
  return reading.sha256 === entry.sha256 ? [] : [`${path} has SHA-256 ${reading.sha256}, not the ${entry.sha256} recorded at install.`]
}
