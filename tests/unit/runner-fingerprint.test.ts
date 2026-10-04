import type { LoadedConfig } from '../../src/config/loaded.ts'
import type { HostEvaluationRecord } from '../../src/protocol/evaluation.ts'
import type { DiagnosticsSettings, Ending, JudgeSettings } from '../../src/protocol/execution.ts'
import type { Failure } from '../../src/protocol/failures.ts'
import type { HostCheck, HostCheckResult } from '../../src/protocol/host-check.ts'
import type { PlannedTest } from '../../src/runner/plan.ts'
import type { Redact, SettingsInput } from '../../src/runner/fingerprint.ts'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { validateConfig } from '../../src/config/validate.ts'
import { attemptEnding, canonicalJson } from '../../src/protocol/execution.ts'
import { defaultTimeouts } from '../../src/protocol/timeouts.ts'
import {
  appBuildsProblem,
  bundleRecord,
  configurationRecord,
  contentSha256,
  evaluationCheckContent,
  executionRecord,
  executionSettings,
  hashModules,
  judgeFor,
  pageCheckContent,
  Requirements,
  runJudges,
  secretDeclarations,
} from '../../src/runner/fingerprint.ts'
import { runConfig } from '../../src/runner/run-config.ts'
import { sha256Hex } from '../../src/shared/sha256.ts'
import { tempFolder } from '../support/temp-folder.ts'

const keep: Redact = (text) => text
const shaOf = (text: string): string => sha256Hex(text)
const helper = { path: 'tests/helpers/records.ts', sha256: shaOf('export const title = "Quarterly report"') }
const testFile = { path: 'tests/records.retest.ts', sha256: shaOf('test(...)') }
const noDiagnostics: DiagnosticsSettings = { capture: true, limits: { consoleEntries: 1000 } }

// A project folder with a judge adapter in it, so the adapter's code can be read and hashed.
const root = tempFolder('fingerprint-')
mkdirSync(join(root, 'judges'), { recursive: true })
writeFileSync(join(root, 'judges/visual.ts'), 'export default () => ({ identity: { version: "1" } })\n')
writeFileSync(join(root, 'judges/words.ts'), 'export default () => ({ identity: { version: "w1" } })\n')

function loaded(config: unknown): LoadedConfig {
  const validated = validateConfig(config, join(root, 'retest.config.ts'))
  assert.ok(validated.ok, validated.ok ? '' : validated.failure.message)
  return validated.config
}

const judgesConfig = {
  visual: { adapter: './judges/visual.ts', credentials: { apiKey: { env: 'JUDGE_KEY' } }, options: { model: 'model-a', temperature: 0 }, accepts: ['text', 'images'] },
  words: { adapter: './judges/words.ts', options: { model: 'words-a' }, accepts: ['text'] },
}

const baseConfig = {
  apps: {
    owner: { browser: 'chromium', baseUrl: 'http://127.0.0.1:4173', executablePath: '/opt/chrome/one' },
    member: { browser: 'chromium', baseUrl: 'http://127.0.0.1:4173', viewport: { width: 1024, height: 700 } },
  },
  secrets: { password: { env: 'TASK_PASSWORD' }, code: () => '481516' },
  evaluation: { judges: judgesConfig, defaultJudge: 'visual' },
  locks: ['records'],
}

function planned(overrides: Partial<PlannedTest> = {}): PlannedTest {
  return {
    file: 'tests/records.retest.ts',
    testId: 'tests/records.retest.ts > shares a record',
    registered: { name: 'shares a record', location: { file: 'tests/records.retest.ts', line: 3, column: 1 }, locks: ['records'] },
    describePath: [],
    apps: ['owner', 'member'],
    states: new Map(),
    variants: [],
    ...overrides,
  }
}

