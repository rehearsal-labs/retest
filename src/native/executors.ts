import { NativeOutputLines } from './output.ts'
import type { Failure } from '../protocol/failures.ts'
import type { Schema } from '../protocol/schema.ts'
import type { NativeTools } from './processes.ts'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, lstat, mkdir, open, readdir, readFile, readlink, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, relative } from 'node:path'
import { errorMessage } from '../protocol/failures.ts'
import { parse, s } from '../protocol/schema.ts'
import { readFileSha256, readRecordText } from '../shared/regular-file.ts'
import { sha256Hex } from '../shared/sha256.ts'
import { endHolder, holdKernelLock } from './desktop-lock.ts'
import { describeCommand, runCommand } from './processes.ts'

// The two XCTest executors Retest drives native apps through, pinned with the Xcode build and simulator runtime they
// were tested with as one set. Both depend on XCTest internals, so a new Xcode can break them: a build is keyed by the
// whole set, and nothing outside it is used. Retest builds them from the pinned commits into a cache of its own; they
// are never package dependencies, and no code from either is copied into Retest.

/** The executors by name: WebDriverAgent for iOS simulators, and the macOS runner of appium-mac2-driver. */
export type ExecutorName = 'webdriveragent' | 'mac2'

/** A licence or notice file of an executor's source, and the SHA-256 the pin expects of it. */
export type PinnedLicense = {
  /** The executor whose source holds the file. */
  readonly from: ExecutorName
  /** Its path in that source. */
  readonly path: string
  /** The name it is copied under, beside the build. */
  readonly copiedAs: string
  readonly spdx: string
  readonly sha256: string
}

/**
 * A file under a licence of its own that is compiled into an executor: its leading comment, which carries the
 * copyright and the licence grant, is copied beside every build.
 */
export type HeaderNotice = { readonly from: ExecutorName; readonly path: string; readonly copiedAs: string; readonly spdx: string }

/** One executor as the pin names it, and how it is built. */
export type ExecutorPin = {
  readonly name: ExecutorName
  readonly title: string
  readonly repository: string
  readonly version: string
  readonly commit: string
  readonly committedAt: string
  readonly platform: 'ios-simulator' | 'macos'
  /** The Xcode project, relative to the source. */
  readonly project: string
  readonly scheme: string
  readonly sdk: 'iphonesimulator' | 'macosx'
  /** The folder of `Build/Products` the build writes its products to. */
  readonly productsFolder: string
  readonly runnerApp: string
  /** The test bundle's Info.plist inside the runner app, which names the Xcode build that compiled it. */
  readonly testBundleInfo: string
  readonly defaultPort: number
  /** Licence texts copied beside every build of this executor. */
  readonly licenses: readonly PinnedLicense[]
  /** Files under another licence compiled into the executor, whose headers are copied beside every build. */
  readonly headerNotices: readonly HeaderNotice[]
}

/** The Xcode and simulator runtime the executors were tested with. */
export type ToolchainPin = {
  readonly xcode: { readonly version: string; readonly build: string }
  readonly sdkVersion: string
  readonly iosRuntimes: readonly { readonly version: string; readonly build: string }[]
  readonly architectures: readonly string[]
}

/** The tested set: the toolchain and both executors. */
export type NativePinSet = { readonly toolchain: ToolchainPin; readonly executors: Readonly<Record<ExecutorName, ExecutorPin>> }

// Apache-2.0's text, as appium-mac2-driver's licence file carries it; FBHTTPStatusCodes.h in both executors is under it.
const apacheLicense: PinnedLicense = { from: 'mac2', path: 'LICENSE', copiedAs: 'Apache-2.0-LICENSE.txt', spdx: 'Apache-2.0', sha256: 'c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4' }

const webDriverAgentLicense: PinnedLicense = {
  from: 'webdriveragent',
  path: 'LICENSE',
  copiedAs: 'WebDriverAgent-LICENSE.txt',
  spdx: 'BSD-3-Clause',
  sha256: 'd9910c6ba5e4c29ae415ee3ce875c9e18a60d8bc4d7fe2c2d104db2a718b1bb4',
}

/**
 * The header 91 of appium-mac2-driver's files keep from WebDriverAgent. It points at a PATENTS file neither repository
 * holds at the pinned commits, and at "the LICENSE file", which in appium-mac2-driver is Apache-2.0: the BSD-style
 * licence it means is WebDriverAgent's, copied beside the macOS runner for that reason.
 */
