import type { LoadedSecret, LoadedSecretSource, LoadedTarget } from '../config/loaded.ts'
import type { LoadedEvaluation, LoadedJudge } from '../config/read-evaluation.ts'
import type { HostEvaluationRecord } from '../protocol/evaluation.ts'
import type {
  AppSettings,
  BundleRecord,
  ConfigurationRecord,
  DiagnosticsSettings,
  EvaluationSettings,
  ExecutionRecord,
  ExecutionSettings,
  JudgeSettings,
  ModuleRecord,
  RequirementCheck,
  RequirementRecord,
  RuntimeRecord,
  SecretDeclaration,
  SecretReference,
  SessionRecord,
  StartingState,
} from '../protocol/execution.ts'
import type { Failure } from '../protocol/failures.ts'
import type { HostCheck } from '../protocol/host-check.ts'
import type { Timeouts } from '../protocol/timeouts.ts'
import type { Variant } from '../protocol/variant.ts'
import type { HostChecks, TestHostCheck } from './host-checks.ts'
import type { PlannedTest } from './plan.ts'
import type { RunConfig } from './run-config.ts'
import { readFileSync } from 'node:fs'
import { dirname, extname, join, resolve } from 'node:path'
import { promptVersion } from '../evaluation/instructions.ts'
import { canonicalJson, executionRecordSchema, executionSettingsSchema, isSha256 } from '../protocol/execution.ts'
import { failure } from '../protocol/failures.ts'
import { hostCheckRecord } from '../protocol/host-check.ts'
import { describeValue, formatPath, isPlainObject, parse } from '../protocol/schema.ts'
import { withoutCredentials } from '../protocol/url.ts'
import { relativePosixPath } from '../shared/posix-path.ts'
import { sha256Hex } from '../shared/sha256.ts'

/**
 * The requirement a host holds its checks to: a version it names, and, once it has frozen them, each check's id with
 * the SHA-256 of its content as a run recorded it. A frozen requirement refuses a run whose checks differ from it in
 * any way: a changed check, a missing one or a new one each need a new version.
 */
export type Requirement = { readonly version: string; readonly checks?: Readonly<Record<string, string>> }

/** A host AI check's content, as `run.started` records it and as an attempt runs it. */
export type EvaluationCheckContent = Pick<HostEvaluationRecord, 'id' | 'judge' | 'criteria' | 'context' | 'evidence' | 'timeoutMs'>

/** Hides every value the run has read in a string. */
export type Redact = (text: string) => string

/** The judges of a run as the fingerprint reads them, by name, and the one a check that names none uses. */
export type RunJudges = { readonly byName: ReadonlyMap<string, JudgeSettings>; readonly defaultJudge: string | undefined }

/** What a test attempt's configuration is read from. */
export type SettingsInput = {
  config: RunConfig
  /** The run's evaluation settings, when the config has judges. */
  evaluation: LoadedEvaluation | undefined
  /** The judges this test's host AI checks use, as the run reads them. */
  judges: readonly JudgeSettings[]
  /** False when the run shows every browser, as `--headed` asks. */
  headless: boolean
  test: PlannedTest
  targets: Variant
  /** The test's budgets, its own timeout in place. */
  timeouts: Timeouts
  /** The environment the host gave the test file's process, when it gave one; only its names are recorded. */
  environment: Readonly<Record<string, string>> | undefined
  diagnostics: DiagnosticsSettings
  playwright: boolean
}

// The files a test file's process loads as modules; anything else in its list is not hashed.
const moduleExtensions = new Set(['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs', '.json'])

/**
 * Each module the test file's process says it loaded, read and hashed by the parent from disk, by its path from the
 * root. Undefined when the process said nothing, or named a path Retest will not read: absolute, not POSIX, not a module
 * file, named twice, or one that cannot be read. A path already hashed in `known` keeps that hash, since the process
 * loads each module once.
 *
 * @example hashModules('/work', ['tests/a.retest.ts', 'tests/helpers/titles.ts'], new Map())
 */
