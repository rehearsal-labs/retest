import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { MediaProcess } from '../../src/media/client.ts'

export async function worker(t: TestContext, mode: string, options: { maxPendingBytes?: number; maxPendingRequests?: number } = {}): Promise<MediaProcess> {
  const media = await MediaProcess.start({ executable: process.execPath, args: [join(import.meta.dirname, 'media-client-worker.ts'), mode], startTimeoutMs: 5000, ...options })
  t.after(async () => { await media.close(500).catch((error: Error) => { assert.match(error.message, /^Media protocol failed:/) }); assert.throws(() => process.kill(media.pid, 0), /ESRCH/) })
  return media
}
