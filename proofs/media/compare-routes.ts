// Replay one saved Chrome input through both routes. This is a single-machine measurement, not a speed claim.
// Build the measuring binary with --features allocation-counts in a separate --target-dir, then run with
// RETEST_MEDIA_BINARY=<measuring binary> node --conditions=retest-source proofs/media/compare-routes.ts <proof folder> <output folder>
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { MediaProcess, mediaEnvironment } from '../../src/media/client.ts'
import { parse, s } from '../../src/protocol/schema.ts'
import { decodePng } from './png.ts'
import { changingBox, childrenOf, decodeAllFrames, differingPixels, ffmpegPath, groupMembers, lumaInBox, mediaBinary, parseTimeOutput, probeVideo, processAlive, proofIdentity, samePixels } from './support.ts'

const input = resolve(process.argv[2] ?? '')
const out = resolve(process.argv[3] ?? '')
assert.ok(process.argv[2] !== undefined && process.argv[3] !== undefined, 'pass the proof folder and a new measurement output folder')
await mkdir(out, { recursive: true })
const binary = mediaBinary()
const ffmpeg = ffmpegPath()
const manifest = parse(s.array(s.object({ index: s.number({ integer: true, min: 0 }), timestampUs: s.number({ integer: true, min: 0 }), typedBefore: s.number(), typedAfter: s.number(), byteLength: s.number({ integer: true, min: 1 }) })), JSON.parse(await readFile(join(input, 'input', 'captures.json'), 'utf8')))
assert.ok(manifest.ok, JSON.stringify(manifest))
const captures = await Promise.all(manifest.value.map(async (capture) => ({ ...capture, bytes: await readFile(join(input, 'input', `${capture.index}.png`)) })))
for (const capture of captures) assert.equal(capture.bytes.byteLength, capture.byteLength)
const sources = captures.map((capture) => decodePng(capture.bytes))
const first = sources[0]
assert.ok(first !== undefined)
const dimensions = { width: first.width, height: first.height }
const box = changingBox(sources)
assert.ok(box !== undefined, 'saved input must contain changes')
const selectedBox = box
const lumas = sources.map((source) => lumaInBox(source, selectedBox))
const twins = sources.map((source) => sources.flatMap((other, index) => samePixels(source, other, selectedBox) ? [index] : []))
const pids = new Set<number>()
const groups = new Set<number>()

function cpuSeconds(pid: number): number {
  return execFileSync('ps', ['-o', 'time=', '-p', String(pid)], { encoding: 'utf8' }).trim().split(':').reduce((total, part) => total * 60 + Number(part), 0)
}