export function hashModules(rootDir: string, paths: readonly string[] | undefined, known: Map<string, string>): ModuleRecord[] | undefined {
  if (paths === undefined || paths.length === 0) return undefined
  const modules: ModuleRecord[] = []
  for (const path of new Set(paths)) {
    if (path === '' || path.startsWith('/') || path.includes('\\') || !moduleExtensions.has(extname(path))) return undefined
    const hashed = known.get(path) ?? readHash(resolve(rootDir, path))
    if (hashed === undefined) return undefined
    known.set(path, hashed)
    modules.push({ path, sha256: hashed })
  }
  return modules.length === paths.length ? modules : undefined
}

/**
 * The bundle of modules, sorted by path, and the SHA-256 of that list as canonical JSON, or undefined when there is no
 * list or one Retest cannot trust: a path that is absolute or not POSIX, or a hash that is not SHA-256.
 *
 * @example bundleRecord([{ path: 'tests/a.retest.ts', sha256 }])?.sha256
 */
export function bundleRecord(modules: readonly ModuleRecord[] | undefined): BundleRecord | undefined {
  if (modules === undefined || modules.length === 0) return undefined
  const paths = new Set<string>()
  for (const { path, sha256 } of modules) {
    if (path === '' || path.startsWith('/') || path.includes('\\') || !isSha256(sha256) || paths.has(path)) return undefined
    paths.add(path)
  }
  const sorted = [...modules].map(({ path, sha256 }) => ({ path, sha256 })).sort((first, second) => (first.path < second.path ? -1 : first.path > second.path ? 1 : 0))
  return { sha256: sha256Hex(canonicalJson(sorted)), modules: sorted }
}

/**
 * The run's judges as the fingerprint reads them: each adapter's code, as the SHA-256 of a file adapter, the installed
 * version of a package adapter or `codeUnavailable` for a factory or an adapter Retest cannot read, the evidence it
 * accepts, its credentials by reference and the SHA-256 of its options, every string redacted first.
 *
 * @example runJudges(config.evaluation, '/work', (text) => redactor.redact(text)).byName.get('visual')?.moduleSha256
 */
export function runJudges(evaluation: LoadedEvaluation | undefined, rootDir: string, redact: Redact): RunJudges {
  const byName = new Map([...(evaluation?.judges.values() ?? [])].map((judge) => [judge.name, judgeSettings(judge, rootDir, redact)]))
  return { byName, defaultJudge: evaluation?.defaultJudge }
}

/**
 * The judge a check uses: the one it names, or the run's default.
 *
 * @example judgeFor(judges, undefined)?.name // the default judge
 */
export function judgeFor(judges: RunJudges, name: string | undefined): JudgeSettings | undefined {
  const chosen = name ?? judges.defaultJudge
  return chosen === undefined ? undefined : judges.byName.get(chosen)
}

/**
 * The settings in effect for one test attempt: its own apps' targets, its budgets, its locks, the environment the host
 * gave its process, by name with each value redacted, the diagnostics policy, the judges its host AI checks use and the
 * Playwright mode. Nothing here holds a secret's value, nor anything that only says where a thing is on this machine,
 * nor a judge or secret the test does not name.
 *
 * @example executionSettings(input).apps
 */
export function executionSettings(input: SettingsInput): ExecutionSettings {
  const { config, test, targets, evaluation, judges } = input
  const apps: Record<string, AppSettings> = {}
  for (const app of test.apps) {
    const name = targets[app]
    const target = name === undefined ? undefined : config.apps.get(app)?.targets.get(name)
    if (target !== undefined) apps[app] = appSettings(target, input.headless)
  }
  const evaluationSettings: EvaluationSettings | undefined =
    evaluation === undefined || judges.length === 0
      ? undefined
      : { judges: [...new Map(judges.map((judge) => [judge.name, judge])).values()], timeoutMs: evaluation.timeoutMs, limits: { ...evaluation.limits }, promptVersion }
  return {
    apps,
    timeouts: { ...input.timeouts },
    locks: [...(test.registered.locks ?? [])],
    // The names alone: a value the host put there is its own, and not declared a secret, so none is written or hashed.
    ...(input.environment === undefined ? {} : { environment: Object.keys(input.environment).sort() }),
    diagnostics: input.diagnostics,
    ...(evaluationSettings === undefined ? {} : { evaluation: evaluationSettings }),
    ...(input.playwright ? { playwright: true as const } : {}),
  }
}

