import type { TestResult } from '../../src/protocol/result.ts'
import type { FinishedRun } from './cli-harness.ts'
import type { Ended, RecordingIdentity } from '../../src/media/protocol.ts'
import type { RecordingRecord } from '../../src/protocol/recording.ts'
import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildReport } from '../../src/reporters/html/build-report.ts'
import { createHumanReporter } from '../../src/reporters/human.ts'
import { countParts } from '../../src/reporters/format.ts'
import { rebuildRecordedResult } from '../../src/store/rebuild-result.ts'
import { filesHolding, repositoryRoot } from './cli-harness.ts'

const evidenceRoot = join(repositoryRoot, '.retest/evidence-targets')
mkdirSync(evidenceRoot, { recursive: true })
// Each test process owns a fresh proof folder. Explicitly retained folders still refuse overwriting a prior run.
export const proofRoot: string = process.env['RETEST_EVIDENCE_OUT'] ?? mkdtempSync(join(evidenceRoot, 'artifacts-'))
export const ffmpeg: string = process.env['RETEST_TEST_FFMPEG'] ?? '/opt/homebrew/bin/ffmpeg'
export const ffprobe: string = process.env['RETEST_TEST_FFPROBE'] ?? '/opt/homebrew/bin/ffprobe'
export const binary: string = process.env['RETEST_TEST_MEDIA_BINARY'] ?? join(repositoryRoot, 'media/target/release/retest-media')

// Observation only: original calls receive their original arguments and their results are returned unchanged.
export function observationLoader(folder: string): string {
  mkdirSync(folder, { recursive: true })
  const path = join(folder, 'observe.mjs')
  writeFileSync(path, `import { registerHooks } from 'node:module'
registerHooks({ load(url, context, nextLoad) {
 const loaded = nextLoad(url, context)
 if (!url.endsWith('/src/media/client.ts')) return loaded
 return { ...loaded, source: String(loaded.source) + ${JSON.stringify(`
import { appendFileSync as evidenceAppend, mkdirSync as evidenceMkdir, writeFileSync as evidenceWrite } from 'node:fs'
import { join as evidenceJoin } from 'node:path'
const evidenceFolder = ${JSON.stringify(folder)}
const evidenceRecord = MediaProcess.prototype.record
MediaProcess.prototype.record = async function(...args) {
 const answer = await evidenceRecord.apply(this, args)
 if (answer.kind !== 'started') return answer
 const recording = answer.recording
 const folder = evidenceJoin(evidenceFolder, recording.id)
 evidenceMkdir(folder, { recursive: true })
 evidenceWrite(evidenceJoin(folder, 'start.json'), JSON.stringify(recording.started))
 const send = recording.frame.bind(recording)
 recording.frame = frame => {
  const outcome = send(frame)
  const image = frame.frameId + '.' + (frame.format === 'jpeg' ? 'jpg' : 'png')
  evidenceWrite(evidenceJoin(folder, image), frame.bytes)
  evidenceAppend(evidenceJoin(folder, 'frames.jsonl'), JSON.stringify({ frameId: frame.frameId, timestampUs: frame.timestampUs, format: frame.format, identity: recording.identity, outcome, image }) + '\\n')
  return outcome
 }
 recording.ended.then(ended => evidenceWrite(evidenceJoin(folder, 'end.json'), JSON.stringify(ended)), () => evidenceWrite(evidenceJoin(folder, 'end-error.json'), JSON.stringify({ state: 'unavailable', reason: 'The observed recording ending rejected; its exact reason belongs to the run recording gap.' })))
 return answer
}
`)} }
} })\n`)
  return path
}

