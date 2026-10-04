import type { Infer, Path } from '../protocol/schema.ts'
import type { DeviceName } from './devices.ts'
import type {
  LoadedApp,
  LoadedElectronTarget,
  LoadedEmulation,
  LoadedNativeDiagnostics,
  LoadedNativeTarget,
  LoadedProxy,
  LoadedStart,
  LoadedTarget,
  LoadedWebTarget,
} from './loaded.ts'
import type { Problems } from './problems.ts'
import type { CustomEmulation, NativePlatform, Viewport } from './types.ts'
import { configKey } from './problems.ts'
import { folderKey } from '../runner/resources.ts'
import { errorMessage } from '../protocol/failures.ts'
import { resolve } from 'node:path'
import { describeValue, isPlainObject, parse, s } from '../protocol/schema.ts'
import { maxTimeout } from '../protocol/timeouts.ts'
import { deviceNames } from './devices.ts'
import { channels } from './types.ts'

/** Where problems go, and the config's folder, which relative paths start from. */
export type ReadContext = { problems: Problems; folder: string }

const pixels = s.number({ integer: true, min: 1 })
const customEmulationSchema = s.object({
  viewport: s.object({ width: pixels, height: pixels }),
  deviceScaleFactor: s.number({ min: 0 }),
  touch: s.boolean(),
  isMobile: s.optional(s.boolean()),
  userAgent: s.optional(s.string()),
})
// A proxy written as its address alone may hold a password, which a schema issue would quote, so the schema
// takes a string and `loadProxy` refuses it.
const proxySchema = s.union([s.object({ server: s.string(), bypass: s.optional(s.array(s.string())) }), s.string()])
const targetSettings = {
  headless: s.optional(s.boolean()),
  emulate: s.optional(s.union([s.enum(deviceNames), customEmulationSchema])),
  viewport: s.optional(s.object({ width: pixels, height: pixels })),
  proxy: s.optional(proxySchema),
}
const proxySchemes: readonly string[] = ['http:', 'https:', 'socks4:', 'socks5:']
const channel = s.optional(s.enum(channels))
const startSchema = s.object({
  command: s.string(),
  ready: s.string(),
  cwd: s.optional(s.string()),
  timeoutMs: s.optional(s.number({ integer: true, min: 1 })),
})
const appSettings = { baseUrl: s.optional(s.string()), start: s.optional(startSchema) }
const appSettingsSchema = s.object(appSettings)

const executablePath = s.optional(s.string())
// An Electron app has no screen to emulate and no proxy of Retest's: its windows are its own.
const electronShape = {
  browser: s.literal('electron'),
  executablePath: s.string(),
  appPath: s.string(),
  args: s.optional(s.array(s.string())),
  userDataDir: s.optional(s.string()),
}
const targetSchema = s.discriminatedUnion('browser', [
  s.object({ browser: s.literal('chromium'), executablePath, ...targetSettings }),
  s.object({ browser: s.literal('chrome'), channel, ...targetSettings }),
  s.object({ browser: s.literal('edge'), channel, ...targetSettings }),
  s.object({ browser: s.literal('firefox'), executablePath, ...targetSettings }),
  s.object({ browser: s.literal('webkit'), executablePath, ...targetSettings }),
  s.object(electronShape),
])
const standaloneTargetSchema = s.discriminatedUnion('browser', [
  s.object({ browser: s.literal('chromium'), executablePath, ...targetSettings, ...appSettings }),
  s.object({ browser: s.literal('chrome'), channel, ...targetSettings, ...appSettings }),
  s.object({ browser: s.literal('edge'), channel, ...targetSettings, ...appSettings }),
  s.object({ browser: s.literal('firefox'), executablePath, ...targetSettings, ...appSettings }),
  s.object({ browser: s.literal('webkit'), executablePath, ...targetSettings, ...appSettings }),
  s.object({ ...electronShape, ...appSettings }),
])
const nativeDiagnostics = s.object({
  logs: s.optional(s.enum(['stdout', 'none'])),
  network: s.optional(s.object({ path: s.string(), client: s.enum(['ios', 'macos']) })),
})
const nativeLaunch = { arguments: s.optional(s.array(s.string())), environment: s.optional(s.record(s.string())), diagnostics: s.optional(nativeDiagnostics) }
const nativeTargetSchema = s.discriminatedUnion('platform', [
  s.object({ platform: s.literal('ios-simulator'), appPath: s.string(), device: s.string(), runtime: s.string(), ...nativeLaunch }),
  s.object({ platform: s.literal('macos'), appPath: s.string(), ...nativeLaunch }),
])