/**
 * The secrets a config declares, by reference: each one's name, where it is read from and the origins beyond a test's
 * apps where it may be typed. Never a value.
 *
 * @example secretDeclarations(config.secrets) // [{ name: 'password', source: 'env', variable: 'TASK_PASSWORD', origins: [] }]
 */
export function secretDeclarations(secrets: ReadonlyMap<string, LoadedSecret>): SecretDeclaration[] {
  return [...secrets].map(([name, secret]) => ({ ...secretReference(name, secret.source), origins: [...secret.origins] }))
}

/**
 * The settings, every string in them redacted, and their fingerprint, the SHA-256 of their canonical JSON once redacted,
 * so no value the run has read reaches the record or the hash.
 *
 * @example configurationRecord(settings, (text) => redactor.redact(text)).sha256
 */
export function configurationRecord(settings: ExecutionSettings, redact: Redact): ConfigurationRecord {
  const redacted = parse(executionSettingsSchema, redactStrings(settings, redact))
  if (!redacted.ok) throw new Error(`Redacting the execution settings changed their shape: ${redacted.issues.map((issue) => `${issue.path} ${issue.message}`).join('; ')}`)
  return { sha256: sha256Hex(canonicalJson(redacted.value)), settings: redacted.value }
}

/**
 * An execution record with every string in it redacted, checked again against its schema. Every fingerprint in it was
 * taken over redacted text already, so each still matches what the record shows.
 *
 * @example redactedRecord(record, (text) => redactor.redact(text))
 */
export function redactedRecord(record: ExecutionRecord, redact: Redact): ExecutionRecord {
  const redacted = parse(executionRecordSchema, redactStrings(record, redact))
  if (!redacted.ok) throw new Error(`Redacting the execution record changed its shape: ${redacted.issues.map((issue) => `${issue.path} ${issue.message}`).join('; ')}`)
  return redacted.value
}

/** What an attempt's execution record is built from, once its browsers are ready and before its first action. */
export type ExecutionInput = {
  configuration: ConfigurationRecord
  modules: readonly ModuleRecord[] | undefined
  secretReferences: SecretDeclaration[]
  runtime: RuntimeRecord
  sessions: SessionRecord[]
  owner: string | undefined
  appBuilds: Readonly<Record<string, string>> | undefined
  apps: readonly string[]
  requirement: RequirementRecord | undefined
  startingState: StartingState[]
}

/**
 * An attempt's execution record. An identity Retest could not record is named in `unavailable`: the bundle, when the
 * test file's process reported none or Retest could not read it, the build of each app the host named no build for,
 * and the code of each judge the attempt's checks use that Retest could not identify.
 *
 * @example executionRecord(input).unavailable // ['app-build:web']
 */
export function executionRecord(input: ExecutionInput): ExecutionRecord {
  const bundle = bundleRecord(input.modules)
  const builds = Object.fromEntries(input.apps.flatMap((app) => (input.appBuilds !== undefined && Object.hasOwn(input.appBuilds, app) ? [[app, input.appBuilds[app] ?? '']] : [])))
  const judges = input.configuration.settings.evaluation?.judges ?? []
  const unavailable = [
    ...(bundle === undefined ? ['bundle'] : []),
    ...input.apps.filter((app) => !Object.hasOwn(builds, app)).map((app) => `app-build:${app}`),
    ...judges.filter((judge) => judge.codeUnavailable === true).map((judge) => `judge-code:${judge.name}`),
  ]
  return {
    ...(bundle === undefined ? {} : { bundle }),
    configuration: input.configuration,
    ...(input.secretReferences.length === 0 ? {} : { secretReferences: input.secretReferences }),
    runtime: input.runtime,
    sessions: input.sessions,
    ...(input.owner === undefined ? {} : { owner: input.owner }),
    ...(Object.keys(builds).length === 0 ? {} : { appBuilds: builds }),
    ...(input.requirement === undefined ? {} : { requirement: input.requirement }),
    startingState: input.startingState,
    ...(unavailable.length === 0 ? {} : { unavailable }),
  }
}