async function measure(route: 'decoded' | 'encoded', run: number) {
  const name = `${route}-${run}`
  const folder = join(out, name)
  await mkdir(folder)
  // These paths are local proof paths; quote them as shell strings, including an embedded apostrophe.
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
  const encoderTime = join(folder, 'encoder-time.txt')
  const mediaTime = join(folder, 'media-time.txt')
  const allocationLog = join(folder, 'allocations.txt')
  const encoderScript = join(folder, 'encoder.sh')
  await writeFile(encoderScript, `#!/bin/sh\nexec /usr/bin/time -l -a -o ${quote(encoderTime)} ${quote(ffmpeg)} "$@"\n`, { mode: 0o755 })
  const media = await MediaProcess.start({ executable: '/usr/bin/time', args: ['-l', '-o', mediaTime, binary, '--ffmpeg', encoderScript], startTimeoutMs: 10_000, env: { ...mediaEnvironment(process.env), RETEST_MEDIA_ALLOCATION_LOG: allocationLog } })
  pids.add(media.pid)
  const worker = childrenOf(media.pid)[0]
  assert.ok(worker !== undefined)
  pids.add(worker)
  let peakMediaRss = 0
  let peakEncoderRss = 0
  let encoderPid: number | undefined
  const sample = () => {
    const listing = execFileSync('ps', ['-axo', 'pid=,ppid=,rss='], { encoding: 'utf8' }).trim().split('\n').map((line) => line.trim().split(/\s+/).map(Number))
    for (const [pid, parent, rss] of listing) {
      if (pid === worker) peakMediaRss = Math.max(peakMediaRss, (rss ?? 0) * 1024)
      if (encoderPid !== undefined && parent === encoderPid) peakEncoderRss = Math.max(peakEncoderRss, (rss ?? 0) * 1024)
    }
  }
  const timer = setInterval(sample, 50)
  try {
    const probe = await media.ready(10_000)
    assert.equal(probe.state, 'ready', JSON.stringify(probe))
    const cpuBefore = cpuSeconds(worker)
    const start = await media.record({ recordingId: name, identity: proofIdentity(name), ...dimensions, fps: 30, output: join(folder, 'video'), deadlineMs: 20_000, queueFrames: 128, ...(route === 'encoded' ? { encodedFormat: 'png' as const } : {}) }, 10_000)
    assert.ok(start.kind === 'started', JSON.stringify(start))
    const recording = start.recording
    assert.equal(recording.started.route, route)
    encoderPid = recording.started.encoderPid
    groups.add(encoderPid)
    const origin = performance.now()
    for (const capture of captures) {
      // Identical input bytes, timestamps and paced delivery on each route.
      const wait = origin + (capture.timestampUs - (captures[0]?.timestampUs ?? 0)) / 1000 - performance.now()
      if (wait > 0) await delay(wait)
      assert.equal(recording.frame({ frameId: `capture-${capture.index}`, timestampUs: capture.timestampUs, format: 'png', bytes: capture.bytes }), 'sent')
    }
    const ended = await recording.finish(30_000, 3_000_000)
    sample()
    const mediaCpu = cpuSeconds(worker) - cpuBefore
    assert.equal(ended.status, 'ok', JSON.stringify(ended))
    assert.equal(ended.frames.received, captures.length)
    assert.equal(ended.frames.dropped + ended.frames.undecodable + ended.frames.unprocessed + ended.frames.duplicate, 0)
    assert.deepEqual(ended.evidence, { status: 'complete', reasons: [] })
    const exit = await media.close(15_000)
    assert.deepEqual([exit.code, exit.signal, exit.forced], [0, null, false])
    const allocations = /(\d+) allocations, (\d+) bytes allocated, (\d+) bytes live at peak/.exec(await readFile(allocationLog, 'utf8'))
    assert.ok(allocations !== null, 'use a binary built with --features allocation-counts')
    const encoderRuns = parseTimeOutput(await readFile(encoderTime, 'utf8'))
    const encoder = encoderRuns.at(-1)
    assert.ok(encoder !== undefined)
    const video = await probeVideo(ended.path ?? '')
    assert.equal(video.framesDecoded, ended.outputFrames)
    assert.ok(Math.abs(video.durationSeconds - ended.durationUs / 1_000_000) <= 0.05)
    const frames = await decodeAllFrames(ended.path ?? '', join(folder, 'decoded'), 'frame')
    assert.equal(frames.length, video.framesDecoded)
    for (const [index, frame] of frames.entries()) {
      const expected = captures.filter((capture) => Math.round((capture.timestampUs - (captures[0]?.timestampUs ?? 0)) * 30 / 1_000_000) <= index).at(-1)
      assert.ok(expected !== undefined)
      const luma = lumaInBox(frame, selectedBox)
      const differences = lumas.map((source) => differingPixels(luma, source, 48))
      const others = differences.filter((_, at) => !(twins[expected.index] ?? []).includes(at))
      assert.ok(Math.min(...others) > (differences[expected.index] ?? Infinity), `frame ${index} does not match capture ${expected.index}`)
    }
    const result = {
      route, run, started: recording.started, ended, video, framesChecked: frames.length,
      clientTraffic: media.traffic,
      media: { recordingCpuSecondsByPs: Math.round(mediaCpu * 100) / 100, peakResidentBytesSampled: peakMediaRss, allocations: Number(allocations[1]), allocatedBytes: Number(allocations[2]), peakLiveAllocatedBytes: Number(allocations[3]) },
      encoder: { ...encoder, peakResidentBytesSampled: peakEncoderRss },
      processTimeIncludingChildren: parseTimeOutput(await readFile(mediaTime, 'utf8')).at(-1),
    }
    await writeFile(join(folder, 'result.json'), `${JSON.stringify(result, null, 2)}\n`)
    console.log(JSON.stringify({ route, run, media: result.media, encoder, bytesToEncoder: ended.bytesToEncoder }))
    return result
  } finally {
    clearInterval(timer)
    await media.close(15_000)
  }
}

const results: Awaited<ReturnType<typeof measure>>[] = []
for (let run = 0; run < 3; run += 1) {
  for (const route of run % 2 === 0 ? ['decoded', 'encoded'] as const : ['encoded', 'decoded'] as const) results.push(await measure(route, run))
}
assert.deepEqual([...pids].filter(processAlive), [])
assert.deepEqual([...groups].flatMap(groupMembers), [])
const hash = createHash('sha256')
for (const capture of captures) hash.update(capture.bytes)
await writeFile(join(out, 'results.json'), `${JSON.stringify({ binary, binarySha256: createHash('sha256').update(await readFile(binary)).digest('hex'), ffmpeg, input, inputSha256: hash.digest('hex'), host: { platform: process.platform, arch: process.arch, node: process.version }, inputFrames: captures.length, inputBytes: captures.reduce((total, frame) => total + frame.bytes.byteLength, 0), results }, null, 2)}\n`)
