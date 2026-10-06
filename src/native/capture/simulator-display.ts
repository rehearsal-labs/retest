import type { FrameFormat } from '../../media/client.ts'
import type { NativeTools } from '../processes.ts'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { errorMessage } from '../../protocol/failures.ts'
import { describeCommand, runCommand } from '../processes.ts'

/** One read of a simulator's display: where, in which format, and how long it may take. */
export type SimulatorDisplayGrab = { readonly tools: NativeTools; readonly udid: string; readonly format: FrameFormat; readonly timeoutMs: number; readonly signal: AbortSignal }

// The file signatures simctl writes: a PNG's eight bytes, and a JPEG's start of image.
const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const jpegSignature = [0xff, 0xd8, 0xff]

/**
 * Reads the simulator's display once with `xcrun simctl io <udid> screenshot --type=<format>`, which needs no executor,
 * and gives back the file simctl wrote exactly as it wrote it, after checking it starts as an image of that format does.
 * `simctl` writes to a file in a folder of its own under the temporary folder, removed after each read. Never throws.
 *
 * @example await grabSimulatorDisplay({ tools: systemTools, udid, format: 'jpeg', timeoutMs: 5000, signal }) // { ok: true, bytes }
 */
export async function grabSimulatorDisplay(options: SimulatorDisplayGrab): Promise<{ readonly ok: true; readonly bytes: Uint8Array } | { readonly ok: false; readonly problem: string }> {
  const { tools, udid, format, timeoutMs, signal } = options
  let folder: string | undefined
  let answer: { readonly ok: true; readonly bytes: Uint8Array } | { readonly ok: false; readonly problem: string }
  try {
    folder = await mkdtemp(join(tmpdir(), 'retest-display-'))
    const path = join(folder, format === 'png' ? 'display.png' : 'display.jpg')
    const result = await runCommand(tools.xcrun, ['simctl', 'io', udid, 'screenshot', `--type=${format}`, path], { timeoutMs, signal, hiddenVariables: tools.hiddenVariables })
    if (result.code !== 0 || result.cleanupProblems.length > 0) answer = { ok: false, problem: describeCommand('xcrun simctl io screenshot', result) }
    else {
      const bytes = new Uint8Array(await readFile(path))
      const signature = format === 'png' ? pngSignature : jpegSignature
      answer = signature.every((byte, index) => bytes[index] === byte)
        ? { ok: true, bytes }
        : { ok: false, problem: `xcrun simctl io screenshot wrote a file that is not a ${format === 'png' ? 'PNG' : 'JPEG'}.` }
    }
  } catch (error) {
    answer = { ok: false, problem: `The simulator's display could not be read: ${errorMessage(error)}` }
  }
  if (folder !== undefined) {
    try { await rm(folder, { recursive: true, force: true }) }
    catch (error) { answer = { ok: false, problem: `${answer.ok ? '' : `${answer.problem} `}The temporary simulator capture could not be removed: ${errorMessage(error)}` } }
  }
  return answer
}
