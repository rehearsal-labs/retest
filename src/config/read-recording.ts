import type { AppPixelRules } from '../media/policy.ts'
import type { Failure } from '../protocol/failures.ts'
import type { Path } from '../protocol/schema.ts'
import type { RecordingConfig } from './types.ts'
import { appPixelRules, appPixelRulesSchema } from '../media/policy.ts'
import { describeChoices, describeValue, isPlainObject, s } from '../protocol/schema.ts'
import { Problems } from './problems.ts'

/**
 * Recording as a run follows it, with every default filled in. `apps` holds the apps the config turned on or off by
 * name; every other app follows `record`. `size` is the video's width and height in pixels.
 */
export type RecordingSettings = {
  readonly nativeWithholding: boolean
  readonly record: boolean
  readonly apps: ReadonlyMap<string, boolean>
  readonly required: boolean
  readonly keep: 'all' | 'failures'
  readonly fps: number
  readonly size: { readonly width: number; readonly height: number }
}

/** Nothing recorded, nothing required, every recording kept, 10 frames a second at 1280 by 720. */
export const defaultRecordingSettings: RecordingSettings = Object.freeze({ record: false, nativeWithholding: false, apps: new Map<string, boolean>(), required: false, keep: 'all', fps: 10, size: Object.freeze({ width: 1280, height: 720 }) })

const recordingKeys = new Set(['nativeWithholding', 'record', 'apps', 'required', 'keep', 'fps', 'size'])
const maxFps = 30
const minSide = 16
const maxSide = 4096

/**
 * Reads a `recording` block, from a config or from `RunOptions`, into settings. Returns undefined when the block is
 * absent or wrong; the caller checks `problems`. `apps` are the config's app names, `pixels` the apps' pixel rules: an app
 * turned on by name must be one of the apps and allow recordings, and `required` needs something recorded.
 *
 * @example readRecording({ record: true }, problems, ['web'], new Map())?.record // true
 */
export function readRecording(value: unknown, problems: Problems, apps: readonly string[], pixels: ReadonlyMap<string, AppPixelRules>, path: Path = ['recording']): RecordingSettings | undefined {
  if (value === undefined) return undefined
  if (!isPlainObject(value)) {
    problems.add(path, `expected object, received ${describeValue(value)}`)
    return undefined
  }
  const before = problems.issues.length
  for (const key of Object.keys(value)) if (!recordingKeys.has(key)) problems.add([...path, key], 'unknown key')
  const nativeWithholding = value['nativeWithholding'] === undefined ? false : problems.check(s.boolean(), value['nativeWithholding'], [...path, 'nativeWithholding'])
  const record = value['record'] === undefined ? false : problems.check(s.boolean(), value['record'], [...path, 'record'])
  const required = value['required'] === undefined ? false : problems.check(s.boolean(), value['required'], [...path, 'required'])
  const keep = value['keep'] === undefined ? 'all' : problems.check(s.enum(['all', 'failures']), value['keep'], [...path, 'keep'])
  const fps = value['fps'] === undefined ? defaultRecordingSettings.fps : readFps(value['fps'], problems, [...path, 'fps'])
  const size = value['size'] === undefined ? defaultRecordingSettings.size : readSize(value['size'], problems, [...path, 'size'])
  const named = readApps(value['apps'], problems, [...path, 'apps'], { apps, pixels })
  if (problems.issues.length > before || nativeWithholding === undefined || record === undefined || required === undefined || keep === undefined || fps === undefined || size === undefined || named === undefined) return undefined
  const settings: RecordingSettings = { record, nativeWithholding, apps: named, required, keep, fps, size }
  if (required && !apps.some((app) => recordsApp(settings, app, pixels))) {
    problems.add([...path, 'required'], 'cannot be true while no app is recorded')
    return undefined
  }
  return settings
}

/**
 * Reads a `pixels` block: each app's pixel rules, by app name. Returns undefined when the block is absent or wrong.
 *
 * @example readPixels({ web: { screenshots: 'never' } }, problems, ['web'])?.get('web')?.screenshots // 'never'
 */
export function readPixels(value: unknown, problems: Problems, apps: readonly string[], path: Path = ['pixels']): ReadonlyMap<string, AppPixelRules> | undefined {
  if (value === undefined) return undefined
  if (!isPlainObject(value)) {
    problems.add(path, `expected object, received ${describeValue(value)}`)
    return undefined
  }
  const rules = new Map<string, AppPixelRules>()
  for (const [app, entry] of Object.entries(value)) {
    if (!apps.includes(app)) {
      problems.add([...path, app], `unknown app, expected ${describeChoices(apps)}`)
      continue
    }
    const read = problems.check(appPixelRulesSchema, entry, [...path, app])
    if (read !== undefined) rules.set(app, appPixelRules(read))
  }
  return rules
}

