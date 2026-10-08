import type { ArchiveEngine, ArchivePin, BuildInspection, BuildPin, BuildPlatform } from '../../browser/builds.ts'
import type { LoadedConfig, LoadedNativeTarget, LoadedTarget } from '../../config/loaded.ts'
import type { ExecutorName } from '../../native/executors.ts'
import type { NativeTools } from '../../native/processes.ts'
import type { Check } from '../doctor/checks.ts'
import type { Environment } from '../terminal.ts'
import { existsSync } from 'node:fs'
import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, relative, sep } from 'node:path'
import { buildPlatform, cacheFolders, describePin, describePlatform, findPin, inspectBuild, pinnedBuilds, pinRefusal, readBundledLicence } from '../../browser/builds.ts'
import { screenRecordingAllowed, screenRecordingGrant, screenRecordingHolder } from '../../native/macos-app.ts'
import { systemTools } from '../../native/processes.ts'
import { retestCommand } from '../../reporters/commands.ts'
import { targetDriver } from '../../runner/target-drivers.ts'
import { licenceLines } from './report.ts'

/**
 * What `checkBuilds` reads beyond the config: the pins, the platform, and which targets have a driver, the machine's
 * own and the runner's unless a test passes others.
 */
export type BuildRowOptions = {
  readonly pins?: readonly BuildPin[]
  readonly platform?: BuildPlatform | undefined
  readonly driven?: (app: string, target: LoadedTarget) => boolean
}

/**
 * One target's need of a pinned build: the engine; the path its config, or the variable its driver reads, names for
 * the binary; and that variable, for engines whose driver reads one.
 */
type BuildNeed = { readonly engine: ArchiveEngine; readonly configured?: string; readonly variable?: string }

const group = 'builds'

// The variables a driver reads a binary's path from when its target names none.
const pathVariables: Partial<Readonly<Record<ArchiveEngine, string>>> = { chromium: 'RETEST_CHROMIUM', webkit: 'RETEST_WEBKIT_BUILD' }

// The engines whose driver runs the installed pinned build when a target names no path (Firefox, in
// src/browser/firefox/executable.ts); the others run it only once a path names it.
const runWithoutPath: ReadonlySet<ArchiveEngine> = new Set(['firefox'])

/**
 * The `builds` rows of `doctor`, one per pinned engine a checked target uses, read from the cache alone: nothing is
 * downloaded or installed. A target whose binary is a build Retest installed shows its version and checksum, or what
 * no longer matches its record; "installed by Retest" is said of nothing else. A configured path is named only where
 * it wins over an installed pinned build, or where it lies in the folder of a build Retest does not install, which the
 * row says Retest never checked. A target that names no binary is shown the installed build, which a Firefox target
 * then runs and the others run once a path names it, or the folder of a build Retest does not install, which no run
 * launches, with the reason; with none installed, a Chromium or WebKit target, which then has no binary at all, gets
 * the install command or the reason `retest install` refuses that build. Targets doctor
 * refuses for want of a driver get no row, nor do Chrome and Edge, which run the browser the machine has, nor does
 * anything without a home folder, which leaves no cache to read.
 *
 * @example await checkBuilds(config, process.env)
 */