export const facebookBsdHeader: string = [
  'Copyright (c) 2015-present, Facebook, Inc.',
  'All rights reserved.',
  '',
  'This source code is licensed under the BSD-style license found in the',
  'LICENSE file in the root directory of this source tree. An additional grant',
  'of patent rights can be found in the PATENTS file in the same directory.',
].join('\n')

/** The set this release was tested with, on Xcode 26.5 (17F42) and the iOS 26.5 runtime (23F77), on Apple silicon. */
export const nativePins: NativePinSet = {
  toolchain: {
    xcode: { version: '26.5', build: '17F42' },
    sdkVersion: '26.5',
    iosRuntimes: [{ version: '26.5', build: '23F77' }],
    architectures: ['arm64'],
  },
  executors: {
    webdriveragent: {
      name: 'webdriveragent',
      title: 'WebDriverAgent',
      repository: 'https://github.com/appium/WebDriverAgent',
      version: '16.13.6',
      commit: '9d1d17ddb59e6097ddc3324b23ca9f4174507b12',
      committedAt: '2026-09-30T14:27:17Z',
      platform: 'ios-simulator',
      project: 'WebDriverAgent.xcodeproj',
      scheme: 'WebDriverAgentRunner',
      sdk: 'iphonesimulator',
      productsFolder: 'Debug-iphonesimulator',
      runnerApp: 'WebDriverAgentRunner-Runner.app',
      testBundleInfo: 'PlugIns/WebDriverAgentRunner.xctest/Info.plist',
      defaultPort: 8100,
      licenses: [webDriverAgentLicense, apacheLicense],
      headerNotices: [{ from: 'webdriveragent', path: 'WebDriverAgentLib/Routing/FBHTTPStatusCodes.h', copiedAs: 'FBHTTPStatusCodes-NOTICE.txt', spdx: 'Apache-2.0' }],
    },
    mac2: {
      name: 'mac2',
      title: 'WebDriverAgentMac (appium-mac2-driver)',
      repository: 'https://github.com/appium/appium-mac2-driver',
      version: '4.3.6',
      commit: 'f38257191fa9f273a684f6a9c8c2b16d1272bd09',
      committedAt: '2026-10-02T03:12:13Z',
      platform: 'macos',
      project: 'WebDriverAgentMac/WebDriverAgentMac.xcodeproj',
      scheme: 'WebDriverAgentRunner',
      sdk: 'macosx',
      productsFolder: 'Debug',
      runnerApp: 'WebDriverAgentRunner-Runner.app',
      testBundleInfo: 'Contents/PlugIns/WebDriverAgentRunner.xctest/Contents/Info.plist',
      defaultPort: 10100,
      licenses: [
        { from: 'mac2', path: 'LICENSE', copiedAs: 'appium-mac2-driver-LICENSE.txt', spdx: 'Apache-2.0', sha256: 'c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4' },
        webDriverAgentLicense,
      ],
      headerNotices: [{ from: 'mac2', path: 'WebDriverAgentMac/WebDriverAgentLib/Routing/FBHTTPStatusCodes.h', copiedAs: 'FBHTTPStatusCodes-NOTICE.txt', spdx: 'Apache-2.0' }],
    },
  },
}

/** Where Retest keeps executor builds unless told otherwise. */
export function defaultExecutorCache(): string {
  return join(homedir(), 'Library', 'Caches', 'retest', 'native-executors')
}

/**
 * The key of one executor's build in the tested set: what decides its bytes, hashed. A different commit, Xcode build,
 * SDK, architecture or runtime set is a different build.
 *
 * @example pinKey(nativePins.executors.mac2, nativePins.toolchain, 'arm64') // '3f0c…' (16 hex digits)
 */
export function pinKey(executor: ExecutorPin, toolchain: ToolchainPin, architecture: string): string {
  const runtimes = executor.platform === 'ios-simulator' ? toolchain.iosRuntimes : []
  const decides = { executor: executor.name, commit: executor.commit, xcode: toolchain.xcode.build, sdk: `${executor.sdk}${toolchain.sdkVersion}`, architecture, runtimes }
  return sha256Hex(JSON.stringify(decides)).slice(0, 16)
}