type ParsedTarget = Infer<typeof targetSchema>
type ParsedBrowserTarget = Exclude<ParsedTarget, { browser: 'electron' }>
type ParsedElectronTarget = Extract<ParsedTarget, { browser: 'electron' }>
type ParsedNativeTarget = Infer<typeof nativeTargetSchema>
type ParsedNativeDiagnostics = Infer<typeof nativeDiagnostics>
/** What a target is: a browser, an Electron app, or the native platform it names. */
type Kind = 'web' | 'electron' | NativePlatform
type ParsedStart = Infer<typeof startSchema>
type ParsedProxy = Infer<typeof proxySchema>

/**
 * Reads `apps`: each entry with `targets` is an app, and any other is a target that stands for an app of its
 * own, named after its browser. Returns the apps that read cleanly; the caller checks `problems`.
 */
export function readApps(value: unknown, context: ReadContext): Map<string, LoadedApp> {
  const apps = new Map<string, LoadedApp>()
  if (!isPlainObject(value)) {
    context.problems.add(['apps'], value === undefined ? 'missing required key' : `expected object, received ${describeValue(value)}`)
    return apps
  }
  if (Object.keys(value).length === 0) context.problems.add(['apps'], 'expected at least one app')
  for (const [name, entry] of Object.entries(value)) {
    const appPath = ['apps', name]
    if (!context.problems.checkName(appPath, name)) continue
    const app = isPlainObject(entry) && Object.hasOwn(entry, 'targets')
      ? readApp(name, entry, appPath, context)
      : readStandaloneTarget(name, entry, appPath, context)
    if (app !== undefined) apps.set(name, app)
  }
  checkDataFolders(apps, value, context.problems)
  checkNetworkSources(apps, value, context.problems)
  return apps
}

// A data folder holds one running Electron app at a time, so every launch of a target waits for the one before it on
// its folder. Two targets on one folder would wait on each other's idle app, the one its setup left for its first
// test, for the whole run, so each target needs a folder of its own.
function checkDataFolders(apps: ReadonlyMap<string, LoadedApp>, entries: Record<string, unknown>, problems: Problems): void {
  const folders = [...apps.values()].flatMap((app) => [...app.targets.values()].flatMap((target) => 'browser' in target && target.browser === 'electron' && target.userDataDir !== undefined ? [target.userDataDir] : []))
  const distinct = new Set(folders)
  if (folders.length < 2) return
  const first = new Map<string, string>()
  for (const [appName, app] of apps) {
    const entry = entries[appName]
    const standalone = !(isPlainObject(entry) && Object.hasOwn(entry, 'targets'))
    for (const [targetName, target] of app.targets) {
      if (!('browser' in target) || target.browser !== 'electron' || target.userDataDir === undefined) continue
      const path = standalone ? ['apps', appName] : ['apps', appName, 'targets', targetName]
      let key: string
      try { key = distinct.size === 1 ? target.userDataDir : folderKey(target.userDataDir) } catch (error) {
        problems.add([...path, 'userDataDir'], `could not read the folder or its disk's case rule: ${errorMessage(error)}`)
        continue
      }
      const earlier = first.get(key)
      if (earlier === undefined) first.set(key, path.join('.'))
      else problems.add([...path, 'userDataDir'], `is also the data folder of ${earlier}: give each Electron target a folder of its own`)
    }
  }
}

