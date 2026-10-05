import type { CompatibilityCase, DeclaredOutcome } from '../fixtures/playwright-compat/cases.ts'
import type { RecordedStep, RecordedTest } from '../fixtures/playwright-compat/operations-reporter.ts'
import type { RetestEvent } from '../src/protocol/events.ts'
import type { RunResult, TestResult } from '../src/protocol/result.ts'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, cpSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual, parseArgs } from 'node:util'
import { compatibilityCases, corpusSources, unavailableCases } from '../fixtures/playwright-compat/cases.ts'
import { startTaskApp } from '../fixtures/task-app/server.ts'
import { WORKFLOW_PASSWORD } from '../fixtures/task-app/workflow-sign-in-page.ts'
import { retestEventSchema } from '../src/protocol/events.ts'
import { runResultSchema } from '../src/protocol/result.ts'
import { eventsFile, resultFile } from '../src/protocol/run-folder.ts'
import { isArray, isPlainObject, parse } from '../src/protocol/schema.ts'
import { browserPath } from '../tests/support/test-browser.ts'

// Runs the Playwright compatibility corpus in fixtures/playwright-compat twice, from the same files: once under a
// pinned Playwright installed outside the repository, once under `retest run --playwright` from this checkout, both
// in the same Chrome against a fresh task app each. It judges every case against what the case declares and against
// the other run, and with --write it writes docs/compatibility/playwright.md from the result.
//
//   node --conditions=retest-source scripts/compare-playwright.ts [--browser <path>] [--work <folder>] [--write]
//
// Playwright is packed from the registry into a folder under the system's temporary folder and kept there while its
// version and checksums are the pinned ones. Nothing is written inside the repository except, with --write, the
// table. It launches real browsers: run it under the heavy-gate lock. Exit 0 when every claimed case matched and every
// declared gap still holds, 1 when one did not, 2 when a run could not finish.

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url))
const corpusFolder = join(repositoryRoot, 'fixtures', 'playwright-compat')
const tablePath = join(repositoryRoot, 'docs', 'compatibility', 'playwright.md')

/** The Playwright the comparison runs, by version and by the registry's checksum of each package it installs. */
export const pinnedPlaywright = {
  version: '1.63.0',
  license: 'Apache-2.0',
  packages: [
    { name: '@playwright/test', integrity: 'sha512-oxMK4vllB9RK5NQ2l1pq1IfOf2AvnEuj/vYGDj0H2nMtmtZpKtCwt/l00GEO6xjGfpBNAvjovvYdCm50dRQkpQ==' },
    { name: 'playwright', integrity: 'sha512-+7ziBLidS4NaNCdt57SUDT+wYmmd5fmiQejUic/kb+YsYSCPyOOE9sebzMjNmQrsnNpDJqd4WHvV/8lfKfUDUg==' },
    { name: 'playwright-core', integrity: 'sha512-rYCsBF/M5HjUch52bbtVONEFjv6Xu8sm8h72dNlR5bzIE1fvC/bxgspzkjSfU+MweEMmPM8KJebG6nnyxo5mCg==' },
  ],
} as const

/** The assertion budget both runs check with, as the workflow cases' own integration files do. */
export const assertionBudgetMs = 1500

// A run that has not ended in this long is stopped, with its process group.
const runLimitMs = 10 * 60_000
const installLimitMs = 5 * 60_000

/** One action, check or step a run went through, by kind and by the line of the spec that made it. */
export type Operation = { readonly kind: 'step' | 'action' | 'assertion'; readonly line: number; readonly title: string }

/**
 * What a failed check expected and what it received, each a list of texts with their ends trimmed and each run of
 * spaces read as one: one text for a single value, such as `"Release checklist"`, `3` or `hidden`, and one per match
 * for a list.
 */
export type FailureValues = { readonly expected: readonly string[]; readonly received: readonly string[] }

/**
 * How one run ended a case. `status` is `passed`, `failed` or what else the runner said. A failure's class is
 * `assertion` for a check that did not pass, as both runners report one, and otherwise the runner's own name for it.
 * `values` is what a failed check expected and received, where the runner's record says it in a form the comparison
 * reads.
 */
export type Observed = {
  readonly status: string
  readonly failure?: { readonly class: string; readonly line?: number; readonly message: string; readonly values?: FailureValues }
  /** The innermost `test.step` that failed. */
  readonly step?: string
  readonly operations: readonly Operation[]
}

/** Whether the two runs went through the same file and the same operations, or the first place they did not. */
export type Retained = { readonly same: true } | { readonly same: false; readonly difference: string }

export type CaseVerdict = {
  readonly testCase: CompatibilityCase
  /** For a case declared to fail: the line of the check it fails at. */
  readonly intendedLine?: number
  readonly playwright?: Observed
  readonly retest?: Observed
  /** Playwright did what the case declares. When it did not, the case itself is wrong. */
  readonly playwrightAsDeclared: boolean
  readonly retestAsDeclared: boolean
  readonly retained: Retained
  /**
   * For a case declared to fail that both runners failed as declared: whether the two failed checks expected the same
   * values and received the same values. A check that fails for another reason at the same line is not the same failure.
   */
  readonly sameValues?: boolean
  readonly equivalent: boolean
  /** Why the case is not equivalent, in plain sentences. */
  readonly problems: readonly string[]
}

export type RunFacts = {
  readonly command: readonly string[]
  readonly exitCode: number | null
  readonly signal: string | null
  /** The tests the runner collected, each counted once. */
  readonly collected: number
  /** Attempts past each test's first, which a retry would add. */
  readonly retried: number
  readonly skipped: number
  /** A failure of the run itself, one no single test explains. */
  readonly runFailure?: string
  readonly logFolder: string
}

export type Comparison = {
  readonly playwright: { readonly version: string; readonly packages: readonly InstalledPackage[]; readonly run: RunFacts }
  readonly retest: { readonly version: string; readonly commit: string; readonly changed: boolean; readonly run: RunFacts }
  readonly browser: { readonly product: string; readonly version: string; readonly executablePath: string }
  readonly node: string
  readonly files: readonly { readonly file: string; readonly sha256: string }[]
  readonly verdicts: readonly CaseVerdict[]
  readonly workFolder: string
}

type InstalledPackage = { readonly name: string; readonly version: string; readonly integrity: string }

type Log = (line: string) => void

export type CompareOptions = { readonly browser: string; readonly workFolder: string; readonly playwrightFolder?: string; readonly log?: Log }

/** The folder the pinned Playwright is installed into, outside the repository. */
export function defaultPlaywrightFolder(): string {
  return join(tmpdir(), 'retest-playwright-compat', `playwright-${pinnedPlaywright.version}`)
}

/**
 * Runs the corpus under the pinned Playwright and under Retest, and judges every case.
 *
 * @example const comparison = await comparePlaywright({ browser, workFolder: '/tmp/compare' })
 */