export async function checkBuilds(config: LoadedConfig, env: Environment, options: BuildRowOptions = {}): Promise<Check[]> {
  const platform = 'platform' in options ? options.platform : buildPlatform()
  const folders = cacheFolders(env)
  if (folders === undefined || platform === undefined) return []
  const rows = new Map<string, Check>()
  for (const app of config.apps.values()) {
    for (const target of app.targets.values()) {
      if (!(options.driven ?? hasDriver)(app.name, target)) continue
      const need = buildNeed(target, env)
      if (need === undefined) continue
      const key = `${need.engine}\u0000${need.configured ?? ''}`
      if (rows.has(key)) continue
      const pin = findPin(need.engine, platform, options.pins ?? pinnedBuilds)
      if (pin?.kind !== 'archive') continue
      const inspection = await inspectBuild(pin, folders)
      const row = await buildRow(need, pin, inspection)
      const notices = pin.licences.inspected && pin.licences.files.some((file) => file.bundled !== undefined) ? licenceLines(pin) : []
      const noticeText = notices.length === 0 ? undefined : checkedNoticeText(pin, inspection)
      if (row !== undefined) {
        rows.set(key, notices.length === 0 ? row : { ...row, detail: [row.detail, ...notices].filter((line) => line !== undefined).join('\n'), ...(noticeText === undefined ? {} : { noticeText }) })
      } else if (notices.length > 0) {
        // A configured build is checked by the target's own row. Its installer notice pin is still reported here.
        const refusal = pinRefusal(pin)
        const complete = refusal === undefined || refusal.missing.length === 0
        rows.set(key, {
          group, subject: need.engine, ok: complete,
          text: `${describePin(pin)} supplied licence notices ${complete ? 'match their pin; the configured build is checked by its target row' : 'cannot be retained as pinned'}`,
          detail: [...notices, ...(refusal === undefined ? [] : [`${retestCommand} install ${need.engine} refuses it: ${refusal.message}`])].join('\n'),
          ...(noticeText === undefined ? {} : { noticeText }),
        })
      }
    }
  }
  return [...rows.values()]
}

function checkedNoticeText(pin: ArchivePin, inspection: BuildInspection): string {
  if (!pin.licences.inspected) return pin.licences.reason
  for (const file of pin.licences.files) {
    const problem = inspection.problems.find(problem => problem.includes(file.path))
    if (problem !== undefined && inspection.state === 'damaged') return problem
  }
  for (const file of pin.licences.files) {
    if (file.bundled === undefined) continue
    const reading = readBundledLicence(file)
    if (!reading.ok) return `${file.path}: ${reading.problem.includes('SHA-256') ? 'notice checksum does not match' : reading.problem}`
  }
  return 'licence notices present and verified'
}

function hasDriver(app: string, target: LoadedTarget): boolean {
  return targetDriver(app, target).ok
}

/** What `checkNativeTarget` reads beyond the target: the pins and the platform, this machine's unless a test passes others. */
export type NativeRowOptions = { readonly pins?: readonly BuildPin[]; readonly platform?: BuildPlatform | undefined }

/**
 * The row `doctor` gives a native target, read from the cache alone: the executor its runtime drives, WebDriverAgent
 * for an iOS simulator app and the macOS runner for a macOS app, as built and recorded in Retest's cache, or that it is
 * not built yet, or what in it no longer matches its record; then that the app bundle is where `appPath` says. Nothing
 * is built, started or downloaded; what the app holds, the simulator, Xcode and Automation Mode are left to a run.
 *
 * @example await checkNativeTarget({ app: 'phone', subject: "{ platform: 'ios-simulator', … }", target, env: process.env })
 */
