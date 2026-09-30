import type { Readable, Writable } from 'node:stream'

export interface TransportHandlers {
  message(text: string): void
  /** A frame that could not be read. The transport keeps going. */
  malformed(problem: string): void
  /** Called once, whichever side ends the transport. */
  close(reason: string): void
}

export interface OutgoingMessage {
  /** True once the message was handed to the pipe, so the browser may have received it. */
  readonly written: boolean
  /** Keeps a message that has not been written yet from ever being written. */
  withdraw(): void
}

export interface Transport {
  listen(handlers: TransportHandlers): void
  send(text: string): OutgoingMessage
  close(): void
}

/** The ends of a `--remote-debugging-pipe` pair: Chrome reads fd 3 and writes fd 4. */
export type PipeStreams = { readable: Readable; writable: Writable }

type Frame = { readonly text: string; state: 'queued' | 'written' | 'withdrawn' }

const SEPARATOR = 0

/** Frames CDP messages as NUL-terminated UTF-8 JSON over a pair of pipes. */
export class PipeTransport implements Transport {
  readonly #readable: Readable
  readonly #writable: Writable
  readonly #decoder = new TextDecoder('utf-8', { fatal: true })
  #handlers: TransportHandlers | undefined
  #partial: Uint8Array[] = []
  #queue: Frame[] = []
  #blocked = false
  #closeReason: string | undefined

  constructor({ readable, writable }: PipeStreams) {
    this.#readable = readable
    this.#writable = writable
    readable.on('end', () => this.#end('the browser closed the pipe'))
    readable.on('close', () => this.#end('the browser closed the pipe'))
    readable.on('error', (error) => this.#end(`reading from the browser failed: ${error.message}`))
    writable.on('close', () => this.#end('the pipe to the browser closed'))
    writable.on('error', (error) => this.#end(`writing to the browser failed: ${error.message}`))
    writable.on('drain', () => {
      this.#blocked = false
      this.#flush()
    })
    // A stream that ended before this point never emits its events again.
    if (readable.destroyed || readable.readableEnded) this.#end('the browser closed the pipe')
    else if (writable.destroyed || writable.writableEnded) this.#end('the pipe to the browser closed')
  }

  /** Starts reading. Nothing is read before this, so no message can arrive unheard. */
  listen(handlers: TransportHandlers): void {
    if (this.#handlers !== undefined) throw new Error('The transport already has a listener')
    this.#handlers = handlers
    if (this.#closeReason !== undefined) {
      handlers.close(this.#closeReason)
      return
    }
    this.#readable.on('data', (chunk: unknown) => this.#receive(chunk))
  }

  send(text: string): OutgoingMessage {
    if (this.#closeReason !== undefined) throw new Error(`The pipe is closed: ${this.#closeReason}`)
    if (text.includes('\0')) throw new TypeError('A CDP message cannot contain a NUL character')
    const frame: Frame = { text, state: 'queued' }
    this.#queue.push(frame)
    this.#flush()
    return {
      get written() {
        return frame.state === 'written'
      },
      withdraw() {
        if (frame.state === 'queued') frame.state = 'withdrawn'
      },
    }
  }

  close(): void {
    this.#end('the connection was closed')
  }

  #receive(chunk: unknown): void {
    if (!(chunk instanceof Uint8Array)) {
      this.#end('the pipe from the browser produced text instead of bytes')
      return
    }
    let start = 0
    for (let end = chunk.indexOf(SEPARATOR); end !== -1; end = chunk.indexOf(SEPARATOR, start)) {
      this.#partial.push(chunk.subarray(start, end))
      start = end + 1
      const frame = Buffer.concat(this.#partial)
      this.#partial = []
      this.#deliver(frame)
      if (this.#closeReason !== undefined) return
    }
    if (start < chunk.length) this.#partial.push(chunk.subarray(start))
  }

  #deliver(frame: Uint8Array): void {
    let text: string
    try {
      text = this.#decoder.decode(frame)
    } catch {
      this.#handlers?.malformed('the message is not valid UTF-8')
      return
    }
    this.#handlers?.message(text)
  }

  #flush(): void {
    while (!this.#blocked && this.#closeReason === undefined) {
      const frame = this.#queue.shift()
      if (frame === undefined) return
      if (frame.state === 'withdrawn') continue
      frame.state = 'written'
      this.#blocked = !this.#writable.write(`${frame.text}\0`)
    }
  }

  #end(reason: string): void {
    if (this.#closeReason !== undefined) return
    this.#closeReason = reason
    this.#queue = []
    const unfinished = this.#partial.length > 0
    this.#partial = []
    this.#readable.destroy()
    this.#writable.destroy()
    if (unfinished) this.#handlers?.malformed('the pipe ended in the middle of a message')
    this.#handlers?.close(reason)
  }
}