export async function comparePlaywright(options: CompareOptions): Promise<Comparison> {
  const log = options.log ?? (() => {})
  const playwrightFolder = options.playwrightFolder ?? defaultPlaywrightFolder()
  const installed = await installPlaywright(playwrightFolder, log)
  mkdirSync(options.workFolder, { recursive: true })
  const playwrightCopy = join(options.workFolder, 'playwright-corpus')
  const retestCopy = join(options.workFolder, 'retest-corpus')
  for (const copy of [playwrightCopy, retestCopy]) copyCorpus(copy)
  // Playwright's copy finds the pinned install through a link; Retest's copy has no node_modules at all.
  symlinkSync(join(playwrightFolder, 'node_modules'), join(playwrightCopy, 'node_modules'), 'dir')

  const reportFile = join(options.workFolder, 'playwright-operations.json')
  const playwrightLogs = join(options.workFolder, 'playwright')
  const playwrightRun = await withTaskApp(async (url) => {
    log(`running the corpus under Playwright ${pinnedPlaywright.version}`)
    const cli = join(playwrightFolder, 'node_modules', '@playwright', 'test', 'cli.js')
    const command = [process.execPath, cli, 'test', '--config', join(playwrightCopy, 'playwright.config.ts'), '--output', join(options.workFolder, 'playwright-results')]
    return runProgram(command, {
      cwd: playwrightCopy,
      env: runEnvironment({ WORKFLOW_APP_URL: url, WORKFLOW_PASSWORD, COMPARE_BROWSER: options.browser, COMPARE_REPORT_FILE: reportFile, FORCE_COLOR: '0' }),
      logFolder: playwrightLogs,
      limitMs: runLimitMs,
    })
  })
  const recorded = existsSync(reportFile) ? readPlaywrightReport(readFileSync(reportFile, 'utf8')) : []

  const retestOutput = join(options.workFolder, 'retest-run')
  const retestLogs = join(options.workFolder, 'retest')
  const retestRun = await withTaskApp(async (url) => {
    log('running the corpus under retest run --playwright')
    const command = [
      process.execPath,
      '--conditions=retest-source',
      join(repositoryRoot, 'src', 'cli', 'main.ts'),
      'run',
      '--playwright',
      '--browser',
      options.browser,
      '--base-url',
      url,
      '--workers',
      '1',
      '--timeouts',
      `assertion=${assertionBudgetMs}`,
      '--no-agent',
      '--output',
      retestOutput,
    ]
    return runProgram(command, { cwd: retestCopy, env: runEnvironment({ WORKFLOW_APP_URL: url, WORKFLOW_PASSWORD }), logFolder: retestLogs, limitMs: runLimitMs })
  })
  const resultPath = join(retestOutput, resultFile)
  if (!existsSync(resultPath)) throw new Error(`retest run --playwright wrote no ${resultFile}; its output is in ${retestLogs}.`)
  const result = readRetestResult(readFileSync(resultPath, 'utf8'))
  const events = readRetestEvents(readFileSync(join(retestOutput, eventsFile), 'utf8'))

  // Playwright names files by their real path, which on macOS runs through /private for the temporary folder.
  const playwrightRoot = realpathSync(playwrightCopy)
  const files = corpusFiles()
  const sameBytes = new Set(files.filter(({ file }) => sha256(join(playwrightCopy, file)) === sha256(join(retestCopy, file))).map(({ file }) => file))
  const verdicts = compatibilityCases.map((testCase) => {
    const source = readFileSync(join(corpusFolder, testCase.file), 'utf8')
    const playwrightTest = recorded.find((test) => relativeFile(playwrightRoot, test.file) === testCase.file && test.title === testCase.name)
    const retestTest = result.files.flatMap((file) => file.tests).find((test) => test.file === testCase.file && test.name === testCase.name)
    return judgeCase({
      testCase,
      source,
      playwright: playwrightTest === undefined ? undefined : playwrightObserved(playwrightTest),
      retest: retestTest === undefined ? undefined : retestObserved(retestTest, events),
      sameFile: sameBytes.has(testCase.file),
    })
  })
  return {
    playwright: { version: pinnedPlaywright.version, packages: installed, run: { ...playwrightRun, ...playwrightCounts(recorded), logFolder: playwrightLogs } },
    retest: { ...retestIdentity(result), run: { ...retestRun, ...retestCounts(result), logFolder: retestLogs } },
    browser: result.browser === null ? { product: 'unknown', version: 'unknown', executablePath: options.browser } : result.browser,
    node: process.version,
    files,
    verdicts,
    workFolder: options.workFolder,
  }
}

/**
 * Whether the two runs as wholes agree, every claimed case matched, every declared gap still holds and Playwright did
 * what each case declares.
 */
export function comparisonHolds(comparison: Comparison): boolean {
  return runProblems(comparison).length === 0 && comparison.verdicts.every((verdict) => verdict.playwrightAsDeclared && verdict.equivalent === verdict.testCase.support.supported)
}

/**
 * What keeps the two runs from agreeing as wholes, in plain sentences: Retest's run failing outside any test, such as
 * a browser it could not close, a runner ended by a signal, or the two exiting with different codes. Each case can be
 * equivalent and the comparison still fail on one of these.
 *
 * @example runProblems(comparison) // ["Retest exited with 2, and Playwright with 1."]
 */
export function runProblems(comparison: Comparison): string[] {
  const { playwright, retest } = comparison
  const problems: string[] = []
  if (retest.run.runFailure !== undefined) problems.push(`Retest's run itself failed, outside any test: ${retest.run.runFailure}`)
  if (playwright.run.signal !== null) problems.push(`Playwright's run was ended by ${playwright.run.signal}.`)
  if (retest.run.signal !== null) problems.push(`Retest's run was ended by ${retest.run.signal}.`)
  if (retest.run.exitCode !== playwright.run.exitCode) problems.push(`Retest exited with ${retest.run.exitCode ?? retest.run.signal}, and Playwright with ${playwright.run.exitCode ?? playwright.run.signal}.`)
  return problems
}

// ---- Installing the pinned Playwright ----

type InstallRecord = { readonly version: string; readonly packages: readonly InstalledPackage[] }

/**
 * Installs the pinned Playwright into `folder`, outside the repository, and says what it installed. A folder this
 * script made is reused while its record names the pinned version and checksums and each packed tarball still hashes
 * to its pinned checksum; its node_modules is then installed again from those tarballs, so what runs is what the
 * checksums cover, whatever has been changed under node_modules since. A folder holding something else is never
 * removed: only one this script made, or none.
 *
 * @example await installPlaywright(defaultPlaywrightFolder(), console.log)
 */
