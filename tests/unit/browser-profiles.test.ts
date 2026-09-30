import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { profilePrefix, removeStaleProfiles } from '../../src/browser/profiles.ts'
import { isRunning } from '../support/run-harness.ts'

/** The id of a process that has exited and been reaped. */
async function exitedPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
  const { pid } = child
  assert.ok(pid !== undefined)
  await once(child, 'exit')
  assert.equal(isRunning(pid), false)
  return pid
}

function scratch(t: TestContext): string {
  const folder = mkdtempSync(join(tmpdir(), 'retest-stale-test-'))
  t.after(() => rmSync(folder, { recursive: true, force: true }))
  return folder
}

test('a profile is named after the process that owns it', () => {
  assert.equal(profilePrefix(4242), 'retest-profile-4242-')
})

test('removes the profiles of processes that are gone and keeps every other entry', async (t) => {
  const folder = scratch(t)
  const dead = await exitedPid()
  const stale = [`${profilePrefix(dead)}a1B2c3`, `${profilePrefix(dead)}Zz9900`]
  const kept = [
    `${profilePrefix(process.pid)}d4E5f6`,
    `${profilePrefix(process.ppid)}g7H8i9`,
    // Process 1 exists and belongs to the system, so asking about it fails with EPERM rather than ESRCH.
    `${profilePrefix(1)}j1K2l3`,
    `${profilePrefix(0)}m4N5o6`,
    'retest-profile-Xy12Ab',
    `retest-profile-${dead}`,
    `retest-profile-${dead}-with-dash`,
    `other-profile-${dead}-a1b2c3`,
  ]
  for (const name of [...stale, ...kept]) mkdirSync(join(folder, name))
  mkdirSync(join(folder, stale[0] ?? '', 'Default'))
  writeFileSync(join(folder, stale[0] ?? '', 'Default', 'Preferences'), '{}')
  const file = `${profilePrefix(dead)}file00`
  writeFileSync(join(folder, file), 'not a folder')

  assert.deepEqual(await removeStaleProfiles(folder), [])
  assert.deepEqual(readdirSync(folder).sort(), [...kept, file].sort())
})

test('a folder it cannot read is reported, not thrown', async (t) => {
  const missing = join(scratch(t), 'missing')
  const problems = await removeStaleProfiles(missing)
  assert.equal(problems.length, 1)
  assert.match(problems[0] ?? '', /^Could not look for stale browser profiles in .*missing: ENOENT/)
})
