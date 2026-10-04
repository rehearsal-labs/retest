import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createTemporaryProfile, profilePrefix, removeStaleProfiles } from '../../src/browser/profiles.ts'
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

test('keeps every earlier profile, including marked profiles of processes that are gone', async (t) => {
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
    `${profilePrefix(dead)}unmarked`,
  ]
  for (const name of [...stale, ...kept]) mkdirSync(join(folder, name))
  for (const name of stale) {
    const path = realpathSync(join(folder, name))
    writeFileSync(join(path, '.retest-profile-owner.json'), JSON.stringify({ version: 1, pid: dead, path }))
  }
  mkdirSync(join(folder, stale[0] ?? '', 'Default'))
  writeFileSync(join(folder, stale[0] ?? '', 'Default', 'Preferences'), '{}')
  const file = `${profilePrefix(dead)}file00`
  writeFileSync(join(folder, file), 'not a folder')

  assert.deepEqual(await removeStaleProfiles(folder), [])
  assert.deepEqual(readdirSync(folder).sort(), [...stale, ...kept, file].sort())
  assert.equal(existsSync(join(folder, stale[0] ?? '', 'Default', 'Preferences')), true)
})

test('a configured folder is kept even when it carries a valid stale temporary-profile record', async (t) => {
  const folder = scratch(t)
  const dead = await exitedPid()
  const profile = await createTemporaryProfile(folder, dead)
  writeFileSync(join(profile, 'user-file.txt'), 'mine')
  assert.deepEqual(await removeStaleProfiles(folder), [])
  assert.equal(existsSync(join(profile, 'user-file.txt')), true)
  assert.deepEqual(await removeStaleProfiles(folder), [])
  assert.equal(existsSync(join(profile, 'user-file.txt')), true, 'another launch never uses an old marker to delete persistent data')
})

test('a folder whose record names another path is kept', async (t) => {
  const folder = scratch(t)
  const dead = await exitedPid()
  const path = join(folder, `${profilePrefix(dead)}abc123`)
  mkdirSync(path)
  writeFileSync(join(path, '.retest-profile-owner.json'), JSON.stringify({ version: 1, pid: dead, path: '/someone/else' }))
  assert.deepEqual(await removeStaleProfiles(folder), [])
  assert.equal(existsSync(path), true)
})

test('a folder it cannot read is reported, not thrown', async (t) => {
  const missing = join(scratch(t), 'missing')
  const problems = await removeStaleProfiles(missing)
  assert.equal(problems.length, 1)
  assert.match(problems[0] ?? '', /^Could not look for stale browser profiles in .*missing: ENOENT/)
})