// An app build is a label the host writes, such as a commit or an image digest.
const longestBuild = 256

/**
 * What is wrong with an `appBuilds` option, as one usage failure, or undefined: a key that names no app of the run,
 * or a build that is not text on one line of up to 256 characters.
 *
 * @example appBuildsProblem({ wbe: 'a1b2c3' }, ['web'])?.class // 'usage'
 */
export function appBuildsProblem(value: unknown, apps: readonly string[]): Failure | undefined {
  if (value === undefined) return undefined
  if (!isPlainObject(value)) return failure('usage', `appBuilds: expected builds by app name, received ${describeValue(value)}.`)
  const problems: string[] = []
  for (const [app, build] of Object.entries(value)) {
    const at = formatPath(['appBuilds', app]).slice(2)
    if (!apps.includes(app)) problems.push(`${at}: names no app of this run. The apps are ${apps.join(', ')}.`)
    if (typeof build !== 'string' || build.trim() === '' || build.length > longestBuild || /[\u0000-\u001f\u007f]/.test(build)) {
      problems.push(`${at}: expected the build as text on one line, up to ${longestBuild} characters, received ${describeValue(build)}.`)
    }
  }
  return usage(problems, 'The app builds')
}

/**
 * The run's requirement: its version, and the identity of every host check it holds. Without a requirement, checks
 * keep the ids they were given and nothing is fingerprinted. With one, every host check needs an id; two checks under
 * one id must be the same check; a check may hold no value of a secret the run has read, since its fingerprint is
 * public; and a frozen requirement must match the run's checks exactly. An AI check's content includes its judge as the
 * run reads it, adapter code and options too. The version and every string of a check are redacted before they are
 * recorded or hashed.
 */
export class Requirements {
  /** What is wrong with the requirement's own shape, as one usage failure. */
  readonly shapeProblem: Failure | undefined
  readonly #requirement: Requirement | undefined
  readonly #redact: Redact
  #checks: RequirementCheck[] = []

  constructor(given: unknown, redact: Redact) {
    this.shapeProblem = requirementShapeProblem(given)
    const read = this.shapeProblem === undefined ? readRequirement(given) : undefined
    this.#redact = redact
    this.#requirement = read === undefined ? undefined : { ...read, version: redact(read.version) }
  }

  /** The version, redacted, when the run has a requirement. */
  get version(): string | undefined {
    return this.#requirement?.version
  }