/**
 * A build of an executor, as its record in the cache holds it: the pin it was made from, where its `.xctestrun` and
 * products are, their checksums, the code directory hash macOS ties permissions to, the licence files beside it, and
 * whether this cache built it or took over a matching build made before. A build taken over (`adopted`) was compiled by
 * the pinned Xcode from a checkout that is at the pinned commit now; that it was at that commit when it was compiled
 * is not verified, and a result says so.
 */
export type ExecutorBuild = {
  schemaVersion: 1
  executor: ExecutorName
  version: string
  commit: string
  key: string
  xcode: { version: string; build: string }
  sdk: string
  architecture: string
  origin: 'built' | 'adopted'
  derivedDataPath: string
  xctestrun: string
  products: string
  productsSha256: string
  xctestrunSha256: string
  codeDirectoryHash?: string
  recordedAt: string
  buildLog?: string
  licenses: { path: string; spdx: string; sha256: string }[]
  notices: { path: string; sha256: string; files: number }[]
}

const executorBuildSchema: Schema<ExecutorBuild> = s.object({
  schemaVersion: s.literal(1),
  executor: s.enum(['webdriveragent', 'mac2']),
  version: s.string(),
  commit: s.string(),
  key: s.string(),
  xcode: s.object({ version: s.string(), build: s.string() }),
  sdk: s.string(),
  architecture: s.string(),
  origin: s.enum(['built', 'adopted']),
  derivedDataPath: s.string(),
  xctestrun: s.string(),
  products: s.string(),
  productsSha256: s.string(),
  xctestrunSha256: s.string(),
  codeDirectoryHash: s.optional(s.string()),
  recordedAt: s.string(),
  buildLog: s.optional(s.string()),
  licenses: s.array(s.object({ path: s.string(), spdx: s.string(), sha256: s.string() })),
  notices: s.array(s.object({ path: s.string(), sha256: s.string(), files: s.number({ integer: true, min: 0 }) })),
})

/** What `ensureExecutorBuild` needs: the executor, the sources of both executors, and where the cache is. */
export type EnsureBuildOptions = {
  readonly executor: ExecutorName
  readonly pins?: NativePinSet | undefined
  /** A clone of each executor's repository at its pinned commit. The macOS runner's licences also need WebDriverAgent's. */
  readonly sources: Readonly<Record<ExecutorName, string>>
  readonly cacheRoot?: string | undefined
  /** Derived data folders of earlier builds this cache may take over when they match the pin. */
  readonly adoptFrom?: readonly string[] | undefined
  readonly logFile: string
  readonly timeoutMs: number
  readonly signal?: AbortSignal | undefined
  readonly tools: NativeTools
  readonly architecture?: string | undefined
}

/** A build that is ready, and how it came to be: found in the cache, taken over from an earlier build, or built now. */
export type EnsuredBuild = { readonly ok: true; readonly build: ExecutorBuild; readonly action: 'reused' | 'adopted' | 'built'; readonly folder: string }

/** The answer of `ensureExecutorBuild`: a ready build, or the setup failure that says why there is none. */
export type EnsureBuildResult = EnsuredBuild | { readonly ok: false; readonly failure: Failure }

/**
 * Makes sure the cache holds a build of the executor for the tested set, and returns its record. The installed Xcode
 * must be the pinned build and the source a clean checkout of the pinned commit, with licence files as pinned. A
 * build recorded in the cache is used as it is, after its products are checked against the recorded checksum; one
 * that does not match fails rather than being built again, since an ad hoc signed macOS runner built again gets a new
 * code hash and loses the permissions macOS tied to the old one. With no record, a derived data folder from `adoptFrom`
 * whose products the pinned Xcode compiled from this commit is taken over in place. Otherwise `xcodebuild
 * build-for-testing` runs into the cache, in a process group of its own, within `timeoutMs`.
 *
 * @example await ensureExecutorBuild({ executor: 'mac2', sources, logFile, timeoutMs: 1_200_000, tools: systemTools })
 */