// Each app here has one target, named after its browser. `judgeNames` are the judges the test's host AI checks name.
function settingsFor(config: unknown, overrides: Partial<SettingsInput> = {}, judgeNames: readonly string[] = [], redact: Redact = keep): SettingsInput {
  const read = loaded(config)
  const configured = runConfig({ kind: 'config', config: read, secrets: new Map() })
  assert.ok(configured.ok)
  const judges = runJudges(read.evaluation, root, redact)
  const targets = Object.fromEntries([...configured.config.apps].map(([name, app]) => [name, [...app.targets.keys()][0] ?? '']))
  return {
    config: configured.config,
    evaluation: read.evaluation,
    judges: judgeNames.flatMap((name) => judgeFor(judges, name) ?? []),
    headless: true,
    test: planned(),
    targets,
    timeouts: { ...defaultTimeouts },
    environment: undefined,
    diagnostics: noDiagnostics,
    playwright: false,
    ...overrides,
  }
}

function fingerprint(config: unknown, overrides: Partial<SettingsInput> = {}, judgeNames: readonly string[] = [], redact: Redact = keep): string {
  return configurationRecord(executionSettings(settingsFor(config, overrides, judgeNames, redact)), redact).sha256
}

function judgeOf(config: unknown, name: string): JudgeSettings {
  const judge = runJudges(loaded(config).evaluation, root, keep).byName.get(name)
  assert.ok(judge !== undefined)
  return judge
}

describe('the bundle fingerprint', () => {
  test('is the same for the same modules in any order, and changes when a helper changes', () => {
    const first = bundleRecord([testFile, helper])
    const again = bundleRecord([helper, testFile])
    assert.ok(first !== undefined)
    assert.deepEqual(first, again)
    assert.deepEqual(first.modules.map((module) => module.path), ['tests/helpers/records.ts', 'tests/records.retest.ts'])
    assert.equal(first.sha256, sha256Hex(canonicalJson(first.modules)))
    const changed = bundleRecord([testFile, { ...helper, sha256: shaOf('export const title = "Quarterly reports"') }])
    assert.notEqual(changed?.sha256, first.sha256, 'a changed helper changes the bundle')
    assert.equal(bundleRecord([helper, helper]), undefined)
    assert.equal(bundleRecord([{ path: 'tests/a.ts', sha256: 'not a hash' }]), undefined)
  })

  test('the parent hashes each module from disk itself, and will not read a path the process names that is not a module', () => {
    const project = tempFolder('modules-')
    mkdirSync(join(project, 'tests/helpers'), { recursive: true })
    writeFileSync(join(project, 'tests/a.retest.ts'), 'test file\n')
    writeFileSync(join(project, 'tests/helpers/titles.ts'), 'helper\n')
    writeFileSync(join(project, 'notes.txt'), 'not a module\n')
    const known = new Map<string, string>()
    const modules = hashModules(project, ['tests/a.retest.ts', 'tests/helpers/titles.ts'], known)
    assert.deepEqual(modules, [
      { path: 'tests/a.retest.ts', sha256: shaOf('test file\n') },
      { path: 'tests/helpers/titles.ts', sha256: shaOf('helper\n') },
    ])
    writeFileSync(join(project, 'tests/helpers/titles.ts'), 'changed after it loaded\n')
    assert.deepEqual(hashModules(project, ['tests/helpers/titles.ts'], known)?.[0]?.sha256, shaOf('helper\n'), 'a module is hashed once per process, as it loaded once')
    for (const refused of [['notes.txt'], ['/etc/hosts.json'], ['tests\\a.ts'], ['tests/missing.ts'], undefined, []]) {
      assert.equal(hashModules(project, refused, new Map()), undefined, JSON.stringify(refused))
    }
  })
})

