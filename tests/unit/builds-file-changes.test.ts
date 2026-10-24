import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { removePath, renamePath, settleChange } from '../../src/cli/install/file-changes.ts'
import { unixOnly } from '../support/platform-skip.ts'
import { tempFolder } from '../support/temp-folder.ts'

// The renames and removals an install makes, as Windows refuses them while another program holds a file open. The
// refusals are the errors Windows gives, raised by a stand-in change, since no test here can make a virus scanner hold
// a file.

const refusal = (code: string) => Object.assign(new Error(`${code}: operation not permitted`), { code })

function failing(codes: readonly string[]): { readonly calls: () => number; readonly run: () => Promise<void> } {
  let calls = 0
  return {
    calls: () => calls,
    run: async () => {
      const code = codes[calls]
      calls += 1
      if (code !== undefined) throw refusal(code)
    },
  }
}

describe('a change Windows refuses while a program holds a file open', () => {
  test('is tried again until it is let go', async () => {
    const change = failing(['EBUSY', 'EPERM', 'EACCES'])
    assert.deepEqual(await settleChange({ run: change.run, folder: tempFolder('retest-change-') }, { platform: 'win32', waitMs: 5000 }), { ok: true })
    assert.equal(change.calls(), 4)
  })

  test('is given up once the wait is over, and says so with the code Windows gave', async () => {
    const change = failing(Array.from({ length: 1000 }, () => 'EBUSY'))
    assert.deepEqual(await settleChange({ run: change.run, folder: tempFolder('retest-change-') }, { platform: 'win32', waitMs: 300 }), { ok: false, reason: 'a program still held a file in it open after 0.3 s (EBUSY)', stopped: false })
    assert.ok(change.calls() > 1 && change.calls() < 10, `tried ${change.calls()} times in 300 ms`)
  })

  test("stops waiting as soon as the install's signal is aborted", async () => {
    const change = failing(Array.from({ length: 1000 }, () => 'EBUSY'))
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 100)
    const started = performance.now()
    const settled = await settleChange({ run: change.run, folder: tempFolder('retest-change-') }, { platform: 'win32', signal: controller.signal, waitMs: 10_000 })
    assert.deepEqual(settled, { ok: false, reason: 'the install was stopped while a program held a file in it open (EBUSY)', stopped: true })
    assert.ok(performance.now() - started < 2000, 'the ten seconds are not waited out')
  })

  test('says at once that the path a rename makes already exists', async () => {
    const folder = tempFolder('retest-change-')
    const target = join(folder, 'electron-44.5.1-win-x64')
    await mkdir(target)
    const change = failing(Array.from({ length: 1000 }, () => 'EPERM'))
    assert.deepEqual(await settleChange({ run: change.run, folder, target }, { platform: 'win32', waitMs: 5000 }), { ok: false, reason: `${target} already exists`, stopped: false })
    assert.equal(change.calls(), 1)
  })

  // The decision is the Windows one, asked of a folder chmod made read-only, which a macOS or Linux test can make and a
  // Windows one cannot: Windows ignores chmod on a folder.
  test('says at once that this user may not change the folder, rather than waiting on a denial', { skip: unixOnly('Windows ignores chmod on a folder, so no read-only folder can stand in for a denial there') }, async (t) => {
    const folder = tempFolder('retest-change-')
    await chmod(folder, 0o555)
    t.after(() => chmod(folder, 0o755))
    const change = failing(Array.from({ length: 1000 }, () => 'EACCES'))
    assert.deepEqual(await settleChange({ run: change.run, folder }, { platform: 'win32', waitMs: 5000 }), { ok: false, reason: `Windows does not let this user change ${folder} (EACCES)`, stopped: false })
    assert.equal(change.calls(), 1)
  })

  test('is tried once on macOS and Linux, and once for any other error on Windows, and never thrown', async () => {
    for (const platform of ['darwin', 'linux'] as const) {
      const change = failing(['EBUSY'])
      assert.deepEqual(await settleChange({ run: change.run, folder: tempFolder('retest-change-') }, { platform, waitMs: 5000 }), { ok: false, reason: 'EBUSY: operation not permitted', stopped: false })
      assert.equal(change.calls(), 1, platform)
    }
    const missing = failing(['ENOENT'])
    assert.equal((await settleChange({ run: missing.run, folder: tempFolder('retest-change-') }, { platform: 'win32', waitMs: 5000 })).ok, false)
    assert.equal(missing.calls(), 1)
  })
})

describe('the renames and removals themselves', () => {
  test('remove a folder whole, or nothing that is not there, and rename onto a path that is free', async () => {
    const folder = tempFolder('retest-change-')
    const staging = join(folder, 'build.staging-1')
    await mkdir(join(staging, 'core'), { recursive: true })
    await writeFile(join(staging, 'core', 'firefox.exe'), 'a stand-in')
    const options = { platform: process.platform }
    assert.deepEqual(await renamePath(staging, join(folder, 'build'), options), { ok: true })
    assert.equal(existsSync(join(folder, 'build', 'core', 'firefox.exe')), true)
    assert.deepEqual(await removePath(join(folder, 'build'), options), { ok: true })
    assert.deepEqual(await removePath(join(folder, 'build'), options), { ok: true }, 'a path already gone is removed')
    assert.equal(existsSync(join(folder, 'build')), false)
  })
})
