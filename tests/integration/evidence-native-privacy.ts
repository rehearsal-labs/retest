import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FinishedRun } from './cli-harness.ts'
import type { RecordingRecord } from '../../src/protocol/recording.ts'
import { isPlainObject } from '../../src/protocol/schema.ts'
import { decoder, observationLoader, observations, proofRoot } from './evidence-support.test.ts'

/** Original source calls and delivery stay intact. Retain only native read spans and image hashes before policy. */
export function nativeObservationLoader(folder: string, awaitFilledState: boolean = false): string {
  const path = observationLoader(folder)
  appendFileSync(path, `registerHooks({ load(url, context, nextLoad) {
    const loaded = nextLoad(url, context)
    if (!url.endsWith('/src/media/capture.ts')) return loaded
    return { ...loaded, source: String(loaded.source) + ${JSON.stringify(`
import { appendFileSync as nativeSpanAppend, existsSync as nativeSpanExists, writeFileSync as nativeSpanWrite } from 'node:fs'
import { createHash as nativeSpanHash } from 'node:crypto'
const nativeSpanStart = ScreenshotLoopSource.prototype.start
ScreenshotLoopSource.prototype.start = function(capture) {
  let notBeforeUs
  return nativeSpanStart.call(this, { ...capture, deliver: frame => {
    const nativeApp = frame.identity.app === 'phone' || frame.identity.app === 'desk'
    if (nativeApp) nativeSpanAppend(${JSON.stringify(join(folder, 'native-source-spans.jsonl'))}, JSON.stringify({ sessionId: frame.identity.sessionId, earliestUs: frame.earliestUs, timestampUs: frame.timestampUs, imageSha256: nativeSpanHash('sha256').update(frame.bytes).digest('hex') }) + '\\n')
    capture.deliver(frame)
    // A marker is written only after fill completed. Observe one delivery, then require an entirely newer read.
    // Final checks still independently require that this real source reached media and was shown in the movie.
    if (${awaitFilledState} && nativeApp) {
      const prefix = ${JSON.stringify(folder)} + '/' + frame.identity.app + '-filled-frame'
      if (!nativeSpanExists(prefix + '-request')) return
      if (notBeforeUs === undefined) notBeforeUs = capture.clock() + 1000
      else if (frame.earliestUs !== undefined && frame.earliestUs >= notBeforeUs) nativeSpanWrite(prefix + '-ready', 'fresh native read delivered\\n')
    }
  } })
}
`)} }
  } })\n`)
  return path
}

/** Count sources shown in the movie whose entire native read began after fill and ended before sign-in input. */
export function nativeCapturesInside(folder: string, recording: RecordingRecord, fromUs: number, untilUs: number): number {
  const spans = readFileSync(join(folder, 'native-source-spans.jsonl'), 'utf8').trim().split('\n').map(line => {
    const value: unknown = JSON.parse(line)
    assert.ok(isPlainObject(value))
    assert.ok(typeof value['sessionId'] === 'string')
    assert.ok(typeof value['imageSha256'] === 'string' && /^[0-9a-f]{64}$/.test(value['imageSha256']))
    const earliestUs = value['earliestUs'], timestampUs = value['timestampUs']
    assert.ok(typeof earliestUs === 'number' && Number.isSafeInteger(earliestUs) && earliestUs >= 0)
    assert.ok(typeof timestampUs === 'number' && Number.isSafeInteger(timestampUs) && timestampUs >= earliestUs)
    return { sessionId: value['sessionId'], imageSha256: value['imageSha256'], earliestUs, timestampUs }
  }).filter(span => span.sessionId === recording.sessionId)
  const approved = observations(folder, recording)
  assert.equal(approved.ended.frameMapOmitted, 0, 'the whole movie map is required for the filled-state witness')
  const shown = new Set(approved.ended.frameMap.filter(frame => frame.fate === 'shown').map(frame => frame.frameId))
  return approved.frames.filter(frame => {
    const hash = createHash('sha256').update(readFileSync(join(approved.folder, frame.image))).digest('hex')
    const matching = spans.filter(span => span.timestampUs === frame.timestampUs && span.imageSha256 === hash)
    assert.equal(matching.length, 1, 'every approved native source has one independently recorded read span')
    const span = matching[0]
    assert.ok(span)
    return frame.outcome === 'sent' && shown.has(frame.frameId) && span.earliestUs >= fromUs && span.timestampUs < untilUs
  }).length
}

/** Check every approved native source image. Vision receives the value only through stdin and emits counts only. */
export async function verifyNativeSourcePrivacy(run: FinishedRun, observedFolder: string, secret: string, expectedApps: readonly string[] = ['desk', 'phone']): Promise<object> {
  const recordings = run.result?.files.flatMap(file => file.tests).flatMap(result => result.recordings ?? []).filter(record => record.app === 'phone' || record.app === 'desk') ?? []
  assert.deepEqual(recordings.map(recording => recording.app).sort(), [...expectedApps].sort())
  const images: string[] = []
  const counts: { app: string; images: number }[] = []
  for (const recording of recordings) {
    const observed = observations(observedFolder, recording)
    assert.equal(observed.ended.frameMapOmitted, 0, 'the whole movie map is required')
    const sources = new Set(observed.frames.map(frame => frame.frameId))
    assert.ok(observed.ended.frameMap.every(frame => sources.has(frame.frameId)), 'every movie source is among the images checked')
    assert.ok(observed.frames.length > 0)
    counts.push({ app: recording.app, images: observed.frames.length })
    for (const frame of observed.frames) images.push(join(observed.folder, frame.image))
  }
  mkdirSync(proofRoot, { recursive: true })
  const binary = join(proofRoot, 'native-privacy')
  if (!existsSync(binary)) await decoder('/usr/bin/xcrun', ['swiftc', fileURLToPath(new URL('./evidence-native-privacy.swift', import.meta.url)), '-o', binary])
  const raw = await new Promise<Buffer>((resolve, reject) => {
    let identityFailure: Error | undefined
    const child = execFile(binary, [], { encoding: 'buffer', timeout: 300000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error !== null) reject(new Error('Native source pixel privacy check did not complete.'))
      else if (identityFailure !== undefined) reject(identityFailure)
      else resolve(stdout)
    })
    try {
      appendFileSync(join(proofRoot, 'decoder-processes.jsonl'), JSON.stringify({ pid: child.pid, command: binary, args: [], state: 'started' }) + '\n')
      assert.ok(child.pid !== undefined)
      const identity = execFileSync('/bin/ps', ['-ww', '-o', 'lstart=,args=', '-p', String(child.pid)], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', TZ: 'UTC0' } }).trim()
      assert.ok(identity.length > 0)
      appendFileSync(join(proofRoot, 'decoder-processes.jsonl'), JSON.stringify({ pid: child.pid, command: binary, args: [], identity }) + '\n')
    } catch {
      // The callback still waits for this exact child to close. Unreadable identity cannot be a passing proof.
      identityFailure = new Error('The native privacy child identity could not be confirmed; its exit was awaited.')
    }
    child.stdin?.end(JSON.stringify({ secret, images }))
  })
  const result: { imagesChecked: number; recognizedSecretImages: number; positiveControls: number; maskedControls: number } = JSON.parse(raw.toString())
  assert.deepEqual(result, { imagesChecked: images.length, recognizedSecretImages: 0, positiveControls: 1, maskedControls: 1 })
  const proof = { method: 'Vision accurate text recognition on every approved native source; every whole-movie-map source included', ...result, counts }
  writeFileSync(join(observedFolder, 'source-privacy.json'), JSON.stringify(proof, null, 2) + '\n')
  return proof
}