export async function ensureExecutorBuild(options: EnsureBuildOptions): Promise<EnsureBuildResult> {
  const pins = options.pins ?? nativePins
  const pin = pins.executors[options.executor]
  const architecture = options.architecture ?? process.arch
  if (!pins.toolchain.architectures.includes(architecture)) {
    return refused(`The native executors are pinned and tested on ${pins.toolchain.architectures.join(', ')}, not on ${architecture}.`)
  }
  const xcode = await checkXcode(options.tools, pins.toolchain, options.signal)
  if (xcode !== undefined) return { ok: false, failure: xcode }
  const source = await checkSource(pins, pin, options.sources, options.tools, options.signal)
  if (source !== undefined) return { ok: false, failure: source }
  const key = pinKey(pin, pins.toolchain, architecture)
  const folder = join(options.cacheRoot ?? defaultExecutorCache(), `${pin.name}-${pin.version}-${key}`)
  await mkdir(folder, { recursive: true })
  const lock = await takeBuildLock(folder, options.tools)
  if (!lock.ok) return { ok: false, failure: lock.failure }
  try {
    const recorded = await readBuildRecord(folder)
    if (recorded.kind === 'unreadable') return refused(`The executor build record ${join(folder, recordFile)} cannot be read: ${recorded.problem}. Remove ${folder} to build again.`)
    if (recorded.kind === 'found') {
      const problem = await verifyRecordedBuild(recorded.build, pin, key)
      if (problem !== undefined) return refused(`${problem} Remove ${folder} to build ${pin.title} again; a macOS runner built again needs its permissions granted again.`)
      return { ok: true, build: await refreshNotices({ pin, pins, key, architecture, folder, options }, recorded.build), action: 'reused', folder }
    }
    const context: RecordContext = { pin, pins, key, architecture, folder, options }
    for (const candidate of options.adoptFrom ?? []) {
      const adopted = await adoptBuild(candidate, context)
      if (adopted !== undefined) return { ok: true, build: adopted, action: 'adopted', folder }
    }
    const built = await buildInto(context)
    return built.ok ? { ok: true, build: built.build, action: 'built', folder } : built
  } finally {
    await lock.release()
  }
}

/**
 * The record of the build in a cache folder, if it has one. Only a regular file no larger than a record is read: a link
 * there is never followed and a FIFO never waited on, so a run that reads the record can neither hang on it nor take
 * another file for it.
 *
 * @example (await readBuildRecord(folder)).kind // 'found'
 */
export async function readBuildRecord(folder: string): Promise<{ readonly kind: 'found'; readonly build: ExecutorBuild } | { readonly kind: 'missing' } | { readonly kind: 'unreadable'; readonly problem: string }> {
  const reading = await readRecordText(join(folder, recordFile))
  if (reading.kind !== 'text') return reading
  let value: unknown
  try {
    value = JSON.parse(reading.text)
  } catch (error) {
    return { kind: 'unreadable', problem: errorMessage(error) }
  }
  const parsed = parse(executorBuildSchema, value)
  if (!parsed.ok) return { kind: 'unreadable', problem: `it is not a build record Retest wrote (${parsed.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ')})` }
  return { kind: 'found', build: parsed.value }
}

/**
 * The SHA-256 of a folder's contents: every entry's path relative to the folder, its kind, and a file's bytes or a
 * link's target, in sorted order. Times and permissions are left out, so a copy has the checksum of its original.
 *
 * @example await folderChecksum('/…/Build/Products/Debug') // 'a1b2…'
 */
export async function folderChecksum(folder: string): Promise<string> {
  const hash = createHash('sha256')
  const walk = async (current: string): Promise<void> => {
    const names = (await readdir(current)).sort()
    for (const name of names) {
      const path = join(current, name)
      const relativePath = relative(folder, path)
      const stats = await lstat(path)
      if (stats.isSymbolicLink()) {
        hash.update(`L ${relativePath} -> ${await readlink(path)}\n`)
      } else if (stats.isDirectory()) {
        hash.update(`D ${relativePath}\n`)
        await walk(path)
      } else if (stats.isFile()) {
        hash.update(`F ${relativePath} ${stats.size}\n`)
        for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
      }
    }
  }
  await walk(folder)
  return hash.digest('hex')
}

const recordFile = 'build.json'
const lockFile = 'build.lock'

type RecordContext = { readonly pin: ExecutorPin; readonly pins: NativePinSet; readonly key: string; readonly architecture: string; readonly folder: string; readonly options: EnsureBuildOptions }

function refused(message: string): { readonly ok: false; readonly failure: Failure } {
  return { ok: false, failure: { class: 'setup_failed', message } }
}

/**
 * Why the installed Xcode is not the pinned one, or undefined when it is.
 *
 * @example await checkXcode(systemTools, nativePins.toolchain) // undefined
 */