describe('the configuration fingerprint', () => {
  test('changes with a budget, a target, the screen, a lock, the environment or the diagnostics policy, and never with a base URL or an executable path', () => {
    const base = fingerprint(baseConfig)
    assert.equal(fingerprint(baseConfig), base, 'the same config gives the same fingerprint')
    assert.notEqual(fingerprint(baseConfig, { timeouts: { ...defaultTimeouts, assertion: 6000 } }), base, 'a timeout')
    assert.notEqual(fingerprint({ ...baseConfig, apps: { ...baseConfig.apps, owner: { browser: 'chrome', baseUrl: 'http://127.0.0.1:4173' } } }), base, 'a target')
    assert.notEqual(fingerprint({ ...baseConfig, apps: { ...baseConfig.apps, member: { browser: 'chromium', viewport: { width: 1280, height: 700 } } } }), base, 'the viewport')
    assert.notEqual(fingerprint(baseConfig, { headless: false }), base, 'a headed run')
    assert.notEqual(fingerprint(baseConfig, { test: planned({ registered: { ...planned().registered, locks: [] } }) }), base, 'the locks the test holds')
    assert.notEqual(fingerprint(baseConfig, { playwright: true }), base, 'Playwright mode')
    assert.notEqual(fingerprint(baseConfig, { environment: { MODE: 'a' } }), fingerprint(baseConfig, { environment: { OTHER: 'a' } }), 'a name of the environment the host gave')
    assert.equal(fingerprint(baseConfig, { environment: { MODE: 'a' } }), fingerprint(baseConfig, { environment: { MODE: 'b' } }), 'never a value of it, which is recorded nowhere')
    assert.notEqual(fingerprint(baseConfig, { environment: { MODE: 'a' } }), base, 'an environment the host gave at all')
    const strict: DiagnosticsSettings = { ...noDiagnostics, policy: { strict: { runtimeErrors: true } } }
    assert.notEqual(fingerprint(baseConfig, { diagnostics: strict }), base, 'a strict diagnostics policy')
    const elsewhere = { ...baseConfig, apps: { owner: { ...baseConfig.apps.owner, baseUrl: 'http://127.0.0.1:5999', executablePath: '/opt/chrome/two' }, member: { ...baseConfig.apps.member, baseUrl: 'http://127.0.0.1:5999' } } }
    assert.equal(fingerprint(elsewhere), base, 'where the app and the browser are does not change how the test runs')
  })

  test("an Electron app's arguments are part of it, and where its binary, its app and its data folder are is not", () => {
    const desktop = { browser: 'electron', executablePath: '/opt/Electron.app/Contents/MacOS/Electron', appPath: 'desktop', args: ['--tasks=3'] }
    const withDesktop = (target: Record<string, unknown>) => ({ apps: { desktop: target }, locks: ['records'] })
    const alone = { test: planned({ apps: ['desktop'] }) }
    const base = fingerprint(withDesktop(desktop), alone)
    const settings = executionSettings(settingsFor(withDesktop(desktop), alone))
    assert.deepEqual(settings.apps, { desktop: { target: 'electron', kind: 'web', browser: 'electron', args: { count: 1, sha256: sha256Hex(canonicalJson(['--tasks=3'])) } } })
    // An argument may carry what nobody should read, so the record keeps its count and the list's hash, never its text.
    const token = { ...desktop, args: ['--token=tok-5f2e9a1c'] }
    assert.equal(JSON.stringify(configurationRecord(executionSettings(settingsFor(withDesktop(token), alone)), keep)).includes('tok-5f2e9a1c'), false)
    assert.notEqual(fingerprint(withDesktop({ ...desktop, args: ['--tasks=3', '--theme=dark'] }), alone), base, 'an added argument')
    assert.notEqual(fingerprint(withDesktop({ ...desktop, args: ['--tasks=4'] }), alone), base, 'a changed argument')
    assert.notEqual(fingerprint(withDesktop({ ...desktop, args: [] }), alone), base, 'no arguments')
    // A named data folder changes where the app starts from, which the attempt's starting state records.
    const moved = { ...desktop, executablePath: '/elsewhere/Electron', appPath: '../desktop', userDataDir: '.data/desktop' }
    assert.equal(fingerprint(withDesktop(moved), alone), base, 'where the binary, the app and its data are does not change how the test runs')
  })

  test('holds only the judges the test’s own host AI checks name, so another judge or a secret it never types changes nothing', () => {
    const otherJudge = { ...baseConfig, evaluation: { ...baseConfig.evaluation, judges: { ...judgesConfig, words: { ...judgesConfig.words, options: { model: 'words-b' } } } } }
    assert.equal(fingerprint(otherJudge), fingerprint(baseConfig), 'a test with no host AI check is not held to any judge')
    assert.equal(fingerprint(otherJudge, {}, ['visual']), fingerprint(baseConfig, {}, ['visual']), 'nor to a judge it does not use')
    assert.notEqual(fingerprint(otherJudge, {}, ['words']), fingerprint(baseConfig, {}, ['words']), 'the judge its check uses changes it')
    const visualOptions = { ...baseConfig, evaluation: { ...baseConfig.evaluation, judges: { ...judgesConfig, visual: { ...judgesConfig.visual, options: { model: 'model-b', temperature: 0 } } } } }
    assert.notEqual(fingerprint(visualOptions, {}, ['visual']), fingerprint(baseConfig, {}, ['visual']), 'an evaluator option of its judge')
    const otherSecret = { ...baseConfig, secrets: { password: { env: 'OTHER_PASSWORD' }, code: () => '481516' } }
    assert.equal(fingerprint(otherSecret), fingerprint(baseConfig), 'secrets are recorded by reference beside the fingerprint, not in it')
    const settings = executionSettings(settingsFor(baseConfig, {}, ['visual']))
    assert.deepEqual(settings.evaluation?.judges.map((judge) => judge.name), ['visual'])
    assert.equal(settings.evaluation?.promptVersion, 'retest-judge-1')
    assert.deepEqual(secretDeclarations(loaded(baseConfig).secrets), [
      { name: 'password', source: 'env', variable: 'TASK_PASSWORD', origins: [] },
      { name: 'code', source: 'function', origins: [] },
    ])
  })

  test("a judge's code is part of it: a file adapter's content, a package's version, and a factory's code named unavailable", () => {
    const before = judgeOf(baseConfig, 'visual')
    assert.equal(before.moduleSha256, shaOf('export default () => ({ identity: { version: "1" } })\n'))
    const fingerprintBefore = fingerprint(baseConfig, {}, ['visual'])
    writeFileSync(join(root, 'judges/visual.ts'), 'export default () => ({ identity: { version: "2" } })\n')
    try {
      assert.notEqual(judgeOf(baseConfig, 'visual').moduleSha256, before.moduleSha256)
      assert.notEqual(fingerprint(baseConfig, {}, ['visual']), fingerprintBefore, 'an edited adapter changes the configuration')
    } finally {
      writeFileSync(join(root, 'judges/visual.ts'), 'export default () => ({ identity: { version: "1" } })\n')
    }
    const factory = judgeOf({ ...baseConfig, evaluation: { judges: { made: { adapter: () => ({}), accepts: ['text'] } } } }, 'made')
    assert.deepEqual([factory.adapter, factory.codeUnavailable, factory.moduleSha256], ['factory', true, undefined])
    mkdirSync(join(root, 'node_modules/@acme/judge'), { recursive: true })
    writeFileSync(join(root, 'node_modules/@acme/judge/package.json'), '{ "name": "@acme/judge", "version": "3.4.5" }\n')
    const packaged = judgeOf({ ...baseConfig, evaluation: { judges: { remote: { adapter: '@acme/judge/adapter', accepts: ['text'] } } } }, 'remote')
    assert.deepEqual([packaged.module, packaged.packageVersion], ['@acme/judge/adapter', '3.4.5'])
    const missing = judgeOf({ ...baseConfig, evaluation: { judges: { gone: { adapter: '@acme/not-installed', accepts: ['text'] } } } }, 'gone')
    assert.equal(missing.codeUnavailable, true)
    const record = executionRecord({
      configuration: configurationRecord(executionSettings({ ...settingsFor(baseConfig), judges: [factory] }), keep),
      modules: undefined,
      secretReferences: [],
      runtime: { retest: '0.0.0', node: 'v24.12.0', platform: 'darwin-arm64' },
      sessions: [],
      owner: undefined,
      appBuilds: undefined,
      apps: ['owner'],
      requirement: undefined,
      startingState: [],
    })
    assert.deepEqual(record.unavailable, ['bundle', 'app-build:owner', 'judge-code:made'])
  })

  test('every string is redacted before it is hashed: a rotated secret in a judge option or the environment changes nothing', () => {
    const withKey = (key: string): unknown => ({ ...baseConfig, evaluation: { ...baseConfig.evaluation, judges: { ...judgesConfig, visual: { ...judgesConfig.visual, options: { baseURL: `https://gateway.example/${key}` } } } } })
    const redactFirst: Redact = (text) => text.replaceAll('rotated-key-1111', '{{gateway}}')
    const redactSecond: Redact = (text) => text.replaceAll('rotated-key-2222', '{{gateway}}')
    const first = fingerprint(withKey('rotated-key-1111'), { environment: { TOKEN: 'rotated-key-1111' } }, ['visual'], redactFirst)
    const second = fingerprint(withKey('rotated-key-2222'), { environment: { TOKEN: 'rotated-key-2222' } }, ['visual'], redactSecond)
    assert.equal(first, second)
    const record = configurationRecord(executionSettings(settingsFor(withKey('rotated-key-1111'), { environment: { TOKEN: 'rotated-key-1111' } }, ['visual'], redactFirst)), redactFirst)
    assert.equal(canonicalJson(record).includes('rotated-key-1111'), false)
    assert.deepEqual(record.settings.environment, ['TOKEN'])
  })

  test('the environment is recorded by name alone, so a value the host never declared a secret is written nowhere and hashed nowhere', () => {
    const identity: Redact = (text) => text
    const settings = (value: string) => executionSettings(settingsFor(baseConfig, { environment: { TOKEN: value, PATH: '/usr/bin' } }, [], identity))
    const first = configurationRecord(settings('undeclared-token-7f2a'), identity)
    assert.deepEqual(first.settings.environment, ['PATH', 'TOKEN'])
    assert.equal(canonicalJson(first).includes('undeclared-token-7f2a'), false)
    assert.equal(first.sha256, configurationRecord(settings('another-value'), identity).sha256, 'a changed value changes nothing; a changed name would')
    assert.notEqual(first.sha256, configurationRecord(executionSettings(settingsFor(baseConfig, { environment: { TOKEN: 'x' } }, [], identity)), identity).sha256)
  })
})

