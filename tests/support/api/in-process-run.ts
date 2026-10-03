import type { AppPage } from '../../../src/api/app-page.ts'
import type { RunTime } from '../../../src/api/run-time.ts'
import type { Hook, RunnableTest, RuntimeBody, RuntimeContext } from '../../../src/api/test-body.ts'
import type { Verdict } from '../../../src/api/test-run.ts'
import type { CommandResult, PageCommand } from '../../../src/protocol/commands.ts'
import type { ChildEvent } from '../../../src/protocol/events.ts'
import type { ChildMessage } from '../../../src/protocol/messages.ts'
import type { Timeouts } from '../../../src/protocol/timeouts.ts'
import { TestRun } from '../../../src/api/test-run.ts'
import { childMessageSchema, singleAppName } from '../../../src/protocol/messages.ts'
import { parse } from '../../../src/protocol/schema.ts'
import { observationOf } from '../observation.ts'
import { quickTimeouts, rootDir } from '../run-harness.ts'

/** Answers a page command sent to an app, or returns undefined to leave it unanswered. */
export type Responder = (command: PageCommand, app: string) => CommandResult | Promise<CommandResult> | undefined

export type SentCommand = { app: string; command: PageCommand }

export type InProcessOptions = {
  /** The apps the parent opened, as its `run` message lists them. Milestone 1's single app by default. */
  apps?: readonly string[]
  timeouts?: Partial<Timeouts>
  /** Where the test's file lives, when it is not in this repository. */
  rootDir?: string
  /** The clock and waits of the run, the host's by default. */
  time?: RunTime
}

export type TestParts = { body: RuntimeBody; apps?: readonly string[]; beforeEach?: readonly Hook[]; afterEach?: readonly Hook[] }

export type InProcessRun = {
  run: TestRun
  messages: ChildMessage[]
  commands: PageCommand[]
  sent: SentCommand[]
  events: () => ChildEvent[]
  /** Runs a test that declares no apps; its function receives the page. */
  runPage: (body: (context: { page: AppPage }) => unknown) => Promise<Verdict>
  /** Runs a test with the apps it declared and its hooks, as the child runs a collected test. */
  runTest: (parts: TestParts) => Promise<Verdict>
}

/**
 * A test run in this process, as the child would hold it. Every message it sends is validated as the parent
 * would, and commands are answered after a turn of the event loop, as over IPC.
 */
export function inProcessRun(file: string, respond: Responder, options: InProcessOptions = {}): InProcessRun {
  const messages: ChildMessage[] = []
  const sent: SentCommand[] = []
  const commands: PageCommand[] = []
  let lastCommandId = 0
  const run: TestRun = new TestRun({
    testId: `${file} > in process`,
    attemptId: 'attempt-1',
    name: 'in process',
    file,
    rootDir: options.rootDir ?? rootDir,
    location: { file, line: 1, column: 1 },
    timeouts: { ...quickTimeouts, ...options.timeouts },
    apps: options.apps ?? [singleAppName],
    nextCommandId: () => ++lastCommandId,
    ...(options.time === undefined ? {} : { time: options.time }),
    send: (message) => {
      const parsed = parse(childMessageSchema, message)
      if (!parsed.ok) throw new Error(`The run sent an invalid message: ${JSON.stringify(parsed.issues)}`)
      messages.push(message)
      if (message.type !== 'command') return
      sent.push({ app: message.app, command: message.command })
      commands.push(message.command)
      setImmediate(async () => {
        const result = await respond(message.command, message.app)
        if (result !== undefined) run.resolveCommand(message.id, result)
      })
    },
  })
  const runTest = ({ body, apps, beforeEach = [], afterEach = [] }: TestParts): Promise<Verdict> => {
    const test: RunnableTest = { body, hooks: { beforeEach, afterEach }, ...(apps === undefined ? {} : { apps }) }
    return run.execute(test)
  }
  return {
    run,
    messages,
    sent,
    commands,
    events: () => messages.flatMap((message) => (message.type === 'event' ? [message.event] : [])),
    runPage: (body) => runTest({ body: (context) => body({ page: appOf(context, 'page') }) }),
    runTest,
  }
}

/** The page a test's context holds for `name`, failing loudly when it has none. */
export function appOf(context: RuntimeContext, name: string): AppPage {
  const page = context[name]
  if (page === undefined) throw new Error(`The context has no ${name}.`)
  return page
}

/** A hook declared at `line` of `file`. */
export function hookAt(file: string, line: number, body: RuntimeBody): Hook {
  return { body, location: { file, line, column: 1 } }
}

/** Answers every command as a page where each locator matches one visible element with this text. */
export function pageWithText(text: string): Responder {
  return (command) => {
    if (command.kind === 'observe') return { ok: true, kind: 'observe', observation: observationOf([{ text, visible: true }]) }
    if (command.kind === 'observePage') return { ok: true, kind: 'observePage', observation: { url: 'http://127.0.0.1:4173/', title: text } }
    if (command.kind === 'goto' || command.kind === 'reload' || command.kind === 'goBack' || command.kind === 'goForward') {
      return { ok: true, kind: command.kind, url: 'http://127.0.0.1:4173/' }
    }
    if (command.kind === 'select' || command.kind === 'check' || command.kind === 'uncheck') return { ok: true, kind: command.kind, changed: true }
    return { ok: true, kind: command.kind }
  }
}