export async function checkXcode(tools: NativeTools, toolchain: ToolchainPin, signal?: AbortSignal): Promise<Failure | undefined> {
  const result = await runCommand(tools.xcodebuild, ['-version'], { timeoutMs: 30_000, signal, hiddenVariables: tools.hiddenVariables })
  if (result.code !== 0) return { class: 'setup_failed', message: `Xcode is needed for native apps and ${describeCommand('xcodebuild -version', result)}. Install Xcode ${toolchain.xcode.version} (${toolchain.xcode.build}) and select it with xcode-select.` }
  const version = /^Xcode (\S+)/m.exec(result.stdout)?.[1]
  const build = /^Build version (\S+)/m.exec(result.stdout)?.[1]
  if (build === toolchain.xcode.build) return undefined
  const found = version === undefined ? 'an Xcode Retest cannot read' : `Xcode ${version} (${build ?? 'unknown build'})`
  return {
    class: 'setup_failed',
    message: `The native executors are pinned to Xcode ${toolchain.xcode.version} (${toolchain.xcode.build}) and this Mac has ${found}. Both executors use XCTest internals, so only the tested Xcode build is used.`,
    details: { pinnedXcode: toolchain.xcode.build, foundXcode: build ?? 'unknown' },
  }
}

async function checkSource(pins: NativePinSet, pin: ExecutorPin, sources: Readonly<Record<ExecutorName, string>>, tools: NativeTools, signal: AbortSignal | undefined): Promise<Failure | undefined> {
  // A build's licence files come from both checkouts, so each one is checked against its own pin.
  const checkouts = [...new Set([pin.name, ...pin.licenses.map((license) => license.from), ...pin.headerNotices.map((notice) => notice.from)])]
  for (const name of checkouts) {
    const executor = pins.executors[name]
    const source = sources[name]
    const clone = `Clone it with: git clone ${executor.repository} ${source} && git -C ${source} checkout ${executor.commit}`
    const head = await runCommand(tools.git, ['-C', source, 'rev-parse', 'HEAD'], { timeoutMs: 30_000, signal, hiddenVariables: tools.hiddenVariables })
    if (head.code !== 0) return { class: 'setup_failed', message: `The source of ${executor.title} at ${source} is not a git checkout of ${executor.repository} at ${executor.commit}. ${clone}` }
    const commit = head.stdout.trim()
    if (commit !== executor.commit) {
      return { class: 'setup_failed', message: `The source of ${executor.title} at ${source} is at ${commit}, not the pinned ${executor.commit}. Run: git -C ${source} checkout ${executor.commit}`, details: { executor: name, pinned: executor.commit, found: commit } }
    }
    const status = await runCommand(tools.git, ['-C', source, 'status', '--porcelain', '--untracked-files=all'], { timeoutMs: 30_000, signal, hiddenVariables: tools.hiddenVariables })
    if (status.code !== 0) return { class: 'setup_failed', message: `Retest could not read the state of ${source}: ${describeCommand('git status', status)}.` }
    const changed = status.stdout.split('\n').filter((line) => line.trim().length > 0)
    if (changed.some((line) => !line.startsWith('??'))) return { class: 'setup_failed', message: `The source of ${executor.title} at ${source} has changes to tracked files, so it is not the pinned commit as published.` }
    if (changed.length > 0) return { class: 'setup_failed', message: `The source of ${executor.title} at ${source} holds ${changed.length} file(s) the pinned commit does not, which a build could pick up.` }
    // A user scheme of the runner's name, even one git ignores, takes precedence over the shared scheme in a build.
    const userScheme = await userSchemeOf(join(source, executor.project), executor.scheme)
    if (userScheme !== undefined) return { class: 'setup_failed', message: `The source of ${executor.title} at ${source} has a user scheme ${userScheme} that would replace the pinned ${executor.scheme} scheme.` }
  }
  for (const license of pin.licenses) {
    const path = join(sources[license.from], license.path)
    const text = await readFile(path).catch(() => undefined)
    if (text === undefined) return { class: 'setup_failed', message: `The licence file ${path} is missing.` }
    const sha256 = sha256Hex(text)
    if (sha256 !== license.sha256) return { class: 'setup_failed', message: `The licence file ${path} has SHA-256 ${sha256}, not the pinned ${license.sha256}.` }
  }
  return undefined
}

async function userSchemeOf(project: string, scheme: string): Promise<string | undefined> {
  const users = await readdir(join(project, 'xcuserdata')).catch(() => [])
  for (const user of users) {
    const path = join(project, 'xcuserdata', user, 'xcschemes', `${scheme}.xcscheme`)
    if (await lstat(path).then(() => true, () => false)) return relative(join(project, '..'), path)
  }
  return undefined
}

