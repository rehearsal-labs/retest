import type { CommandResult, PageCommand } from '../../src/protocol/commands.ts'
import type { ChildEvent, EventBody } from '../../src/protocol/events.ts'
import type { ParentMessage } from '../../src/protocol/messages.ts'
import type { Timeouts } from '../../src/protocol/timeouts.ts'
import type { Redactor } from '../../src/runner/redactor.ts'
import type { BodyReport, RunningTestOptions, TestProcess } from '../../src/runner/running-test.ts'
import type { ProcessEvent } from '../../src/runner/test-file-process.ts'
import type { ProcessExit } from '../../src/shared/process-exit.ts'
import type { FakeOptions, FakePage } from './fake-browser.ts'
import { childMessageSchema } from '../../src/protocol/messages.ts'
import { parse } from '../../src/protocol/schema.ts'
import { RunningTest } from '../../src/runner/running-test.ts'
import { FakeBrowser } from './fake-browser.ts'
import { quickTimeouts } from './run-harness.ts'

/**
 * A test file's process that a unit test speaks for. It keeps every message the parent sends, and delivers the
 * messages the test writes after checking them against the protocol, as the real process does.
 */
export class ScriptedProcess implements TestProcess {
  readonly sent: ParentMessage[] = []
  exit: ProcessExit | undefined
  killed = false
  readonly #closed = Promise.withResolvers<ProcessExit>()
  readonly #answers = new Map<number, PromiseWithResolvers<CommandResult>>()
  readonly #onSend: (message: ParentMessage) => void
  #listener: ((event: ProcessEvent) => void) | undefined

  constructor(onSend: (message: ParentMessage) => void = () => undefined) {
    this.#onSend = onSend
  }

  get closed(): Promise<ProcessExit> {
    return this.#closed.promise
  }

  /** The ownership carried by commands from the currently running test. */
  get scope(): { testId: string; attemptId: string } {
    const run = this.sent.findLast((message) => message.type === 'run')
    if (run === undefined) throw new Error('No test was asked to run.')
    return { testId: run.testId, attemptId: run.attemptId }
  }

  listen(listener: ((event: ProcessEvent) => void) | undefined): void {
    this.#listener = listener
  }

  send(message: ParentMessage): void {
    if (this.exit !== undefined) return
    this.sent.push(message)
    this.#onSend(message)
    if (message.type === 'command-result') this.#answer(message.id).resolve(message.result)
  }

  kill(): Promise<ProcessExit> {
    if (this.exit === undefined) {
      this.killed = true
      this.exit = { code: null, signal: 'SIGKILL' }
      this.#listener?.({ kind: 'exit', exit: this.exit })
      this.#closed.resolve(this.exit)
    }
    return this.closed
  }

  /** Sends a message as the test file's process would. One the protocol refuses arrives as the real process reports it. */
  deliver(message: unknown): void {
    const parsed = parse(childMessageSchema, message)
    if (!parsed.ok) return this.#listener?.({ kind: 'invalid', problem: parsed.issues.map((issue) => `${issue.path} ${issue.message}`).join('; ') })
    if (parsed.value.type !== 'process-error') this.#listener?.({ kind: 'message', message: parsed.value })
  }

  /** The answer the parent gives command `id`, once it gives one. */
  answer(id: number): Promise<CommandResult> {
    return this.#answer(id).promise
  }

  #answer(id: number): PromiseWithResolvers<CommandResult> {
    const known = this.#answers.get(id)
    if (known !== undefined) return known
    const created = Promise.withResolvers<CommandResult>()
    this.#answers.set(id, created)
    return created
  }
}

export type ScriptedTestOptions = {
  fake?: FakeOptions
  redactor?: Redactor
  attemptId?: string
  timeouts?: Partial<Timeouts>
  /** The page emulates a touch screen, as a phone's does. */
  touch?: boolean
  fillSecret?: RunningTestOptions['fillSecret']
}

// A phone's screen, as far as the fake page cares: it taps where it is asked to click.
const touchScreen = { viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.625, touch: true, isMobile: true }

/** One test body run against a fake page, with the test process played by the unit test. */
export type ScriptedTest = {
  process: ScriptedProcess
  page: FakePage
  running: RunningTest
  /** Everything the parent emitted, with the origin it gave each. */
  events: { body: EventBody; origin: 'parent' | 'child' }[]
  /** Event types and parent messages, in the order they happened. */
  timeline: string[]
  report: Promise<BodyReport>
  testId: string
  attemptId: string
  /** Sends a page command for the page's app, and waits for its answer. */
  command(id: number, command: PageCommand): Promise<CommandResult>
  /** Sends an event as the test process reports one. */
  event(event: ChildEvent): void
  /** Reports the test finished and passed, and waits for the parent's report. */
  finish(): Promise<BodyReport>
}

/** The app of every scripted test, as milestone 1's single page. */
export const scriptedApp = 'page'

/** Starts a test body whose process the unit test plays, on one fake page. */
export async function scriptedTest(options: ScriptedTestOptions = {}): Promise<ScriptedTest> {
  const timeline: string[] = []
  const process = new ScriptedProcess((message) => timeline.push(message.type))
  const browser = new FakeBrowser(options.fake ?? {}, { executablePath: '/fake/chromium', logFile: '/dev/null', headless: true })
  const page = await browser.newPage({ baseUrl: 'http://127.0.0.1:4173', ...(options.touch === true ? { emulation: touchScreen } : {}) }, 1000)
  const events: ScriptedTest['events'] = []
  const testId = 'tests/a.retest.ts > runs'
  const attemptId = options.attemptId ?? 'attempt1'
  const running = new RunningTest({
    process,
    pages: new Map([[scriptedApp, page]]),
    testId,
    attemptId,
    timeouts: { ...quickTimeouts, ...options.timeouts },
    emit: (body, origin = 'parent') => {
      events.push({ body, origin })
      timeline.push(body.type)
    },
    ...(options.redactor === undefined ? {} : { redactor: options.redactor }),
    ...(options.touch === true ? { touch: new Set([scriptedApp]) } : {}),
    ...(options.fillSecret === undefined ? {} : { fillSecret: options.fillSecret }),
  })
  const report = running.run()
  return {
    process,
    page,
    running,
    events,
    timeline,
    report,
    testId,
    attemptId,
    command: (id, command) => {
      process.deliver({ type: 'command', testId, attemptId, id, app: scriptedApp, command, timeoutMs: 500 })
      return process.answer(id)
    },
    event: (event) => process.deliver({ type: 'event', event }),
    finish: async () => {
      process.deliver({ type: 'test-finished', testId, attemptId, status: 'passed', assertionCount: 0, durationMs: 0 })
      const finished = await report
      await running.settle(0)
      running.close()
      return finished
    },
  }
}