// A network file's records name their client and nothing else, so a file and client read for one app would hand it
// another's requests too. Two apps may not share one, and neither may two targets of one app that can run at once:
// iOS targets on different simulators. Targets on one simulator, or on the Mac's one desktop, run one at a time.
function checkNetworkSources(apps: ReadonlyMap<string, LoadedApp>, entries: Record<string, unknown>, problems: Problems): void {
  type Declared = { app: string; path: Path; file: string; client: string; runsOn: string }
  const declared: Declared[] = []
  for (const [appName, app] of apps) {
    const entry = entries[appName]
    const standalone = !(isPlainObject(entry) && Object.hasOwn(entry, 'targets'))
    for (const [targetName, target] of app.targets) {
      const network = 'platform' in target ? target.diagnostics?.network : undefined
      if (network === undefined || !('platform' in target)) continue
      const path = [...(standalone ? ['apps', appName] : ['apps', appName, 'targets', targetName]), 'diagnostics', 'network']
      declared.push({ app: appName, path, file: network.path, client: network.client, runsOn: target.platform === 'macos' ? 'macos' : `${target.device} (${target.runtime})` })
    }
  }
  const first = new Map<string, Declared>()
  for (const entry of declared) {
    if (!declared.some((other) => other !== entry && other.client === entry.client)) continue
    let key: string
    try { key = `${entry.client}:${folderKey(entry.file)}` } catch (error) {
      problems.add([...entry.path, 'path'], `could not read where the file is or its disk's case rule: ${errorMessage(error)}`)
      continue
    }
    const earlier = first.get(key)
    if (earlier === undefined) first.set(key, entry)
    else if (earlier.app !== entry.app) problems.add(entry.path, `is also the network source of ${configKey(earlier.path)} for the client ${entry.client}: the records cannot tell the two apps apart, so give each app a file or client of its own`)
    else if (earlier.runsOn !== entry.runsOn) problems.add(entry.path, `is also the network source of ${configKey(earlier.path)} for the client ${entry.client}, on another simulator that can run at the same time: give each simulator a file or client of its own`)
  }
}

// The settings are checked whatever the targets say, so one pass reports every problem of the app.
function readApp(name: string, entry: Record<string, unknown>, path: Path, context: ReadContext): LoadedApp | undefined {
  const { targets, ...rest } = entry
  const settings = readSettings(rest, path, context)
  const loaded = readTargets(targets, [...path, 'targets'], context)
  if (settings === undefined || loaded === undefined) return undefined
  // A target that did not read says nothing of its kind, so the kinds are checked only once every target has read.
  if (isPlainObject(targets) && loaded.size === Object.keys(targets).length) checkKinds(loaded, settings, path, context.problems)
  return { name, ...settings, targets: loaded }
}

// A test's handle on an app offers what its targets can do, so they are all one kind; a native app has no address,
// and neither has an Electron app, whose first window is the page.
function checkKinds(targets: ReadonlyMap<string, LoadedTarget>, settings: LoadedSettings, path: Path, problems: Problems): void {
  const kinds = new Set([...targets.values()].map(kindOf))
  if (kinds.size > 1) {
    const mixed = [...kinds].map(describeKind).join(' and ')
    const rule = kinds.has('electron') ? "An app's targets are all of one kind" : "An app's targets are all browsers, all iOS simulators or all macOS apps"
    problems.add([...path, 'targets'], `mixes ${mixed}. ${rule}: give each kind an app of its own`)
  }
  if (settings.baseUrl === undefined || kinds.has('web')) return
  const problem = kinds.has('electron')
    ? 'an Electron app has no address: the first window it opens is the page, so it takes no baseUrl'
    : 'a native app has no address, so it takes no baseUrl'
  problems.add([...path, 'baseUrl'], problem)
}

function readStandaloneTarget(name: string, entry: unknown, path: Path, context: ReadContext): LoadedApp | undefined {
  if (!isPlainObject(entry)) {
    context.problems.check(standaloneTargetSchema, entry, path)
    return undefined
  }
  const { baseUrl, start, ...shape } = entry
  const settings = readSettings({ ...(baseUrl === undefined ? {} : { baseUrl }), ...(start === undefined ? {} : { start }) }, path, context)
  const target = readTargetKind(shape, path, context)
  if (settings === undefined || target === undefined) return undefined
  checkKinds(new Map([[target.name, target]]), settings, path, context.problems)
  return { name, ...settings, targets: new Map([[target.name, target]]) }
}

// A target on its own is named after its browser, or its platform.
function readTargetKind(shape: Record<string, unknown>, path: Path, context: ReadContext): LoadedTarget | undefined {
  if (Object.hasOwn(shape, 'platform')) {
    const native = readNativeShape(shape, path, context.problems)
    return native === undefined ? undefined : loadNativeTarget(native.platform, native, path, context)
  }
  const target = context.problems.check(targetSchema, shape, path)
  return target === undefined ? undefined : loadTarget(target.browser, target, path, context)
}