async function verifyRecordedBuild(build: ExecutorBuild, pin: ExecutorPin, key: string): Promise<string | undefined> {
  if (build.executor !== pin.name || build.commit !== pin.commit || build.key !== key) return `The build record names ${build.executor} at ${build.commit} with key ${build.key}, not the pinned build.`
  const products = await folderChecksum(build.products).catch((error: unknown) => `unreadable (${errorMessage(error)})`)
  if (products !== build.productsSha256) return `The products of the recorded ${pin.title} build at ${build.products} have checksum ${products}, not the recorded ${build.productsSha256}.`
  // The record names this path, so it is read as the record is: a FIFO there would hold every run that reuses the build.
  const xctestrun = await readFileSha256(build.xctestrun)
  if (xctestrun.kind === 'other') return `The recorded ${pin.title} test run file cannot be read: ${xctestrun.problem}`
  if (xctestrun.kind === 'missing' || xctestrun.sha256 !== build.xctestrunSha256) return `The recorded ${pin.title} test run file ${build.xctestrun} is ${xctestrun.kind === 'missing' ? 'missing' : 'changed'}.`
  return undefined
}

// Takes over an earlier build in place, never copying it, when its test bundle was compiled by the pinned Xcode for the
// pinned SDK. The checkout is at the pinned commit now, as `checkSource` confirmed, but which commit the build was
// compiled from is not recorded in it, so an adopted build is named as one whose commit is not verified.
async function adoptBuild(derivedDataPath: string, context: RecordContext): Promise<ExecutorBuild | undefined> {
  const located = await locateProducts(derivedDataPath, context.pin, context.architecture)
  if (located === undefined) return undefined
  const compiled = await readCompiledBy(located.products, context.pin, context.options.tools)
  if (compiled?.xcodeBuild !== context.pins.toolchain.xcode.build || compiled.sdk !== `${context.pin.sdk}${context.pins.toolchain.sdkVersion}`) return undefined
  return writeRecord({ ...context, derivedDataPath, located, origin: 'adopted' })
}

async function buildInto(context: RecordContext): Promise<{ readonly ok: true; readonly build: ExecutorBuild } | { readonly ok: false; readonly failure: Failure }> {
  const { pin, options, folder, architecture } = context
  const derivedDataPath = join(folder, 'derived')
  const destination = pin.platform === 'ios-simulator' ? 'generic/platform=iOS Simulator' : `platform=macOS,arch=${architecture}`
  const project = join(options.sources[pin.name], pin.project)
  const args = ['build-for-testing', '-project', project, '-scheme', pin.scheme, '-destination', destination, '-derivedDataPath', derivedDataPath, 'COMPILER_INDEX_STORE_ENABLE=NO']
  await mkdir(dirname(options.logFile), { recursive: true })
  const log = await open(options.logFile, 'a')
  let result
  let outputProblem: string | undefined
  try {
    result = await runCommand(options.tools.xcodebuild, args, { timeoutMs: options.timeoutMs, signal: options.signal, cwd: join(project, '..'), hiddenVariables: options.tools.hiddenVariables })
    const chunks: string[] = []
    const lines = new NativeOutputLines(options.tools.redact ?? ((text: string) => text), (text) => chunks.push(text), (problem) => { outputProblem ??= problem })
    lines.push(`$ xcodebuild ${args.join(' ')}\n${result.stdout}${result.stderr}\n`)
    lines.end()
    await log.write(chunks.join(''))
  } finally {
    await log.close()
  }
  if (outputProblem !== undefined) return refused(`${outputProblem} The build log is ${options.logFile}.`)
  if (result.code !== 0 || !result.stdout.includes('** TEST BUILD SUCCEEDED **')) {
    return refused(`Building ${pin.title} for testing failed: ${describeCommand('xcodebuild build-for-testing', result)}. The build log is ${options.logFile}.`)
  }
  const located = await locateProducts(derivedDataPath, pin, architecture)
  if (located === undefined) return refused(`xcodebuild built ${pin.title} but wrote no test run file under ${derivedDataPath}. The build log is ${options.logFile}.`)
  const compiled = await readCompiledBy(located.products, pin, options.tools)
  if (compiled?.xcodeBuild !== context.pins.toolchain.xcode.build) return refused(`The ${pin.title} test bundle names Xcode build ${compiled?.xcodeBuild ?? 'unknown'}, not ${context.pins.toolchain.xcode.build}.`)
  return { ok: true, build: await writeRecord({ ...context, derivedDataPath, located, origin: 'built', buildLog: options.logFile }) }
}