export type ObservedFrame = { frameId: string; timestampUs: number; format: string; identity: RecordingIdentity; outcome: string; image: string }
export function observations(folder: string, recording: RecordingRecord): { frames: ObservedFrame[]; ended: Ended; folder: string } {
  const root = join(folder, recording.recordingId)
  return { folder: root, frames: readFileSync(join(root, 'frames.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)), ended: JSON.parse(readFileSync(join(root, 'end.json'), 'utf8')) }
}

export function decoder(command: string, args: string[], options: { maximum?: number; timeoutMs?: number } = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, { encoding: 'buffer', timeout: options.timeoutMs ?? 60000, maxBuffer: options.maximum ?? 64 * 1024 * 1024 }, (error, stdout) => error === null ? resolve(stdout) : reject(error))
    const identity = child.pid === undefined ? undefined : execFileSync('/bin/ps', ['-ww', '-o', 'lstart=,args=', '-p', String(child.pid)], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', TZ: 'UTC0' } }).trim()
    appendFileSync(join(proofRoot, 'decoder-processes.jsonl'), JSON.stringify({ pid: child.pid, command, args, identity }) + '\n')
  })
}

export async function verifyVideo(run: FinishedRun, recording: RecordingRecord, observedFolder: string, reportFile: string = join(observedFolder, recording.recordingId, 'decode.json')): Promise<void> {
  assert.ok(recording.path && recording.video && recording.clock, 'playable video, facts and clock are required')
  const video = recording.video
  const path = join(run.output, recording.path)
  const probe: { streams: { codec_name: string; width: number; height: number; nb_read_frames: string }[]; format: { duration: string } } = JSON.parse((await decoder(ffprobe, ['-v', 'error', '-count_frames', '-show_entries', 'stream=codec_name,width,height,nb_read_frames:format=duration', '-of', 'json', path])).toString())
  assert.equal(probe.streams.length, 1)
  const stream = probe.streams[0]
  assert.ok(stream)
  assert.deepEqual([stream.codec_name, stream.width, stream.height, Number(stream.nb_read_frames)], [video.codec, video.width, video.height, video.outputFrames])
  assert.ok(video.outputFrames > 0)
  assert.ok(Math.abs(Number(probe.format.duration) * 1e6 - video.durationUs) <= 100000)
  await decoder(ffmpeg, ['-v', 'error', '-xerror', '-i', path, '-f', 'null', '-'])
  const observed = observations(observedFolder, recording)
  const identity = { runId: run.result?.runId, testId: recording.testId, attemptId: recording.attemptId, app: recording.app, sessionId: recording.sessionId }
  assert.deepEqual(observed.ended.identity, identity)
  assert.equal(observed.ended.frameMapOmitted, 0)
  assert.equal(observed.ended.outputFrames, video.outputFrames)
  assert.equal(recording.clock.videoZeroUs, observed.ended.firstTimestampUs)
  assert.deepEqual(recording.clock.shortened, observed.ended.gaps)
  const sent = observed.frames.filter(frame => frame.outcome === 'sent')
  assert.ok(sent.length > 0)
  for (const frame of observed.frames) assert.deepEqual(frame.identity, identity, 'every forwarded frame carries the recording identity')
  for (let index = 1; index < sent.length; index += 1) assert.ok((sent[index]?.timestampUs ?? 0) >= (sent[index - 1]?.timestampUs ?? 0), 'frame order is monotonic')
  assert.deepEqual(observed.ended.frameMap.map(frame => frame.frameId), sent.map(frame => frame.frameId))
  assert.deepEqual(observed.ended.frameMap.map(frame => frame.captureUs), sent.map(frame => frame.timestampUs), 'the media map retains each actual capture timestamp')
  const width = 64, height = 48
  const raw = await decoder(ffmpeg, ['-v', 'error', '-xerror', '-i', path, '-vf', `scale=${width}:${height}:flags=area`, '-pix_fmt', 'gray', '-f', 'rawvideo', 'pipe:1'])
  assert.equal(raw.length, video.outputFrames * width * height, 'whole video independently decodes through final frame')
  const shown = observed.ended.frameMap.filter(frame => frame.fate === 'shown')
  assert.ok(shown.length > 0)
  const sample = [...new Set([shown[0], shown[Math.floor(shown.length / 2)], shown.at(-1)])]
  const matches: object[] = []
  for (const frame of sample) {
    assert.ok(frame && frame.videoUs !== undefined)
    const source = sent.find(each => each.frameId === frame.frameId)
    assert.ok(source)
    let reference = join(observed.folder, source.image)
    if (recording.source === 'webkit') {
      // The macOS WebKit source embeds its display profile. ffmpeg ignores ICC transforms, so ColorSync
      // independently converts the reference's intended colours to sRGB. Keep the original source untouched.
      const srgb = join(observed.folder, `${source.frameId}-reference-srgb.png`)
      await decoder('/usr/bin/sips', ['--matchToWithIntent', '/System/Library/ColorSync/Profiles/sRGB Profile.icc', 'relative', '--setProperty', 'format', 'png', reference, '--out', srgb])
      assert.ok(existsSync(srgb), 'ColorSync produced the independent sRGB reference')
      reference = srgb
    }
    const pixels = await decoder(ffmpeg, ['-v', 'error', '-i', reference, '-vf', `scale=${video.width}:${video.height}:force_original_aspect_ratio=decrease:flags=bilinear,pad=${video.width}:${video.height}:(ow-iw)/2:(oh-ih)/2:black,scale=${width}:${height}:flags=area`, '-pix_fmt', 'gray', '-frames:v', '1', '-f', 'rawvideo', 'pipe:1'])
    assert.equal(pixels.length, width * height)
    const index = Math.round(frame.videoUs * video.fps / 1e6)
    assert.ok(index >= 0 && index < video.outputFrames)
    const actual = raw.subarray(index * width * height, (index + 1) * width * height)
    let error = 0
    for (let byte = 0; byte < actual.length; byte += 1) error += Math.abs((actual[byte] ?? 0) - (pixels[byte] ?? 0))
    const mean = error / actual.length
    assert.ok(mean < 12, `video frame ${index} differs from its mapped source by ${mean}`)
    matches.push({ frameId: frame.frameId, videoFrame: index, meanAbsolutePixelError: mean, sourceReference: reference, colourReference: recording.source === 'webkit' ? 'ColorSync relative colorimetric to sRGB' : 'source sRGB' })
  }
  const start = run.events.find(event => event.type === 'test.started' && event.attemptId === recording.attemptId)
  const end = run.events.find(event => event.type === 'test.finished' && event.attemptId === recording.attemptId)
  assert.ok(start && end)
  assert.ok(video.durationUs <= (end.elapsedMs - start.elapsedMs) * 1000 + 200000)
  writeFileSync(reportFile, JSON.stringify({ identity, probe, decodedFrames: video.outputFrames, samples: matches, captureCadencePerSecond: sent.length < 2 ? null : (sent.length - 1) * 1e6 / Math.max(1, (sent.at(-1)?.timestampUs ?? 0) - (sent[0]?.timestampUs ?? 0)), cadenceMethod: 'forwarded intervals / elapsed time between first and last forwarded capture timestamps; secret withholding remains in that elapsed span', recording }, null, 2))
}

export function preserve(run: FinishedRun, name: string): string {
  const path = join(proofRoot, name)
  assert.equal(existsSync(path), false, 'run folders are never overwritten')
  mkdirSync(proofRoot, { recursive: true })
  cpSync(run.output, path, { recursive: true })
  return path
}

export async function preserveReport(run: FinishedRun, name: string): Promise<string> {
  const kept = preserve(run, name)
  // Keep raw evidence even when the independent report verification fails.
  await reportFor({ ...run, output: kept })
  for (const file of ['report.html', 'terminal-report.txt']) cpSync(join(kept, file), join(run.output, file))
  return kept
}

export async function reportFor(run: FinishedRun): Promise<string> {
  assert.ok(run.result)
  assert.deepEqual(rebuildRecordedResult(run.events), run.result)
  const report = await buildReport({ directory: run.output, shown: run.output, source: 'result.json', result: run.result, events: run.events, warnings: [] })
  writeFileSync(join(run.output, 'report.html'), report)
  const block = /<script type="application\/json" id="retest-outcome">([^<]*)<\/script>/.exec(report)?.[1]
  assert.ok(block, 'HTML contains the structured outcome')
  const data: { runId: string; status: string; exitCode: number; counts: object; tests: { testId: string; status: string }[] } = JSON.parse(block)
  assert.deepEqual([data.runId, data.status, data.exitCode, data.counts], [run.result.runId, run.result.status, run.result.exitCode, run.result.counts])
  assert.deepEqual(data.tests.map(test => [test.testId, test.status]), run.result.files.flatMap(file => file.tests).map(test => [test.testId, test.status]))
  let terminal = ''
  const writer = { write: (text: string): void => { terminal += text } }
  const human = createHumanReporter({ stdout: writer, stderr: writer, color: false, runFolder: run.output })
  for (const event of run.events) human.onEvent(event)
  human.onRunEnd(run.result)
  writeFileSync(join(run.output, 'terminal-report.txt'), terminal)
  const counts = countParts(run.result.counts).join(' · ')
  if (counts !== '') assert.ok(terminal.includes(counts), 'human terminal and structured reports name the same counts')
  for (const result of run.result.files.flatMap(file => file.tests)) for (const recording of result.recordings ?? []) {
    if (recording.path) assert.ok(report.includes(recording.path) && report.includes('<video controls'), 'HTML shows the real recording')
    if (recording.status !== 'complete') {
      assert.ok(recording.gaps.length > 0)
      for (const gap of recording.gaps) assert.ok(gap.message.length > 0 && report.includes(gap.message.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;').replaceAll('`', '&#96;')), 'HTML names the actual missing evidence')
      for (const gap of recording.gaps) assert.ok(terminal.includes(gap.message), 'human terminal names the actual missing evidence')
    }
  }
  return report
}

export function secretAbsent(run: FinishedRun, secret: string): void {
  assert.deepEqual(filesHolding(run.output, secret), [], 'no run file holds the secret in plain or encoded form')
  assert.equal(run.stdout.includes(secret) || run.stderr.includes(secret), false, 'secret absent from process output')
}

export async function verifyScreenshots(run: FinishedRun, result: TestResult): Promise<void> {
  const evaluation = result.evaluations?.flatMap(check => check.evidence).filter(item => item.kind === 'screenshot' && item.path !== undefined) ?? []
  assert.ok(evaluation.length > 0, 'normal pass and failure each have a real approved evaluation screenshot')
  for (const image of evaluation) {
    assert.ok(image.path)
    assert.deepEqual([image.testId, image.attemptId, image.app, image.sessionId], [result.testId, result.attemptId, result.recordings?.[0]?.app, result.recordings?.[0]?.sessionId])
    await decoder(ffmpeg, ['-v', 'error', '-xerror', '-i', join(run.output, image.path), '-f', 'null', '-'])
    assert.ok(readFileSync(join(run.output, 'report.html'), 'utf8').includes(image.path), 'HTML and judge use the same approved screenshot reference')
  }
  if (result.status === 'failed') {
    const image = result.evidence.find(item => item.kind === 'screenshot')
    assert.ok(image, 'expected assertion failure has a valid screenshot')
    await decoder(ffmpeg, ['-v', 'error', '-xerror', '-i', join(run.output, image.path), '-f', 'null', '-'])
  }
}
