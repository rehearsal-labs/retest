import type { CommandResult, PageCommand } from '../../src/protocol/commands.ts'
import type { ChildEvent } from '../../src/protocol/events.ts'
import type { ChildMessage } from '../../src/protocol/messages.ts'
import type { Timeouts } from '../../src/protocol/timeouts.ts'
import { TestRun } from '../../src/api/test-run.ts'
import { childMessageSchema } from '../../src/protocol/messages.ts'
import { parse } from '../../src/protocol/schema.ts'
import { quickTimeouts, rootDir } from './run-harness.ts'

/** Answers a page command, or returns undefined to leave it unanswered. */
export type Responder = (command: PageCommand) => CommandResult | Promise<CommandResult> | undefined

export type InProcessRun = {
  run: TestRun
  messages: ChildMessage[]
  commands: PageCommand[]
  events: () => ChildEvent[]
}

/**
 * A test run in this process, as the child would hold it. Every message it sends is validated like the
 * parent would, and commands are answered after a turn of the event loop, as over IPC.
 */
export function inProcessRun(file: string, respond: Responder, timeouts: Partial<Timeouts> = {}): InProcessRun {
  const messages: ChildMessage[] = []
  const commands: PageCommand[] = []
  let lastCommandId = 0
  const run: TestRun = new TestRun({
    testId: `${file} > in process`,
    attemptId: 'attempt-1',
    name: 'in process',
    file,
    rootDir,
    location: { file, line: 1, column: 1 },
    timeouts: { ...quickTimeouts, ...timeouts },
    nextCommandId: () => ++lastCommandId,
    send: (message) => {
      const parsed = parse(childMessageSchema, message)
      if (!parsed.ok) throw new Error(`The run sent an invalid message: ${JSON.stringify(parsed.issues)}`)
      messages.push(message)
      if (message.type !== 'command') return
      commands.push(message.command)
      setImmediate(async () => {
        const result = await respond(message.command)
        if (result !== undefined) run.resolveCommand(message.id, result)
      })
    },
  })
  const events = (): ChildEvent[] => messages.flatMap((message) => (message.type === 'event' ? [message.event] : []))
  return { run, messages, commands, events }
}

/** Answers every command as a page where each test id matches one visible element with this text. */
export function pageWithText(text: string): Responder {
  return (command) => {
    if (command.kind === 'observe') return { ok: true, kind: 'observe', observation: { count: 1, visible: true, text } }
    if (command.kind === 'goto') return { ok: true, kind: 'goto', url: 'http://127.0.0.1:4173/' }
    return { ok: true, kind: command.kind }
  }
}
