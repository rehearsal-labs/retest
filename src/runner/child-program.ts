import type { Failure } from '../protocol/failures.ts'
import type { ChildMessage, ParentMessage } from '../protocol/messages.ts'
import { resolve } from 'node:path'
import { inspect } from 'node:util'
import { currentScope } from '../api/context.ts'
import { failureFrom, fromEarlierTest } from '../api/failure.ts'
import { collectFile, findTest, reportCollectionProblem, sourceRoot } from '../api/registry.ts'
import { TestRun } from '../api/test-run.ts'
import { explainLoadFailure, loadedModules, useProject, withSentence } from '../loader/project.ts'
import { playwrightArgument } from '../loader/resolve.ts'
import { failure } from '../protocol/failures.ts'
import { parentMessageSchema } from '../protocol/messages.ts'
import { parse } from '../protocol/schema.ts'
import { resolveOwnPackage } from './own-package.ts'

// The process a test file runs in. It has no browser: page commands go to the parent, one message at a time.

type RunMessage = Extract<ParentMessage, { type: 'run' }>

let current: TestRun | undefined
let lastCommandId = 0
// Set once an error outside any test is on its way to the parent; the process then ends with that error.
let endingAfterError = false

if (process.send === undefined) {
  process.stderr.write('This is the process Retest runs a test file in. Start tests with retest run.\n')
  process.exit(2)
}

// Before any test file loads, so each one imports the copy of Retest that runs it, wherever the file is.
const packageName = resolveOwnPackage()
// The parent says when the run is of Playwright test files; their imports then resolve to this copy's own subpath.
const playwright = process.argv.includes(playwrightArgument) ? { playwright: `${packageName}/playwright` } : {}

process.on('message', (raw: unknown) => {
  const parsed = parse(parentMessageSchema, raw)
  if (parsed.ok) return receive(parsed.value)
  const issues = parsed.issues.map((issue) => `${issue.path} ${issue.message}`).join('; ')
  endAfterError(new Error(`Retest received a message it could not read: ${issues}`))
})
process.on('disconnect', () => process.exit(1))
process.on('uncaughtException', report)
process.on('unhandledRejection', report)

function receive(message: ParentMessage): void {
  switch (message.type) {
    case 'collect':
      return void collect(message.file, message.rootDir)
    case 'run':
      return void run(message)
    case 'command-result':
      return current?.resolveCommand(message.id, message.result)
    case 'evaluation-result':
      return current?.resolveEvaluation(message.id, message.answer)
    case 'abort':
      return current?.abort()
    case 'close':
      return closeAfterQueuedWork()
  }
}

// Work the file queued before the request arrived, such as an error thrown on the turn after its tests were
// collected, runs first: immediates run in the order they were queued. An error it throws ends the process instead.
function closeAfterQueuedWork(): void {
  setImmediate(() => {
    if (!endingAfterError) exitWhenFlushed(0)
  })
}

// The project's hooks go on before the file loads: the root directory, where its tsconfig is looked for, comes with
// the request.
async function collect(file: string, rootDir: string): Promise<void> {
  const project = useProject({ folder: rootDir, entry: resolve(rootDir, file), ...playwright })
  if (!project.ok) return send({ type: 'collection-failed', failure: project.failure })
  const collected = await collectFile(file, rootDir)
  send(collected.ok ? { type: 'collected', tests: collected.tests, modules: loadedPaths() } : { type: 'collection-failed', failure: explained(collected.failure) })
}

// A failure to load with no location of its own, such as a compile error, gains what the project's code says about it.
function explained(problem: Failure): Failure {
  if (problem.location !== undefined) return problem
  const explanation = explainLoadFailure(problem.message)
  return explanation === undefined ? problem : { ...problem, message: withSentence(problem.message, explanation) }
}

async function run({ testId, attemptId, timeouts, apps }: RunMessage): Promise<void> {
  const found = findTest(testId)
  if (found === undefined) {
    const unknown = failure('test_error', `This file has no test with the id ${JSON.stringify(testId)}.`)
    return send({ type: 'test-finished', testId, attemptId, status: 'failed', failure: unknown, assertionCount: 0, durationMs: 0 })
  }
  const testRun = new TestRun({
    testId,
    attemptId,
    name: found.test.name,
    file: found.file,
    rootDir: found.rootDir,
    location: found.test.location,
    timeouts,
    apps,
    send,
    nextCommandId: () => ++lastCommandId,
  })
  current = testRun
  const verdict = await testRun.execute(found.test)
  if (current === testRun) current = undefined
  // A module the test imported while it ran belongs to the bundle it ran, so the list goes with the verdict.
  send({ type: 'test-finished', testId, attemptId, ...verdict, modules: loadedPaths() })
}

// The parent hashes each module from disk itself, so the process names them and nothing more.
function loadedPaths(): string[] {
  return loadedModules().map((module) => module.path)
}

// Rejections and exceptions nobody handled belong to the running test, or to the file while it loads.
// The async context names the test whose code threw, which may be an earlier one.
function report(error: unknown): void {
  const origin = currentScope()?.run
  if (current !== undefined) return current.recordThrown(error, origin)
  const problem = failureFrom(error, sourceRoot() ?? process.cwd())
  const whileLoading: Failure = { ...problem, class: 'collection_failed', message: `While the file loaded: ${problem.message}` }
  if (reportCollectionProblem(whileLoading)) return
  endAfterError(error, origin === undefined ? problem : fromEarlierTest(problem, origin.name))
}

// No test can take the error any more, so the parent is told before the process ends.
function endAfterError(error: unknown, problem = failureFrom(error, sourceRoot() ?? process.cwd())): void {
  endingAfterError = true
  process.stderr.write(`${inspect(error)}\n`)
  send({ type: 'process-error', failure: problem }, () => exitWhenFlushed(1))
}

// `sent` runs once the message has been handed to the parent, or at once when there is no parent to take it.
function send(message: ChildMessage, sent?: () => void): void {
  if (!process.connected || process.send === undefined) return sent?.()
  if (sent === undefined) process.send(message)
  else process.send(message, undefined, undefined, sent)
}

// Output written just before exit would be lost on a pipe that is not flushed yet.
function exitWhenFlushed(code: number): void {
  process.stdout.write('', () => process.stderr.write('', () => process.exit(code)))
}
