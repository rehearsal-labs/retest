import type { TestContext } from 'node:test'
import type { TaskApp } from '../../fixtures/task-app/server.ts'
import type { RetestEvent, TestStatus } from '../../src/protocol/events.ts'
import type { FailureClass } from '../../src/protocol/failures.ts'
import type { TestResult } from '../../src/protocol/result.ts'
import type { Exit } from '../integration/cli-harness.ts'
import type { Anchor, AppCounter, ConformanceCase, Declared, Fact, Group, GroupName, HeldValue, Message, RunCase, RunFact, TestCase } from './cases.ts'
import type { Engine, EngineSetup } from './engines.ts'
import type { EndedRun } from './process.ts'
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { isDeepStrictEqual } from 'node:util'
import { conformanceVariables } from '../../fixtures/conformance/config.ts'
import { startTaskApp } from '../../fixtures/task-app/server.ts'
import { TASK_APP_PASSWORD } from '../../fixtures/task-app/sign-in.ts'
import { WORKFLOW_PASSWORD, WORKFLOW_SESSION_COOKIE } from '../../fixtures/task-app/workflow-sign-in-page.ts'
import { runResultSchema } from '../../src/protocol/result.ts'
import { conformanceDifferences } from '../integration/engine-differences.ts'
import { conformanceExpectation, conformanceMessageProblems, conformanceProblems, declarationProblems, readProofs } from '../integration/engine-expectations.ts'
import { assertLooksStayWithTheirSession } from '../integration/participants-harness.ts'
import {
  answersAt,
  appServerCommand,
  appServersOn,
  assertStdoutIsEvents,
  budgets,
  eventsOf,
  filesHolding,
  freePort,
  parseLine,
  repositoryRoot,
  sourceCommand,
  textHolds,
} from '../integration/cli-harness.ts'
import { tempFolder } from '../support/temp-folder.ts'
import { conformanceCases, groups } from './cases.ts'
import { engineNames, engineSetup, targetNames } from './engines.ts'
import { assertNothingLeft, endRun, RunProcess } from './process.ts'

// Runs the fixed conformance cases on one engine: each group of `cases.ts` as one run of its folder under
// `fixtures/conformance/`, through Retest's CLI from source or a host program, against a task app or app server this
// process starts, then reads each run's own record and compares every case with its declared outcome. Nothing here
// judges a case from what a test printed: only the run folder, the run's events and the apps' own counters.

const fixturesRoot = join(repositoryRoot, 'fixtures/conformance')

/** The budgets every CLI run gets unless its group says otherwise. */
const runBudgets = { collection: 10_000, setup: 20_000, action: 1500, navigation: 5000, assertion: 1500, test: 20_000, cleanup: 5000 }

/** How long the runner waits for the moment a group's interruption needs, and for a stopped run to end. */
const interruptionWaitMs = 30_000

/** How long one group's run may take before its process group is ended and the run is reported as stuck. */
const runLimitMs = 5 * 60_000

/** The secrets each group's config declares, by the variable it reads. */
const groupSecrets: Partial<Record<GroupName, Readonly<Record<string, string>>>> = {
  web: { [conformanceVariables.password]: TASK_APP_PASSWORD },
  participants: { [conformanceVariables.password]: TASK_APP_PASSWORD },
  workflow: { [conformanceVariables.workflowPassword]: WORKFLOW_PASSWORD },
}

const heldValues: Readonly<Record<HeldValue, string>> = {
  password: TASK_APP_PASSWORD,
  'workflow-password': WORKFLOW_PASSWORD,
  'workflow-session-cookie': WORKFLOW_SESSION_COOKIE,
}

/** A test's end as the run recorded it: its status, and for a failure its class, the operation it failed at and its step. */
export type Actual = {
  readonly status: TestStatus | 'absent'
  readonly class?: FailureClass
  readonly operation?: string
  readonly step?: string
}

/**
 * What an engine gave for one case: its result in words, and how it differs from the declared outcome, if it does.
 * `declared` marks a case the engine was held to its own declared outcome for, which engine-differences.ts gives.
 */
export type CaseReport = { readonly id: string; readonly given: string; readonly differences: readonly string[]; readonly declared?: true }

/** One run of a group: how it exited against its declared exit code, and any problem with the run itself. */
export type GroupReport = {
  readonly group: GroupName
  readonly declaredExit: number
  readonly exit?: Exit
  readonly durationMs?: number
  readonly problems: readonly string[]
}

/** A browser a run started, as `browser.started` named it. */
export type BrowserIdentity = { readonly product: string; readonly version: string; readonly executablePath: string }

/**
 * Whether an engine ran. One that did not is `excused` when a variable opted it out by name or 0.1.0 does not support
 * it on this platform; it is then reported as not verified, and otherwise it fails the gate. Neither is ever a pass.
 */
export type Availability = { readonly available: true } | { readonly available: false; readonly reason: string; readonly excused: boolean }

/**
 * Everything one engine gave: whether it was available, the browsers it ran, each run and each case. `error` is a
 * conformance run that failed before it could judge every case, which judges none.
 */
export type EngineReport = {
  readonly engine: Engine
  readonly availability: Availability
  readonly error?: string
  /** How the runs started the engine, where a reader of the results must know it. */
  readonly notes?: readonly string[]
  readonly browsers: readonly BrowserIdentity[]
  readonly retestVersion?: string
  readonly groups: readonly GroupReport[]
  readonly cases: readonly CaseReport[]
}

export type RunEngineOptions = {
  /** A folder outside the repository to copy each run folder into, with what the run printed, under `<engine>/<group>`. */
  readonly keep?: string
}

