import type { Failure } from '../protocol/failures.ts'
import type { Path } from '../protocol/schema.ts'
import type { Timeouts } from '../protocol/timeouts.ts'
import type { Variant } from '../protocol/variant.ts'
import type { LoadedApp, LoadedConfig } from './loaded.ts'
import type { ConfigIssue } from './problems.ts'
import type { BaseUrlHost, SecretDestinations } from './read-secrets.ts'
import { dirname, resolve } from 'node:path'
import { readDiagnostics } from '../diagnostics/policy.ts'
import { tagOperators } from '../protocol/names.ts'
import { describeChoices, describeValue, isPlainObject, s } from '../protocol/schema.ts'
import { maxTimeout, partialTimeoutsSchema } from '../protocol/timeouts.ts'
import { variantKey } from '../protocol/variant.ts'
import { configKey, Problems } from './problems.ts'
import { readApps } from './read-apps.ts'
import { readEvaluation } from './read-evaluation.ts'
import { readPixels, readRecording } from './read-recording.ts'
import { readSecrets } from './read-secrets.ts'

export type ConfigResult = { ok: true; config: LoadedConfig } | { ok: false; failure: Failure }

const configKeys = new Set(['apps', 'defaultApp', 'runs', 'secrets', 'secretOrigins', 'testIds', 'tags', 'states', 'locks', 'timeouts', 'evaluation', 'diagnostics', 'recording', 'pixels'])
const namesSchema = s.array(s.string())
const runsSchema = s.array(s.record(s.string()))
const testIdsSchema = s.union([s.record(s.string()), s.array(s.string())])

/**
 * Checks a config and reads it into the shape the runner uses. `path` is where it came from: messages name it,
 * and relative paths in it start from its folder. A key set to undefined counts as absent. Anything wrong is a
 * usage failure that names every key at fault, the first in `details.key`.
 *
 * @example const loaded = validateConfig(imported.default, 'retest.config.ts')
 */
export function validateConfig(value: unknown, path: string): ConfigResult {
  const problems = new Problems()
  const config = readConfig(withoutUndefined(value, new WeakSet()), resolve(path), problems)
  const [first] = problems.issues
  if (config !== undefined && first === undefined) return { ok: true, config }
  return { ok: false, failure: configFailure(path, problems.issues) }
}

function readConfig(value: unknown, file: string, problems: Problems): LoadedConfig | undefined {
  if (!isPlainObject(value)) {
    problems.add([], `expected the object defineConfig() returns, received ${describeValue(value)}`)
    return undefined
  }
  for (const key of Object.keys(value)) {
    if (!configKeys.has(key)) problems.add([key], 'unknown key')
  }
  const declaredApps = isPlainObject(value['apps']) ? Object.keys(value['apps']) : []
  const apps = readApps(value['apps'], { problems, folder: dirname(file) })
  const defaultApp = readDefaultApp(value['defaultApp'], declaredApps, problems)
  const runs = readRuns(value['runs'], { declaredApps, apps, problems })
  const secrets = readSecrets(value['secrets'], value['secretOrigins'], problems, secretDestinations(apps))
  if (value['testIds'] !== undefined) problems.check(testIdsSchema, value['testIds'], ['testIds'])
  const tags = readNames(value['tags'], ['tags'], problems)
  for (const [index, tag] of (tags ?? []).entries()) {
    if (tagOperators.has(tag)) problems.add(['tags', index], `${JSON.stringify(tag)} cannot be a tag, because --tag reads it as a word`)
  }
  const states = readNames(value['states'], ['states'], problems)
  const locks = readNames(value['locks'], ['locks'], problems)
  const timeouts = readTimeouts(value['timeouts'], problems)
  const evaluation = readEvaluation(value['evaluation'], file, problems)
  const diagnostics = readDiagnostics(value['diagnostics'], problems)
  const pixels = readPixels(value['pixels'], problems, declaredApps)
  const recording = readRecording(value['recording'], problems, declaredApps, pixels ?? new Map())
  return {
    file,
    apps,
    ...(defaultApp === undefined ? {} : { defaultApp }),
    runs,
    secrets,
    ...(tags === undefined ? {} : { tags }),
    ...(states === undefined ? {} : { states }),
    ...(locks === undefined ? {} : { locks }),
    timeouts,
    ...(evaluation === undefined ? {} : { evaluation }),
    ...(diagnostics === undefined ? {} : { diagnostics }),
    ...(recording === undefined ? {} : { recording }),
    ...(pixels === undefined || pixels.size === 0 ? {} : { pixels }),
  }
}

