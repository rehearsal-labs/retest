import type { Infer, Path } from '../protocol/schema.ts'
import type { DeviceName } from './devices.ts'
import type { LoadedApp, LoadedEmulation, LoadedProxy, LoadedStart, LoadedTarget } from './loaded.ts'
import type { Problems } from './problems.ts'
import type { CustomEmulation } from './types.ts'
import { resolve } from 'node:path'
import { describeValue, isPlainObject, s } from '../protocol/schema.ts'
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

const targetSchema = s.discriminatedUnion('browser', [
  s.object({ browser: s.literal('chromium'), executablePath: s.optional(s.string()), ...targetSettings }),
  s.object({ browser: s.literal('chrome'), channel, ...targetSettings }),
  s.object({ browser: s.literal('edge'), channel, ...targetSettings }),
])
const standaloneTargetSchema = s.discriminatedUnion('browser', [
  s.object({ browser: s.literal('chromium'), executablePath: s.optional(s.string()), ...targetSettings, ...appSettings }),
  s.object({ browser: s.literal('chrome'), channel, ...targetSettings, ...appSettings }),
  s.object({ browser: s.literal('edge'), channel, ...targetSettings, ...appSettings }),
])

type ParsedTarget = Infer<typeof targetSchema>
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
  return apps
}

// The settings are checked whatever the targets say, so one pass reports every problem of the app.
function readApp(name: string, entry: Record<string, unknown>, path: Path, context: ReadContext): LoadedApp | undefined {
  const { targets, ...rest } = entry
  const settings = readSettings(rest, path, context)
  const loaded = readTargets(targets, [...path, 'targets'], context)
  if (settings === undefined || loaded === undefined) return undefined
  return { name, ...settings, targets: loaded }
}

function readStandaloneTarget(name: string, entry: unknown, path: Path, context: ReadContext): LoadedApp | undefined {
  if (!isPlainObject(entry)) {
    context.problems.check(standaloneTargetSchema, entry, path)
    return undefined
  }
  const { baseUrl, start, ...shape } = entry
  const settings = readSettings({ ...(baseUrl === undefined ? {} : { baseUrl }), ...(start === undefined ? {} : { start }) }, path, context)
  const target = context.problems.check(targetSchema, shape, path)
  if (settings === undefined || target === undefined) return undefined
  const loaded = loadTarget(target.browser, target, path, context)
  return { name, ...settings, targets: new Map([[target.browser, loaded]]) }
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
    if (target !== undefined) targets.set(name, loadTarget(name, target, targetPath, context))
  }
  return targets
}

// Settings that belong to the app would otherwise read as unknown keys, which hides where they go.
function readTargetShape(entry: unknown, path: Path, problems: Problems): ParsedTarget | undefined {
  if (!isPlainObject(entry)) return problems.check(targetSchema, entry, path)
  const { baseUrl, start, ...target } = entry
  for (const [key, value] of Object.entries({ baseUrl, start })) {
    if (value !== undefined) problems.add([...path, key], `${key} belongs to the app, not to one of its targets`)
  }
  return problems.check(targetSchema, target, path)
}

function loadTarget(name: string, target: ParsedTarget, path: Path, { problems, folder }: ReadContext): LoadedTarget {
  const emulate = target.emulate === undefined ? {} : { emulate: loadEmulation(target.emulate, [...path, 'emulate'], problems) }
  const proxy = target.proxy === undefined ? undefined : loadProxy(target.proxy, [...path, 'proxy'], problems)
  const base = { name, headless: target.headless ?? true, ...emulate, ...(proxy === undefined ? {} : { proxy }) }
  if (target.browser !== 'chromium') return { ...base, browser: target.browser, channel: target.channel ?? 'stable' }
  if (target.executablePath === undefined) return { ...base, browser: 'chromium' }
  problems.checkFilled([...path, 'executablePath'], target.executablePath, 'a path')
  return { ...base, browser: 'chromium', executablePath: resolve(folder, target.executablePath) }
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
