import { dirname, join } from 'node:path'
import { writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import type { Ended, MediaReply, MediaRequest, Started } from '../../src/media/protocol.ts'
import { mediaTarget } from '../../src/cli/install/media-pins.ts'

const mode = process.argv[2]
let pendingEnding: Ended | undefined
function send(reply: MediaReply, payload = Buffer.alloc(0)): void {
  const head = Buffer.from(JSON.stringify(reply.type === 'ended' ? { ...reply, frameMap: undefined } : reply))
  const prefix = Buffer.alloc(8)
  prefix.writeUInt32BE(head.length)
  prefix.writeUInt32BE(payload.length, 4)
  process.stdout.write(Buffer.concat([prefix, head, payload]))
}
send({ type: 'hello', protocol: 2, version: '0.1.0', build: { target: mediaTarget() ?? 'aarch64-apple-darwin', profile: 'release' }, ffmpeg: '/fixture/ffmpeg', encoder: mode === 'ended-hostile' || mode === 'running-hostile' ? { state: 'ready', version: 'fixture', codec: 'h264', container: 'mp4', encoder: 'libx264', encodedInput: ['png'], probeMs: 0 } : { state: 'probing' } })
if (mode === 'stopped') {
  process.stdin.pause()
  setInterval(() => undefined, 1000)
} else {
  let pending = Buffer.alloc(0)
  process.stdin.on('data', (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk])
    while (pending.length >= 8) {
      const headLength = pending.readUInt32BE(0)
      const payloadLength = pending.readUInt32BE(4)
      const length = 8 + headLength + payloadLength
      if (pending.length < length) return
      const request = JSON.parse(pending.subarray(8, 8 + headLength).toString('utf8')) as MediaRequest
      pending = pending.subarray(length)
      if (request.type === 'shutdown') {
        if (mode?.startsWith('truncated') === true) {
          const whole = Buffer.from([0, 0, 0, 20, 0, 0, 0, 0, 123])
          process.stdout.write(whole.subarray(0, mode === 'truncated-prefix' ? 3 : 9))
        } else send({ type: 'bye', stopped: 0 })
        process.stdin.pause()
        process.stdout.end()
        return
      }
      if (request.type === 'finish' && pendingEnding !== undefined) {
        send(pendingEnding)
        continue
      }
      if (request.type === 'start') {
        const identity = (mode?.endsWith('identity') === true || mode === 'ended-hostile' || mode === 'running-hostile') ? { ...request.identity, attemptId: 'foreign-attempt' } : request.identity
        const recordingId = mode?.endsWith('id') === true ? 'foreign-recording' : request.recordingId
        const path = mode === 'ended-hostile' || mode === 'running-hostile' ? join(dirname(request.output), 'foreign.mp4') : `${mode?.endsWith('path') === true ? '/foreign/video' : request.output}.mp4`
        if (mode === 'ended-hostile' || mode === 'running-hostile') writeFileSync(path, 'foreign nonempty video')
        if (mode?.startsWith('started') === true || mode === 'running-hostile') {
          const encoder = mode === 'running-hostile' ? spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' }) : undefined
          encoder?.unref()
          const reply: Started = { type: 'started', recordingId, identity: mode === 'running-hostile' ? request.identity : identity, path: mode === 'running-hostile' ? `${request.output}.mp4` : path, encoderPid: encoder?.pid ?? process.pid, codec: 'h264', container: 'mp4', encoder: 'fixture', encoderVersion: '1', width: 8, height: 8, fps: 10, route: 'decoded', queueFrames: 1, queueBytes: 1024, maxGapMs: 1000, maxDurationMs: 1000, stallMs: 1000 }
          send(reply)
          if (mode !== 'running-hostile') continue
        }
        {
          const reply: Ended = { type: 'ended', recordingId, identity, path, status: 'ok', message: 'fixture video', frames: { received: 1, shown: 1, superseded: 0, dropped: 0, outOfOrder: 0, outOfRange: 0, undecodable: 0, duplicate: 0, unprocessed: 0, resized: 0 }, framesBeforeFirst: 0, gaps: [], gapsShortened: 0, endClipped: false, outputFrames: 1, durationUs: 100000, bytesReceived: 1, bytesToEncoder: 1, queue: { peakFrames: 1, peakBytes: 1, saturated: 0 }, captureGaps: [], captureGapsReported: 0, evidence: { status: 'complete', reasons: [] }, frameMapEntries: 0, frameMapOmitted: 0, frameMap: [] }
          if (mode === 'running-hostile') pendingEnding = reply
          else send(reply)
        }
      } else if (request.type === 'frames') {
        send({ type: 'frames', requestId: request.requestId, recordingId: 'foreign-recording', status: 'ok', recording: 'ended', fromUs: request.fromUs, toUs: request.toUs, inInterval: 0, available: 0, frames: [], omitted: { byCount: 0, byBytes: 0, undecodable: 0 }, stretches: [], stretchesFound: 0 })
      }
    }
  })
}
