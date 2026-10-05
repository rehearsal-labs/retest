import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { installedBuild, installedExecutablePath } from '../../src/browser/builds.ts'
import { sha256Hex } from '../../src/shared/sha256.ts'
import { installStandIn, standInPin, temporaryCache } from './builds-fixtures.ts'

// What a driver learns of a pinned build in the cache when its target names no path: a damaged build is told apart
// from a missing one, so no driver falls back to another binary in its place.

describe('the pinned build a driver asks for', () => {
  test('is missing, installed with its executable, or damaged with what is wrong, where it is and how to fix it', async () => {
    const { home, folders } = temporaryCache()
    const pin = standInPin({ sha256: sha256Hex('archive') }, { engine: 'firefox', title: 'Firefox' })
    const options = { platform: 'mac-arm64' as const, pins: [pin] }
    assert.deepEqual(await installedBuild('firefox', { HOME: home }, options), { state: 'missing' })
    assert.deepEqual(await installedBuild('firefox', {}, options), { state: 'missing' }, 'without a home folder there is no cache')
    assert.deepEqual(await installedBuild('firefox', { HOME: home }, { platform: 'linux-x64', pins: [pin] }), { state: 'missing' }, 'no pin for this machine')
    const { folder } = await installStandIn(folders, pin)
    assert.deepEqual(await installedBuild('firefox', { HOME: home }, options), { state: 'installed', executablePath: installedExecutablePath(folder, pin) })
    await rm(join(folder, 'build/LICENSE'))
    const damaged = await installedBuild('firefox', { HOME: home }, options)
    assert.equal(damaged.state, 'damaged')
    assert.equal(damaged.state === 'damaged' ? damaged.folder : '', folder)
    assert.equal(damaged.state === 'damaged' ? damaged.message : '', `The pinned Firefox 1.0.0 in ${folder} is not usable: ${join(folder, 'build/LICENSE')} is missing. Remove ${folder}, or give the target an executablePath.`)
  })

  test('is damaged, never installed, when its folder is for a pin retest install refuses', async () => {
    const { home, folders } = temporaryCache()
    const pin = standInPin({}, { engine: 'firefox', title: 'Firefox' })
    const { folder } = await installStandIn(folders, pin)
    const answer = await installedBuild('firefox', { HOME: home }, { platform: 'mac-arm64', pins: [pin] })
    assert.equal(answer.state, 'damaged')
    assert.match(answer.state === 'damaged' ? answer.message : '', new RegExp(`^The pinned Firefox 1\\.0\\.0 in .+ is not usable: Retest does not install Firefox 1\\.0\\.0, so nothing in .+ was installed or checked by Retest: No checksum is pinned .+ Remove ${folder.replaceAll('.', '\\.')}, or give the target an executablePath\\.$`))
  })
})
