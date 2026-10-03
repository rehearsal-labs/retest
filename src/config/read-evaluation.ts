import type { EvaluatorSetup, JsonValue } from '../evaluation/contract.ts'
import type { EvaluationLimits } from '../evaluation/budget.ts'
import type { EvidenceKind } from '../protocol/evaluation.ts'
import type { Path } from '../protocol/schema.ts'
import type { LoadedSecretSource } from './loaded.ts'
import type { Problems } from './problems.ts'
import type { SecretContext } from './types.ts'
import { isAbsolute, resolve } from 'node:path'
import { defaultEvaluationLimits } from '../evaluation/budget.ts'
import { describeChoices, describeValue, isArray, isPlainObject } from '../protocol/schema.ts'
import { maxTimeout } from '../protocol/timeouts.ts'

/** A factory as the config gave it: the project's own code, whose result the parent checks before using it. */
export type MakeEvaluator = (setup: EvaluatorSetup) => unknown

/**
 * Where a judge's evaluator comes from: a module file, absolute; a package specifier, resolved from the config's folder
 * when the judge is first used; or a factory the config gave.
 */
export type LoadedAdapter =
  | { readonly kind: 'file'; readonly path: string }
  | { readonly kind: 'package'; readonly specifier: string; readonly from: string }
  | { readonly kind: 'factory'; readonly factory: MakeEvaluator }

/** A judge as the runner reads it. Its credentials are sources; the parent reads them the first time a check uses it. */
export type LoadedJudge = {
  readonly name: string
  readonly adapter: LoadedAdapter
  readonly credentials: ReadonlyMap<string, LoadedSecretSource>
  readonly options: Readonly<Record<string, JsonValue>>
  readonly accepts: readonly EvidenceKind[]
}

/** `defaultJudge` is absent when several judges leave it unnamed. Every limit has its value, given or default. */
export type LoadedEvaluation = {
  readonly judges: ReadonlyMap<string, LoadedJudge>
  readonly defaultJudge?: string
  readonly timeoutMs: number
  readonly limits: EvaluationLimits
}

/** How long a check may take when neither the config nor the check says, in milliseconds. A bound, not a tuned number. */
export const defaultEvaluationTimeoutMs = 30_000

const evaluationKeys = new Set(['judges', 'defaultJudge', 'timeoutMs', 'limits'])
const judgeKeys = new Set(['adapter', 'credentials', 'options', 'accepts'])
const evidenceKinds: readonly EvidenceKind[] = ['text', 'images', 'frames']
const envName = /^[A-Za-z_][A-Za-z0-9_]*$/
const limitNames = Object.keys(defaultEvaluationLimits)

/**
 * Reads `evaluation`: the judges, each with its adapter, credentials, options and what it accepts, the default judge,
 * the time a check may take and the limits. Returns undefined when the key is absent or wrong; the caller checks
 * `problems`. A credential written as its value is refused without quoting it: credentials come from the environment
 * or from a function, never from the config's text.
 */
export function readEvaluation(value: unknown, file: string, problems: Problems): LoadedEvaluation | undefined {
  if (value === undefined) return undefined
  if (!isPlainObject(value)) {
    problems.add(['evaluation'], `expected object, received ${describeValue(value)}`)
    return undefined
  }
  for (const key of Object.keys(value)) if (!evaluationKeys.has(key)) problems.add(['evaluation', key], 'unknown key')
  const judges = readJudges(value['judges'], file, problems)
  const defaultJudge = readDefaultJudge(value['defaultJudge'], judges, problems)
  const timeoutMs = readMilliseconds(value['timeoutMs'], ['evaluation', 'timeoutMs'], problems) ?? defaultEvaluationTimeoutMs
  const limits = readLimits(value['limits'], problems)
  return { judges, ...(defaultJudge === undefined ? {} : { defaultJudge }), timeoutMs, limits }
}

function readJudges(value: unknown, file: string, problems: Problems): Map<string, LoadedJudge> {
  const judges = new Map<string, LoadedJudge>()
  const path = ['evaluation', 'judges']
  if (!isPlainObject(value)) {
    problems.add(path, value === undefined ? 'missing required key' : `expected object, received ${describeValue(value)}`)
    return judges
  }
  if (Object.keys(value).length === 0) problems.add(path, 'expected at least one judge')
  for (const [name, entry] of Object.entries(value)) {
    if (!problems.checkName([...path, name], name)) continue
    const judge = readJudge(name, entry, [...path, name], { file, problems })
    if (judge !== undefined) judges.set(name, judge)
  }
  return judges
}