export async function installPlaywright(folder: string, log: Log): Promise<InstalledPackage[]> {
  const recordPath = join(folder, 'retest-install.json')
  const recorded = readInstallRecord(recordPath)
  if (recorded !== undefined && madeHere(folder) && recordMatches(recorded) && packsMatch(folder)) {
    log(`installing @playwright/test ${pinnedPlaywright.version} again from the checked tarballs in ${join(folder, 'packs')}`)
    rmSync(join(folder, 'node_modules'), { recursive: true, force: true })
    await installPacks(folder, pinnedPlaywright.packages.map((entry) => packFile(entry.name)))
    if (!installMatches(folder, recorded)) throw new Error(`The packages installed again in ${folder} are not the pinned ones.`)
    return [...recorded.packages]
  }
  if (existsSync(folder) && readdirSync(folder).length > 0 && !madeHere(folder)) {
    throw new Error(`${folder} holds files this script did not install. Remove it, or pass another folder.`)
  }
  rmSync(folder, { recursive: true, force: true })
  const packs = join(folder, 'packs')
  mkdirSync(packs, { recursive: true })
  // Named before anything is fetched, so a stopped install is still known as this script's own.
  writeFileSync(join(folder, 'package.json'), `${JSON.stringify({ name: installName, private: true, type: 'module' }, null, 2)}\n`)
  log(`packing @playwright/test ${pinnedPlaywright.version} into ${folder}`)
  const specs = pinnedPlaywright.packages.map((entry) => `${entry.name}@${pinnedPlaywright.version}`)
  const packed = await runProgram(['npm', 'pack', ...specs, '--json', '--pack-destination', packs], { cwd: folder, env: npmEnvironment(), logFolder: join(folder, 'pack-logs'), limitMs: installLimitMs })
  if (packed.exitCode !== 0) throw new Error(`npm pack failed; its output is in ${join(folder, 'pack-logs')}.`)
  const tarballs = readPackedTarballs(readFileSync(join(folder, 'pack-logs', 'stdout.txt'), 'utf8'))
  if (!packsMatch(folder)) throw new Error(`The tarballs npm packed into ${packs} do not hash to the pinned checksums.`)
  await installPacks(folder, tarballs.map((tarball) => tarball.filename))
  const packages = tarballs.map(({ name, version, integrity }) => ({ name, version, integrity }))
  const record: InstallRecord = { version: pinnedPlaywright.version, packages }
  if (!installMatches(folder, record)) throw new Error(`The packages installed in ${folder} are not the pinned ones.`)
  writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`)
  return packages
}

// Installs the packed tarballs with no network, as the first install did.
async function installPacks(folder: string, filenames: readonly string[]): Promise<void> {
  const install = await runProgram(
    ['npm', 'install', '--offline', '--no-audit', '--no-fund', '--ignore-scripts', ...filenames.map((filename) => `./packs/${filename}`)],
    { cwd: folder, env: npmEnvironment(), logFolder: join(folder, 'install-logs'), limitMs: installLimitMs },
  )
  if (install.exitCode !== 0) throw new Error(`npm install failed; its output is in ${join(folder, 'install-logs')}.`)
}

/**
 * The file `npm pack` writes a package's tarball to: its name without the `@` of its scope and with `-` for the slash,
 * then the version.
 *
 * @example packFile('@playwright/test') // 'playwright-test-1.63.0.tgz'
 */
export function packFile(name: string): string {
  return `${name.replace(/^@/, '').replace('/', '-')}-${pinnedPlaywright.version}.tgz`
}

/**
 * The registry's form of a file's checksum, as `npm pack --json` and the pins write it.
 *
 * @example integrityOf(Buffer.from('')) // 'sha512-z4PhNX7vuL3xVChQ1m2AB9Yg5AULVxXcg/SpIdNs6c5H0NE8XYXysP+DGNKHfuwvY7kxvUdBeoGlODJ6+SfaPg=='
 */
export function integrityOf(bytes: Buffer): string {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`
}

/** Whether each pinned package's tarball is in the folder's `packs` and hashes to its pinned checksum. */
export function packsMatch(folder: string): boolean {
  return pinnedPlaywright.packages.every((pinned) => {
    const tarball = join(folder, 'packs', packFile(pinned.name))
    return existsSync(tarball) && integrityOf(readFileSync(tarball)) === pinned.integrity
  })
}

function recordMatches(record: InstallRecord): boolean {
  return record.version === pinnedPlaywright.version && pinnedPlaywright.packages.every((pinned) => record.packages.some((item) => item.name === pinned.name && item.integrity === pinned.integrity && item.version === pinnedPlaywright.version))
}

const installName = 'retest-playwright-compat'

// A folder this script made names itself in its package.json, even when an install stopped before its record.
function madeHere(folder: string): boolean {
  const manifest = join(folder, 'package.json')
  if (!existsSync(manifest)) return false
  const parsed: unknown = JSON.parse(readFileSync(manifest, 'utf8'))
  return isPlainObject(parsed) && parsed['name'] === installName
}

type PackedTarball = InstalledPackage & { readonly filename: string }

// npm pack --json lists each tarball with the registry's checksum; each must be the pinned one.
function readPackedTarballs(text: string): PackedTarball[] {
  const parsed: unknown = JSON.parse(text)
  if (!isArray(parsed)) throw new Error('npm pack --json printed no list.')
  return pinnedPlaywright.packages.map((pinned) => {
    const entry = parsed.find((item) => isPlainObject(item) && item['name'] === pinned.name)
    const read = isPlainObject(entry) ? { version: entry['version'], integrity: entry['integrity'], filename: entry['filename'] } : undefined
    if (read === undefined || typeof read.version !== 'string' || typeof read.integrity !== 'string' || typeof read.filename !== 'string') {
      throw new Error(`npm pack did not pack ${pinned.name}.`)
    }
    if (read.version !== pinnedPlaywright.version || read.integrity !== pinned.integrity) {
      throw new Error(`npm pack gave ${pinned.name} ${read.version} with checksum ${read.integrity}, not the pinned ${pinnedPlaywright.version} ${pinned.integrity}.`)
    }
    return { name: pinned.name, version: read.version, integrity: read.integrity, filename: read.filename }
  })
}

function readInstallRecord(path: string): InstallRecord | undefined {
  if (!existsSync(path)) return undefined
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (!isPlainObject(parsed) || typeof parsed['version'] !== 'string' || !isArray(parsed['packages'])) return undefined
  const packages = parsed['packages'].flatMap((item): InstalledPackage[] => {
    if (!isPlainObject(item)) return []
    const { name, version, integrity } = item
    return typeof name === 'string' && typeof version === 'string' && typeof integrity === 'string' ? [{ name, version, integrity }] : []
  })
  return { version: parsed['version'], packages }
}

