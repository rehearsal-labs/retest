import type { LoadedConfig, LoadedNativeTarget } from '../../src/config/loaded.ts'
import assert from 'node:assert/strict'
import { existsSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { app, defineConfig } from '../../src/config/define.ts'
import { validateConfig } from '../../src/config/validate.ts'
import { tempFolder } from '../support/temp-folder.ts'

// Where a native app's diagnostics come from, as the config declares them: its standard output by default, or none,
// and a network file with the client name its records give the app. One app owns a file and client in a run.

const folder = tempFolder('native-diagnostics-config-')
after(() => rmSync(folder, { recursive: true, force: true }))
const path = join(folder, 'retest.config.ts')
const phone = { platform: 'ios-simulator', appPath: 'build/TaskPhone.app', device: 'iPhone 17', runtime: '26.5' } as const
const desk = { platform: 'macos', appPath: 'build/TaskDesk.app' } as const

function loaded(value: unknown): LoadedConfig {
  const result = validateConfig(value, path)
  assert.ok(result.ok, result.ok ? '' : result.failure.message)
  return result.config
}

function target(config: LoadedConfig, appName: string, targetName: string): LoadedNativeTarget {
  const found = config.apps.get(appName)?.targets.get(targetName)
  assert.ok(found !== undefined && 'platform' in found, `${appName} has the native target ${targetName}`)
  return found
}

/** Every problem the config has, as `key: message` lines. */
function problems(value: unknown): string[] {
  const result = validateConfig(value, path)
  assert.equal(result.ok, false, 'expected the config to be rejected')
  if (result.ok) return []
  assert.equal(result.failure.class, 'usage')
  const lines = result.failure.message.split('\n')
  return lines.length === 1 ? [lines[0]?.slice(`${path}: `.length) ?? ''] : lines.slice(1).map((line) => line.trim())
}

describe('a native app declares where its diagnostics come from', () => {
  test('a network file is read for the client it names, from a path relative to the config, and stdout is the default', () => {
    const config = loaded(defineConfig({ apps: { phone: { ...phone, diagnostics: { network: { path: 'service/network.jsonl', client: 'ios' } } } } }))
    assert.deepEqual(target(config, 'phone', 'ios-simulator').diagnostics, { logs: 'stdout', network: { path: join(folder, 'service/network.jsonl'), client: 'ios' } })
  })

  test("an app that keeps no log says so, and one that declares nothing has no diagnostics, read as stdout and no network source", () => {
    const config = loaded(defineConfig({ apps: { quiet: { ...desk, diagnostics: { logs: 'none' } }, plain: desk } }))
    assert.deepEqual(target(config, 'quiet', 'macos').diagnostics, { logs: 'none' })
    assert.equal(target(config, 'plain', 'macos').diagnostics, undefined)
  })

  test('each target of an app keeps its own declaration', () => {
    const config = loaded(defineConfig({ apps: { desk: app({ targets: { logged: { ...desk, diagnostics: { logs: 'stdout' } }, quiet: { ...desk, diagnostics: { logs: 'none', network: { path: '/var/service/network.jsonl', client: 'macos' } } } } }) } }))
    assert.deepEqual(target(config, 'desk', 'logged').diagnostics, { logs: 'stdout' })
    assert.deepEqual(target(config, 'desk', 'quiet').diagnostics, { logs: 'none', network: { path: '/var/service/network.jsonl', client: 'macos' } })
  })

  test('a declaration of the wrong shape is refused by key, and so is one on a browser', () => {
    assert.deepEqual(problems({ apps: { phone: { ...phone, diagnostics: { logs: 'stderr' } } } }), ['apps.phone.diagnostics.logs: expected one of "stdout", "none", received "stderr"'])
    assert.deepEqual(problems({ apps: { phone: { ...phone, diagnostics: { network: { path: 'network.jsonl', client: 'web' } } } } }), ['apps.phone.diagnostics.network.client: expected one of "ios", "macos", received "web"'])
    assert.deepEqual(problems({ apps: { phone: { ...phone, diagnostics: { network: { path: '  ', client: 'ios' } } } } }), ['apps.phone.diagnostics.network.path: expected a file, received "  "'])
    assert.deepEqual(problems({ apps: { phone: { ...phone, diagnostics: { network: { path: 'network.jsonl', client: 'ios', headers: true } } } } }), ['apps.phone.diagnostics.network.headers: unknown key'])
    assert.deepEqual(problems({ apps: { phone: { ...phone, diagnostics: { network: 'network.jsonl' } } } }), ['apps.phone.diagnostics.network: expected object, received "network.jsonl"'])
    assert.deepEqual(problems({ apps: { web: { browser: 'chromium', diagnostics: { logs: 'stdout' } } } }), ['apps.web.diagnostics: unknown key'])
  })
})

describe('one app owns a network file and client', () => {
  const file = join(folder, 'network.jsonl')

  test('two apps that declare the same file and client are refused, naming both', () => {
    assert.deepEqual(problems(defineConfig({ apps: { phone: { ...phone, diagnostics: { network: { path: file, client: 'ios' } } }, tablet: { ...phone, device: 'iPad Air 11-inch (M3)', diagnostics: { network: { path: 'network.jsonl', client: 'ios' } } } } })), [
      'apps.tablet.diagnostics.network: is also the network source of apps.phone.diagnostics.network for the client ios: the records cannot tell the two apps apart, so give each app a file or client of its own',
    ])
    assert.deepEqual(problems(defineConfig({ apps: { desk: { ...desk, diagnostics: { network: { path: file, client: 'macos' } } }, desk2: app({ targets: { mac: { ...desk, diagnostics: { network: { path: `${folder}/./network.jsonl`, client: 'macos' } } } } }) } })), [
      'apps.desk2.targets.mac.diagnostics.network: is also the network source of apps.desk.diagnostics.network for the client macos: the records cannot tell the two apps apart, so give each app a file or client of its own',
    ])
  })

  test('two names for one file are one file, through a link and, on a disk that ignores case, in another case', () => {
    const declare = (other: string): ReturnType<typeof validateConfig> => validateConfig(defineConfig({ apps: { phone: { ...phone, diagnostics: { network: { path: file, client: 'ios' } } }, tablet: { ...phone, device: 'iPad Air 11-inch (M3)', diagnostics: { network: { path: other, client: 'ios' } } } } }), path)
    const link = join(folder, 'linked')
    symlinkSync(folder, link)
    assert.equal(declare(join(link, 'network.jsonl')).ok, false, 'a link to the folder names the same file')
    // The case rule is the disk's own, so it is read the way the loader reads it: a file, and its name turned over.
    writeFileSync(join(folder, 'case-probe'), '')
    const ignoresCase = existsSync(join(folder, 'CASE-PROBE'))
    const turned = declare(join(folder, 'NETWORK.jsonl'))
    assert.equal(turned.ok, !ignoresCase, turned.ok ? 'accepted' : turned.failure.message)
  })

  test('one file read for two clients, or two files for one client, belongs to each app on its own', () => {
    loaded(defineConfig({ apps: { phone: { ...phone, diagnostics: { network: { path: file, client: 'ios' } } }, desk: { ...desk, diagnostics: { network: { path: file, client: 'macos' } } } } }))
    loaded(defineConfig({ apps: { phone: { ...phone, diagnostics: { network: { path: file, client: 'ios' } } }, tablet: { ...phone, device: 'iPad Air 11-inch (M3)', diagnostics: { network: { path: join(folder, 'tablet.jsonl'), client: 'ios' } } } } }))
  })

  test("an app's targets share one only when they cannot run at once: on the Mac, or on one simulator", () => {
    const network = { path: file, client: 'ios' } as const
    loaded(defineConfig({ apps: { desk: app({ targets: { plain: { ...desk, diagnostics: { network: { path: file, client: 'macos' } } }, reset: { ...desk, arguments: ['-reset'], diagnostics: { network: { path: file, client: 'macos' } } } } }) } }))
    loaded(defineConfig({ apps: { phone: app({ targets: { plain: { ...phone, diagnostics: { network } }, reset: { ...phone, arguments: ['-reset'], diagnostics: { network } } } }) } }))
    assert.deepEqual(problems(defineConfig({ apps: { phone: app({ targets: { iphone: { ...phone, diagnostics: { network } }, older: { ...phone, runtime: '26.4', diagnostics: { network } } } }) } })), [
      'apps.phone.targets.older.diagnostics.network: is also the network source of apps.phone.targets.iphone.diagnostics.network for the client ios, on another simulator that can run at the same time: give each simulator a file or client of its own',
    ])
  })
})
