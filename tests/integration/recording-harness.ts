import type { TestContext } from 'node:test'
import type { FinishedRun, StartedRun } from './cli-harness.ts'
import type { RecordingRecord } from '../../src/protocol/recording.ts'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { mediaTarget } from '../../src/cli/install/media-pins.ts'
import { OwnedProcessGroup } from '../../src/shared/process-ownership.ts'
import { rebuildRecordedResult } from '../../src/store/rebuild-result.ts'
import { browserPath, openApp, waitForGroupEnd } from './browser-harness.ts'
import { budgets, configSource, finishRun, repositoryRoot, startRun, writeProject } from './cli-harness.ts'

export const file = 'tests/record.retest.ts'

const recordingTools = [
  ['the media binary', process.env['RETEST_TEST_MEDIA_BINARY'] ?? join(repositoryRoot, 'media/target/release/retest-media'), 'RETEST_TEST_MEDIA_BINARY'],
  ['ffmpeg', process.env['RETEST_TEST_FFMPEG'] ?? '/opt/homebrew/bin/ffmpeg', 'RETEST_TEST_FFMPEG'],
  ['ffprobe', process.env['RETEST_TEST_FFPROBE'] ?? '/opt/homebrew/bin/ffprobe', 'RETEST_TEST_FFPROBE'],
] as const

/**
 * The skip for a test that records with the real media binary and ffmpeg, or false where it can run. On macOS it is
 * always false, so a gate that forgot to build the binary fails by name. Elsewhere a machine with no pinned media target
 * records nothing, and one without the tools cannot record.
 *
 * @example test('records a video', { skip: recordingSkip }, async (t) => {})
 */
export const recordingSkip: string | false = process.platform === 'darwin' ? false : recordingProblem()

function recordingProblem(): string | false {
  if (mediaTarget() === undefined) return `unverified: retest-media has a pinned target for macOS arm64 and Linux x64 only, and this machine is ${process.platform} ${process.arch}`
  const missing = recordingTools.filter(([, path]) => !existsSync(path)).map(([name, path, variable]) => `${name} at ${path} (or set ${variable})`)
  return missing.length === 0 ? false : `unverified: recording needs ${missing.join(', ')}, which this machine lacks`
}

export async function recordingRun(t: TestContext, source: string, options: { record?: boolean; required?: boolean; timeout?: number; keep?: 'all' | 'failures' } = {}): Promise<StartedRun> {
  const app = await openApp(t)
  const root = await writeProject(t, {
    'retest.config.ts': configSource(`{ apps: { web: chromium({ executablePath: ${JSON.stringify(browserPath())}, baseUrl: ${JSON.stringify(app.url)} }) }, recording: { record: ${options.record ?? true}, required: ${options.required ?? false}, keep: ${JSON.stringify(options.keep ?? 'all')}, fps: 10, size: { width: 320, height: 240 } } }`),
    [file]: source,
  })
  const executable = process.env['RETEST_TEST_MEDIA_BINARY'] ?? join(repositoryRoot, 'media/target/release/retest-media')
  const ffmpeg = process.env['RETEST_TEST_FFMPEG'] ?? '/opt/homebrew/bin/ffmpeg'
  if (options.record !== false) {
    assert.ok(existsSync(executable), 'build or explicitly name the media binary before this gate')
    assert.ok(existsSync(ffmpeg), 'explicit ffmpeg prerequisite exists')
  }
  const mediaBinary = options.record === false ? join(root, 'missing-media') : executable
  const encoder = options.record === false ? join(root, 'missing-ffmpeg') : ffmpeg
  return startRun(t, { cwd: root, browser: false, files: [file], timeouts: budgets({ test: options.timeout ?? 15000 }), env: { RETEST_MEDIA_BINARY: mediaBinary, RETEST_FFMPEG: encoder } })
}

export function ownershipOf(started: StartedRun): OwnedProcessGroup {
  const owner = new OwnedProcessGroup(started.retest.pid)
  assert.deepEqual(owner.capture(), [], 'record this test run and its launch descendants')
  return owner
}

export function encoderPid(mediaPid: number): number {
  const rows = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,comm='], { encoding: 'utf8', timeout: 5000 }).split('\n')
  const matches = rows.flatMap(row => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(row)
    // macOS reports the executable path in comm; Linux reports its basename. The direct parent stays required.
    return match?.[1] !== undefined && Number(match[2]) === mediaPid && basename(match[3] ?? '') === 'ffmpeg' ? [Number(match[1])] : []
  })
  assert.equal(matches.length, 1, 'the running recording has one ffmpeg encoder')
  return matches[0] ?? 0
}

export function killOwned(owner: OwnedProcessGroup, pid: number): void {
  assert.ok(owner.verifiedIdentity(pid), 'only a recorded launch descendant can be killed')
  process.kill(pid, 'SIGKILL')
}

export async function finishRecordingRun(started: StartedRun, owner?: OwnedProcessGroup): Promise<FinishedRun> {
  const run = await finishRun(started)
  assert.ok(run.result)
  assert.deepEqual(rebuildRecordedResult(run.events), run.result, 'events rebuild exactly to result.json')
  for (const event of run.events) if (event.type === 'media.started') await waitForGroupEnd(event.media.pid, 5000)
  if (owner !== undefined) {
    assert.equal(owner.remains(), false, 'the media worker, encoder, browser and test processes are gone through ownership')
    assert.deepEqual(owner.readProblems, [])
  }
  return run
}

export function decoded(run: FinishedRun, recording: RecordingRecord): void {
  assert.ok(recording.path && recording.video && recording.clock, 'a usable recording has path, video facts and clock mapping')
  const path = join(run.output, recording.path)
  const probe = execFileSync(process.env['RETEST_TEST_FFPROBE'] ?? '/opt/homebrew/bin/ffprobe', ['-v', 'error', '-count_frames', '-show_entries', 'stream=codec_name,width,height,nb_read_frames:format=duration', '-of', 'json', path], {encoding:'utf8', timeout:15000})
  const read: { streams: { codec_name: string; width: number; height: number; nb_read_frames: string }[]; format: { duration: string } } = JSON.parse(probe)
  assert.equal(read.streams.length, 1)
  const stream = read.streams[0]
  assert.ok(stream)
  assert.deepEqual([stream.codec_name, stream.width, stream.height, Number(stream.nb_read_frames)], [recording.video.codec, recording.video.width, recording.video.height, recording.video.outputFrames])
  assert.ok(recording.video.outputFrames > 0)
  assert.ok(Math.abs(Number(read.format.duration) * 1e6 - recording.video.durationUs) <= 100000)
  execFileSync(process.env['RETEST_TEST_FFMPEG'] ?? '/opt/homebrew/bin/ffmpeg', ['-v', 'error', '-xerror', '-i', path, '-f', 'null', '-'], { timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] })
  console.log(`decoded ${recording.recordingId}: ${stream.nb_read_frames} ${stream.codec_name} frames, ${read.format.duration} s, ${stream.width}x${stream.height}`)
}

export function saveProof(run: FinishedRun, name: string): void {
  const proof = process.env['RETEST_RECORDING_PROOF_OUT']
  if (proof === undefined) return
  mkdirSync(proof, {recursive:true})
  const output = join(proof, name)
  assert.equal(existsSync(output), false, 'proof folders are never overwritten')
  cpSync(run.output, output, {recursive:true})
}

export function partialFiles(folder: string): string[] {
  return readdirSync(folder, {recursive:true, encoding:'utf8'}).filter(path => path.endsWith('.partial') || path.endsWith('.copying'))
}