function installMatches(folder: string, record: InstallRecord): boolean {
  if (record.version !== pinnedPlaywright.version) return false
  return pinnedPlaywright.packages.every((pinned) => {
    const entry = record.packages.find((item) => item.name === pinned.name)
    if (entry === undefined || entry.integrity !== pinned.integrity || entry.version !== pinnedPlaywright.version) return false
    const manifest = join(folder, 'node_modules', ...pinned.name.split('/'), 'package.json')
    if (!existsSync(manifest)) return false
    const parsed: unknown = JSON.parse(readFileSync(manifest, 'utf8'))
    return isPlainObject(parsed) && parsed['version'] === pinnedPlaywright.version
  })
}

function npmEnvironment(): NodeJS.ProcessEnv {
  return { ...process.env, npm_config_update_notifier: 'false', npm_config_fund: 'false' }
}

// ---- Running the two runners ----

function copyCorpus(destination: string): void {
  rmSync(destination, { recursive: true, force: true })
  cpSync(corpusFolder, destination, { recursive: true })
  // Both copies read their files as ES modules, whatever folder holds them.
  writeFileSync(join(destination, 'package.json'), `${JSON.stringify({ name: 'playwright-compat-corpus', private: true, type: 'module' }, null, 2)}\n`)
}

function corpusFiles(): { file: string; sha256: string }[] {
  const files = [...new Set(compatibilityCases.map((testCase) => testCase.file))]
  return files.map((file) => ({ file, sha256: sha256(join(corpusFolder, file)) }))
}

async function withTaskApp<T>(work: (url: string) => Promise<T>): Promise<T> {
  const app = await startTaskApp()
  try {
    return await work(app.url)
  } finally {
    await app.close()
  }
}

// The runners' environment: this process's own, without the marker Node's test runner gives its children, so neither
// runner takes itself for a test of this process, with the comparison's variables added.
function runEnvironment(extra: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra }
  delete env['NODE_TEST_CONTEXT']
  return env
}

type ProgramRun = { readonly command: readonly string[]; readonly exitCode: number | null; readonly signal: string | null }

type ProgramOptions = { readonly cwd: string; readonly env: NodeJS.ProcessEnv; readonly logFolder: string; readonly limitMs: number }

// Each program runs in its own process group, with its output in files, and is stopped with its group when it
// outlasts its limit. Only groups this function started are ever signalled.
async function runProgram(command: readonly string[], options: ProgramOptions): Promise<ProgramRun> {
  mkdirSync(options.logFolder, { recursive: true })
  const stdout = openSync(join(options.logFolder, 'stdout.txt'), 'w')
  const stderr = openSync(join(options.logFolder, 'stderr.txt'), 'w')
  const [program = '', ...args] = command
  let timer: NodeJS.Timeout | undefined
  try {
    const child = spawn(program, args, { cwd: options.cwd, env: options.env, detached: true, stdio: ['ignore', stdout, stderr] })
    timer = setTimeout(() => stopGroup(child.pid), options.limitMs)
    const ended = await new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code: number | null, signal: NodeJS.Signals | null) => resolve({ code, signal }))
    })
    return { command, exitCode: ended.code, signal: ended.signal }
  } finally {
    // Cleared on every path, a program that could not start included, so a failed start does not keep this process
    // alive until the limit.
    clearTimeout(timer)
    closeSync(stdout)
    closeSync(stderr)
  }
}

function stopGroup(pid: number | undefined): void {
  if (pid === undefined) return
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    // The group has already ended.
  }
}

type RunCounts = Pick<RunFacts, 'collected' | 'retried' | 'skipped' | 'runFailure'>

// Playwright reports each attempt at a test, so a test it retried appears more than once.
function playwrightCounts(recorded: readonly RecordedTest[]): RunCounts {
  const collected = new Set(recorded.map((test) => `${test.file}\n${test.title}`)).size
  return { collected, retried: recorded.length - collected, skipped: recorded.filter((test) => test.status === 'skipped').length }
}

// Retest runs each test once; a failure of the run itself, such as a browser it could not close, is kept apart.
function retestCounts(result: RunResult): RunCounts {
  const tests = result.files.flatMap((file) => file.tests)
  return { collected: tests.length, retried: 0, skipped: tests.filter((test) => test.status === 'skipped').length, ...(result.failure === undefined ? {} : { runFailure: `${result.failure.class}: ${result.failure.message}` }) }
}

function retestIdentity(result: RunResult): { version: string; commit: string; changed: boolean } {
  const commit = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repositoryRoot, encoding: 'utf8' })
  // Untracked files count: a new source file the run loaded is as much a change as an edited one.
  const status = spawnSync('git', ['status', '--porcelain'], { cwd: repositoryRoot, encoding: 'utf8' })
  return { version: result.retestVersion, commit: commit.status === 0 ? commit.stdout.trim() : 'unknown', changed: status.status === 0 && status.stdout.trim() !== '' }
}

// ---- Reading what each runner wrote ----

/**
 * The operations reporter's file: each test's result and its tree of steps.
 *
 * @example readPlaywrightReport('[]') // []
 */
export function readPlaywrightReport(text: string): RecordedTest[] {
  const parsed: unknown = JSON.parse(text)
  if (!isArray(parsed)) throw new Error('The Playwright operations report is not a list.')
  return parsed.map((item, index) => {
    if (!isPlainObject(item)) throw new Error(`Test ${index + 1} of the Playwright operations report is not an object.`)
    const { file, title, titlePath, status, errors, steps } = item
    if (typeof file !== 'string' || typeof title !== 'string' || typeof status !== 'string' || !isArray(titlePath) || !isArray(errors) || !isArray(steps)) {
      throw new Error(`Test ${index + 1} of the Playwright operations report is missing a field.`)
    }
    return {
      file,
      title,
      titlePath: titlePath.filter((part) => typeof part === 'string'),
      status,
      errors: errors.flatMap((error) => {
        if (!isPlainObject(error)) return []
        const location = readLocation(error['location'])
        return [{ message: typeof error['message'] === 'string' ? error['message'] : '', ...(location === undefined ? {} : { location }) }]
      }),
      steps: steps.map(readStep),
    }
  })
}

function readStep(value: unknown): RecordedStep {
  if (!isPlainObject(value) || typeof value['title'] !== 'string' || typeof value['category'] !== 'string' || !isArray(value['steps'])) {
    throw new Error('A step of the Playwright operations report is missing a field.')
  }
  const location = readLocation(value['location'])
  const error = value['error']
  return {
    title: value['title'],
    category: value['category'],
    ...(location === undefined ? {} : { location }),
    ...(typeof error === 'string' ? { error } : {}),
    steps: value['steps'].map(readStep),
  }
}

function readLocation(value: unknown): { file: string; line: number; column: number } | undefined {
  if (!isPlainObject(value)) return undefined
  const { file, line, column } = value
  return typeof file === 'string' && typeof line === 'number' && typeof column === 'number' ? { file, line, column } : undefined
}