type Located = { readonly xctestrun: string; readonly products: string }

async function locateProducts(derivedDataPath: string, pin: ExecutorPin, architecture: string): Promise<Located | undefined> {
  const productsRoot = join(derivedDataPath, 'Build', 'Products')
  const names = await readdir(productsRoot).catch(() => [])
  const prefix = `${pin.scheme}_${pin.sdk}`
  const xctestrun = names.find((name) => name.startsWith(prefix) && name.endsWith('.xctestrun') && (pin.platform === 'ios-simulator' || name.includes(architecture)))
  if (xctestrun === undefined) return undefined
  const products = join(productsRoot, pin.productsFolder)
  const runner = await lstat(join(products, pin.runnerApp)).catch(() => undefined)
  if (runner?.isDirectory() !== true) return undefined
  return { xctestrun: join(productsRoot, xctestrun), products }
}

async function readCompiledBy(products: string, pin: ExecutorPin, tools: NativeTools): Promise<{ readonly xcodeBuild: string; readonly sdk: string } | undefined> {
  const plist = join(products, pin.runnerApp, pin.testBundleInfo)
  const read = async (key: string): Promise<string | undefined> => {
    const result = await runCommand(tools.plutil, ['-extract', key, 'raw', '-o', '-', plist], { timeoutMs: 10_000, hiddenVariables: tools.hiddenVariables })
    return result.code === 0 ? result.stdout.trim() : undefined
  }
  const xcodeBuild = await read('DTXcodeBuild')
  const sdk = await read('DTSDKName')
  return xcodeBuild === undefined || sdk === undefined ? undefined : { xcodeBuild, sdk }
}

async function writeRecord(context: RecordContext & { readonly derivedDataPath: string; readonly located: Located; readonly origin: 'built' | 'adopted'; readonly buildLog?: string }): Promise<ExecutorBuild> {
  const { pin, pins, key, architecture, folder, options, located } = context
  const { licenses, notices } = await writeLicenceFiles(folder, pin, options.sources)
  const codeDirectoryHash = await readCodeDirectoryHash(join(located.products, pin.runnerApp), options.tools)
  const build: ExecutorBuild = {
    schemaVersion: 1,
    executor: pin.name,
    version: pin.version,
    commit: pin.commit,
    key,
    xcode: pins.toolchain.xcode,
    sdk: `${pin.sdk}${pins.toolchain.sdkVersion}`,
    architecture,
    origin: context.origin,
    derivedDataPath: context.derivedDataPath,
    xctestrun: located.xctestrun,
    products: located.products,
    productsSha256: await folderChecksum(located.products),
    xctestrunSha256: sha256Hex(await readFile(located.xctestrun)),
    ...(codeDirectoryHash === undefined ? {} : { codeDirectoryHash }),
    recordedAt: new Date().toISOString(),
    ...(context.buildLog === undefined ? {} : { buildLog: context.buildLog }),
    licenses,
    notices,
  }
  // Written last and moved into place, so a build that stopped part way leaves no record that could pass for one.
  const temporary = join(folder, `${recordFile}.${process.pid}.tmp`)
  await writeFile(temporary, `${JSON.stringify(build, null, 2)}\n`)
  await rename(temporary, join(folder, recordFile))
  return build
}

// Writes every licence text and notice the pin names beside a build, and returns what the record lists of them.
async function writeLicenceFiles(folder: string, pin: ExecutorPin, sources: Readonly<Record<ExecutorName, string>>): Promise<Pick<ExecutorBuild, 'licenses' | 'notices'>> {
  const licenses = await copyLicenses(folder, pin, sources)
  const notices = [...(pin.name === 'mac2' ? [await writeBsdNotice(folder, pin, sources.mac2)] : [])]
  for (const notice of pin.headerNotices) notices.push(await writeHeaderNotice(folder, notice, sources[notice.from]))
  return { licenses, notices }
}