/**
 * Whether a run records `app`: its own setting when the config names it, otherwise the run's `record`, and never when
 * the app's pixel rules forbid recordings.
 *
 * @example recordsApp({ ...defaultRecordingSettings, record: true }, 'web', new Map()) // true
 */
export function recordsApp(settings: RecordingSettings, app: string, pixels: ReadonlyMap<string, AppPixelRules>): boolean {
  if (pixels.get(app)?.recordings === 'never') return false
  return settings.apps.get(app) ?? settings.record
}

/**
 * The settings a run follows: the host's `RunOptions.recording` when given, whole, or else the config's, or else the
 * default, which records nothing. A host block that cannot be read is a usage failure that names every key at fault.
 *
 * @example resolveRecording(undefined, undefined, ['web'], new Map()) // { ok: true, settings: defaultRecordingSettings }
 */
export function resolveRecording(options: RecordingConfig | undefined, configured: RecordingSettings | undefined, apps: readonly string[], pixels: ReadonlyMap<string, AppPixelRules>, environment: Readonly<Record<string, string | undefined>> = process.env): { ok: true; settings: RecordingSettings } | { ok: false; failure: Failure } {
  const override = environment['RETEST_NATIVE_WITHHOLDING']
  if (override !== undefined && override !== 'true' && override !== 'false') return { ok: false, failure: { class: 'usage', message: 'RETEST_NATIVE_WITHHOLDING must be true or false.', details: { key: 'RETEST_NATIVE_WITHHOLDING' } } }
  let settings = configured ?? defaultRecordingSettings
  if (options !== undefined) {
    const problems = new Problems()
    const read = readRecording(withoutUndefined(options), problems, apps, pixels)
    if (read === undefined || problems.issues.length > 0) {
      const lines = problems.issues.map(({ key, message }) => `${key}: ${message}`)
      const counted = lines.length === 1 ? 'has a problem' : `has ${lines.length} problems`
      return { ok: false, failure: { class: 'usage', message: `RunOptions.recording ${counted}: ${lines.join('; ')}`, details: { key: problems.issues[0]?.key ?? 'recording' } } }
    }
    settings = read
  }
  return { ok: true, settings: override === undefined ? settings : { ...settings, nativeWithholding: override === 'true' } }
}

function readFps(value: unknown, problems: Problems, path: Path): number | undefined {
  const fps = problems.check(s.number({ integer: true, min: 1 }), value, path)
  if (fps === undefined || fps <= maxFps) return fps
  problems.add(path, `expected integer <= ${maxFps}, received ${fps}`)
  return undefined
}

function readSize(value: unknown, problems: Problems, path: Path): { width: number; height: number } | undefined {
  const size = problems.check(s.object({ width: s.number({ integer: true, min: minSide }), height: s.number({ integer: true, min: minSide }) }), value, path)
  if (size === undefined) return undefined
  let fine = true
  for (const side of ['width', 'height'] as const) {
    if (size[side] > maxSide) problems.add([...path, side], `expected integer <= ${maxSide}, received ${size[side]}`)
    else if (size[side] % 2 !== 0) problems.add([...path, side], `expected an even number, since video encoders need one, received ${size[side]}`)
    else continue
    fine = false
  }
  return fine ? { width: size.width, height: size.height } : undefined
}

function readApps(value: unknown, problems: Problems, path: Path, known: { apps: readonly string[]; pixels: ReadonlyMap<string, AppPixelRules> }): Map<string, boolean> | undefined {
  if (value === undefined) return new Map()
  const entries = problems.check(s.record(s.boolean()), value, path)
  if (entries === undefined) return undefined
  const named = new Map<string, boolean>()
  for (const [app, on] of Object.entries(entries)) {
    if (!known.apps.includes(app)) problems.add([...path, app], `unknown app, expected ${describeChoices(known.apps)}`)
    else if (on && known.pixels.get(app)?.recordings === 'never') problems.add([...path, app], `cannot be true while pixels.${app}.recordings is never`)
    else named.set(app, on)
  }
  return named
}

// A host's block may carry keys set to undefined, which count as absent, as they do in a config.
function withoutUndefined(value: RecordingConfig): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined))
}