function readRetestResult(text: string): RunResult {
  const parsed = parse(runResultSchema, JSON.parse(text))
  if (!parsed.ok) throw new Error(`Retest's ${resultFile} does not match its schema: ${parsed.issues.map((issue) => `${issue.path} ${issue.message}`).join('; ')}`)
  return parsed.value
}

function readRetestEvents(text: string): RetestEvent[] {
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line, index) => {
      const parsed = parse(retestEventSchema, JSON.parse(line))
      if (!parsed.ok) throw new Error(`Line ${index + 1} of Retest's ${eventsFile} does not match its schema.`)
      return parsed.value
    })
}

// ---- Judging ----

/** Playwright's messages carry terminal colours unless told otherwise; the comparison reads them without. */
export function withoutColours(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, '')
}

/**
 * The class of a Playwright failure, as the comparison names it: `assertion` for a check that did not pass, `ambiguous`
 * for a locator that matched several elements, `timeout` for an action or a test out of time, and `error` for
 * anything else.
 *
 * @example playwrightFailureClass('Error: expect(locator).toHaveText(expected) failed') // 'assertion'
 */
export function playwrightFailureClass(message: string): string {
  const text = withoutColours(message)
  if (/strict mode violation/.test(text)) return 'ambiguous'
  if (/expect\((locator|page|received)\)\.(not\.)?\w+\(/.test(text)) return 'assertion'
  if (/Timeout \d+ms exceeded|Test timeout of \d+ms exceeded/.test(text)) return 'timeout'
  return 'error'
}

/**
 * The class of a Retest failure, as the comparison names it: `assertion` for `check_failed`, and Retest's own class
 * for anything else, `unsupported` included.
 *
 * @example retestFailureClass('check_failed') // 'assertion'
 */
export function retestFailureClass(failureClass: string): string {
  return failureClass === 'check_failed' ? 'assertion' : failureClass
}

/**
 * How Playwright ended a test: its status, its first error, the innermost step that failed, and the actions, checks
 * and steps it ran from the spec, in order. Hooks are looked into; fixtures are not, since a fixture is Playwright's
 * setup rather than the test's.
 */
export function playwrightObserved(test: RecordedTest): Observed {
  const operations: Operation[] = []
  const visit = (steps: readonly RecordedStep[]): void => {
    for (const step of steps) {
      const inSpec = step.location?.file === test.file
      if (step.category === 'test.step') {
        if (inSpec && step.location !== undefined) operations.push({ kind: 'step', line: step.location.line, title: step.title })
        visit(step.steps)
      } else if (step.category === 'hook') {
        visit(step.steps)
      } else if ((step.category === 'pw:api' || step.category === 'expect') && inSpec && step.location !== undefined) {
        operations.push({ kind: step.category === 'expect' ? 'assertion' : 'action', line: step.location.line, title: step.title })
      }
    }
  }
  visit(test.steps)
  const [error] = test.errors
  const step = innermostFailedStep(test.steps)
  const values = error === undefined ? undefined : playwrightValues(error.message)
  return {
    status: test.status === 'failed' || test.status === 'timedOut' ? (test.status === 'failed' ? 'failed' : 'timed_out') : test.status,
    ...(error === undefined
      ? {}
      : {
          failure: {
            class: playwrightFailureClass(error.message),
            ...(error.location === undefined ? {} : { line: error.location.line }),
            message: firstLine(withoutColours(error.message)),
            ...(values === undefined ? {} : { values }),
          },
        }),
    ...(step === undefined ? {} : { step }),
    operations,
  }
}

/**
 * What a failed `expect` of Playwright's expected and received, read from its message: the `Expected:` and
 * `Received:` lines for one value, a quoted text, a number or a state such as `hidden`, and for a list the diff it
 * prints inside `Array [`, where a line only the expected list holds starts with `-` and one only the received list
 * holds with `+`. Undefined when the message holds neither form.
 *
 * @example playwrightValues('Error: expect(locator).toHaveText(expected) failed\n\nExpected: "Saved"\nReceived: "Save"') // { expected: ['Saved'], received: ['Save'] }
 */
export function playwrightValues(message: string): FailureValues | undefined {
  const text = withoutColours(message).split('\nCall log:')[0] ?? ''
  const expected = /^Expected:\s+(.+)$/m.exec(text)?.[1]
  const received = /^Received:\s+(.+)$/m.exec(text)?.[1]
  if (expected !== undefined && received !== undefined) {
    const values = { expected: [playwrightValue(expected)], received: [playwrightValue(received)] }
    return values.expected.includes(undefined) || values.received.includes(undefined) ? undefined : normalisedValues(values.expected.flatMap(defined), values.received.flatMap(defined))
  }
  const lines = text.split('\n')
  const start = lines.findIndex((line) => line.trim() === 'Array [')
  const end = lines.findIndex((line, index) => index > start && line.trim() === ']')
  if (start === -1 || end === -1) return undefined
  const both: { side: string; value: string | undefined }[] = lines.slice(start + 1, end).map((line) => ({ side: line.charAt(0), value: playwrightValue(line.slice(1).trim().replace(/,$/, '')) }))
  if (both.some((entry) => entry.value === undefined || ![' ', '-', '+'].includes(entry.side))) return undefined
  const sideOf = (side: string): string[] => both.flatMap((entry) => (entry.side === ' ' || entry.side === side ? defined(entry.value) : []))
  return normalisedValues(sideOf('-'), sideOf('+'))
}

// One value as Playwright prints it: a quoted text as JSON writes one, or a bare word or number as it is.
function playwrightValue(printed: string): string | undefined {
  const value = printed.trim()
  if (!value.startsWith('"')) return /^[\w.-]+$/.test(value) ? value : undefined
  try {
    const parsed: unknown = JSON.parse(value)
    return typeof parsed === 'string' ? parsed : undefined
  } catch {
    return undefined
  }
}

function defined(value: string | undefined): string[] {
  return value === undefined ? [] : [value]
}

/**
 * What a failed check of Retest's expected and received, from its failure's details: one text, or a list where the
 * text is a JSON list of texts, as Retest records a list check. Undefined when either is missing or was cut short.
 *
 * @example retestValues({ expected: { text: 'Saved', truncated: false }, received: { text: 'Save', truncated: false } }) // { expected: ['Saved'], received: ['Save'] }
 */
export function retestValues(details: Readonly<Record<string, unknown>> | undefined): FailureValues | undefined {
  const expected = recordedText(details?.['expected'])
  const received = recordedText(details?.['received'])
  if (expected === undefined || received === undefined) return undefined
  return normalisedValues(textList(expected), textList(received))
}

function recordedText(value: unknown): string | undefined {
  if (!isPlainObject(value) || value['truncated'] === true) return undefined
  const text = value['text']
  return typeof text === 'string' ? text : undefined
}

function textList(text: string): string[] {
  if (!text.startsWith('[')) return [text]
  try {
    const parsed: unknown = JSON.parse(text)
    return isArray(parsed) && parsed.every((item) => typeof item === 'string') ? parsed.flatMap((item) => (typeof item === 'string' ? [item] : [])) : [text]
  } catch {
    return [text]
  }
}

// Both runners compare text with its ends trimmed and each run of spaces or line breaks read as one space.
function normalisedValues(expected: readonly string[], received: readonly string[]): FailureValues {
  const normal = (text: string): string => text.trim().replace(/\s+/g, ' ')
  return { expected: expected.map(normal), received: received.map(normal) }
}

function innermostFailedStep(steps: readonly RecordedStep[]): string | undefined {
  for (const step of steps) {
    if (step.error === undefined) continue
    const inner = innermostFailedStep(step.steps)
    if (inner !== undefined) return inner
    if (step.category === 'test.step') return step.title
  }
  return undefined
}

/**
 * How Retest ended a test: its status, its failure, the innermost step that failed, and the actions, checks and steps
 * its events record, in order. A hook's own step is left out, as Playwright files a hook apart from the test's steps.
 */
export function retestObserved(test: TestResult, events: readonly RetestEvent[]): Observed {
  const operations: Operation[] = []
  const failedSteps = new Map<string, string>()
  const stepNames = new Map<string, { name: string; parent?: string }>()
  for (const event of events) {
    if (!('testId' in event) || event.testId !== test.testId || !('attemptId' in event) || event.attemptId !== test.attemptId) continue
    if (event.type === 'step.started') {
      stepNames.set(event.stepId, { name: event.name, ...(event.parentStepId === undefined ? {} : { parent: event.parentStepId }) })
      if (event.hook === undefined && event.location !== undefined) operations.push({ kind: 'step', line: event.location.line, title: event.name })
    } else if (event.type === 'step.finished' && event.status === 'failed') {
      failedSteps.set(event.stepId, stepNames.get(event.stepId)?.name ?? '')
    } else if ((event.type === 'action.completed' || event.type === 'action.failed') && event.location !== undefined) {
      operations.push({ kind: 'action', line: event.location.line, title: event.command })
    } else if ((event.type === 'assertion.passed' || event.type === 'assertion.failed') && event.location !== undefined) {
      operations.push({ kind: 'assertion', line: event.location.line, title: event.matcher })
    }
  }
  // The innermost failed step is one no other failed step names as its parent.
  const parents = new Set([...failedSteps.keys()].flatMap((stepId) => stepNames.get(stepId)?.parent ?? []))
  const innermost = [...failedSteps.entries()].find(([stepId]) => !parents.has(stepId))
  const { failure } = test
  const values = failure === undefined ? undefined : retestValues(failure.details)
  return {
    status: test.status,
    ...(failure === undefined
      ? {}
      : {
          failure: {
            class: retestFailureClass(failure.class),
            ...(failure.location === undefined ? {} : { line: failure.location.line }),
            message: firstLine(failure.message),
            ...(values === undefined ? {} : { values }),
          },
        }),
    ...(innermost === undefined || hookStep(innermost[0], events) ? {} : { step: innermost[1] }),
    operations,
  }
}

function hookStep(stepId: string, events: readonly RetestEvent[]): boolean {
  return events.some((event) => event.type === 'step.started' && event.stepId === stepId && event.hook !== undefined)
}

/**
 * The line of the check a failing case names: the first line holding its text after the line that opens its step.
 *
 * @example intendedLine("test.step('a', async () => {\n  await expect(x).toBeHidden()", { status: 'failed', step: 'a', operation: 'toBeHidden()', failure: 'assertion' }) // 2
 */
export function intendedLine(source: string, outcome: DeclaredOutcome): number | undefined {
  if (outcome.status !== 'failed') return undefined
  const lines = source.split('\n')
  const start = lines.findIndex((line) => line.includes(`test.step('${outcome.step}'`))
  if (start === -1) return undefined
  const index = lines.findIndex((line, at) => at > start && line.includes(outcome.operation))
  return index === -1 ? undefined : index + 1
}

type CaseRuns = {
  readonly testCase: CompatibilityCase
  readonly source: string
  readonly playwright: Observed | undefined
  readonly retest: Observed | undefined
  /** Both runners read byte for byte the same spec file. */
  readonly sameFile: boolean
}

/**
 * Judges one case. Equivalent means: Playwright did what the case declares, Retest did the same, neither refused it as
 * unsupported, and both went through the same file and the same operations at the same lines. A failing case counts
 * only when it failed in its named step, at the line of its named check, as an assertion, and when both failed checks
 * expected the same values and received the same values.
 */
export function judgeCase(runs: CaseRuns): CaseVerdict {
  const { testCase, playwright, retest } = runs
  const line = intendedLine(runs.source, testCase.outcome)
  const problems: string[] = []
  if (testCase.outcome.status === 'failed' && line === undefined) problems.push(`The spec has no ${testCase.outcome.operation} inside the step "${testCase.outcome.step}".`)
  const playwrightProblem = playwright === undefined ? 'Playwright did not run it.' : outcomeProblem('Playwright', playwright, testCase.outcome, line)
  if (playwrightProblem !== undefined) problems.push(playwrightProblem)
  const retestProblem = retest === undefined ? 'Retest did not run it.' : outcomeProblem('Retest', retest, testCase.outcome, line)
  if (retestProblem !== undefined) problems.push(retestProblem)
  const valuesProblem = testCase.outcome.status === 'failed' && playwrightProblem === undefined && retestProblem === undefined ? differentValues(playwright, retest) : undefined
  if (valuesProblem !== undefined) problems.push(valuesProblem)
  const retained = retainedBetween(runs.sameFile, playwright, retest)
  if (!retained.same) problems.push(retained.difference)
  return {
    testCase,
    ...(line === undefined ? {} : { intendedLine: line }),
    ...(playwright === undefined ? {} : { playwright }),
    ...(retest === undefined ? {} : { retest }),
    playwrightAsDeclared: playwrightProblem === undefined,
    retestAsDeclared: retestProblem === undefined,
    retained,
    ...(testCase.outcome.status === 'failed' && playwrightProblem === undefined && retestProblem === undefined ? { sameValues: valuesProblem === undefined } : {}),
    equivalent: problems.length === 0,
    problems,
  }
}

// Why two failures at the intended check are not the same failure, or undefined when both expected the same values
// and received the same values. A failure whose values neither runner's record says cannot count as the same.
function differentValues(playwright: Observed | undefined, retest: Observed | undefined): string | undefined {
  const theirs = playwright?.failure?.values
  const ours = retest?.failure?.values
  if (theirs === undefined) return "Playwright's failure names no expected and received values the comparison can read, so the two failures cannot be shown to be the same."
  if (ours === undefined) return "Retest's failure names no expected and received values the comparison can read, so the two failures cannot be shown to be the same."
  if (isDeepStrictEqual(theirs, ours)) return undefined
  return `The two checks failed on different values: Playwright expected ${JSON.stringify(theirs.expected)} and received ${JSON.stringify(theirs.received)}, Retest expected ${JSON.stringify(ours.expected)} and received ${JSON.stringify(ours.received)}.`
}

// Why a run did not do what the case declares, or undefined when it did. An unsupported member is never equivalent to
// an intended failure, so it is named as what it is.
function outcomeProblem(runner: string, observed: Observed, outcome: DeclaredOutcome, line: number | undefined): string | undefined {
  if (observed.failure?.class === 'unsupported') return `${runner} refused it as unsupported at line ${observed.failure.line ?? '?'}: ${observed.failure.message}`
  if (outcome.status === 'passed') {
    if (observed.status === 'passed') return undefined
    return `${runner} ended it ${describeObserved(observed)}, where the case passes.`
  }
  const failedAsDeclared =
    observed.status === 'failed' && observed.failure?.class === outcome.failure && observed.failure.line === line && observed.step === outcome.step
  if (failedAsDeclared) return undefined
  return `${runner} ended it ${describeObserved(observed)}, where the case fails as an assertion at line ${line ?? '?'} in the step "${outcome.step}".`
}

/**
 * Whether the two runs read the same file and went through the same steps, actions and checks at the same lines, in
 * the same order, or the first place they part.
 */
export function retainedBetween(sameFile: boolean, playwright: Observed | undefined, retest: Observed | undefined): Retained {
  if (!sameFile) return { same: false, difference: 'The two runners read different bytes for the spec.' }
  if (playwright === undefined || retest === undefined) return { same: false, difference: 'One runner did not run it, so its operations cannot be compared.' }
  const longest = Math.max(playwright.operations.length, retest.operations.length)
  for (let index = 0; index < longest; index++) {
    const ours = retest.operations[index]
    const theirs = playwright.operations[index]
    if (ours !== undefined && theirs !== undefined && sameOperation(ours, theirs)) continue
    return { same: false, difference: `Operation ${index + 1}: Playwright ${describeOperation(theirs)}, Retest ${describeOperation(ours)}.` }
  }
  return { same: true }
}

function sameOperation(first: Operation, second: Operation): boolean {
  return first.kind === second.kind && first.line === second.line && (first.kind !== 'step' || first.title === second.title)
}

function describeOperation(operation: Operation | undefined): string {
  if (operation === undefined) return 'ran nothing more'
  if (operation.kind === 'step') return `opened the step "${operation.title}" at line ${operation.line}`
  return `ran ${operation.kind === 'action' ? 'an action' : 'a check'} at line ${operation.line}`
}

/**
 * A run's ending in a few words: the status, and for a failure its class, line and step.
 *
 * @example describeObserved({ status: 'passed', operations: [] }) // 'passed'
 */
export function describeObserved(observed: Observed): string {
  if (observed.failure === undefined) return observed.status
  const at = observed.failure.line === undefined ? '' : ` at line ${observed.failure.line}`
  const step = observed.step === undefined ? '' : ` in "${observed.step}"`
  return `${observed.status}: ${observed.failure.class}${at}${step}`
}

function firstLine(text: string): string {
  return text.trim().split('\n')[0] ?? ''
}

function relativeFile(root: string, file: string): string {
  return relative(root, file).split(sep).join('/')
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

// ---- The table ----

/** The table docs/compatibility/playwright.md holds, written from a comparison. */
export function renderTable(comparison: Comparison): string {
  const { verdicts } = comparison
  const passing = verdicts.filter((verdict) => verdict.testCase.outcome.status === 'passed')
  const failing = verdicts.filter((verdict) => verdict.testCase.outcome.status === 'failed')
  const claimed = verdicts.filter((verdict) => verdict.testCase.support.supported)
  const gaps = verdicts.filter((verdict) => !verdict.testCase.support.supported)
  const count = (list: readonly CaseVerdict[], test: (verdict: CaseVerdict) => boolean): string => `${list.filter(test).length} of ${list.length}`
  const total = verdicts.length + unavailableCases.length
  const starter = verdicts.filter((verdict) => verdict.testCase.file === corpusSources.starter.corpusFile).length
  const variants = verdicts.filter((verdict) => verdict.testCase.variantOf !== undefined).length
  const wholes = runProblems(comparison)
  const packages = comparison.playwright.packages.map((entry) => `\`${entry.name}\` ${entry.version} (\`${entry.integrity}\`)`).join(', ')
  const retest = `\`@rehearsal-labs/retest\` ${comparison.retest.version} from source at commit \`${comparison.retest.commit}\`${comparison.retest.changed ? ', with uncommitted changes' : ''}`
  const lines = [
    '# Playwright compatibility',
    '',
    "The same Playwright test files, run once by Playwright and once by Retest's compatibility (`retest run --playwright`), and compared case by case. Generated by `node --conditions=retest-source scripts/compare-playwright.ts --write` from `fixtures/playwright-compat`; do not edit it by hand. `tests/integration/playwright-compat-table.test.ts` runs the same comparison and fails when a case declared supported differs, when a declared gap has closed, or when the case list below no longer matches the runs.",
    '',
    'Any count here describes this corpus only.',
    '',
    '## What ran',
    '',
    '| | |',
    '| --- | --- |',
    `| Playwright | ${packages}, packed from the registry into a folder outside the repository (${pinnedPlaywright.license}) |`,
    `| Retest | ${retest} |`,
    `| Browser | ${comparison.browser.product} ${comparison.browser.version}, the same executable for both runners, headless |`,
    `| Node.js | ${comparison.node} |`,
    '| App | `fixtures/task-app`, a fresh one for each runner |',
    `| Settings | one worker, no retries, a ${assertionBudgetMs / 1000} second assertion budget: Playwright from the corpus's \`playwright.config.ts\`, Retest from \`--workers 1 --timeouts assertion=${assertionBudgetMs}\`, since Retest reads no \`playwright.config.ts\` |`,
    `| Corpus | Playwright's starter, \`${corpusSources.starter.file}\` of \`${corpusSources.starter.package}\` ${corpusSources.starter.version} (sha256 \`${corpusSources.starter.sha256}\`, ${corpusSources.starter.license}) with ${corpusSources.starter.change}; and the basic workflow cases of \`${corpusSources.workflow}\`, written as Playwright tests against the task app |`,
    '',
    '## Summary',
    '',
    `- The fixed list holds ${total} cases: ${starter} from the starter, ${total - starter - variants} workflow cases, and ${variants} of those written again in the form a Playwright test most often takes, which Retest refuses. The corpus holds ${verdicts.length}; ${unavailableCases.length} are not in it, and each is a declared gap.`,
    `- Collected: Playwright ${comparison.playwright.run.collected}, Retest ${comparison.retest.run.collected}.`,
    `- Playwright did what the case declares: ${count(verdicts, (verdict) => verdict.playwrightAsDeclared)}.`,
    `- Retest did what the case declares: ${count(verdicts, (verdict) => verdict.retestAsDeclared)}.`,
    `- Same file and the same steps, actions and checks at the same lines: ${count(verdicts, (verdict) => verdict.retained.same)}.`,
    `- Equivalent: ${count(verdicts, (verdict) => verdict.equivalent)}; of the passing cases ${count(passing, (verdict) => verdict.equivalent)}, of the intended failures ${count(failing, (verdict) => verdict.equivalent)}.`,
    `- Declared supported: ${claimed.length} of ${total} cases, of which equivalent ${claimed.filter((verdict) => verdict.equivalent).length}.`,
    `- Declared gaps: ${gaps.length + unavailableCases.length} of ${total} cases: ${gaps.length} in the corpus, of which still gaps ${gaps.filter((verdict) => !verdict.equivalent).length}, and the ${unavailableCases.length} cases not in the corpus.`,
    `- Retried: Playwright ${comparison.playwright.run.retried}, Retest ${comparison.retest.run.retried}. Skipped: Playwright ${comparison.playwright.run.skipped}, Retest ${comparison.retest.run.skipped}.`,
    `- Exit codes: Playwright ${comparison.playwright.run.exitCode ?? comparison.playwright.run.signal}, Retest ${comparison.retest.run.exitCode ?? comparison.retest.run.signal}.`,
    wholes.length === 0 ? '- The runs as wholes agree: neither failed outside a test, and both exited alike.' : `- The runs as wholes do not agree, so the comparison fails: ${cell(wholes.join(' '))}`,
    '',
    '## Cases',
    '',
    '| Case | Test | Declared | Playwright | Retest | Same file and operations | Failed at the intended check | Equivalent |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...verdicts.map(caseRow),
    '',
    '## Not in the corpus',
    '',
    '| Case | Test | Why |',
    '| --- | --- | --- |',
    ...unavailableCases.map((unavailable) => `| ${unavailable.id} | ${cell(unavailable.name)} | ${cell(unavailable.reason)} |`),
    '',
  ]
  const notes = verdicts.filter((verdict) => !verdict.equivalent || !verdict.testCase.support.supported)
  if (notes.length > 0) {
    lines.push('## Differences', '')
    for (const verdict of notes) {
      const gap = verdict.testCase.support.supported ? '' : ` Declared gap: ${verdict.testCase.support.gap}`
      lines.push(`- ${verdict.testCase.id}, ${verdict.testCase.name}.${gap} ${verdict.problems.join(' ')}`.trimEnd())
    }
    lines.push('')
  }
  lines.push(
    '## How a case is judged',
    '',
    '- A case is equivalent when Playwright did what the case declares, Retest did the same, and both read the same bytes of the spec and went through the same steps, actions and checks, at the same lines, in the same order.',
    '- A case declared to fail counts only when it failed in its named step, at the line of its named check, as an assertion: an `expect` that did not pass under Playwright, `check_failed` under Retest. Both failed checks must also have expected the same values and received the same values, each text trimmed with its runs of spaces read as one, as each runner records them.',
    '- The comparison fails, whatever the cases, when Retest\'s run fails outside any test, when either runner is ended by a signal, or when the two exit with different codes.',
    '- A member or option Retest refuses as unsupported is never equivalent to an intended failure, wherever it stops the test.',
    "- Playwright's operations come from its reporter's steps (`pw:api`, `expect` and `test.step`, with hooks looked into and fixtures left out); Retest's from its events (`action.*`, `assertion.*` and `step.started`).",
    '',
  )
  return `${lines.join('\n')}`
}

function caseRow(verdict: CaseVerdict): string {
  const declared = verdict.testCase.outcome.status === 'passed' ? 'passes' : `fails at line ${verdict.intendedLine ?? '?'} in "${verdict.testCase.outcome.step}"`
  const playwright = verdict.playwright === undefined ? 'did not run' : describeObserved(verdict.playwright)
  const retest = verdict.retest === undefined ? 'did not run' : describeObserved(verdict.retest)
  const same = verdict.retained.same ? 'yes' : 'no'
  const equivalent = verdict.equivalent ? 'yes' : verdict.testCase.support.supported ? 'no' : 'no, declared gap'
  return `| ${verdict.testCase.id} | ${cell(verdict.testCase.name)} | ${cell(declared)} | ${cell(playwright)} | ${cell(retest)} | ${same} | ${atIntendedCheck(verdict)} | ${equivalent} |`
}

// For a case declared to fail: which runners failed in its step, at its check, as an assertion. Nothing for a case
// declared to pass.
function atIntendedCheck(verdict: CaseVerdict): string {
  if (verdict.testCase.outcome.status === 'passed') return ''
  if (verdict.playwrightAsDeclared && verdict.retestAsDeclared) return verdict.sameValues === true ? 'both, on the same values' : 'both, on other values'
  if (verdict.playwrightAsDeclared) return 'Playwright only'
  return verdict.retestAsDeclared ? 'Retest only' : 'neither'
}

function cell(text: string): string {
  return text.replaceAll('|', '\\|').replaceAll('\n', ' ')
}

// ---- The command line ----

async function main(): Promise<number> {
  const { values } = parseArgs({ options: { browser: { type: 'string' }, work: { type: 'string' }, write: { type: 'boolean', default: false } } })
  const workFolder = values.work ?? join(tmpdir(), 'retest-playwright-compat', 'runs', `${Date.now()}-${process.pid}`)
  const comparison = await comparePlaywright({ browser: values.browser ?? browserPath(), workFolder, log: (line) => process.stdout.write(`${line}\n`) })
  writeFileSync(join(workFolder, 'comparison.json'), `${JSON.stringify(comparison, null, 2)}\n`)
  const table = renderTable(comparison)
  writeFileSync(join(workFolder, 'playwright.md'), `${table}\n`)
  if (values.write) {
    mkdirSync(join(repositoryRoot, 'docs', 'compatibility'), { recursive: true })
    writeFileSync(tablePath, `${table}\n`)
    process.stdout.write(`wrote ${relative(repositoryRoot, tablePath)}\n`)
  }
  for (const verdict of comparison.verdicts) {
    const mark = verdict.equivalent ? 'same' : verdict.testCase.support.supported ? 'DIFFERS' : 'gap'
    process.stdout.write(`${mark.padEnd(8)}${verdict.testCase.id.padEnd(11)}${verdict.problems.join(' ')}\n`)
  }
  for (const problem of runProblems(comparison)) process.stdout.write(`run     ${problem}\n`)
  process.stdout.write(`work folder: ${workFolder}\n`)
  return comparisonHolds(comparison) ? 0 : 1
}

if (import.meta.main) {
  main().then(
    (code) => {
      process.exitCode = code
    },
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      process.exitCode = 2
    },
  )
}
