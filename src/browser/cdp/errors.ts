import type { ProtocolErrorBody } from './message.ts'

/** The command an error is about. `sessionId` is undefined for the browser itself. */
export type CommandIdentity = { readonly method: string; readonly sessionId: string | undefined }

export class CdpError extends Error {
  readonly method: string
  readonly sessionId: string | undefined

  constructor(command: CommandIdentity, message: string) {
    super(message)
    this.name = new.target.name
    this.method = command.method
    this.sessionId = command.sessionId
  }
}

/** The connection or the session ended while the command waited for its response. */
export class CdpDisconnectedError extends CdpError {
  readonly reason: string
  /** False only when the command certainly never reached the browser. */
  readonly written: boolean

  constructor(command: CommandIdentity, outcome: { reason: string; written: boolean }) {
    super(command, `${command.method} got no response: ${outcome.reason}`)
    this.reason = outcome.reason
    this.written = outcome.written
  }
}

export class CdpTimeoutError extends CdpError {
  readonly timeoutMs: number
  /** False only when the command certainly never reached the browser. */
  readonly written: boolean

  constructor(command: CommandIdentity, outcome: { timeoutMs: number; written: boolean }) {
    super(command, `${command.method} got no response within ${outcome.timeoutMs} ms`)
    this.timeoutMs = outcome.timeoutMs
    this.written = outcome.written
  }
}

/** The target could not answer, such as after it crashed or while a dialog held it, so Retest stopped waiting. */
export class CdpBlockedError extends CdpError {
  readonly reason: string
  /** False only when the command certainly never reached the browser. */
  readonly written: boolean

  constructor(command: CommandIdentity, outcome: { reason: string; written: boolean }) {
    super(command, `${command.method} got no response: ${outcome.reason}`)
    this.reason = outcome.reason
    this.written = outcome.written
  }
}

/** The caller stopped waiting for the command. A command it stopped before it was written never is. */
export class CdpAbortedError extends CdpError {
  /** False only when the command certainly never reached the browser. */
  readonly written: boolean

  constructor(command: CommandIdentity, outcome: { written: boolean }) {
    super(command, `${command.method} was stopped ${outcome.written ? 'while it waited for a response' : 'before it was sent'}`)
    this.written = outcome.written
  }
}

/** The browser answered the command with a CDP error. */
export class CdpProtocolError extends CdpError {
  readonly code: number
  readonly protocolMessage: string
  readonly data: string | undefined

  constructor(command: CommandIdentity, error: ProtocolErrorBody) {
    super(command, `${command.method} failed: ${error.message} (${error.code})`)
    this.code = error.code
    this.protocolMessage = error.message
    this.data = error.data
  }
}

/** The browser answered the command with something that is not a valid response. */
export class CdpInvalidResponseError extends CdpError {
  readonly problem: string

  constructor(command: CommandIdentity, problem: string) {
    super(command, `${command.method} got a response that could not be read: ${problem}`)
    this.problem = problem
  }
}

/** The command was not sent because too many commands were already waiting. */
export class CdpPendingLimitError extends CdpError {
  readonly limit: number

  constructor(command: CommandIdentity, limit: number) {
    super(command, `${command.method} was not sent: ${limit} commands are already waiting for a response`)
    this.limit = limit
  }
}

/** The command was not sent because the connection or the session had already ended. */
export class CdpClosedError extends CdpError {
  readonly reason: string

  constructor(command: CommandIdentity, reason: string) {
    super(command, `${command.method} was not sent: ${reason}`)
    this.reason = reason
  }
}