describe('the execution record', () => {
  test('names the identities it could not record, and keeps secrets by reference beside the fingerprint', () => {
    const configuration = configurationRecord(executionSettings(settingsFor(baseConfig)), keep)
    const input = {
      configuration,
      secretReferences: secretDeclarations(loaded(baseConfig).secrets),
      runtime: { retest: '0.0.0', node: 'v24.12.0', platform: 'darwin-arm64' },
      sessions: [],
      owner: undefined,
      apps: ['owner', 'member'],
      requirement: undefined,
      startingState: [],
    }
    const bare = executionRecord({ ...input, modules: undefined, appBuilds: undefined })
    assert.deepEqual(bare.unavailable, ['bundle', 'app-build:owner', 'app-build:member'])
    assert.equal(bare.secretReferences?.length, 2)
    const full = executionRecord({ ...input, modules: [testFile], appBuilds: { owner: 'a1b2c3', member: 'a1b2c3', admin: 'other' } })
    assert.equal(full.unavailable, undefined)
    assert.deepEqual(full.appBuilds, { owner: 'a1b2c3', member: 'a1b2c3' }, 'only the builds of its own apps')
    assert.equal(appBuildsProblem({ owner: 'a1b2c3' }, ['owner', 'member']), undefined)
    assert.match(appBuildsProblem({ wner: 'a1b2c3', member: '' }, ['owner', 'member'])?.message ?? '', /appBuilds\.wner: names no app of this run\. The apps are owner, member\.\n.*appBuilds\.member: expected the build as text on one line/)
  })
})