function readTargets(value: unknown, path: Path, context: ReadContext): Map<string, LoadedTarget> | undefined {
  const { problems } = context
  if (!isPlainObject(value)) {
    problems.add(path, `expected object, received ${describeValue(value)}`)
    return undefined
  }
  if (Object.keys(value).length === 0) problems.add(path, 'expected at least one target')
  const targets = new Map<string, LoadedTarget>()
  for (const [name, entry] of Object.entries(value)) {
    const targetPath = [...path, name]
    if (!problems.checkName(targetPath, name)) continue
    const target = readTargetShape(entry, targetPath, problems)
    if (target === undefined) continue
    targets.set(name, 'platform' in target ? loadNativeTarget(name, target, targetPath, context) : loadTarget(name, target, targetPath, context))
  }
  return targets
}

// Settings that belong to the app would otherwise read as unknown keys, which hides where they go. A target that
// names a platform is a native app's; any other is a browser.
function readTargetShape(entry: unknown, path: Path, problems: Problems): ParsedTarget | ParsedNativeTarget | undefined {
  if (!isPlainObject(entry)) return problems.check(targetSchema, entry, path)
  const { baseUrl, start, ...target } = entry
  for (const [key, value] of Object.entries({ baseUrl, start })) {
    if (value !== undefined) problems.add([...path, key], `${key} belongs to the app, not to one of its targets`)
  }
  return Object.hasOwn(target, 'platform') ? readNativeShape(target, path, problems) : problems.check(targetSchema, target, path)
}

function loadTarget(name: string, target: ParsedTarget, path: Path, context: ReadContext): LoadedWebTarget | LoadedElectronTarget {
  return target.browser === 'electron' ? loadElectronTarget(name, target, path, context) : loadBrowserTarget(name, target, path, context)
}

function loadBrowserTarget(name: string, target: ParsedBrowserTarget, path: Path, { problems, folder }: ReadContext): LoadedWebTarget {
  const screen = loadScreen(target, path, problems)
  const emulate = screen === undefined ? {} : { emulate: screen }
  const proxy = target.proxy === undefined ? undefined : loadProxy(target.proxy, [...path, 'proxy'], problems)
  const base = { name, headless: target.headless ?? true, ...emulate, ...(proxy === undefined ? {} : { proxy }) }
  if (target.browser === 'chrome' || target.browser === 'edge') return { ...base, browser: target.browser, channel: target.channel ?? 'stable' }
  if (target.executablePath === undefined) return { ...base, browser: target.browser }
  problems.checkFilled([...path, 'executablePath'], target.executablePath, 'a path')
  return { ...base, browser: target.browser, executablePath: resolve(folder, target.executablePath) }
}

// Retest gives the app its debugging pipe and its data folder. Chromium reads the switches after the app's path too,
// and the last of two wins, so an argument that names either would take the app away from Retest.
function loadElectronTarget(name: string, target: ParsedElectronTarget, path: Path, { problems, folder }: ReadContext): LoadedElectronTarget {
  problems.checkFilled([...path, 'executablePath'], target.executablePath, 'a path')
  problems.checkFilled([...path, 'appPath'], target.appPath, 'a path')
  const args = target.args ?? []
  for (const [index, argument] of args.entries()) {
    const problem = reservedArgumentProblem(argument)
    if (problem !== undefined) problems.add([...path, 'args', index], problem)
  }
  if (target.userDataDir !== undefined) problems.checkFilled([...path, 'userDataDir'], target.userDataDir, 'a folder')
  const dataFolder = target.userDataDir === undefined ? {} : { userDataDir: resolve(folder, target.userDataDir) }
  const paths = { executablePath: resolve(folder, target.executablePath), appPath: resolve(folder, target.appPath) }
  return { name, browser: 'electron', ...paths, args: [...args], ...dataFolder }
}