export async function checkNativeTarget(request: { readonly app: string; readonly subject: string; readonly target: LoadedNativeTarget; readonly env: Environment }, options: NativeRowOptions = {}): Promise<Check> {
  const { app, subject, target } = request
  const check = { group: app, subject }
  const engine: ExecutorName = target.platform === 'macos' ? 'mac2' : 'webdriveragent'
  const pins = options.pins ?? pinnedBuilds
  const folders = cacheFolders(request.env)
  if (folders === undefined) {
    const named = findPin(engine, 'mac-arm64', pins)
    return { ...check, ok: false, text: `HOME is not set to an absolute folder, so Retest has no cache to read the ${named === undefined ? engine : describePin(named)} build from.` }
  }
  const platform = 'platform' in options ? options.platform : buildPlatform()
  const pin = platform === undefined ? undefined : findPin(engine, platform, pins)
  if (pin?.kind !== 'source') {
    const machine = platform === undefined ? `${process.platform} ${process.arch}` : describePlatform(platform)
    return { ...check, ok: false, text: `Retest builds the ${engine} executor only on macOS arm64, and this machine is ${machine}, so the target ${target.name} of the app ${app} cannot start.` }
  }
  const inspection = await inspectBuild(pin, folders)
  const permissions = engine === 'mac2' ? '; a macOS runner built again needs its permissions granted again' : ''
  if (inspection.state === 'missing') return { ...check, ok: false, text: `${describePin(pin)} is not built in Retest's cache`, fix: `Run ${retestCommand} install ${engine} to build it from its pinned commit; otherwise the first run builds it.` }
  if (inspection.state !== 'installed') return { ...check, ok: false, text: `${describePin(pin)} in ${inspection.folder} does not match its record: ${inspection.problems.join(' ')}`, fix: `Remove ${inspection.folder} and run ${retestCommand} install ${engine} again${permissions}.` }
  // An app bundle is a folder; what is in it is read by a run, which installs and launches it.
  const bundled = await lstat(target.appPath).then((stats) => stats.isDirectory(), () => false)
  if (!bundled) return { ...check, ok: false, text: `No app at ${target.appPath}, the path appPath gives.`, fix: 'Build the app there, or change the path.' }
  return { ...check, ok: true, text: `${describePin(pin)} built in Retest's cache${inspection.sha256 === undefined ? '' : ` · products sha256 ${inspection.sha256.slice(0, 12)}`}, and the app is there; doctor starts neither`, detail: inspection.folder }
}

/** What `checkScreenRecording` reads with: the tools, the system's unless a test passes fakes, and a stop. */
export type ScreenRecordingOptions = { readonly tools?: NativeTools; readonly signal?: AbortSignal | undefined }

/**
 * The `macos` row of `doctor` for a config with a macOS app target: whether macOS lets the terminal or agent that runs
 * Retest record the screen, which the capture of the app's window needs, read within ten seconds without a prompt or a
 * capture. An iOS simulator app and a browser need no such permission, so a config without a macOS app gets no row, nor
 * does a machine that is not a Mac, where the target's own row says it cannot start.
 *
 * @example await checkScreenRecording(config, { signal }) // [{ group: 'macos', subject: 'Screen Recording', ok: false, … }]
 */
export async function checkScreenRecording(config: LoadedConfig, options: ScreenRecordingOptions = {}): Promise<Check[]> {
  const macos = [...config.apps.values()].some((app) => [...app.targets.values()].some((target) => 'platform' in target && target.platform === 'macos'))
  if (!macos || process.platform !== 'darwin') return []
  const check = { group: 'macos', subject: 'Screen Recording' }
  const fix = `${screenRecordingGrant}.`
  const reading = await screenRecordingAllowed(options.tools ?? systemTools, { timeoutMs: 10_000, signal: options.signal })
  if (!reading.ok) return [{ ...check, ok: false, text: `Retest could not read whether ${screenRecordingHolder} may record the screen (${reading.problem}).`, fix }]
  if (!reading.allowed) return [{ ...check, ok: false, text: `Screen Recording is off for ${screenRecordingHolder}, so Retest cannot capture a macOS app's window.`, fix }]
  return [{ ...check, ok: true, text: `on for ${screenRecordingHolder}, which the capture of a macOS app's window needs` }]
}

function buildNeed(target: LoadedTarget, env: Environment): BuildNeed | undefined {
  if ('platform' in target) return undefined
  if (target.browser === 'chrome' || target.browser === 'edge') return undefined
  const engine = target.browser
  const variable = pathVariables[engine]
  const fromVariable = variable === undefined ? undefined : env[variable]
  const own = 'executablePath' in target ? target.executablePath : undefined
  const configured = own ?? (fromVariable === '' ? undefined : fromVariable)
  return { engine, ...(configured === undefined ? {} : { configured }), ...(variable === undefined ? {} : { variable }) }
}