/** A group's run that ended, with what the runner started for it. */
type GroupRun = {
  readonly group: Group
  readonly ended: EndedRun
  readonly baseUrl: string
  readonly app?: TaskApp
  readonly server?: { readonly url: string; readonly port: number }
  readonly problems: string[]
  readonly runFacts: Map<string, readonly string[]>
  /** Each task app count a case of the group names, by `counterKey`, as the run changed it. */
  readonly counts: ReadonlyMap<string, number>
}

/** A group that never produced a run to read, and why. */
type MissingRun = { readonly group: Group; readonly problems: readonly string[] }

/**
 * Runs every group on `engine` and compares every case with its declared outcome. An engine the machine does not have
 * is reported as not available, with every case left unjudged. A run that refuses every test because no driver runs
 * the engine is not that: it is the engine's own failure, and every case differs.
 *
 * @example const report = await runEngine(t, 'chrome')
 */
export async function runEngine(t: TestContext, engine: Engine, options: RunEngineOptions = {}): Promise<EngineReport> {
  // A declaration that names no case, or cites no item of its engine's page, would hold nothing; no engine is judged then.
  const unsound = [...declarationProblems(conformanceDifferences, readProofs()), ...conformanceProblems(conformanceDifferences, conformanceCases)]
  if (unsound.length > 0) throw new Error(`The conformance declarations of engine-differences.ts do not hold: ${unsound.join(' ')}`)
  const setup = engineSetup(engine)
  if (!setup.available) return notAvailable(engine, { available: false, reason: setup.reason, excused: setup.excused })
  const shared = await startTaskApp()
  t.after(() => shared.close())
  const runs = new Map<GroupName, GroupRun | MissingRun>()
  let stopped: string | undefined
  for (const group of groups) {
    if (stopped !== undefined) {
      runs.set(group.name, { group, problems: [stopped] })
      continue
    }
    const run = await runGroup(t, { engine, setup, group, shared, keep: options.keep })
    runs.set(group.name, run)
    if (group !== groups[0] || !('ended' in run)) continue
    const notStarted = startedNothing(run.ended)
    if (notStarted !== undefined) stopped = `Not run: the first run on ${engineNames[engine]} started no test. ${notStarted}`
  }
  const ended = [...runs.values()].flatMap((run) => ('ended' in run ? [run.ended] : []))
  const reports = conformanceCases.map((each) => caseReport(each, runs.get(each.group), engine))
  return {
    engine,
    availability: { available: true },
    ...(setup.notes.length === 0 ? {} : { notes: setup.notes }),
    browsers: browsersOf(ended),
    ...(ended[0]?.result === undefined ? {} : { retestVersion: ended[0].result.retestVersion }),
    groups: groups.map((group) => groupReport(group, runs.get(group.name))),
    cases: reports.map((report) => withPremises(report, reports, runs, engine)),
  }
}

/**
 * Judges a group's kept run again, as `runEngine` judges it after the run, with the task app's counts given by
 * `counterKey`: every case of the group and its run facts but those that ask a live app or server. For reading a kept
 * run folder again, and for showing what a changed record makes a case say.
 *
 * @example await judgeGroupRecord('workflow', ended, new Map([['sign-ups:Ada Lovelace', 1]]), 'chrome')
 */
export async function judgeGroupRecord(name: GroupName, ended: EndedRun, counts: ReadonlyMap<string, number>, engine: Engine): Promise<CaseReport[]> {
  const group = groups.find((each) => each.name === name)
  if (group === undefined) throw new Error(`No conformance group is named ${name}`)
  const run: GroupRun = { group, ended, baseUrl: '', problems: [], runFacts: new Map(), counts }
  for (const runCase of runCasesOf(name)) run.runFacts.set(runCase.id, await checkRunFact(runCase.fact, run))
  const reports = conformanceCases.filter((each) => each.group === name).map((each) => caseReport(each, run, engine))
  return reports.map((report) => withPremises(report, reports, new Map([[name, run]]), engine))
}

function notAvailable(engine: Engine, availability: Availability): EngineReport {
  return { engine, availability, browsers: [], groups: [], cases: [] }
}

type GroupRequest = { engine: Engine; setup: Extract<EngineSetup, { available: true }>; group: Group; shared: TaskApp; keep: string | undefined }