// Chromium takes a switch written with one dash or two. The message names the switch, never the value beside it.
function reservedArgumentProblem(argument: string): string | undefined {
  const name = argument.replace(/^-{1,2}/, '--').split('=', 1)[0] ?? ''
  if (name === '--user-data-dir') return 'Retest gives the app its data folder: set userDataDir instead of --user-data-dir'
  if (name.startsWith('--remote-debugging-')) return `Retest drives the app over a debugging pipe of its own, so the app takes no ${name}`
  return undefined
}

function loadNativeTarget(name: string, target: ParsedNativeTarget, path: Path, { problems, folder }: ReadContext): LoadedNativeTarget {
  problems.checkFilled([...path, 'appPath'], target.appPath, 'a path')
  const appPath = resolve(folder, target.appPath)
  const launch = { ...(target.arguments === undefined ? {} : { arguments: [...target.arguments] }), ...(target.environment === undefined ? {} : { environment: { ...target.environment } }) }
  for (const [index, argument] of (target.arguments ?? []).entries()) {
    const reserved = reservedArgumentProblem(argument)
    if (reserved !== undefined) problems.add([...path, 'arguments', index], reserved)
    if (argument.includes('\0')) problems.add([...path, 'arguments', index], 'takes no null byte')
  }
  for (const [key, value] of Object.entries(target.environment ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) problems.add([...path, 'environment'], 'takes environment variable names only')
    else if (key.startsWith('TEST_RUNNER_') || key.startsWith('SIMCTL_CHILD_') || key.startsWith('DYLD_') || ['USE_PORT', 'USE_IP', 'USE_HOST', 'MJPEG_SERVER_PORT', 'NODE_OPTIONS'].includes(key)) problems.add([...path, 'environment', key], `Retest owns ${key}; the app cannot set it`)
    if (value.includes('\0')) problems.add([...path, 'environment', key], 'takes no null byte')
  }
  const diagnostics = target.diagnostics === undefined ? {} : { diagnostics: loadNativeDiagnostics(target.diagnostics, [...path, 'diagnostics'], { problems, folder }) }
  if (target.platform === 'macos') return { name, platform: 'macos', appPath, ...launch, ...diagnostics }
  problems.checkFilled([...path, 'device'], target.device, 'a device type such as "iPhone 17"')
  problems.checkFilled([...path, 'runtime'], target.runtime, 'an iOS version such as "26.0"')
  return { name, platform: 'ios-simulator', appPath, device: target.device, runtime: target.runtime, ...launch, ...diagnostics }
}

// The app's standard output unless the config says 'none', and the network file with its path made absolute.
function loadNativeDiagnostics(declared: ParsedNativeDiagnostics, path: Path, { problems, folder }: ReadContext): LoadedNativeDiagnostics {
  const { network } = declared
  if (network !== undefined) problems.checkFilled([...path, 'network', 'path'], network.path, 'a file')
  return { logs: declared.logs ?? 'stdout', ...(network === undefined ? {} : { network: { path: resolve(folder, network.path), client: network.client } }) }
}

function kindOf(target: LoadedTarget): Kind {
  if ('platform' in target) return target.platform
  return target.browser === 'electron' ? 'electron' : 'web'
}

function describeKind(kind: Kind): string {
  if (kind === 'web') return 'browsers'
  if (kind === 'electron') return 'Electron apps'
  return kind === 'ios-simulator' ? 'iOS simulators' : 'macOS apps'
}

// A viewport alone is the custom emulation it stands for, so it reaches the page, the events and the reports the same
// way. With `emulate` beside it, the two would disagree about the size.
function loadScreen(target: ParsedBrowserTarget, path: Path, problems: Problems): LoadedEmulation | undefined {
  const { emulate, viewport } = target
  if (emulate !== undefined && viewport !== undefined) {
    problems.add([...path, 'viewport'], 'emulate already sets the screen, so give viewport or emulate, not both')
  }
  if (emulate !== undefined) return loadEmulation(emulate, [...path, 'emulate'], problems)
  return viewport === undefined ? undefined : viewportEmulation(viewport)
}

function viewportEmulation({ width, height }: Viewport): LoadedEmulation {
  return { viewport: { width, height }, deviceScaleFactor: 1, touch: false, isMobile: false }
}

