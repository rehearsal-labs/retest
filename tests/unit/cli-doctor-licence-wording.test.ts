import assert from 'node:assert/strict'
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { buildFolder, findPin, readBundledLicence } from '../../src/browser/builds.ts'
import { renderChecks } from '../../src/cli/commands/doctor.ts'
import { checkBuilds } from '../../src/cli/install/doctor-rows.ts'
import { app } from '../../src/config/define.ts'
import { createStyle } from '../../src/reporters/style.ts'
import { tempFolder } from '../support/temp-folder.ts'
import { installStandIn, standInPin, temporaryCache, writeEntries } from './builds-fixtures.ts'
import { loadedConfig } from './cli-fixtures.ts'

test('doctor prints exactly one short notice row for a configured WebKit build and retains all internal facts', async () => {
  const { home } = temporaryCache()
  const real = findPin('webkit', 'mac-arm64')
  assert.ok(real?.licences.inspected)
  const config = loadedConfig(tempFolder('retest-doctor-notice-'), { apps: { web: app({ targets: { webkit: { browser: 'webkit', executablePath: '/configured/build' } } }) } })
  const rows = await checkBuilds(config, { HOME: home }, { platform: 'mac-arm64' })
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.ok, true)
  const text = renderChecks(rows, config, createStyle(false))
  assert.equal(text, '\n  builds   webkit                   ✓ licence notices present and verified\n\n  Ready. 1 app, 1 target.\n')
  assert.doesNotMatch(text, /licenses\/|SHA-256|[a-f0-9]{64}|Source |Patches /)
  for (const file of real.licences.files) assert.ok(rows[0]?.detail?.includes(file.path))
})

test('doctor checksum verification survives shorter wording, and an installed missing notice is named', async () => {
  const { home, folders } = temporaryCache()
  const real = findPin('webkit', 'mac-arm64')
  assert.ok(real?.licences.inspected)
  const notice = real.licences.files.find(file => file.bundled !== undefined)
  assert.ok(notice !== undefined)
  const supplied = readBundledLicence(notice)
  assert.ok(supplied.ok)
  const pin = standInPin({ sha256: 'd'.repeat(64) }, { engine: 'webkit', title: 'WebKit', licences: { inspected: true, files: [notice] } })
  await writeEntries(join(buildFolder(folders, pin), 'build'), { [notice.path]: supplied.bytes.toString('utf8') })
  const { folder } = await installStandIn(folders, pin, { size: 7, sha256: 'd'.repeat(64) })
  const config = loadedConfig(tempFolder('retest-doctor-installed-notice-'), { apps: { web: app({ targets: { webkit: { browser: 'webkit', executablePath: join(folder, 'build') } } }) } })
  const read = () => checkBuilds(config, { HOME: home }, { pins: [pin], platform: 'mac-arm64' })
  const rows = await read()
  assert.equal(rows[0]?.ok, true)
  const text = renderChecks(rows, config, createStyle(false))
  assert.equal((text.match(/licence notices present and verified/g) ?? []).length, 1)
  assert.ok(!text.includes(notice.path))
  assert.ok(!text.includes(notice.sha256 ?? 'no checksum'))
  await writeFile(join(folder, 'build', notice.path), 'wrong bytes')
  const changed = await read()
  assert.equal(changed[0]?.ok, false)
  assert.ok(changed[0]?.text.includes(notice.path))
  assert.ok(!renderChecks(changed, config, createStyle(false)).includes('licence notices present and verified'))
  await rm(join(folder, 'build', notice.path))
  const missing = await read()
  assert.equal(missing[0]?.ok, false)
  assert.ok(renderChecks(missing, config, createStyle(false)).includes(`${notice.path} is missing.`))
  assert.equal(renderChecks(missing, config, createStyle(false)).split(`${notice.path} is missing.`).length - 1, 1)
  assert.ok(!renderChecks(missing, config, createStyle(false)).includes('licence notices present and verified'))
})
