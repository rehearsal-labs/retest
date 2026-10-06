import type { MediaReply } from '../../src/media/protocol.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MAX_REPLY_HEADER_BYTES, MAX_REPLY_PAYLOAD_BYTES, MEDIA_PROTOCOL_VERSION, MediaProtocolError, MediaVersionMismatch, ReplyReader } from '../../src/media/protocol.ts'

// A reply as the process frames it: the header's and the payload's lengths, the header, the payload.
function message(header: object, payload: Uint8Array = new Uint8Array()): Buffer {
  const json = Buffer.from(JSON.stringify(header), 'utf8')
  const prefix = Buffer.alloc(8)
  prefix.writeUInt32BE(json.byteLength, 0)
  prefix.writeUInt32BE(payload.byteLength, 4)
  return Buffer.concat([prefix, json, payload])
}

function live(byteLength: number, sequence = 1) {
  return { type: 'live', recordingId: 'r', frameId: `f${sequence}`, captureUs: 0, width: 1, height: 1, format: 'jpeg', sequence, skipped: 0, dropped: 0, byteLength }
}

function chunks(bytes: Buffer, size: number): Buffer[] {
  const parts: Buffer[] = []
  for (let offset = 0; offset < bytes.byteLength; offset += size) parts.push(bytes.subarray(offset, Math.min(offset + size, bytes.byteLength)))
  return parts
}

test('a reply split into single bytes is read whole, and two replies in one chunk are both read', () => {
  const reader = new ReplyReader()
  const payload = Uint8Array.of(0xff, 0xd8, 1, 2, 3)
  const replies: MediaReply[] = []
  for (const part of chunks(message(live(payload.byteLength), payload), 1)) replies.push(...reader.push(part))
  assert.equal(replies.length, 1)
  assert.equal(reader.pendingBytes, 0)
  const [first] = replies
  assert.ok(first?.type === 'live')
  assert.deepEqual([...first.bytes], [...payload])
  const both = reader.push(Buffer.concat([message({ type: 'bye', stopped: 0 }), message({ type: 'bye', stopped: 2 })]))
  assert.deepEqual(both, [{ type: 'bye', stopped: 0 }, { type: 'bye', stopped: 2 }])
})

test('a large reply arriving in pipe-sized chunks is copied once, not once per chunk', (t) => {
  const payloadBytes = 48 * 1024 * 1024
  const whole = message(live(payloadBytes), new Uint8Array(payloadBytes).fill(7))
  const parts = chunks(whole, 64 * 1024)
  const joins = t.mock.method(Buffer, 'concat')
  const reader = new ReplyReader()
  const replies = parts.flatMap((part) => reader.push(part))
  // A join that threw has no result; the reply would then be missing and the test fails below.
  const copied = joins.mock.calls.reduce((total, call) => total + (call.result?.byteLength ?? 0), 0)
  joins.mock.restore()
  assert.equal(replies.length, 1)
  const [reply] = replies
  assert.ok(reply?.type === 'live')
  assert.equal(reply.bytes.byteLength, payloadBytes)
  assert.equal(reply.bytes[payloadBytes - 1], 7)
  // Joining on every chunk copied about 18 GB for this reply.
  assert.ok(copied <= 2 * whole.byteLength, `the reader copied ${copied} bytes for a reply of ${whole.byteLength}`)
})

test('a reply payload holds no view into the chunk it arrived in', () => {
  const reader = new ReplyReader()
  const payload = Uint8Array.of(9, 9, 9)
  const chunk = message(live(payload.byteLength), payload)
  const [reply] = reader.push(chunk)
  chunk.fill(0)
  assert.ok(reply?.type === 'live')
  assert.deepEqual([...reply.bytes], [9, 9, 9])
})

test('lengths past the limits, a payload on a reply that carries none and an image shorter than its header says are refused', () => {
  const tooLong = Buffer.alloc(8)
  tooLong.writeUInt32BE(MAX_REPLY_HEADER_BYTES + 1, 0)
  assert.throws(() => new ReplyReader().push(tooLong), MediaProtocolError)
  const tooLarge = Buffer.alloc(8)
  tooLarge.writeUInt32BE(2, 0)
  tooLarge.writeUInt32BE(MAX_REPLY_PAYLOAD_BYTES + 1, 4)
  assert.throws(() => new ReplyReader().push(tooLarge), MediaProtocolError)
  assert.throws(() => new ReplyReader().push(message({ type: 'bye', stopped: 0 }, Uint8Array.of(1))), /carried 1 payload bytes/)
  assert.throws(() => new ReplyReader().push(message(live(4), Uint8Array.of(1, 2))), /names 4 bytes; 2 came/)
})

test('a greeting of another protocol version names it and is not otherwise trusted', () => {
  const greeting = { type: 'hello', protocol: MEDIA_PROTOCOL_VERSION + 1, version: `9.9.9${'x'.repeat(100)}`, target: 'macos-aarch64' }
  assert.throws(
    () => new ReplyReader().push(message(greeting)),
    (error: unknown) => error instanceof MediaVersionMismatch && error.protocol === MEDIA_PROTOCOL_VERSION + 1 && error.binaryVersion?.length === 64,
  )
})


test('sequence gap-omission and bye reply-loss markers survive protocol parsing and require counts', () => {
  const header = { type: 'frames', requestId: 'q1', recordingId: 'r', status: 'ok', recording: 'ended', fromUs: 2_000_000, toUs: 2_300_000, inInterval: 0, available: 0, frames: [], omitted: { byCount: 0, byBytes: 0, undecodable: 0 }, stretches: [], stretchesFound: 0, captureGapsOmitted: 1 }
  const [sequence] = new ReplyReader().push(message(header))
  assert.ok(sequence?.type === 'frames')
  assert.equal(sequence.captureGapsOmitted, 1)
  const [bye] = new ReplyReader().push(message({ type: 'bye', stopped: 0, repliesDropped: 5 }))
  assert.deepEqual(bye, { type: 'bye', stopped: 0, repliesDropped: 5 })
  assert.throws(() => new ReplyReader().push(message({ ...header, captureGapsOmitted: -1 })), MediaProtocolError)
  assert.throws(() => new ReplyReader().push(message({ type: 'bye', stopped: 0, repliesDropped: 1.5 })), MediaProtocolError)
})

test('a poisoned reader retains no rejected prefix or subsequent input', () => {
  const reader = new ReplyReader()
  const prefix = Buffer.alloc(8)
  prefix.writeUInt32BE(MAX_REPLY_HEADER_BYTES + 1)
  assert.throws(() => reader.push(prefix), MediaProtocolError)
  assert.equal(reader.pendingBytes, 0)
  for (let index = 0; index < 32; index++) {
    assert.throws(() => reader.push(Buffer.alloc(64 * 1024)), MediaProtocolError)
    assert.equal(reader.pendingBytes, 0)
  }
})

test('EOF with a partial prefix, header or payload is a protocol failure', () => {
  const whole = message(live(4), Buffer.alloc(4))
  for (const length of [3, 9, whole.length - 1]) {
    const reader = new ReplyReader()
    reader.push(whole.subarray(0, length))
    assert.throws(() => reader.end(), /truncated|incomplete/i)
    assert.equal(reader.pendingBytes, 0)
  }
  const reader = new ReplyReader()
  reader.push(message({ type: 'bye', stopped: 0 }))
  assert.doesNotThrow(() => reader.end())
})