/** Starts what a group's run needs, runs it, interrupts it when the group says so, reads it and checks its run facts. */
async function runGroup(t: TestContext, request: GroupRequest): Promise<GroupRun | MissingRun> {
  const { group } = request
  try {
    const target = await groupTarget(t, request)
    const output = join(tempFolder('retest-conformance-run-'), 'run')
    const cwd = join(fixturesRoot, group.folder)
    const env = {
      ...request.setup.environment,
      [conformanceVariables.engine]: request.engine,
      [conformanceVariables.executable]: request.setup.executable ?? '',
      [conformanceVariables.baseUrl]: target.baseUrl,
      ...groupSecrets[group.name],
      ...(target.server === undefined ? {} : { [conformanceVariables.serverUrl]: target.server.url, [conformanceVariables.serverCommand]: target.server.command }),
      CI: group.ci === true ? 'true' : '',
    }
    const counters = countersOf(group.name)
    const before = await readCounts(target.app, counters)
    const run = await RunProcess.start({ command: groupCommand(group), args: groupArguments(group, output), cwd, env })
    t.after(() => run.endGroup())
    const problems: string[] = []
    if (group.interruption !== undefined) {
      try {
        await interrupt(run, group, target.app)
      } catch (error) {
        problems.push(`The run could not be interrupted as the group asks: ${messageOf(error)}`)
        await stopRun(run)
      }
    }
    if (!(await run.exitsWithin(runLimitMs))) {
      problems.push(`The run did not end within ${runLimitMs} ms, so its process group was ended.`)
      run.endGroup()
    }
    const ended = await endRun(run, output)
    if (group.host === undefined) rmSync(join(cwd, '.retest'), { recursive: true, force: true })
    if (!existsSync(output)) problems.push(`The run made no run folder. It exited with ${exitText(ended.exit)} and printed on stderr: ${JSON.stringify(ended.stderr.slice(0, 600))}`)
    problems.push(...printedProblems(group, ended))
    try {
      await assertNothingLeft(run, ended)
    } catch (error) {
      const unended = run.endLeftovers()
      problems.push(`The run left something behind: ${messageOf(error)}${unended.length === 0 ? '' : ` What could not be ended: ${unended.join(' ')}`}`)
    }
    if (request.keep !== undefined) keepRun(request.keep, request.engine, group.name, ended)
    const after = await readCounts(target.app, counters)
    const groupRun: GroupRun = {
      group,
      ended,
      baseUrl: target.baseUrl,
      problems,
      runFacts: new Map(),
      counts: new Map(counters.map((counter) => [counterKey(counter), (after.get(counterKey(counter)) ?? 0) - (before.get(counterKey(counter)) ?? 0)])),
      ...(target.app === undefined ? {} : { app: target.app }),
      ...(target.server === undefined ? {} : { server: target.server }),
    }
    for (const runCase of runCasesOf(group.name)) groupRun.runFacts.set(runCase.id, await checkRunFact(runCase.fact, groupRun))
    return groupRun
  } catch (error) {
    return { group, problems: [`The run could not be made: ${messageOf(error)}`] }
  }
}

type GroupTarget = { baseUrl: string; app?: TaskApp; server?: { url: string; port: number; command: string } }

/** The address a group's run is given: the shared task app, a task app of its own in a mode, or an app server's. */
async function groupTarget(t: TestContext, request: GroupRequest): Promise<GroupTarget> {
  const { group, shared } = request
  if (group.app === 'task-app') return { baseUrl: shared.url, app: shared }
  if (group.app === 'frozen-task-app' || group.app === 'delayed-task-app') {
    const app = await startTaskApp(group.app === 'frozen-task-app' ? { mode: 'frozen' } : { mode: 'delayed', delayMs: 60_000 })
    t.after(() => app.close())
    return { baseUrl: app.url, app }
  }
  const port = await freePort()
  const url = `http://127.0.0.1:${port}`
  const command = group.app === 'app-server' ? appServerCommand(port, { delayMs: 300, child: true }) : appServerCommand(port, { neverListen: true, child: true })
  return { baseUrl: shared.url, server: { url, port, command } }
}

function groupCommand(group: Group): readonly string[] {
  if (group.host === undefined) return sourceCommand
  return [process.execPath, '--conditions=retest-source', join(fixturesRoot, group.folder, group.host)]
}

function groupArguments(group: Group, output: string): string[] {
  if (group.host !== undefined) return [output]
  const timeouts = budgets({ ...runBudgets, ...group.budgets })
  return ['run', ...(group.files ?? []), '--reporter', 'jsonl', '--output', output, '--timeouts', timeouts, ...(group.args ?? [])]
}

/**
 * Waits for the moment the group names, then stops the run with SIGINT or ends the browser the run reported, through
 * the record the run process keeps of what the run launched: only a recorded process, still the one recorded.
 */
async function interrupt(run: RunProcess, group: Group, app: TaskApp | undefined): Promise<void> {
  const interruption = group.interruption
  if (interruption === undefined) return
  const browser = await within(run.waitForEvent('browser.started'), 'the run starting its browser')
  if (interruption.when === 'press-received') {
    if (app === undefined) throw new Error('the group has no task app to count the press')
    await waitUntil('the task app receiving the press', () => app.submissions() >= 1)
  } else {
    await within(
      run.waitForEvent('action.completed', (event) => event.command === 'click'),
      'the click completing',
    )
  }
  if (interruption.then === 'stop') {
    run.signal('SIGINT')
    return
  }
  const problems = run.endBrowser(browser.pid)
  if (problems.length > 0) throw new Error(`the browser the run reported was not ended: ${problems.join(' ')}`)
}

/** Stops a run whose interruption failed: SIGINT, and the whole group of the run process if it does not end. */
async function stopRun(run: RunProcess): Promise<void> {
  run.signal('SIGINT')
  if (!(await run.exitsWithin(interruptionWaitMs))) run.endGroup()
}

async function within<T>(promise: Promise<T>, what: string): Promise<T> {
  const timer = delay(interruptionWaitMs).then(() => {
    throw new Error(`${what} did not happen within ${interruptionWaitMs} ms`)
  })
  return Promise.race([promise, timer])
}

async function waitUntil(what: string, condition: () => boolean): Promise<void> {
  const end = performance.now() + interruptionWaitMs
  while (!condition()) {
    if (performance.now() > end) throw new Error(`${what} did not happen within ${interruptionWaitMs} ms`)
    await delay(10)
  }
}

/** The task app counts the cases of a group name, each once. */
function countersOf(group: GroupName): AppCounter[] {
  const named = conformanceCases.flatMap((each) => (each.kind === 'test' && each.group === group ? (each.facts ?? []) : [])).flatMap((fact) => (fact.kind === 'app-count' ? [fact.counter] : []))
  return [...new Map(named.map((counter) => [counterKey(counter), counter])).values()]
}

/** A counter as one key, such as `saves:Release checklist`. */
export function counterKey(counter: AppCounter): string {
  if (counter.of === 'saves') return `saves:${counter.title}`
  if (counter.of === 'sign-ups') return `sign-ups:${counter.name}`
  return 'searches'
}

