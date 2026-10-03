/** The command an error is about. */
export type CommandIdentity = { readonly method: string }

export class BidiError extends Error {
  readonly method: string

  constructor(command: CommandIdentity, message: string) {
    super(message)
    this.name = new.target.name
    this.method = command.method
  }
}

/** The WebSocket could not be opened, so no command was ever sent. */
export class BidiConnectError extends Error {
  override readonly name = 'BidiConnectError'
}

/** The connection ended while the command waited for its response. */
export class BidiDisconnectedError extends BidiError {
  readonly reason: string
  /** False only when the command certainly never reached the browser. */
  readonly written: boolean

  constructor(command: CommandIdentity, outcome: { reason: string; written: boolean }) {
    super(command, `${command.method} got no response: ${outcome.reason}`)
    this.reason = outcome.reason
    this.written = outcome.written
  }
}

export class BidiTimeoutError extends BidiError {
  readonly timeoutMs: number
  /** False only when the command certainly never reached the browser. */
  readonly written: boolean

  constructor(command: CommandIdentity, outcome: { timeoutMs: number; written: boolean }) {
    super(command, `${command.method} got no response within ${outcome.timeoutMs} ms`)
    this.timeoutMs = outcome.timeoutMs
    this.written = outcome.written
  }
}

/** The caller stopped waiting for the command. A command it stopped before it was written never is. */
export class BidiAbortedError extends BidiError {
  /** False only when the command certainly never reached the browser. */
  readonly written: boolean

  constructor(command: CommandIdentity, outcome: { written: boolean }) {
    super(command, `${command.method} was stopped ${outcome.written ? 'while it waited for a response' : 'before it was sent'}`)
    this.written = outcome.written
  }
}

/**
 * The browser answered the command with a WebDriver BiDi error. `error` is the error code the protocol defines, such
 * as `no such element` or `invalid argument`. Firefox quotes the command's arguments in its own message, so that
 * message is kept, in `protocolMessage` and in the error's text, only for a command that asked for it.
 */
export class BidiProtocolError extends BidiError {
  readonly error: string
  readonly protocolMessage: string | undefined

  constructor(command: CommandIdentity, body: { error: string; message: string | undefined }) {
    super(command, `${command.method} failed: ${body.error}${body.message === undefined ? '' : `: ${body.message}`}`)
    this.error = body.error
    this.protocolMessage = body.message
  }
}

/** The browser answered the command with something that is not a valid response. */
export class BidiInvalidResponseError extends BidiError {
  readonly problem: string

  constructor(command: CommandIdentity, problem: string) {
    super(command, `${command.method} got a response that could not be read: ${problem}`)
    this.problem = problem
  }
}

/** The command was not sent because the connection had already ended. */
export class BidiClosedError extends BidiError {
  readonly reason: string

  constructor(command: CommandIdentity, reason: string) {
    super(command, `${command.method} was not sent: ${reason}`)
    this.reason = reason
  }
}