type JudgeContext = { file: string; problems: Problems }

function readJudge(name: string, entry: unknown, path: Path, { file, problems }: JudgeContext): LoadedJudge | undefined {
  if (!isPlainObject(entry)) {
    problems.add(path, `expected a judge such as { adapter: './judges/visual.ts', accepts: ['images'] }, received ${describeValue(entry)}`)
    return undefined
  }
  for (const key of Object.keys(entry)) if (!judgeKeys.has(key)) problems.add([...path, key], 'unknown key')
  const adapter = readAdapter(entry['adapter'], [...path, 'adapter'], { file, problems })
  const credentials = readCredentials(name, entry['credentials'], [...path, 'credentials'], problems)
  const options = readOptions(entry['options'], [...path, 'options'], problems)
  const accepts = readAccepts(entry['accepts'], [...path, 'accepts'], problems)
  if (adapter === undefined || credentials === undefined || options === undefined || accepts === undefined) return undefined
  return { name, adapter, credentials, options, accepts }
}

// A path that starts with a dot, or an absolute one, is a file; anything else names a package.
function readAdapter(value: unknown, path: Path, { file, problems }: JudgeContext): LoadedAdapter | undefined {
  if (typeof value === 'function') return { kind: 'factory', factory: factoryOf(value) }
  if (typeof value !== 'string' || value.trim() === '') {
    problems.add(path, value === undefined ? 'missing required key' : `expected a module path such as './judges/visual.ts', a package, or a function that makes the judge, received ${describeValue(value)}`)
    return undefined
  }
  if (value.startsWith('./') || value.startsWith('../') || isAbsolute(value)) return { kind: 'file', path: resolve(file, '..', value) }
  return { kind: 'package', specifier: value, from: file }
}

function readCredentials(judge: string, value: unknown, path: Path, problems: Problems): Map<string, LoadedSecretSource> | undefined {
  const credentials = new Map<string, LoadedSecretSource>()
  if (value === undefined) return credentials
  if (!isPlainObject(value)) {
    problems.add(path, `expected credentials by name, such as { apiKey: env('API_KEY') }, received ${kindOf(value)}`)
    return undefined
  }
  let ok = true
  for (const [name, source] of Object.entries(value)) {
    if (!problems.checkName([...path, name], name)) {
      ok = false
      continue
    }
    const read = readCredentialSource(`${judge}.${name}`, source, [...path, name], problems)
    if (read === undefined) ok = false
    else credentials.set(name, read)
  }
  return ok ? credentials : undefined
}

// Only the kind of a wrong value is named: written where its source belongs, it may be the credential itself.
function readCredentialSource(label: string, source: unknown, path: Path, problems: Problems): LoadedSecretSource | undefined {
  if (typeof source === 'function') return { read: credentialReader(label, source) }
  const env = isPlainObject(source) && Object.keys(source).length === 1 ? source['env'] : undefined
  if (typeof env === 'string' && envName.test(env)) return { env }
  if (typeof env === 'string') {
    problems.add([...path, 'env'], `expected an environment variable name, received ${describeValue(env)}`)
    return undefined
  }
  const written = typeof source === 'string' ? '. Credentials are never written into the config: read one with env("NAME") or a function' : ''
  problems.add(path, `expected env("NAME") or a function that returns the credential, received ${kindOf(source)}${written}`)
  return undefined
}

// What a function gives back is checked once, here, and an error never shows it.
function credentialReader(label: string, source: Function): (context: SecretContext) => Promise<string> {
  return async (context) => {
    const value: unknown = await source(context)
    if (typeof value === 'string' && value !== '') return value
    throw new TypeError(`The function for the credential ${label} returned ${typeof value === 'string' ? 'an empty string' : kindOf(value)}, not the credential's text.`)
  }
}

function readOptions(value: unknown, path: Path, problems: Problems): Record<string, JsonValue> | undefined {
  if (value === undefined) return {}
  if (!isPlainObject(value)) {
    problems.add(path, `expected an object of JSON values, received ${describeValue(value)}`)
    return undefined
  }
  const found = jsonProblem(value, path)
  if (found !== undefined) {
    problems.add(found.path, found.message)
    return undefined
  }
  const options: Record<string, JsonValue> = {}
  for (const [key, entry] of Object.entries(value)) {
    const json = asJson(entry)
    if (json !== undefined) options[key] = json
  }
  return options
}

