import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:http'

// A WebDriver BiDi endpoint the unit tests script: a WebSocket server of its own, written against RFC 6455 for text
// frames only, so the real client is tested over a real socket without a browser. Each command is answered by the
// handler its method has, or with `unknown command`; events go out when a test emits them.

/** What a handler answers: a result, an error, or nothing for a command that never gets an answer. */
export type Answer = { result: object } | { error: string; message?: string } | 'silent'

export type Handler = (params: Record<string, unknown>, command: SentCommand) => Answer | Promise<Answer>

/** A command as the endpoint received it. */
export type SentCommand = { id: number; method: string; params: Record<string, unknown> }

const guid = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/** A scripted BiDi endpoint at `url`, which keeps every command it received in order. */
export class ScriptedBidi {
  readonly url: string
  readonly sent: SentCommand[] = []
  readonly #handlers = new Map<string, Handler>()
  readonly #sockets: Set<Duplex>
  readonly #close: () => Promise<void>

  private constructor(url: string, sockets: Set<Duplex>, close: () => Promise<void>) {
    this.url = url
    this.#sockets = sockets
    this.#close = close
  }

  static async start(): Promise<ScriptedBidi> {
    const server = createServer()
    const sockets = new Set<Duplex>()
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('the scripted endpoint has no port')
    const endpoint = new ScriptedBidi(`ws://127.0.0.1:${address.port}/session`, sockets, async () => {
      for (const socket of sockets) socket.destroy()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    })
    server.on('upgrade', (request: IncomingMessage, socket: Duplex) => endpoint.accepted(request, socket))
    return endpoint
  }

  /** Answers every later command of `method` with `handler`. */
  on(method: string, handler: Handler): void {
    this.#handlers.set(method, handler)
  }

  /** Answers every later command of `method` with an empty result. */
  accept(...methods: string[]): void {
    for (const method of methods) this.#handlers.set(method, () => ({ result: {} }))
  }

  /** Sends an event to every connected client. */
  emit(method: string, params: object): void {
    this.#broadcast({ type: 'event', method, params })
  }

  /** The commands of one method received so far. */
  commands(method: string): SentCommand[] {
    return this.sent.filter((command) => command.method === method)
  }

  /** Drops every connection without a closing handshake, as a browser killed outright leaves it. */
  drop(): void {
    for (const socket of this.#sockets) socket.destroy()
  }

  close(): Promise<void> {
    return this.#close()
  }

  /** Takes a connection the endpoint's server upgraded. */
  accepted(request: IncomingMessage, socket: Duplex): void {
    const key = request.headers['sec-websocket-key']
    if (typeof key !== 'string') {
      socket.destroy()
      return
    }
    const accept = createHash('sha1').update(key + guid).digest('base64')
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
    this.#sockets.add(socket)
    socket.on('close', () => this.#sockets.delete(socket))
    socket.on('error', () => this.#sockets.delete(socket))
    let buffered = Buffer.alloc(0)
    socket.on('data', (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk])
      for (;;) {
        const frame = readFrame(buffered)
        if (frame === undefined) return
        buffered = buffered.subarray(frame.length)
        if (frame.opcode === 8) {
          socket.end(encodeFrame(Buffer.from([0x03, 0xe8]), 8))
          return
        }
        if (frame.opcode === 1) void this.#command(socket, frame.payload.toString('utf8'))
      }
    })
  }

  async #command(socket: Duplex, text: string): Promise<void> {
    const message: unknown = JSON.parse(text)
    if (typeof message !== 'object' || message === null) return
    const id = Reflect.get(message, 'id')
    const method = Reflect.get(message, 'method')
    const params: unknown = Reflect.get(message, 'params')
    if (typeof id !== 'number' || typeof method !== 'string') return
    const command: SentCommand = { id, method, params: typeof params === 'object' && params !== null ? Object.fromEntries(Object.entries(params)) : {} }
    this.sent.push(command)
    const handler = this.#handlers.get(method)
    const answer = handler === undefined ? { error: 'unknown command', message: `${method} is not scripted` } : await handler(command.params, command)
    if (answer === 'silent') return
    const reply = 'result' in answer ? { type: 'success', id, result: answer.result } : { type: 'error', id, error: answer.error, message: answer.message ?? answer.error }
    if (!socket.destroyed) socket.write(encodeFrame(Buffer.from(JSON.stringify(reply)), 1))
  }

  #broadcast(message: object): void {
    const frame = encodeFrame(Buffer.from(JSON.stringify(message)), 1)
    for (const socket of this.#sockets) if (!socket.destroyed) socket.write(frame)
  }
}

function readFrame(buffer: Buffer): { opcode: number; payload: Buffer; length: number } | undefined {
  if (buffer.length < 2) return undefined
  const first = buffer[0] ?? 0
  const second = buffer[1] ?? 0
  const masked = (second & 0x80) !== 0
  let length = second & 0x7f
  let offset = 2
  if (length === 126) {
    if (buffer.length < 4) return undefined
    length = buffer.readUInt16BE(2)
    offset = 4
  } else if (length === 127) {
    if (buffer.length < 10) return undefined
    length = Number(buffer.readBigUInt64BE(2))
    offset = 10
  }
  const maskLength = masked ? 4 : 0
  if (buffer.length < offset + maskLength + length) return undefined
  const mask = buffer.subarray(offset, offset + maskLength)
  const payload = Buffer.from(buffer.subarray(offset + maskLength, offset + maskLength + length))
  if (masked) for (let index = 0; index < payload.length; index += 1) payload[index] = (payload[index] ?? 0) ^ (mask[index % 4] ?? 0)
  return { opcode: first & 0x0f, payload, length: offset + maskLength + length }
}

function encodeFrame(payload: Buffer, opcode: number): Buffer {
  const header = payload.length < 126 ? Buffer.from([0x80 | opcode, payload.length]) : payload.length < 65536 ? Buffer.alloc(4) : Buffer.alloc(10)
  if (payload.length >= 126 && payload.length < 65536) {
    header[0] = 0x80 | opcode
    header[1] = 126
    header.writeUInt16BE(payload.length, 2)
  } else if (payload.length >= 65536) {
    header[0] = 0x80 | opcode
    header[1] = 127
    header.writeBigUInt64BE(BigInt(payload.length), 2)
  }
  return Buffer.concat([header, payload])
}