  /**
   * What the run must refuse in its checks before any test starts, as one usage failure, or undefined. Once nothing is
   * wrong, `recorded` lists every check.
   */
  contentProblem(
    hostChecks: HostChecks | undefined,
    hostEvaluations: Readonly<Record<string, readonly EvaluationCheckContent[]>> | undefined,
    judges: RunJudges,
    holdsSecret: (text: string) => boolean,
  ): Failure | undefined {
    const requirement = this.#requirement
    if (requirement === undefined) return undefined
    const problems: string[] = []
    const checksById = new Map<string, { check: RequirementCheck; at: string }>()
    const consider = (at: string, id: string | undefined, kind: RequirementCheck['kind'], content: unknown): void => {
      if (id === undefined) return void problems.push(`${at}.id: a run with a requirement names every host check with an id.`)
      if (/^evaluation-\d+$/.test(id)) problems.push(`${at}.id: ids such as ${JSON.stringify(id)} name a test's own AI checks. Give the host's check another id.`)
      if (strings(content).some(holdsSecret)) problems.push(`${at}: holds the value of a secret, and Retest never fingerprints a secret. Take the value out of the check.`)
      const check = { id, kind, sha256: this.#contentSha256(kind, content) }
      const known = checksById.get(id)
      if (known === undefined) checksById.set(id, { check, at })
      else if (known.check.sha256 !== check.sha256 || known.check.kind !== kind) problems.push(`${at}.id: ${JSON.stringify(id)} also names a different check, at ${known.at}. Each check keeps an id of its own.`)
    }
    for (const [key, checks] of Object.entries(hostChecks ?? {})) {
      for (const [index, check] of checks.entries()) consider(formatPath(['hostChecks', key, index]).slice(2), check.id, 'page', pageCheckContent(check))
    }
    for (const [key, checks] of Object.entries(hostEvaluations ?? {})) {
      for (const [index, check] of checks.entries()) consider(formatPath(['hostEvaluations', key, index]).slice(2), check.id, 'evaluation', evaluationCheckContent(check, judgeFor(judges, check.judge)))
    }
    const frozen = requirement.checks
    if (frozen !== undefined) problems.push(...frozenProblems(requirement.version, frozen, [...checksById.values()]))
    this.#checks = [...checksById.values()].map(({ check }) => check).sort(byCheckId)
    return usage(problems, `The requirement ${JSON.stringify(requirement.version)}`)
  }

  /** The requirement as `run.started` records it, with every check it holds, or undefined without one. */
  recorded(): { version: string; checks: RequirementCheck[] } | undefined {
    return this.#requirement === undefined ? undefined : { version: this.#requirement.version, checks: this.#checks }
  }

  /** The requirement one test is held to: its own host checks and host AI checks, or undefined without a requirement. */
  forTest(hostChecks: readonly TestHostCheck[], hostEvaluations: readonly EvaluationCheckContent[], judges: RunJudges): RequirementRecord | undefined {
    const requirement = this.#requirement
    if (requirement === undefined) return undefined
    const checks = new Map<string, RequirementCheck>()
    for (const { check } of hostChecks) if (check.id !== undefined) checks.set(check.id, { id: check.id, kind: 'page', sha256: this.#contentSha256('page', pageCheckContent(check)) })
    for (const check of hostEvaluations) checks.set(check.id, { id: check.id, kind: 'evaluation', sha256: this.#contentSha256('evaluation', evaluationCheckContent(check, judgeFor(judges, check.judge))) })
    const listed = [...checks.values()].sort(byCheckId)
    return { version: requirement.version, sha256: sha256Hex(canonicalJson({ version: requirement.version, checks: listed })), checks: listed }
  }

  #contentSha256(kind: RequirementCheck['kind'], content: unknown): string {
    return contentSha256(kind, redactStrings(content, this.#redact))
  }
}

/**
 * A page check's content: everything that decides it, its name and id left out. The origin is written as the URL
 * standard writes it, and a `RegExp` path as its source and flags.
 *
 * @example pageCheckContent({ kind: 'text', id: 'saved', text: 'Saved' }) // { kind: 'text', text: 'Saved', app: null, timeoutMs: null }
 */
export function pageCheckContent(check: HostCheck): Record<string, unknown> {
  const { id: _id, name: _name, ...record } = hostCheckRecord(check)
  return { ...record, app: check.app ?? null, timeoutMs: check.timeoutMs ?? null }
}

/**
 * A host AI check's content: its criteria in order, its context, its evidence, its time, and its judge as the run reads
 * it, its adapter's code and its options included, or the judge's name alone when the run has no such judge. Its id is
 * left out.
 *
 * @example evaluationCheckContent({ id: 'saved', criteria: [{ id: 'shown', requirement: 'It shows.' }], evidence: [{ kind: 'screenshot' }] }, judge)
 */
export function evaluationCheckContent(check: EvaluationCheckContent, judge: JudgeSettings | undefined): Record<string, unknown> {
  const criteria = check.criteria.map(({ id, requirement }) => ({ id, requirement }))
  return { criteria, context: check.context ?? null, evidence: check.evidence, judge: judge ?? check.judge ?? null, timeoutMs: check.timeoutMs ?? null }
}

/**
 * The SHA-256 a check's id is bound to: its kind and content as canonical JSON.
 *
 * @example contentSha256('page', pageCheckContent(check))
 */
export function contentSha256(kind: RequirementCheck['kind'], content: unknown): string {
  return sha256Hex(canonicalJson({ kind, content }))
}

function appSettings(target: LoadedTarget, headless: boolean): AppSettings {
  if ('platform' in target) {
    return target.platform === 'ios-simulator'
      ? { target: target.name, kind: 'ios-simulator', simulator: { device: target.device, runtime: target.runtime } }
      : { target: target.name, kind: 'macos' }
  }
  const { emulate, proxy } = target
  return {
    target: target.name,
    kind: 'web',
    browser: target.browser,
    ...('channel' in target ? { channel: target.channel } : {}),
    headless: headless ? target.headless : false,
    ...(emulate === undefined ? {} : typeof emulate === 'string' ? { device: emulate } : { emulation: { ...emulate, viewport: { ...emulate.viewport } } }),
    ...(proxy === undefined ? {} : { proxy: { server: withoutCredentials(proxy.server), bypass: [...proxy.bypass] } }),
  }
}

function secretReference(name: string, source: LoadedSecretSource): SecretReference {
  return 'env' in source ? { name, source: 'env', variable: source.env } : { name, source: 'function' }
}

// A judge's options are the config's own text and may be nested, so the record keeps their fingerprint, taken over
// redacted text so a rotated secret changes nothing. Its code is what it runs: a file adapter's content, or a package
// adapter's installed version.
function judgeSettings(judge: LoadedJudge, rootDir: string, redact: Redact): JudgeSettings {
  const { adapter } = judge
  const code = adapterCode(adapter.kind === 'file' ? { kind: 'file', path: adapter.path } : adapter.kind === 'package' ? { kind: 'package', specifier: adapter.specifier, from: adapter.from } : { kind: 'factory' })
  const module = adapter.kind === 'file' ? { module: relativePosixPath(rootDir, adapter.path) } : adapter.kind === 'package' ? { module: adapter.specifier } : {}
  return {
    name: judge.name,
    adapter: adapter.kind,
    ...module,
    ...code,
    accepts: [...judge.accepts],
    credentials: [...judge.credentials].map(([name, source]) => secretReference(name, source)),
    optionsSha256: sha256Hex(canonicalJson(redactStrings(judge.options, redact))),
  }
}

type AdapterSource = { kind: 'file'; path: string } | { kind: 'package'; specifier: string; from: string } | { kind: 'factory' }

function adapterCode(source: AdapterSource): Pick<JudgeSettings, 'moduleSha256' | 'packageVersion' | 'codeUnavailable'> {
  if (source.kind === 'factory') return { codeUnavailable: true }
  if (source.kind === 'file') {
    const hashed = readHash(source.path)
    return hashed === undefined ? { codeUnavailable: true } : { moduleSha256: hashed }
  }
  const version = installedVersion(source.specifier, source.from)
  return version === undefined ? { codeUnavailable: true } : { packageVersion: version }
}

// The version in the package.json of the package a specifier names, found as Node finds it: in node_modules beside the
// config, then in each folder above.
function installedVersion(specifier: string, from: string): string | undefined {
  const parts = specifier.split('/')
  const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
  if (name === undefined || name === '') return undefined
  for (let folder = dirname(from); ; folder = dirname(folder)) {
    const manifest = readJson(join(folder, 'node_modules', name, 'package.json'))
    const version = isPlainObject(manifest) ? manifest['version'] : undefined
    if (typeof version === 'string') return version
    if (dirname(folder) === folder) return undefined
  }
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    // A folder without the package is the next one to look in.
    return undefined
  }
}

function readHash(path: string): string | undefined {
  try {
    return sha256Hex(readFileSync(path))
  } catch {
    // A file that cannot be read has no identity Retest can give, and the record says so.
    return undefined
  }
}

function requirementShapeProblem(value: unknown): Failure | undefined {
  if (value === undefined) return undefined
  if (!isPlainObject(value)) return failure('usage', `requirement: expected { version, checks? }, received ${describeValue(value)}.`)
  const problems: string[] = []
  for (const key of Object.keys(value)) if (key !== 'version' && key !== 'checks' && value[key] !== undefined) problems.push(`requirement.${key}: unknown key`)
  const { version, checks } = value
  if (typeof version !== 'string' || version.trim() === '' || version.length > longestBuild || /[\u0000-\u001f\u007f]/.test(version)) {
    problems.push(`requirement.version: expected the version as text on one line, up to ${longestBuild} characters, received ${describeValue(version)}`)
  }
  if (checks !== undefined && !isPlainObject(checks)) problems.push(`requirement.checks: expected each check's SHA-256 by its id, received ${describeValue(checks)}`)
  if (isPlainObject(checks)) {
    for (const [id, sha256] of Object.entries(checks)) {
      if (typeof sha256 !== 'string' || !isSha256(sha256)) problems.push(`${formatPath(['requirement', 'checks', id]).slice(2)}: expected a SHA-256 in lowercase hex, as a run records it, received ${describeValue(sha256)}`)
    }
  }
  return usage(problems, 'The requirement')
}

// Called once the shape is known to be right.
function readRequirement(value: unknown): Requirement | undefined {
  if (!isPlainObject(value) || typeof value['version'] !== 'string') return undefined
  const checks = value['checks']
  if (!isPlainObject(checks)) return { version: value['version'] }
  const frozen = Object.fromEntries(Object.entries(checks).flatMap(([id, sha256]) => (typeof sha256 === 'string' ? [[id, sha256]] : [])))
  return { version: value['version'], checks: frozen }
}

// A frozen requirement names exactly the checks the run has, each with the same content.
function frozenProblems(version: string, frozen: Readonly<Record<string, string>>, current: readonly { check: RequirementCheck; at: string }[]): string[] {
  const named = JSON.stringify(version)
  const problems: string[] = []
  for (const { check, at } of current) {
    const held = Object.hasOwn(frozen, check.id) ? frozen[check.id] : undefined
    if (held === undefined) problems.push(`${at}: ${JSON.stringify(check.id)} is not in the requirement ${named}. A new check needs a new version.`)
    else if (held !== check.sha256) problems.push(`${at}: ${JSON.stringify(check.id)} changed since the requirement ${named} froze it: its content hashes to ${check.sha256}, the requirement holds ${held}. A changed check needs a new version.`)
  }
  const present = new Set(current.map(({ check }) => check.id))
  for (const id of Object.keys(frozen)) {
    if (!present.has(id)) problems.push(`requirement.checks.${id}: the requirement ${named} holds ${JSON.stringify(id)}, which this run does not have. A requirement is never met by leaving a check out.`)
  }
  return problems
}

// A copy of a value with every string in it, at any depth, passed through `redact`. Keys stay as they are.
function redactStrings(value: unknown, redact: Redact): unknown {
  if (typeof value === 'string') return redact(value)
  if (Array.isArray(value)) return value.map((item: unknown) => redactStrings(item, redact))
  if (typeof value !== 'object' || value === null) return value
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactStrings(item, redact)]))
}

// Every string a check's content holds, at any depth, so none of them can carry a secret into a fingerprint.
function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap((item: unknown) => strings(item))
  if (typeof value !== 'object' || value === null) return []
  return Object.values(value).flatMap((item: unknown) => strings(item))
}

function byCheckId(first: RequirementCheck, second: RequirementCheck): number {
  return first.id < second.id ? -1 : first.id > second.id ? 1 : 0
}

function usage(problems: readonly string[], subject: string): Failure | undefined {
  const [first] = problems
  if (first === undefined) return undefined
  if (problems.length === 1) return failure('usage', first)
  return failure('usage', `${subject} has ${problems.length} problems:\n${problems.map((problem) => `  ${problem}`).join('\n')}`)
}