async function buildRow(need: BuildNeed, pin: ArchivePin, inspection: BuildInspection): Promise<Check | undefined> {
  const { engine, configured, variable } = need
  if (configured !== undefined) return configuredRow(engine, configured, pin, inspection)
  const names = `its executablePath${variable === undefined ? '' : `, or ${variable},`}`
  if (inspection.state === 'installed') return installedRow(engine, pin, inspection, runWithoutPath.has(engine) ? '; the target runs it, since it names no executablePath' : `; the target runs it once ${names} names this path`)
  if (inspection.state === 'damaged') return damagedRow(engine, pin, inspection)
  const refusal = pinRefusal(pin)
  const refused = refusal === undefined ? '' : `${retestCommand} install ${engine} refuses it: ${refusal.message} Give the target an executablePath instead.`
  if (inspection.state === 'unverifiable') {
    return { group, subject: engine, ok: false, text: `${describePin(pin)} is not installed: ${inspection.folder} holds a build Retest did not install or check, and no run launches it`, fix: `Remove ${inspection.folder}.${refused === '' ? '' : ` ${refused}`}` }
  }
  // A Firefox target with no path is left to its driver, which then looks where Firefox installs on the machine.
  if (engine !== 'chromium' && engine !== 'webkit') return undefined
  const fix = refusal === undefined ? `Run ${retestCommand} install ${engine}, then give the target its executablePath${variable === undefined ? '' : ` or set ${variable}`}.` : refused
  return { group, subject: engine, ok: false, text: `${describePin(pin)} is not installed, and the target names no build`, fix }
}

// A configured path that is the installed build is reported as the build; one elsewhere only when an installed build
// is there for it to win over. A path with nothing at it is left to the target's own row. A configured path inside the
// folder of a build Retest does not install is the target's own choice: it runs, and the row says Retest never
// checked it rather than calling it installed.
async function configuredRow(engine: ArchiveEngine, configured: string, pin: ArchivePin, inspection: BuildInspection): Promise<Check | undefined> {
  if (await isInside(configured, inspection.folder)) {
    if (inspection.state === 'installed') return installedRow(engine, pin, inspection, '')
    if (inspection.state === 'damaged') return damagedRow(engine, pin, inspection)
    if (inspection.state === 'unverifiable') return { group, subject: engine, ok: true, text: `found at a configured path in ${inspection.folder}, which holds a build Retest does not install and never checked`, detail: configured }
    return undefined
  }
  if (inspection.state !== 'installed' || !existsSync(configured)) return undefined
  return { group, subject: engine, ok: true, text: `found at a configured path, which wins over the installed ${describePin(pin)}`, detail: configured }
}

// Said only of a build `retest install` installs, whose record names the pin's archive checksum and whose executable,
// pinned files and licence notices read as the pin has them: inspection never calls anything else installed.
function installedRow(engine: ArchiveEngine, pin: ArchivePin, inspection: BuildInspection, after: string): Check {
  const sha256 = inspection.sha256 === undefined ? '' : ` · sha256 ${inspection.sha256.slice(0, 12)}`
  return { group, subject: engine, ok: true, text: `${describePin(pin)}, installed by Retest${sha256}${after}`, ...(inspection.executablePath === undefined ? {} : { detail: inspection.executablePath }) }
}

// Only a pin `retest install` installs is ever damaged, since a folder for one it refuses is unverifiable, so running
// the install again is always a fix it accepts.
function damagedRow(engine: ArchiveEngine, pin: ArchivePin, inspection: BuildInspection): Check {
  return { group, subject: engine, ok: false, text: `${describePin(pin)} in ${inspection.folder} does not match its record: ${inspection.problems.join(' ')}`, fix: `Remove ${inspection.folder} and run ${retestCommand} install ${engine} again.` }
}

async function isInside(path: string, folder: string): Promise<boolean> {
  const [real, base] = await Promise.all([realpath(path).catch(() => path), realpath(folder).catch(() => folder)])
  const inside = relative(base, real)
  return inside !== '' && inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside)
}