describe('the requirement', () => {
  const saved: HostCheck = { kind: 'text', id: 'record-shown', app: 'member', text: 'Quarterly report' }
  const owner: HostCheck = { kind: 'address', id: 'owner-page', app: 'owner', origin: 'http://127.0.0.1:4173', path: /^\/shared/ }
  const judged: HostEvaluationRecord = { id: 'record-reads-well', criteria: [{ id: 'title', requirement: 'The record shows its title.' }], evidence: [{ kind: 'screenshot', app: 'member' }] }
  const none = (): boolean => false
  const judges = runJudges(loaded(baseConfig).evaluation, root, keep)

  test('without one, nothing is fingerprinted and checks need no id', () => {
    const requirements = new Requirements(undefined, keep)
    assert.equal(requirements.contentProblem({ 'tests/a.retest.ts': [{ kind: 'text', text: 'Saved' }] }, undefined, judges, none), undefined)
    assert.equal(requirements.recorded(), undefined)
    assert.equal(requirements.forTest([], [], judges), undefined)
  })

  test("binds each id to its content, an AI check's judge and its code included", () => {
    const requirements = new Requirements({ version: 'records-v1' }, keep)
    assert.equal(requirements.contentProblem({ 'tests/a.retest.ts': [saved, owner] }, { 'tests/a.retest.ts > shares': [judged] }, judges, none), undefined)
    const recorded = requirements.recorded()
    assert.deepEqual(recorded?.checks.map((check) => [check.id, check.kind]), [
      ['owner-page', 'page'],
      ['record-reads-well', 'evaluation'],
      ['record-shown', 'page'],
    ])
    assert.equal(recorded?.checks.find((check) => check.id === 'record-shown')?.sha256, contentSha256('page', pageCheckContent(saved)))
    assert.equal(recorded?.checks.find((check) => check.id === 'record-reads-well')?.sha256, contentSha256('evaluation', evaluationCheckContent(judged, judgeFor(judges, undefined))))
    const forTest = requirements.forTest([{ check: saved, app: 'member' }], [judged], judges)
    assert.deepEqual(forTest?.checks.map((check) => check.id), ['record-reads-well', 'record-shown'])
    assert.equal(requirements.forTest([{ check: { ...saved, name: 'the record is shown' }, app: 'member' }], [judged], judges)?.sha256, forTest?.sha256, "a check's name is a label")
    assert.notEqual(requirements.forTest([{ check: { ...saved, text: 'Quarterly reports' }, app: 'member' }], [judged], judges)?.sha256, forTest?.sha256)
    const otherOptions = runJudges(loaded({ ...baseConfig, evaluation: { ...baseConfig.evaluation, judges: { ...judgesConfig, visual: { ...judgesConfig.visual, options: { model: 'model-b' } } } } }).evaluation, root, keep)
    assert.notEqual(requirements.forTest([], [judged], otherOptions)?.sha256, requirements.forTest([], [judged], judges)?.sha256, "a change to the judge's policy changes the check")
  })

  test('a frozen requirement refuses, by name, a check that changed, one it does not hold and one that is missing', () => {
    const frozen = new Requirements({ version: 'records-v1' }, keep)
    assert.equal(frozen.contentProblem({ 'tests/a.retest.ts': [saved, owner] }, undefined, judges, none), undefined)
    const checks = Object.fromEntries((frozen.recorded()?.checks ?? []).map((check) => [check.id, check.sha256]))
    assert.equal(new Requirements({ version: 'records-v1', checks }, keep).contentProblem({ 'tests/a.retest.ts': [saved, owner] }, undefined, judges, none), undefined)
    const changed = new Requirements({ version: 'records-v1', checks }, keep).contentProblem({ 'tests/a.retest.ts': [{ ...saved, text: 'Quarterly' }, owner] }, undefined, judges, none)
    assert.match(changed?.message ?? '', /^hostChecks\["tests\/a\.retest\.ts"\]\[0\]: "record-shown" changed since the requirement "records-v1" froze it: its content hashes to [0-9a-f]{64}, the requirement holds [0-9a-f]{64}\. A changed check needs a new version\.$/)
    const missing = new Requirements({ version: 'records-v1', checks }, keep).contentProblem({ 'tests/a.retest.ts': [saved] }, undefined, judges, none)
    assert.match(missing?.message ?? '', /requirement\.checks\.owner-page: the requirement "records-v1" holds "owner-page", which this run does not have\./)
    const extra = new Requirements({ version: 'records-v1', checks }, keep).contentProblem({ 'tests/a.retest.ts': [saved, owner] }, { 'tests/a.retest.ts': [judged] }, judges, none)
    assert.match(extra?.message ?? '', /"record-reads-well" is not in the requirement "records-v1"\. A new check needs a new version\./)
  })

  test('refuses a check with no id, one id for two checks, a test check’s id and a check that holds a secret, and redacts the version', () => {
    const requirements = new Requirements({ version: 'v2' }, keep)
    const problem = requirements.contentProblem(
      { 'tests/a.retest.ts': [{ kind: 'text', text: 'Saved' }, saved], 'tests/b.retest.ts': [{ ...saved, text: 'Other' }, { kind: 'text', id: 'evaluation-1', text: 'hunter2 secret' }] },
      undefined,
      judges,
      (text) => text.includes('hunter2'),
    )
    const message = problem?.message ?? ''
    assert.match(message, /hostChecks\["tests\/a\.retest\.ts"\]\[0\]\.id: a run with a requirement names every host check with an id\./)
    assert.match(message, /hostChecks\["tests\/b\.retest\.ts"\]\[0\]\.id: "record-shown" also names a different check/)
    assert.match(message, /ids such as "evaluation-1" name a test's own AI checks/)
    assert.match(message, /hostChecks\["tests\/b\.retest\.ts"\]\[1\]: holds the value of a secret/)
    const secretVersion = new Requirements({ version: 'release-hunter2-7391' }, (text) => text.replaceAll('hunter2-7391', '{{password}}'))
    assert.equal(secretVersion.version, 'release-{{password}}')
    assert.equal(secretVersion.contentProblem({ 'a.retest.ts': [saved] }, undefined, judges, none), undefined)
    assert.equal(secretVersion.recorded()?.version, 'release-{{password}}')
    assert.equal(canonicalJson(secretVersion.forTest([{ check: saved, app: 'member' }], [], judges)).includes('hunter2'), false)
  })
})

describe('the ending of an attempt', () => {
  const failed = (failure: Failure, seen: readonly Failure[] = [failure]): Ending => attemptEnding({ status: 'failed', failure, seen })

  test('tells an assertion from a required check, a setup, an action, a crash, a stop and an unknown outcome the parent saw', () => {
    assert.deepEqual(attemptEnding({ status: 'passed' }), { kind: 'passed' })
    assert.deepEqual(failed({ class: 'check_failed', message: 'x' }), { kind: 'assertion_failed' })
    assert.deepEqual(failed({ class: 'not_found', message: 'x' }), { kind: 'action_failed' })
    assert.deepEqual(failed({ class: 'timeout', message: 'The test ran longer than its 3000 ms budget.' }), { kind: 'timed_out' })
    assert.deepEqual(failed({ class: 'timeout', message: 'The click took longer than 500 ms.' }), { kind: 'action_failed' })
    assert.deepEqual(failed({ class: 'setup_failed', message: 'x' }), { kind: 'setup_failed' })
    assert.deepEqual(failed({ class: 'session_lost', message: 'x' }), { kind: 'crashed' })
    assert.deepEqual(failed({ class: 'outcome_unknown', message: 'x' }), { kind: 'outcome_unknown' })
    assert.deepEqual(attemptEnding({ status: 'failed', failure: { class: 'test_error', message: 'x' }, crashed: true }), { kind: 'crashed' })
    const stop: Failure = { class: 'interrupted', message: 'The run was interrupted.' }
    assert.deepEqual(attemptEnding({ status: 'error', failure: stop, interruption: stop }), { kind: 'cancelled' })
    assert.deepEqual(attemptEnding({ status: 'error', cleanupFailures: [{ class: 'cleanup_failed', message: 'x' }] }), { kind: 'cleanup_failed' })
  })

  test('a class the test process only reports never names a check, a crash or an unknown outcome', () => {
    const unseen = (failure: Failure): Ending => attemptEnding({ status: 'failed', failure, seen: [], hostChecks: [{ check: { kind: 'text', id: 'record-shown', text: 'x' }, app: 'web', status: 'not_run' }] })
    assert.deepEqual(unseen({ class: 'host_check_failed', message: 'The host check "record-shown" failed.' }), { kind: 'test_error', notRun: ['record-shown'] }, 'a forged host check failure, while every host check was not run')
    assert.deepEqual(unseen({ class: 'session_lost', message: 'The browser was lost.' }).kind, 'test_error')
    assert.deepEqual(unseen({ class: 'outcome_unknown', message: 'Nobody knows.' }).kind, 'test_error')
    assert.deepEqual(unseen({ class: 'interrupted', message: 'The run was interrupted.' }).kind, 'test_error')
    assert.deepEqual(unseen({ class: 'check_failed', message: 'expect(received).toBe(expected)' }).kind, 'assertion_failed', 'a value assertion is the test’s own')
    const poll: Failure = { class: 'timeout', message: 'The function given to expect.poll() was still running when its 1000 ms ran out.' }
    assert.deepEqual(unseen(poll).kind, 'assertion_failed', 'an expect.poll that ran out of time is an assertion, not an action')
    assert.deepEqual(attemptEnding({ status: 'not_run', failure: { class: 'interrupted', message: 'Not run: the setup "a" did not pass.' }, interruption: { class: 'interrupted', message: 'The run was interrupted.' } }).kind, 'not_run', "a setup's copied class is not the run's stop")
  })

  test('names the required check that failed, a check the parent could not complete, and every required check that never ran', () => {
    const shown: HostCheckResult = { check: { kind: 'text', id: 'record-shown', text: 'Quarterly report' }, app: 'member', status: 'failed', failure: { class: 'host_check_failed', message: 'The host check "record-shown" on member failed.' } }
    assert.deepEqual(attemptEnding({ status: 'failed', failure: shown.failure, hostChecks: [shown] }), { kind: 'required_check_failed', checkId: 'record-shown' })
    const slow: Failure = { class: 'session_lost', message: 'The page of member did not answer a host check within 300 ms, so Retest could not read it.' }
    const unread: HostCheckResult = { ...shown, failure: slow }
    assert.deepEqual(attemptEnding({ status: 'error', failure: slow, hostChecks: [unread], browserLost: false }), { kind: 'check_error', checkId: 'record-shown' }, 'a slow page is not a crash')
    assert.deepEqual(attemptEnding({ status: 'error', failure: slow, hostChecks: [unread], browserLost: true }).kind, 'crashed', 'a browser that was gone is')
    const early = attemptEnding({
      status: 'failed',
      failure: { class: 'not_found', message: 'Nothing matched.' },
      seen: [{ class: 'not_found', message: 'Nothing matched.' }],
      hostChecks: [{ ...shown, status: 'not_run' }],
      evaluations: [{ checkId: 'record-reads-well', source: 'host', mode: 'required', verdict: 'not_run', criteria: [], criteriaSha256: 'x', evidence: [], durationMs: 0 }],
    })
    assert.deepEqual(early, { kind: 'action_failed', notRun: ['record-shown', 'record-reads-well'] })
    const judgedFailure: Failure = { class: 'evaluation_failed', message: 'The AI check record-reads-well failed.' }
    const judged = attemptEnding({ status: 'failed', failure: judgedFailure, evaluations: [{ checkId: 'record-reads-well', source: 'host', mode: 'required', verdict: 'fail', criteria: [], criteriaSha256: 'x', evidence: [], durationMs: 1, failure: judgedFailure }] })
    assert.deepEqual(judged, { kind: 'required_check_failed', checkId: 'record-reads-well' })
  })
})