function loadEmulation(emulate: DeviceName | CustomEmulation, path: Path, problems: Problems): LoadedEmulation {
  if (typeof emulate === 'string') return emulate
  const { viewport, deviceScaleFactor, touch, isMobile, userAgent } = emulate
  if (deviceScaleFactor === 0) problems.add([...path, 'deviceScaleFactor'], 'expected number > 0, received 0')
  if (userAgent !== undefined) problems.checkFilled([...path, 'userAgent'], userAgent, 'a user agent')
  const agent = userAgent === undefined ? {} : { userAgent }
  return { viewport: { width: viewport.width, height: viewport.height }, deviceScaleFactor, touch, isMobile: isMobile ?? false, ...agent }
}

// A proxy address may hold a password, so no message quotes it.
function loadProxy(proxy: ParsedProxy, path: Path, problems: Problems): LoadedProxy | undefined {
  if (typeof proxy === 'string') {
    problems.add(path, "expected an object such as { server: 'http://127.0.0.1:8080' }, received a string")
    return undefined
  }
  const server = proxyServer(proxy.server, [...path, 'server'], problems)
  const bypass = proxy.bypass ?? []
  for (const [index, rule] of bypass.entries()) {
    const problem = bypassProblem(rule)
    if (problem !== undefined) problems.add([...path, 'bypass', index], problem)
  }
  return server === undefined ? undefined : { server, bypass }
}

function proxyServer(text: string, path: Path, problems: Problems): string | undefined {
  const url = URL.parse(text)
  if (url !== null && (url.username !== '' || url.password !== '')) {
    problems.add(path, 'holds a user name or password, and Retest does not sign in to a proxy. Give the address alone')
    return undefined
  }
  const bare = url !== null && (url.pathname === '' || url.pathname === '/') && url.search === '' && url.hash === ''
  if (url !== null && bare && url.hostname !== '' && proxySchemes.includes(url.protocol)) return `${url.protocol}//${url.host}`
  problems.add(path, 'expected a proxy address such as http://127.0.0.1:8080: the scheme http, https, socks4 or socks5, and a host')
  return undefined
}

// Chrome takes the rules as one list joined with ";".
function bypassProblem(rule: string): string | undefined {
  if (rule.includes(';')) return `expected one rule, received ${describeValue(rule)}. List each rule on its own`
  if (rule.trim() === '') return `expected a rule such as localhost or *.internal, received ${describeValue(rule)}`
  return undefined
}

type LoadedSettings = Pick<LoadedApp, 'baseUrl' | 'start'>

function readSettings(value: unknown, path: Path, context: ReadContext): LoadedSettings | undefined {
  const settings = context.problems.check(appSettingsSchema, value, path)
  if (settings === undefined) return undefined
  const { baseUrl, start } = settings
  if (baseUrl !== undefined) context.problems.checkUrl([...path, 'baseUrl'], baseUrl)
  return {
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(start === undefined ? {} : { start: loadStart(start, [...path, 'start'], context) }),
  }
}

function loadStart(start: ParsedStart, path: Path, { problems, folder }: ReadContext): LoadedStart {
  problems.checkFilled([...path, 'command'], start.command, 'a command')
  problems.checkUrl([...path, 'ready'], start.ready)
  if (start.cwd !== undefined) problems.checkFilled([...path, 'cwd'], start.cwd, 'a folder')
  if (start.timeoutMs !== undefined && start.timeoutMs > maxTimeout) {
    problems.add([...path, 'timeoutMs'], `expected integer <= ${maxTimeout}, received ${start.timeoutMs}`)
  }
  const timeout = start.timeoutMs === undefined ? {} : { timeoutMs: start.timeoutMs }
  return { command: start.command, ready: start.ready, cwd: resolve(folder, start.cwd ?? '.'), ...timeout }
}

function readNativeShape(value: Record<string, unknown>, path: Path, problems: Problems): ParsedNativeTarget | undefined {
  const parsed = parse(nativeTargetSchema, value)
  if (parsed.ok) return parsed.value
  for (const issue of parsed.issues) {
    if (issue.path.startsWith('$.arguments')) problems.add([...path, 'arguments'], 'expected a list of argument strings; argument values are withheld')
    else if (issue.path.startsWith('$.environment')) problems.add([...path, 'environment'], 'expected environment variable names mapped to strings; values are withheld')
    else problems.issues.push({ key: configKey(path) + issue.path.slice(1), message: issue.message })
  }
  return undefined
}