// An app that failed to read is still declared, so it is not reported again as unknown.
function readDefaultApp(value: unknown, declaredApps: readonly string[], problems: Problems): string | undefined {
  if (value === undefined) return declaredApps.length === 1 ? declaredApps[0] : undefined
  const name = problems.check(s.string(), value, ['defaultApp'])
  if (name === undefined || declaredApps.includes(name)) return name
  problems.add(['defaultApp'], `expected ${describeChoices(declaredApps)}, received ${describeValue(name)}`)
  return undefined
}

type RunsContext = { declaredApps: readonly string[]; apps: ReadonlyMap<string, LoadedApp>; problems: Problems }

function readRuns(value: unknown, context: RunsContext): Variant[] {
  if (value === undefined) return []
  const entries = context.problems.check(runsSchema, value, ['runs']) ?? []
  const firstIndex = new Map<string, number>()
  const runs: Variant[] = []
  for (const [index, entry] of entries.entries()) {
    const path = ['runs', index]
    if (!isRun(entry, path, context)) continue
    const key = variantKey(entry)
    const first = firstIndex.get(key)
    if (first === undefined) {
      firstIndex.set(key, index)
      runs.push({ ...entry })
    } else {
      context.problems.add(path, `repeats ${configKey(['runs', first])}`)
    }
  }
  return runs
}

function isRun(entry: Variant, path: Path, context: RunsContext): boolean {
  const pairs = Object.entries(entry)
  if (pairs.length > 0) return pairs.map(([app, target]) => isRunTarget(app, target, [...path, app], context)).every(Boolean)
  context.problems.add(path, 'expected at least one app')
  return false
}

// An app that failed to read has its problems under apps already.
function isRunTarget(app: string, target: string, path: Path, { declaredApps, apps, problems }: RunsContext): boolean {
  if (!declaredApps.includes(app)) {
    problems.add(path, `unknown app, expected ${describeChoices(declaredApps)}`)
    return false
  }
  const targets = apps.get(app)?.targets
  if (targets === undefined || targets.has(target)) return targets !== undefined
  problems.add(path, `expected ${describeChoices(targets.keys())}, received ${describeValue(target)}`)
  return false
}

function readNames(value: unknown, path: Path, problems: Problems): string[] | undefined {
  if (value === undefined) return undefined
  const names = problems.check(namesSchema, value, path)
  const firstIndex = new Map<string, number>()
  for (const [index, name] of (names ?? []).entries()) {
    if (!problems.checkName([...path, index], name)) continue
    const first = firstIndex.get(name)
    if (first === undefined) firstIndex.set(name, index)
    else problems.add([...path, index], `repeats ${configKey([...path, first])}`)
  }
  return names
}

function readTimeouts(value: unknown, problems: Problems): Partial<Timeouts> {
  if (value === undefined) return {}
  const timeouts = problems.check(partialTimeoutsSchema, value, ['timeouts']) ?? {}
  for (const [name, milliseconds] of Object.entries(timeouts)) {
    if (milliseconds !== undefined && milliseconds > maxTimeout) {
      problems.add(['timeouts', name], `expected integer <= ${maxTimeout}, received ${milliseconds}`)
    }
  }
  return timeouts
}

function configFailure(path: string, issues: readonly ConfigIssue[]): Failure {
  const lines = issues.map(({ key, message }) => (key === '' ? message : `${key}: ${message}`))
  const message =
    lines.length === 1 ? `${path}: ${lines[0]}` : `${path} has ${lines.length} problems:\n${lines.map((line) => `  ${line}`).join('\n')}`
  return { class: 'usage', message, details: { key: issues[0]?.key ?? '' } }
}

// Objects are walked once each, so a config that refers to itself still ends.
function withoutUndefined(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value !== 'object' || value === null || seen.has(value)) return value
  seen.add(value)
  if (Array.isArray(value)) return value.map((item: unknown) => withoutUndefined(item, seen))
  if (!isPlainObject(value)) return value
  const kept = Object.entries(value).filter(([, entry]) => entry !== undefined)
  return Object.fromEntries(kept.map(([key, entry]) => [key, withoutUndefined(entry, seen)]))
}

// A native app's destination is its exact bundle id, which only a config with a native app reads; HTTP origins keep
// the web validation. The hosts of the config's own base URLs are never read as bundle ids.
function secretDestinations(apps: ReadonlyMap<string, LoadedApp>): SecretDestinations {
  const bundles = [...apps.values()].some((app) => [...app.targets.values()].some((target) => 'platform' in target))
  const hosts = new Map<string, BaseUrlHost>()
  for (const app of apps.values()) {
    const url = app.baseUrl === undefined ? null : URL.parse(app.baseUrl)
    if (url !== null && url.hostname !== '' && !hosts.has(url.hostname)) hosts.set(url.hostname, { app: configKey(['apps', app.name]), origin: url.origin })
  }
  return { bundles, hosts }
}
