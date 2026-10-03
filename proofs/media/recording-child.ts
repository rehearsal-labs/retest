// A process that records through the client the way a test run would, for the tests of what happens to the media
// process when this one ends. Arguments: the media binary, ffmpeg, the output path without its extension, and a
// mode. It starts a recording, sends frames until the encoder has begun its file, prints one JSON line naming the
// media process, the encoder and the `.partial`, and then:
//
// - `keep`: goes on sending a frame every 50 ms and never closes anything, for a signal to end it mid-recording.
// - `forget`: finishes the recording, prints its status, and returns without `close()`, so this process may exit
//   only if the client lets it.

import { MediaProcess, mediaArguments } from '../../src/media/client.ts'
import { encodePng, solidImage } from './png.ts'
import { frameUntilPartial } from './support.ts'

const [binary, ffmpeg, output, mode] = process.argv.slice(2)
if (binary === undefined || ffmpeg === undefined || output === undefined || (mode !== 'keep' && mode !== 'forget')) {
  throw new Error('usage: recording-child.ts <binary> <ffmpeg> <output> keep|forget')
}

const media = await MediaProcess.start({ executable: binary, args: mediaArguments({ ffmpeg }), startTimeoutMs: 5000 })
const start = await media.record({ recordingId: 'child', width: 64, height: 48, fps: 10, output, deadlineMs: 10_000 }, 5000)
if (start.kind !== 'started') throw new Error(`the recording did not start: ${JSON.stringify(start)}`)
const { recording } = start
const bytes = encodePng(solidImage(64, 48, [120, 40, 200]))
let sent = await frameUntilPartial(recording, bytes)
console.log(JSON.stringify({ mediaPid: media.pid, encoderPid: recording.started.encoderPid, partialPath: `${recording.started.path}.partial` }))

if (mode === 'keep') {
  setInterval(() => {
    recording.frame({ timestampUs: sent * 100_000, format: 'png', bytes })
    sent += 1
  }, 50)
} else {
  const ended = await recording.finish(15_000)
  console.log(JSON.stringify({ ended: ended.status, path: ended.path }))
}