function readAccepts(value: unknown, path: Path, problems: Problems): EvidenceKind[] | undefined {
  if (!isArray(value) || value.length === 0) {
    problems.add(path, value === undefined ? `missing required key: say what the judge takes, from ${describeChoices(evidenceKinds)}` : `expected a list from ${describeChoices(evidenceKinds)}, received ${describeValue(value)}`)
    return undefined
  }
  const accepts: EvidenceKind[] = []
  for (const [index, kind] of value.entries()) {
    const known = evidenceKinds.find((each) => each === kind)
    if (known === undefined) problems.add([...path, index], `expected ${describeChoices(evidenceKinds)}, received ${describeValue(kind)}`)
    else if (accepts.includes(known)) problems.add([...path, index], `repeats ${JSON.stringify(known)}`)
    else accepts.push(known)
  }
  return accepts.length === value.length ? accepts : undefined
}

// A judge that failed to read is still declared, so it is not reported again as unknown.
function readDefaultJudge(value: unknown, judges: ReadonlyMap<string, LoadedJudge>, problems: Problems): string | undefined {
  if (value === undefined) return judges.size === 1 ? judges.keys().next().value : undefined
  if (typeof value !== 'string' || !judges.has(value)) {
    const known = judges.size === 0 ? 'no judge is declared' : `expected ${describeChoices(judges.keys())}`
    problems.add(['evaluation', 'defaultJudge'], `${known}, received ${describeValue(value)}`)
    return undefined
  }
  return value
}

function readLimits(value: unknown, problems: Problems): EvaluationLimits {
  if (value === undefined) return defaultEvaluationLimits
  if (!isPlainObject(value)) {
    problems.add(['evaluation', 'limits'], `expected object, received ${describeValue(value)}`)
    return defaultEvaluationLimits
  }
  const given: Record<string, number> = {}
  for (const [name, limit] of Object.entries(value)) {
    const path = ['evaluation', 'limits', name]
    if (!limitNames.includes(name)) {
      problems.add(path, `unknown key, expected ${describeChoices(limitNames)}`)
      continue
    }
    const read = readMilliseconds(limit, path, problems, 'a whole number from 1')
    if (read !== undefined) given[name] = read
  }
  return { ...defaultEvaluationLimits, ...given }
}

function readMilliseconds(value: unknown, path: Path, problems: Problems, what = 'a whole number of milliseconds from 1'): number | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= maxTimeout) return value
  problems.add(path, `expected ${what} to ${maxTimeout}, received ${describeValue(value)}`)
  return undefined
}

function jsonProblem(value: unknown, path: Path): { path: Path; message: string } | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return undefined
  if (typeof value === 'number') return Number.isFinite(value) ? undefined : { path, message: `expected a finite number, received ${describeValue(value)}` }
  if (isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = jsonProblem(item, [...path, index])
      if (found !== undefined) return found
    }
    return undefined
  }
  if (!isPlainObject(value)) return { path, message: `expected a JSON value, received ${typeof value}` }
  for (const [key, item] of Object.entries(value)) {
    const found = jsonProblem(item, [...path, key])
    if (found !== undefined) return found
  }
  return undefined
}

// Called only on a value `jsonProblem` accepted, so nothing is left out; `null` is a value like any other.
function asJson(value: unknown): JsonValue | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return value
  if (isArray(value)) return value.flatMap((item) => jsonItem(item))
  if (!isPlainObject(value)) return undefined
  const object: Record<string, JsonValue> = {}
  for (const [key, item] of Object.entries(value)) {
    const json = asJson(item)
    if (json !== undefined) object[key] = json
  }
  return object
}

function jsonItem(item: unknown): JsonValue[] {
  const json = asJson(item)
  return json === undefined ? [] : [json]
}

// A config's function is the project's code; the parent calls it with a setup and checks what it returns.
function factoryOf(value: Function): MakeEvaluator {
  return (setup) => {
    const made: unknown = value(setup)
    return made
  }
}

function kindOf(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value === 'string' ? 'a string' : typeof value
}