// A build recorded before the pin named all of its licence files gets them now; its products are not touched.
async function refreshNotices(context: RecordContext, build: ExecutorBuild): Promise<ExecutorBuild> {
  const expected = [...context.pin.licenses.map((license) => license.copiedAs), ...context.pin.headerNotices.map((notice) => notice.copiedAs)]
  const recorded = [...build.licenses, ...build.notices].map((entry) => basename(entry.path))
  if (expected.every((name) => recorded.includes(name))) return build
  const refreshed: ExecutorBuild = { ...build, ...(await writeLicenceFiles(context.folder, context.pin, context.options.sources)) }
  const temporary = join(context.folder, `${recordFile}.${process.pid}.tmp`)
  await writeFile(temporary, `${JSON.stringify(refreshed, null, 2)}\n`)
  await rename(temporary, join(context.folder, recordFile))
  return refreshed
}

async function writeHeaderNotice(folder: string, notice: HeaderNotice, source: string): Promise<ExecutorBuild['notices'][number]> {
  const text = await readFile(join(source, notice.path), 'utf8')
  const end = text.indexOf('*/')
  const header = end === -1 ? '' : text.slice(0, end + 2)
  const path = join(folder, 'licenses', notice.copiedAs)
  const written = `${notice.path} (${notice.spdx}) is compiled into this build. Its header:\n\n${header}\n`
  await writeFile(path, written)
  return { path, sha256: sha256Hex(written), files: 1 }
}

async function copyLicenses(folder: string, pin: ExecutorPin, sources: Readonly<Record<ExecutorName, string>>): Promise<ExecutorBuild['licenses']> {
  const target = join(folder, 'licenses')
  await mkdir(target, { recursive: true })
  const copied: ExecutorBuild['licenses'] = []
  for (const license of pin.licenses) {
    const path = join(target, license.copiedAs)
    await copyFile(join(sources[license.from], license.path), path)
    copied.push({ path, spdx: license.spdx, sha256: sha256Hex(await readFile(path)) })
  }
  return copied
}

async function writeBsdNotice(folder: string, pin: ExecutorPin, mac2Source: string): Promise<ExecutorBuild['notices'][number]> {
  const files = await filesHolding(join(mac2Source, 'WebDriverAgentMac'), facebookBsdHeader.split('\n')[0] ?? '')
  const lines = [
    `${files.length} files of appium-mac2-driver ${pin.version} (${pin.commit}) keep this header from WebDriverAgent:`,
    '',
    facebookBsdHeader,
    '',
    'The BSD-style licence it names is WebDriverAgent\'s, copied beside this notice as WebDriverAgent-LICENSE.txt. Neither repository holds a PATENTS file at its pinned commit.',
    '',
    'Files:',
    ...files.map((file) => `  WebDriverAgentMac/${file}`),
    '',
  ]
  const path = join(folder, 'licenses', 'appium-mac2-driver-FACEBOOK-BSD-NOTICE.txt')
  const text = lines.join('\n')
  await writeFile(path, text)
  return { path, sha256: sha256Hex(text), files: files.length }
}

async function filesHolding(root: string, line: string): Promise<string[]> {
  const found: string[] = []
  const walk = async (current: string): Promise<void> => {
    for (const entry of (await readdir(current, { withFileTypes: true })).sort((first, second) => first.name.localeCompare(second.name))) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile() && /\.(h|m)$/.test(entry.name) && (await readFile(path, 'utf8')).includes(line)) found.push(relative(root, path))
    }
  }
  await walk(root)
  return found
}

async function readCodeDirectoryHash(app: string, tools: NativeTools): Promise<string | undefined> {
  const result = await runCommand(tools.codesign, ['--display', '--verbose=4', app], { timeoutMs: 30_000, hiddenVariables: tools.hiddenVariables })
  return /^CDHash=([0-9a-f]+)$/m.exec(`${result.stderr}\n${result.stdout}`)?.[1]
}

// One build at a time per cache folder, across processes, held by the same kernel lock as the desktop: the kernel
// lets it go when its holder ends in any way, so no taker judges whether a holder is alive and two never both build.
async function takeBuildLock(folder: string, tools: NativeTools): Promise<{ readonly ok: true; release(): Promise<void> } | { readonly ok: false; readonly failure: Failure }> {
  const path = join(folder, lockFile)
  const held = await holdKernelLock({ path, tools, name: 'build lock' })
  if (held.ok) return { ok: true, release: () => endHolder(held.holder) }
  if (held.reason === 'held') return refused(`Another process holds the build lock ${path}: it is building this executor into ${folder}.`)
  return refused(held.reason)
}
