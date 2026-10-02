import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { ChromiumProcess } from '../../src/browser/chromium-process.ts'

// A process stands in for the browser: it gets the same group and pipes, and ends at once.
async function startShell(profile: string, logFile: string): Promise<ChromiumProcess> {
  return ChromiumProcess.start({ executable: '/bin/sh', args: ['-c', 'exit 0'], profile, logFile })
}

// A host that runs many runs in one process must not gain an exit hook for every browser it could not clean up.
test('a browser whose process group has gone takes its exit hook away, even when its profile could not be removed', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'retest-exit-hook-'))
  const locked = join(folder, 'locked')
  t.after(async () => {
    await chmod(locked, 0o755)
    await rm(folder, { recursive: true, force: true })
  })
  const profile = join(locked, 'profile')
  await mkdir(profile, { recursive: true })
  await writeFile(join(profile, 'Preferences'), '{}')
  // A folder nobody may write keeps the profile in it from being removed.
  await chmod(locked, 0o555)
  const before = process.listenerCount('exit')
  const browser = await startShell(profile, join(folder, 'browser.log'))
  assert.equal(process.listenerCount('exit'), before + 1, 'a running browser has its hook')
  const problems = await browser.stop(1000)
  assert.match(problems.join('\n'), /^Could not remove the browser profile /)
  assert.equal(process.listenerCount('exit'), before, 'nothing is left for the hook to kill')
})

test('a browser that stopped cleanly takes its exit hook away', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'retest-exit-hook-'))
  t.after(() => rm(folder, { recursive: true, force: true }))
  const profile = join(folder, 'profile')
  await mkdir(profile)
  const before = process.listenerCount('exit')
  const browser = await startShell(profile, join(folder, 'browser.log'))
  assert.deepEqual(await browser.stop(1000), [])
  assert.equal(process.listenerCount('exit'), before)
})
