// Stands in for retest-media where a test needs a process that misbehaves in one chosen way. It greets with the
// protocol argv[2] claims, then does what argv[3] says:
//
// - `stubborn` (the default): ignores its input, its input ending and SIGTERM, so only a kill ends it.
// - `late-start`: answers a `start` 300 ms later with a `started` whose encoder is a `sleep` in a group of its
//   own, writes that pid to `<output>.pid`, and never sends an `ended`. For the client's handling of a start
//   answered after its timeout.
// - `close-input`: closes its end of the input pipe after 100 ms and stays alive, so the client's writes break
//   while the process has not exited.
//
// It records nothing.

import { spawn } from 'node:child_process'
import { closeSync, writeFileSync } from 'node:fs'

const protocol = Number(process.argv[2] ?? '1')
const mode = process.argv[3] ?? 'stubborn'

function reply(message: Record<string, unknown>): void {
  const header = Buffer.from(JSON.stringify(message))
  const prefix = Buffer.alloc(8)
  prefix.writeUInt32BE(header.byteLength, 0)
  process.stdout.write(Buffer.concat([prefix, header]))
}

reply({ type: 'hello', protocol, version: '0.0.0-stub', target: 'stub', ffmpeg: 'none' })
process.on('SIGTERM', () => {})
setInterval(() => {}, 60_000)

if (mode === 'close-input') {
  setTimeout(() => closeSync(0), 100)
} else if (mode === 'late-start') {
  let pending = Buffer.alloc(0)
  process.stdin.on('data', (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk])
    for (;;) {
      if (pending.byteLength < 8) return
      const end = 8 + pending.readUInt32BE(0) + pending.readUInt32BE(4)
      if (pending.byteLength < end) return
      const request: unknown = JSON.parse(pending.subarray(8, 8 + pending.readUInt32BE(0)).toString('utf8'))
      pending = pending.subarray(end)
      if (typeof request === 'object' && request !== null && 'type' in request && request.type === 'start') startLate(request)
    }
  })
  process.stdin.on('end', () => {})
} else {
  process.stdin.resume()
  process.stdin.on('end', () => {})
}

function startLate(request: object): void {
  const recordingId = 'recordingId' in request && typeof request.recordingId === 'string' ? request.recordingId : ''
  const output = 'output' in request && typeof request.output === 'string' ? request.output : ''
  setTimeout(() => {
    const encoder = spawn('/bin/sleep', ['30'], { detached: true, stdio: 'ignore' })
    encoder.unref()
    writeFileSync(`${output}.pid`, String(encoder.pid ?? 0))
    reply({
      type: 'started',
      recordingId,
      codec: 'h264',
      container: 'mp4',
      encoder: 'sleep',
      encoderVersion: 'sleep',
      encoderPid: encoder.pid ?? 0,
      path: `${output}.mp4`,
      width: 64,
      height: 48,
      fps: 10,
      queueFrames: 60,
      queueBytes: 64 * 1024 * 1024,
      maxGapMs: 10_000,
      maxDurationMs: 1_800_000,
      stallMs: 10_000,
    })
  }, 300)
}