/** The task app's counts, as it answers for them now: saves of a title and sign-ups under a name over HTTP. */
async function readCounts(app: TaskApp | undefined, counters: readonly AppCounter[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>()
  if (counters.length === 0) return counts
  if (app === undefined) throw new Error('a case counts what the task app received, and the group has no task app')
  for (const counter of counters) {
    if (counter.of === 'searches') counts.set(counterKey(counter), app.searches())
    else if (counter.of === 'saves') counts.set(counterKey(counter), await countAt(`${app.url}/api/submissions?title=${encodeURIComponent(counter.title)}`, 'count'))
    else counts.set(counterKey(counter), await countAt(`${app.url}/workflow/api/sign-ups?name=${encodeURIComponent(counter.name)}`, 'received'))
  }
  return counts
}

async function countAt(url: string, field: string): Promise<number> {
  const response = await fetch(url)
  const body: unknown = await response.json()
  const count = typeof body === 'object' && body !== null ? Reflect.get(body, field) : undefined
  if (typeof count !== 'number') throw new Error(`${url} did not answer a count`)
  return count
}

/**
 * What the run printed must be its record: stdout exactly the events of `events.jsonl`, and for a host program the
 * result it printed exactly `result.json`, with the run's exit code.
 */
function printedProblems(group: Group, ended: EndedRun): string[] {
  const problems: string[] = []
  try {
    assertStdoutIsEvents(ended)
    if (group.host !== undefined) {
      const printed = /^result (.+)$/m.exec(ended.stderr)?.[1]
      assert.ok(printed !== undefined, 'the host printed the result runFiles returned')
      assert.deepEqual(parseLine(runResultSchema, printed, 'the result runFiles returned'), ended.result, 'the result runFiles returned is result.json')
      assert.equal(ended.exit.code, ended.result?.exitCode, 'the host exits with the run exit code')
    }
  } catch (error) {
    problems.push(`What the run printed is not its record: ${messageOf(error)}`)
  }
  return problems
}

function keepRun(keep: string, engine: Engine, group: GroupName, ended: EndedRun): void {
  const folder = join(keep, engine, group)
  rmSync(folder, { recursive: true, force: true })
  mkdirSync(folder, { recursive: true })
  if (existsSync(ended.output)) cpSync(ended.output, join(folder, 'run'), { recursive: true })
  writeFileSync(join(folder, 'stdout.log'), ended.stdout)
  writeFileSync(join(folder, 'stderr.log'), ended.stderr)
}

/** Why a run started no test at all, when every test it holds failed before it started; undefined when one started. */
function startedNothing(ended: EndedRun): string | undefined {
  if (eventsOf(ended.events, 'test.started').length > 0) return undefined
  const tests = ended.result?.files.flatMap((file) => file.tests) ?? []
  const reason = ended.result?.failure?.message ?? tests.find((each) => each.failure !== undefined)?.failure?.message
  return reason ?? `It exited with ${JSON.stringify(ended.exit)} and wrote ${ended.result === undefined ? 'no result' : 'no test'}.`
}

function browsersOf(ended: readonly EndedRun[]): BrowserIdentity[] {
  const seen = new Map<string, BrowserIdentity>()
  for (const event of ended.flatMap((run) => eventsOf(run.events, 'browser.started'))) {
    const identity = { product: event.product, version: event.version, executablePath: event.executablePath }
    seen.set(JSON.stringify(identity), identity)
  }
  return [...seen.values()]
}

function groupReport(group: Group, run: GroupRun | MissingRun | undefined): GroupReport {
  if (run === undefined) return { group: group.name, declaredExit: group.exitCode, problems: ['The run was not made.'] }
  if (!('ended' in run)) return { group: group.name, declaredExit: group.exitCode, problems: run.problems }
  const problems = [...run.problems]
  const { exit } = run.ended
  if (exit.code !== group.exitCode || exit.signal !== null) problems.push(`The run exited with ${exitText(exit)}, declared ${group.exitCode}.`)
  return { group: group.name, declaredExit: group.exitCode, exit, durationMs: Math.round(run.ended.durationMs), problems }
}

/** An exit as a person reads it. */
export function exitText(exit: Exit): string {
  return exit.signal === null ? `exit code ${exit.code}` : `signal ${exit.signal}`
}

function runCasesOf(group: GroupName): RunCase[] {
  return conformanceCases.filter((each): each is RunCase => each.kind === 'run' && each.group === group)
}

function caseReport(each: ConformanceCase, run: GroupRun | MissingRun | undefined, engine: Engine): CaseReport {
  if (run === undefined || !('ended' in run)) {
    const problems = run?.problems ?? ['The run was not made.']
    return { id: each.id, given: 'not run', differences: [...problems] }
  }
  if (each.kind === 'run') {
    const differences = run.runFacts.get(each.id) ?? ['The fact was not checked.']
    return { id: each.id, given: differences.length === 0 ? 'holds' : 'does not hold', differences }
  }
  return testCaseReport(each, run, engine)
}

/**
 * A case whose meaning rests on others gains a difference for each that did not end as declared, or whose test did
 * not start before its own: a signed-out test after a signed-in one that never ran says nothing about isolation.
 */
function withPremises(report: CaseReport, reports: readonly CaseReport[], runs: ReadonlyMap<GroupName, GroupRun | MissingRun>, engine: Engine): CaseReport {
  const testCase = conformanceCases.find((each) => each.id === report.id)
  if (testCase === undefined || testCase.kind !== 'test' || testCase.requires === undefined) return report
  const run = runs.get(testCase.group)
  const differences = testCase.requires.flatMap((id): string[] => {
    const premise = reports.find((each) => each.id === id)
    const premiseCase = conformanceCases.find((each) => each.id === id)
    if (premise === undefined || premiseCase === undefined || premiseCase.kind !== 'test') return [`Its premise ${id} is not a test case.`]
    if (premise.differences.length > 0) return [`Its premise ${id} did not end as declared (${premise.given}), so this case shows nothing.`]
    if (run === undefined || !('ended' in run) || conformanceExpectation(conformanceDifferences, engine, premiseCase).outcome.status === 'not_run') return []
    const started = eventsOf(run.ended.events, 'test.started')
    const premiseAt = started.findIndex((event) => event.name === premiseCase.test && event.file === premiseCase.file)
    const ownAt = started.findIndex((event) => event.name === testCase.test && event.file === testCase.file)
    if (ownAt === -1) return []
    return premiseAt !== -1 && premiseAt < ownAt ? [] : [`Its premise ${id} did not start before it.`]
  })
  return differences.length === 0 ? report : { ...report, differences: [...report.differences, ...differences] }
}

function testCaseReport(testCase: TestCase, run: GroupRun, engine: Engine): CaseReport {
  // On an engine that declares a difference for the case, its declared outcome and facts take the place of the case's.
  const expected = conformanceExpectation(conformanceDifferences, engine, testCase)
  const declared = expected.declaration === undefined ? {} : { declared: true as const }
  const { result, events } = run.ended
  if (result === undefined) return { id: testCase.id, given: 'no result', differences: ['The run wrote no result.json.'], ...declared }
  const sameTest = (name: string, variantKey: string | undefined): boolean => name === testCase.test && (testCase.variant === undefined || variantKey === testCase.variant)
  const found = result.files.flatMap((file) => file.tests).filter((each) => sameTest(each.name, each.variantKey))
  if (found.length > 1) return { id: testCase.id, given: `${found.length} results`, differences: [`The run has ${found.length} results for this test.`], ...declared }
  const [only] = found
  if (only === undefined) {
    const started = eventsOf(events, 'test.started').some((event) => sameTest(event.name, event.variantKey))
    const actual: Actual = { status: 'absent' }
    const differences = [...compareOutcome(expected.outcome, actual), ...(started ? ['The test started, and the run has no result for it.'] : [])]
    return { id: testCase.id, given: describe(actual), differences, ...declared }
  }
  const attempt = events.filter((event) => 'attemptId' in event && event.attemptId === only.attemptId)
  const failing = failingEvent(only, attempt)
  const actual = actualOf(only, attempt, failing)
  const context: FactContext = { result: only, attempt, events, failing, counts: run.counts }
  const outcome = compareOutcome(expected.outcome, actual)
  // An engine that now ends the case as Chrome does still differs from its declaration, and is told to remove it.
  const stale = expected.declaration !== undefined && outcome.length > 0 && compareOutcome(testCase.outcome, actual).length === 0
  if (stale) outcome.push(`It ended as the case's own outcome, so the ${engineNames[engine]} declaration in engine-differences.ts no longer holds: remove it.`)
  // The failure's own words say why an outcome differs; they are the run's, redacted as every result is.
  const said = outcome.length > 0 && only.failure !== undefined ? [`Its failure says: ${JSON.stringify(only.failure.message.slice(0, 400))}`] : []
  const located = outcome.length === 0 ? failureDifferences(testCase, expected.outcome, { group: run.group, result: only, attempt, target: targetNames[engine] }) : []
  const exactMessage = expected.declaration === undefined ? [] : conformanceMessageProblems(expected.declaration, only.failure?.message ?? '', failing?.type === 'assertion.failed' ? failing.attempts : undefined)
  const differences = [...outcome, ...said, ...located, ...exactMessage, ...expected.facts.flatMap((fact) => checkFact(fact, context))]
  return { id: testCase.id, given: describe(actual), differences, ...declared }
}

type FailingEvent = Extract<RetestEvent, { type: 'action.failed' | 'assertion.failed' }>

/**
 * The action or assertion a failed test failed at: the one whose failure is the test's, or, when the test's failure is
 * the run's own, such as its interruption, the last one that failed in the attempt.
 */
function failingEvent(result: TestResult, attempt: readonly RetestEvent[]): FailingEvent | undefined {
  if (result.failure === undefined) return undefined
  const failed = attempt.filter((event): event is FailingEvent => event.type === 'action.failed' || event.type === 'assertion.failed')
  return failed.find((event) => event.failure.message === result.failure?.message) ?? failed.at(-1)
}

function actualOf(result: TestResult, attempt: readonly RetestEvent[], failing: FailingEvent | undefined): Actual {
  const { status, failure } = result
  if (failure === undefined) return { status }
  if (status === 'not_run') return { status, class: failure.class }
  const operation = failing === undefined ? 'test' : failing.type === 'action.failed' ? failing.command : failing.matcher
  const step = failing?.stepId === undefined ? undefined : eventsOf(attempt, 'step.started').find((event) => event.stepId === failing.stepId)?.name
  return step === undefined ? { status, class: failure.class, operation } : { status, class: failure.class, operation, step }
}

/** How the actual end differs from the declared outcome, in words, or nothing when it is the same. */
function compareOutcome(declared: Declared, actual: Actual): string[] {
  if (declared.status !== actual.status) return [`It ended ${describe(actual)}, declared ${describe(declared)}.`]
  if (declared.status === 'not_run' && declared.class !== actual.class) return [`It ended ${describe(actual)}, declared ${describe(declared)}.`]
  if (declared.status !== 'failed' && declared.status !== 'error') return []
  const differs = declared.class !== actual.class || declared.operation !== actual.operation || (declared.step !== undefined && declared.step !== actual.step)
  return differs ? [`It ended ${describe(actual)}, declared ${describe(declared)}.`] : []
}

/**
 * How a failure that ended as declared differs from where and how the case says it fails: the step it names must have
 * finished failed, the failure must be located at the declared line of the case's own file, and its message must say
 * what the case says, as docs/compatibility/workflow-cases.md fixes a failing case.
 */
function failureDifferences(testCase: TestCase, declared: Declared, record: { group: Group; result: TestResult; attempt: readonly RetestEvent[]; target: string }): string[] {
  const { group, result, attempt, target } = record
  if (declared.status !== 'failed' && declared.status !== 'error' && declared.status !== 'not_run') return []
  const problems: string[] = []
  if (declared.status !== 'not_run' && declared.step !== undefined) {
    const started = eventsOf(attempt, 'step.started').find((event) => event.name === declared.step)
    const finished = started === undefined ? undefined : eventsOf(attempt, 'step.finished').find((event) => event.stepId === started.stepId)
    if (finished?.status !== 'failed') problems.push(`Its step "${declared.step}" finished ${finished?.status ?? 'never'}, declared failed.`)
  }
  if (declared.at !== undefined) {
    const anchor = declared.status === 'not_run' || declared.step === undefined ? declared.at : { after: `test.step('${declared.step}'`, ...declared.at }
    const line = lineOf(join(fixturesRoot, group.folder, testCase.file), testCase.test, anchor)
    const location = result.failure?.location
    if (line === undefined) problems.push(`The case's file has no line holding ${JSON.stringify(declared.at.holding)} where the case says.`)
    else if (location?.file !== testCase.file || location.line !== line) problems.push(`Its failure is located at ${location === undefined ? 'nothing' : `${location.file}:${location.line}`}, declared ${testCase.file}:${line}.`)
  }
  if (declared.message !== undefined) {
    const pattern = messagePattern(declared.message, target)
    const message = result.failure?.message ?? ''
    if (!pattern.test(message)) problems.push(`Its message does not match ${String(pattern)}: ${JSON.stringify(message.slice(0, 400))}`)
  }
  return problems
}

function messagePattern(message: Message, target: string): RegExp {
  return message instanceof RegExp ? message : message(target)
}

const sources = new Map<string, readonly string[]>()

/**
 * The line an anchor names in a case's file: the first line after the line holding `after`, or else after the line
 * that declares the test, that holds `holding`. Undefined when the file has no such line.
 *
 * @example lineOf('/…/f04-create.retest.ts', 'a save that drops…', { after: "test.step('the new task…'", holding: "toHaveText('Release checklist')" })
 */
export function lineOf(file: string, test: string, anchor: Anchor): number | undefined {
  const lines = sources.get(file) ?? readFileSync(file, 'utf8').split('\n')
  sources.set(file, lines)
  const declaredAt = firstIndex(lines, `'${test}'`, 0)
  if (declaredAt === undefined) return undefined
  // A step is looked for after the test's own line, so its name is the test's step; a hook or a setup declared before
  // the test is looked for from the top.
  const start = anchor.after === undefined ? declaredAt : (firstIndex(lines, anchor.after, declaredAt) ?? firstIndex(lines, anchor.after, 0))
  if (start === undefined) return undefined
  const index = firstIndex(lines, anchor.holding, start + 1)
  return index === undefined ? undefined : index + 1
}

function firstIndex(lines: readonly string[], holding: string, from: number): number | undefined {
  const index = lines.findIndex((line, at) => at >= from && line.includes(holding))
  return index === -1 ? undefined : index
}

/**
 * A declared or actual end in words, such as `failed check_failed at toHaveText in step "the reports arrive"`.
 *
 * @example describe({ status: 'not_run', class: 'setup_failed' }) // 'not run, setup_failed'
 */
export function describe(outcome: Actual): string {
  if (outcome.status === 'absent') return 'left out'
  if (outcome.status === 'not_run') return `not run, ${outcome.class ?? 'no failure'}`
  if (outcome.status !== 'failed' && outcome.status !== 'error') return outcome.status
  const step = outcome.step === undefined ? '' : ` in step "${outcome.step}"`
  return `${outcome.status} ${outcome.class ?? 'with no failure'} at ${outcome.operation ?? 'nothing'}${step}`
}

type FactContext = {
  result: TestResult
  attempt: readonly RetestEvent[]
  events: readonly RetestEvent[]
  failing: FailingEvent | undefined
  counts: ReadonlyMap<string, number>
}

/**
 * The late bound of a deadline: how long past its time an operation may give up. A look in flight at the deadline is
 * bounded by the time left, so what remains is reporting it.
 *
 * @example lateBoundMs(1500) // 375
 */
export function lateBoundMs(ms: number): number {
  return Math.max(250, ms / 4)
}

/** How the attempt's record differs from a fact, in words, or nothing when it holds. */
function checkFact(fact: Fact, context: FactContext): string[] {
  const { attempt, failing } = context
  switch (fact.kind) {
    case 'deadline':
      return deadlineProblems(fact, context)
    case 'at-once':
      if (failing === undefined) return ['No operation failed.']
      return failing.durationMs < fact.withinMs ? [] : [`It failed after ${Math.round(failing.durationMs)} ms, declared at once, within ${fact.withinMs} ms.`]
    case 'detail': {
      const value = failing?.failure.details?.[fact.key] ?? context.result.failure?.details?.[fact.key]
      return isDeepStrictEqual(value, fact.value) ? [] : [`Its failure's ${fact.key} is ${JSON.stringify(value)}, declared ${JSON.stringify(fact.value)}.`]
    }
    case 'polled': {
      const looks = eventsOf(attempt, 'assertion.passed').filter((event) => event.matcher === fact.matcher)
      return looks.some((event) => event.attempts > 1) ? [] : [`No passing ${fact.matcher} looked more than once: ${JSON.stringify(looks.map((event) => event.attempts))}.`]
    }
    case 'commands': {
      const completed = eventsOf(attempt, 'action.completed').map((event) => (fact.sessions === true ? `${event.session ?? ''}:${event.command}` : event.command))
      return isDeepStrictEqual(completed, fact.commands) ? [] : [`It completed ${JSON.stringify(completed)}, declared ${JSON.stringify(fact.commands)}.`]
    }
    case 'navigations': {
      const seen = eventsOf(attempt, 'navigation').map((event) => [new URL(event.url).pathname, event.cause, event.document])
      return isDeepStrictEqual(seen, fact.navigations) ? [] : [`It navigated ${JSON.stringify(seen)}, declared ${JSON.stringify(fact.navigations)}.`]
    }
    case 'paths': {
      const seen = eventsOf(attempt, 'navigation').map((event) => new URL(event.url).pathname)
      return isDeepStrictEqual(seen, fact.paths) ? [] : [`It opened ${JSON.stringify(seen)}, declared ${JSON.stringify(fact.paths)}.`]
    }
    case 'opened-by-actions': {
      const opened = eventsOf(attempt, 'navigation').filter((event) => event.cause === 'action' && event.document === 'new').length
      return opened === fact.count ? [] : [`Its own actions opened ${opened} pages, declared ${fact.count}.`]
    }
    case 'observed': {
      const looks = eventsOf(attempt, 'assertion.passed').filter((event) => event.locator?.by === 'testId' && event.locator.value === fact.testId)
      return looks.some((event) => event.actual?.text === fact.text) ? [] : [`The parent read ${JSON.stringify(looks.map((event) => event.actual?.text))} at ${fact.testId}, declared "${fact.text}".`]
    }
    case 'afterwards': {
      if (failing === undefined) return ['No operation failed, so nothing was read after a failure.']
      const reads = eventsOf(attempt, 'assertion.passed')
        .filter((event) => event.sequence > failing.sequence)
        .map((event) => [event.locator?.by === 'testId' ? event.locator.value : JSON.stringify(event.locator), event.actual?.text ?? null])
      return isDeepStrictEqual(reads, fact.reads) ? [] : [`After it failed, the parent read ${JSON.stringify(reads)}, declared ${JSON.stringify(fact.reads)}.`]
    }
    case 'secret-fill':
      return eventsOf(attempt, 'action.completed').some((event) => event.command === 'fill' && event.secret === fact.secret) ? [] : [`No fill was recorded by the secret's name, ${fact.secret}.`]
    case 'fills': {
      const fills = eventsOf(attempt, 'action.completed')
        .filter((event) => event.command === 'fill')
        .map((event) => event.secret ?? null)
      return isDeepStrictEqual(fills, fact.secrets) ? [] : [`Its fills typed ${JSON.stringify(fills)}, declared ${JSON.stringify(fact.secrets)}.`]
    }
    case 'choices': {
      const choices = eventsOf(attempt, 'action.completed')
        .filter((event) => event.command === 'select' || event.command === 'check' || event.command === 'uncheck')
        .map((event) => [event.command, event.changed ?? null, event.input ?? null])
      return isDeepStrictEqual(choices, fact.choices) ? [] : [`Its choices were ${JSON.stringify(choices)}, declared ${JSON.stringify(fact.choices)}.`]
    }
    case 'not-completed':
      return eventsOf(attempt, 'action.completed').some((event) => event.command === fact.command) ? [`A ${fact.command} completed.`] : []
    case 'sent-nothing': {
      const sent = context.events.filter((event) => event.type.startsWith('action.') && 'testId' in event && event.testId === context.result.testId)
      return sent.length === 0 ? [] : [`It sent ${sent.length} actions to a page.`]
    }
    case 'own-sessions':
      try {
        assertLooksStayWithTheirSession({ events: [...attempt] }, context.result.attemptId, fact.accounts)
        return []
      } catch (error) {
        return [messageOf(error)]
      }
    case 'steps': {
      const finished = eventsOf(attempt, 'step.finished')
      const steps = eventsOf(attempt, 'step.started').map((event) => [event.name, finished.find((end) => end.stepId === event.stepId)?.status ?? 'unfinished'])
      return isDeepStrictEqual(steps, fact.steps) ? [] : [`Its steps went ${JSON.stringify(steps)}, declared ${JSON.stringify(fact.steps)}.`]
    }
    case 'saved': {
      const saved = eventsOf(attempt, 'state.saved').map((event) => event.state)
      return isDeepStrictEqual(saved, [fact.state]) ? [] : [`It saved ${JSON.stringify(saved)}, declared ${JSON.stringify([fact.state])}.`]
    }
    case 'restored': {
      const restored = eventsOf(attempt, 'state.restored').map((event) => event.state)
      const declared = fact.state === null ? [] : [fact.state]
      return isDeepStrictEqual(restored, declared) ? [] : [`It started from ${JSON.stringify(restored)}, declared ${JSON.stringify(declared)}.`]
    }
    case 'app-count': {
      const count = context.counts.get(counterKey(fact.counter))
      return count === fact.count ? [] : [`The task app's ${counterKey(fact.counter)} changed by ${count ?? 'nothing read'} during the run, declared ${fact.count}.`]
    }
  }
}

// A failed operation, or the test's own budget, waited its time in full, never less, gave up within the late bound,
// recorded the time it was given, and, for a check, looked again.
function deadlineProblems(fact: Extract<Fact, { kind: 'deadline' }>, context: FactContext): string[] {
  const { failing, result } = context
  const lateMs = fact.lateMs ?? lateBoundMs(fact.ms)
  const timed = failing === undefined ? { durationMs: result.durationMs, timeoutMs: result.failure?.details?.['timeoutMs'] } : { durationMs: failing.durationMs, timeoutMs: failing.timeoutMs }
  if (result.failure === undefined) return [`Nothing failed, so nothing waited ${fact.ms} ms.`]
  const problems: string[] = []
  if (timed.durationMs < fact.ms) problems.push(`It gave up after ${timed.durationMs} ms, before its ${fact.ms} ms had passed.`)
  if (timed.durationMs > fact.ms + lateMs) problems.push(`It gave up after ${Math.round(timed.durationMs)} ms, more than ${lateMs} ms past its ${fact.ms} ms.`)
  if (timed.timeoutMs !== undefined && timed.timeoutMs !== fact.ms) problems.push(`It recorded a time of ${JSON.stringify(timed.timeoutMs)} ms, declared ${fact.ms} ms.`)
  if (failing?.type === 'assertion.failed' && failing.attempts < (fact.looks ?? 2)) problems.push(`It looked ${failing.attempts} times, declared at least ${fact.looks ?? 2}.`)
  return problems
}

/** How a whole run differs from a run fact, in words, or nothing when it holds. */
async function checkRunFact(fact: RunFact, run: GroupRun): Promise<string[]> {
  const { events, result, output, stdout, stderr } = run.ended
  switch (fact.kind) {
    case 'browsers': {
      const started = eventsOf(events, 'browser.started').length
      return started === fact.count ? [] : [`The run started ${started} browsers, declared ${fact.count}.`]
    }
    case 'discovered': {
      const found = (result?.files.map((file) => file.file) ?? []).toSorted()
      const named = [...new Set(conformanceCases.flatMap((each) => (each.kind === 'test' && each.group === run.group.name ? [each.file] : [])))].toSorted()
      return isDeepStrictEqual(found, named) ? [] : [`Discovery found ${JSON.stringify(found)}, declared ${JSON.stringify(named)}.`]
    }
    case 'server-stopped': {
      const problems: string[] = []
      if (eventsOf(events, 'app.started').length !== 1) problems.push(`The run reported ${eventsOf(events, 'app.started').length} app servers started, declared 1.`)
      if (run.server !== undefined && (await answersAt(run.server.url))) problems.push(`Something still answers at ${run.server.url} after the run.`)
      return problems
    }
    case 'server-failed': {
      const failed = eventsOf(events, 'app.failed')
      const problems = failed.length === 1 && failed[0]?.failure.class === 'setup_failed' ? [] : [`The run reported ${JSON.stringify(failed.map((event) => event.failure.class))} for its server, declared one setup_failed.`]
      if (run.server !== undefined) {
        const left = await appServersOn(run.server.port)
        if (left.length > 0) problems.push(`The server is still running: ${left.join('; ')}`)
      }
      return problems
    }
    case 'narrowed': {
      const narrowed = result?.narrowed
      return narrowed?.kept === fact.kept && narrowed.collected === fact.collected ? [] : [`The run was narrowed to ${JSON.stringify(narrowed)}, declared ${fact.kept} of ${fact.collected}.`]
    }
    case 'run-failure': {
      const problems = result?.failure?.class === fact.class ? [] : [`The run's failure is ${JSON.stringify(result?.failure)}, declared ${fact.class}.`]
      if (eventsOf(events, 'test.started').length > 0) problems.push('A test started.')
      return problems
    }
    case 'secret-absent': {
      const value = heldValues[fact.value]
      const files = filesHolding(output, value)
      const problems = files.length === 0 ? [] : [`The value is in ${files.join(', ')}.`]
      if (textHolds(stdout, value) || textHolds(stderr, value)) problems.push('The value is in what the run printed.')
      const premise = fact.premise
      if ('filled' in premise && !eventsOf(events, 'action.completed').some((event) => event.command === 'fill' && event.secret === premise.filled)) {
        problems.push(`No fill of the secret ${premise.filled} completed in the run, so its absence shows nothing.`)
      }
      if ('saved' in premise && !eventsOf(events, 'state.saved').some((event) => event.state === premise.saved)) {
        problems.push(`The run saved no state ${premise.saved}, so the absence of its cookie shows nothing.`)
      }
      return problems
    }
    case 'lock-waited':
      return eventsOf(events, 'lock.acquired').some((event) => event.waitedMs > 0) ? [] : ['No test waited for a lock.']
    case 'sessions-waited':
      return eventsOf(events, 'session.reserved').some((event) => event.waitedMs > 0) ? [] : ['No attempt waited for a session.']
    case 'app-saves': {
      const saves = run.app?.submissions()
      return saves === fact.count ? [] : [`The task app received ${saves} saves, declared ${fact.count}.`]
    }
    case 'states': {
      const problems: string[] = []
      const saved = eventsOf(events, 'state.saved').map((event) => event.state)
      if (!isDeepStrictEqual(saved, fact.saved)) problems.push(`The run saved ${JSON.stringify(saved)}, declared ${JSON.stringify(fact.saved)}.`)
      const tests = result?.files.flatMap((file) => file.tests) ?? []
      const restoredFor = eventsOf(events, 'state.restored').map((event) => tests.find((each) => each.testId === event.testId)?.name ?? event.testId)
      const declared = fact.restoredFor.map((id) => {
        const named = conformanceCases.find((each) => each.id === id)
        return named?.kind === 'test' ? named.test : id
      })
      if (!isDeepStrictEqual(restoredFor, declared)) problems.push(`The run restored a state for ${JSON.stringify(restoredFor)}, declared ${JSON.stringify(declared)}.`)
      return problems
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
