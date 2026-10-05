import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { isRecord } from '../../src/browser/cdp/message.ts'
import { PipeTransport } from '../../src/browser/cdp/transport.ts'
import { WebKitConnection } from '../../src/browser/webkit/connection.ts'

// A scripted WebKit build on the far end of a real pipe: it reads the frames the driver writes, unwraps the commands
// sent to page targets, and answers, fails or sends events as each test says. It proves message shapes, routing and
// the driver's reading of answers, nothing about a real browser; the integration tests drive the real build.

/** A command as the scripted build received it, with the page proxy and target it went to, if any. */
export type ReceivedCommand = {
  readonly id: number
  readonly method: string
  readonly params: Record<string, unknown>
  readonly pageProxyId: string | undefined
  readonly targetId: string | undefined
  /** The id of the `Target.sendMessageToTarget` wrapper a target command came in. */
  readonly wrapperId: number | undefined
}

export type ScriptedBuild = {
  readonly connection: WebKitConnection
  readonly diagnostics: string[]
  /** Every command received so far, in order, wrappers left out. */
  readonly received: ReceivedCommand[]
  nextCommand(): Promise<ReceivedCommand>
  /** Answers every command that `answer` returns a value for, now and later; `undefined` leaves it for the test. */
  serve(answer: (command: ReceivedCommand) => object | Error | undefined): void
  reply(command: ReceivedCommand, result: object): void
  fail(command: ReceivedCommand, message: string, code?: number): void
  /** Refuses the wrapper a target command came in, as a page proxy refuses one for a target that is gone. */
  refuseWrapper(command: ReceivedCommand, message: string): void
  event(method: string, params: object): void
  proxyEvent(pageProxyId: string, method: string, params: object): void
  targetEvent(pageProxyId: string, targetId: string, method: string, params: object): void
  exit(): void
}

/**
 * A connection over an in-memory pipe whose far end is a scripted WebKit build. Wrappers of target commands are
 * answered at once, as the build answers them, unless `answerWrappers` is false.
 */
export function scriptedBuild(t: TestContext, options: { timeoutMs?: number; maxPending?: number; answerWrappers?: boolean } = {}): ScriptedBuild {
  const toBrowser = new PassThrough()
  const fromBrowser = new PassThrough()
  const diagnostics: string[] = []
  const connection = new WebKitConnection(new PipeTransport({ readable: fromBrowser, writable: toBrowser }), {
    timeoutMs: options.timeoutMs ?? 1000,
    ...(options.maxPending === undefined ? {} : { maxPending: options.maxPending }),
    onDiagnostic: (problem) => diagnostics.push(problem),
  })
  t.after(() => connection.close())
  // A real pipe never answers within the write that sent the command, so neither does the scripted build.
  const send = (message: object): void => {
    const frame = `${JSON.stringify(message)}\0`
    setImmediate(() => fromBrowser.write(frame))
  }
  const received: ReceivedCommand[] = []
  const queued: ReceivedCommand[] = []
  const waiting: ((command: ReceivedCommand) => void)[] = []
  const servers: ((command: ReceivedCommand) => object | Error | undefined)[] = []
  const answer = (command: ReceivedCommand, result: object | Error): void => {
    if (result instanceof Error) build.fail(command, result.message)
    else build.reply(command, result)
  }
  const deliver = (command: ReceivedCommand): void => {
    received.push(command)
    for (const server of servers) {
      const result = server(command)
      if (result !== undefined) return answer(command, result)
    }
    const waiter = waiting.shift()
    if (waiter === undefined) queued.push(command)
    else waiter(command)
  }
  const reader = new PipeTransport({ readable: toBrowser, writable: new PassThrough() })
  reader.listen({
    message: (text) => {
      const message: unknown = JSON.parse(text)
      if (!isRecord(message)) return assert.fail('the driver wrote a frame that is not an object')
      const id = numberOf(message['id'])
      const method = stringOf(message['method'])
      const params = isRecord(message['params']) ? message['params'] : {}
      const pageProxyId = typeof message['pageProxyId'] === 'string' ? message['pageProxyId'] : undefined
      if (method !== 'Target.sendMessageToTarget') return deliver({ id, method, params, pageProxyId, targetId: undefined, wrapperId: undefined })
      if (options.answerWrappers !== false) send({ id, result: {}, pageProxyId })
      const inner: unknown = JSON.parse(stringOf(params['message']))
      if (!isRecord(inner)) return assert.fail('a wrapped message is not an object')
      deliver({ id: numberOf(inner['id']), method: stringOf(inner['method']), params: isRecord(inner['params']) ? inner['params'] : {}, pageProxyId, targetId: stringOf(params['targetId']), wrapperId: id })
    },
    malformed: (problem) => assert.fail(`the driver wrote a malformed frame: ${problem}`),
    close: () => {},
  })
  const build: ScriptedBuild = {
    connection,
    diagnostics,
    received,
    nextCommand: () => {
      const command = queued.shift()
      return command === undefined ? new Promise((resolve) => waiting.push(resolve)) : Promise.resolve(command)
    },
    serve: (server) => {
      servers.push(server)
      for (const command of queued.splice(0)) deliver(command)
    },
    reply: (command, result) => {
      if (command.targetId !== undefined && command.pageProxyId !== undefined) {
        send({ method: 'Target.dispatchMessageFromTarget', params: { targetId: command.targetId, message: JSON.stringify({ id: command.id, result }) }, pageProxyId: command.pageProxyId })
        return
      }
      send({ id: command.id, result, ...(command.pageProxyId === undefined ? {} : { pageProxyId: command.pageProxyId }) })
    },
    fail: (command, message, code = -32000) => {
      const error = { code, message, data: [{ code, message }] }
      if (command.targetId !== undefined && command.pageProxyId !== undefined) {
        send({ method: 'Target.dispatchMessageFromTarget', params: { targetId: command.targetId, message: JSON.stringify({ id: command.id, error }) }, pageProxyId: command.pageProxyId })
        return
      }
      send({ id: command.id, error, ...(command.pageProxyId === undefined ? {} : { pageProxyId: command.pageProxyId }) })
    },
    refuseWrapper: (command, message) => {
      assert.ok(command.wrapperId !== undefined, 'only a target command has a wrapper')
      send({ id: command.wrapperId, error: { code: -32000, message, data: [] }, pageProxyId: command.pageProxyId })
    },
    event: (method, params) => send({ method, params }),
    proxyEvent: (pageProxyId, method, params) => send({ method, params, pageProxyId }),
    targetEvent: (pageProxyId, targetId, method, params) => {
      send({ method: 'Target.dispatchMessageFromTarget', params: { targetId, message: JSON.stringify({ method, params }) }, pageProxyId })
    },
    exit: () => setImmediate(() => fromBrowser.end()),
  }
  return build
}

function numberOf(value: unknown): number {
  if (typeof value !== 'number') return assert.fail('the frame has no numeric id')
  return value
}

function stringOf(value: unknown): string {
  if (typeof value !== 'string') return assert.fail('the frame has no text where one belongs')
  return value
}
