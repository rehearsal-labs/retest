import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { readSandboxSystem, readStartAttempt } from '../../src/browser/sandbox-system.ts'
import { unixOnly } from '../support/platform-skip.ts'

// The files as Ubuntu 24.04 shows them to a user's shell, and as a Docker container on that host shows them.
const ubuntu: Record<string, string> = {
  '/proc/sys/kernel/apparmor_restrict_unprivileged_userns': '1\n',
  '/proc/self/attr/apparmor/current': 'unconfined\n',
}
const dockerOnUbuntu: Record<string, string> = {
  '/proc/sys/kernel/apparmor_restrict_unprivileged_userns': '1\n',
  '/proc/self/attr/apparmor/current': 'docker-default (enforce)\n\0',
  '/.dockerenv': '',
}

function reader(files: Record<string, string>, asked: string[] = []): (path: string) => Promise<string | undefined> {
  return async (path) => {
    asked.push(path)
    return files[path]
  }
}

describe('readSandboxSystem', () => {
  test('reads the restriction, its own label and the container markers, as the kernel words them', async () => {
    const asked: string[] = []
    assert.deepEqual(await readSandboxSystem('linux', reader(ubuntu, asked)), { userNamespaceRestriction: '1', appArmorLabel: 'unconfined', container: false })
    assert.deepEqual(asked.toSorted(), ['/.dockerenv', '/proc/self/attr/apparmor/current', '/proc/sys/kernel/apparmor_restrict_unprivileged_userns', '/run/.containerenv'])
    assert.deepEqual(await readSandboxSystem('linux', reader(dockerOnUbuntu)), { userNamespaceRestriction: '1', appArmorLabel: 'docker-default (enforce)', container: true })
    assert.equal((await readSandboxSystem('linux', reader({ '/run/.containerenv': 'engine="podman-5.0.0"\n' }))).container, true)
  })

  test('a file it cannot read leaves that fact unknown', async () => {
    assert.deepEqual(await readSandboxSystem('linux', reader({})), { userNamespaceRestriction: undefined, appArmorLabel: undefined, container: false })
  })

  test('reads nothing outside Linux', async () => {
    const asked: string[] = []
    for (const platform of ['darwin', 'win32'] as const) {
      assert.deepEqual(await readSandboxSystem(platform, reader(ubuntu, asked)), { userNamespaceRestriction: undefined, appArmorLabel: undefined, container: false })
    }
    assert.deepEqual(asked, [])
  })
})

describe('readStartAttempt', () => {
  test('names the file a link leads to beside the path that was started', { skip: unixOnly('Windows makes a symbolic link only for an administrator or in developer mode') }, async (t) => {
    const folder = await mkdtemp(join(tmpdir(), 'retest-sandbox-system-'))
    t.after(() => rm(folder, { recursive: true, force: true }))
    const file = join(folder, 'chrome')
    const link = join(folder, 'chrome-link')
    await writeFile(file, '')
    await symlink(file, link)
    const attempt = await readStartAttempt(link)
    assert.equal(attempt.executable, link)
    // The temporary folder itself may be reached through a link, as /var is on macOS.
    assert.equal(attempt.file, await realpath(file))
    assert.notEqual(attempt.file, link)
  })

  test('a path that can no longer be resolved is named as it was started', async () => {
    const missing = join(tmpdir(), 'retest-no-such-browser', 'chrome')
    const attempt = await readStartAttempt(missing)
    assert.equal(attempt.file, missing)
  })
})
