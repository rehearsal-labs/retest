import type { TestContext } from 'node:test'
import type { LoadedTarget } from '../../src/config/loaded.ts'
import type { WebKitLaunchOptions } from '../../src/browser/webkit/browser.ts'
import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { runChecks } from '../../src/cli/doctor/checks.ts'
import { buildFolderOf, describeBuildVersion, findWebKitBuild, readRevision, webKitBuildPath, webKitPin } from '../../src/browser/webkit/build.ts'
import { validateConfig } from '../../src/config/validate.ts'
import { defaultTimeouts } from '../../src/protocol/timeouts.ts'
import { BrowserPool } from '../../src/runner/browser-pool.ts'
import { targetDriver } from '../../src/runner/target-drivers.ts'
import { fakeLauncher } from '../support/fake-browser.ts'
import { fakeExecutable } from '../support/project.ts'
import { quickTimeouts } from '../support/run-harness.ts'

const webkit: LoadedTarget = { name: 'webkit', browser: 'webkit', headless: true, executablePath: '/cache/webkit-2359' }

async function folder(t: TestContext): Promise<string> {
  const path = await mkdtemp(join(await realpath(tmpdir()), 'retest-webkit-build-test-'))
  t.after(() => rm(path, { recursive: true, force: true }))
  return path
}

/** A folder shaped like an unpacked build, with a protocol.json that is not the pinned one. */
async function fakeBuild(parent: string, name: string): Promise<string> {
  const directory = join(parent, name)
  const macos = join(directory, 'Playwright.app', 'Contents', 'MacOS')
  await mkdir(macos, { recursive: true })
  await writeFile(join(macos, 'Playwright'), '#!/bin/sh\nexit 0\n')
  await chmod(join(macos, 'Playwright'), 0o755)
  await writeFile(join(directory, 'protocol.json'), '{"domains":[]}')
  return directory
}

test('a WebKit target runs on the WebKit driver', { timeout: 10_000 }, () => {
  assert.deepEqual(targetDriver('web', webkit), { ok: true, driver: 'webkit', target: webkit })
})

test("a WebKit target's build is the path it names, or RETEST_WEBKIT_BUILD, and nowhere else", { timeout: 10_000 }, () => {
  assert.deepEqual(webKitBuildPath({ executablePath: '/a/webkit-2359' }, { RETEST_WEBKIT_BUILD: '/b' }), { ok: true, path: '/a/webkit-2359', source: 'executablePath' })
  assert.deepEqual(webKitBuildPath({}, { RETEST_WEBKIT_BUILD: '/b/webkit-2359' }), { ok: true, path: '/b/webkit-2359', source: 'RETEST_WEBKIT_BUILD' })
  const missing = webKitBuildPath({}, { RETEST_WEBKIT_BUILD: '' })
  assert.deepEqual(missing, { ok: false, failure: { class: 'setup_failed', message: 'A WebKit target needs a build. Give its executablePath, or set RETEST_WEBKIT_BUILD, to an unpacked Playwright WebKit build 2359, the folder or the executable inside it.' } })
})

test('a path to the executable inside a build names the build folder, and the folder name gives the revision', { timeout: 10_000 }, () => {
  assert.equal(buildFolderOf('/cache/webkit-2359/Playwright.app/Contents/MacOS/Playwright'), '/cache/webkit-2359')
  assert.equal(buildFolderOf('/cache/webkit-2359/'), '/cache/webkit-2359')
  assert.equal(buildFolderOf('/cache/other/MacOS/Playwright'), '/cache/other/MacOS/Playwright')
  assert.equal(readRevision('/cache/webkit-2359'), '2359')
  assert.equal(readRevision('/cache/my-webkit'), undefined)
  assert.equal(describeBuildVersion({ version: '626.1.6+', revision: '2359' }), '626.1.6+, build 2359')
  assert.equal(describeBuildVersion({ version: '626.1.6+', revision: undefined }), '626.1.6+')
})

test('a build is refused on a host other than macOS, where none is there, and when its protocol is not the pinned one', { timeout: 10_000 }, async (t) => {
  await assert.rejects(findWebKitBuild('/cache/webkit-2359', 'executablePath', 'linux'), /Retest runs WebKit on macOS only, and this host is linux\./)
  // Read as on macOS, the one host Retest runs WebKit on, so the folder and protocol checks run on any machine.
  const parent = await folder(t)
  await assert.rejects(findWebKitBuild(join(parent, 'absent'), 'executablePath', 'darwin'), /No WebKit build at .*absent, the path executablePath gives: nothing is there\./)
  const build = await fakeBuild(parent, 'webkit-2359')
  await assert.rejects(findWebKitBuild(build, 'RETEST_WEBKIT_BUILD', 'darwin'), (error: unknown) => {
    assert.ok(error instanceof Error)
    assert.match(error.message, /speaks another protocol than the one Retest's WebKit driver was written for/)
    assert.ok(error.message.includes(webKitPin.protocolSha256))
    return true
  })
})

test('the pool launches a WebKit target through its own launcher, once, and names the engine of what it ensures', { timeout: 10_000 }, async () => {
  const fake = fakeLauncher()
  const asked: WebKitLaunchOptions[] = []
  const pool = new BrowserPool({
    launch: async () => assert.fail('the Chromium launcher is never asked for a WebKit target'),
    findExecutable: fakeExecutable,
    launchWebKit: (options, timeoutMs) => {
      asked.push(options)
      return fake.launch({ executablePath: options.buildPath, logFile: options.logFile, headless: options.headless }, timeoutMs)
    },
    logFile: (appName, target) => `/logs/${appName}-${target}.log`,
    headless: true,
    named: true,
    timeouts: quickTimeouts,
    stopped: new Promise(() => {}),
    interruption: () => undefined,
    onStarted: () => {},
    onLost: () => {},
  })
  const app = { name: 'web', targets: new Map([[webkit.name, webkit]]) }
  const first = await pool.ensure(app, webkit)
  const second = await pool.ensure(app, webkit)
  assert.ok(first.ok && second.ok)
  assert.equal(first.value.runtime.kind === 'web' ? first.value.runtime.engine : undefined, 'webkit')
  assert.equal(first.value.browser, second.value.browser, 'one browser serves every test of the target')
  assert.deepEqual(asked, [{ buildPath: '/cache/webkit-2359', buildSource: 'executablePath', logFile: '/logs/web-webkit.log', headless: true }])
  assert.equal(pool.started.length, 1)
  await pool.close()
})

test('doctor names the WebKit build a target lacks, and the protocol a build it finds does not speak, and starts nothing', { timeout: 10_000, skip: process.platform === 'darwin' ? false : `unverified: doctor reads a WebKit build only on macOS, where Retest runs WebKit, and this host is ${process.platform}` }, async (t) => {
  const parent = await folder(t)
  const build = await fakeBuild(parent, 'webkit-2359')
  const result = validateConfig({ apps: { missing: { browser: 'webkit' }, found: { browser: 'webkit', executablePath: build } } }, '/work/retest.config.ts')
  assert.ok(result.ok, result.ok ? '' : result.failure.message)
  const launched = fakeLauncher()
  const checks = await runChecks(result.config, {
    dependencies: {
      resolveExecutable: () => assert.fail('no Chromium executable is looked for'),
      launchBrowser: (options, timeoutMs) => launched.launch(options, timeoutMs),
      probeReady: async () => true,
      startAppServer: () => Promise.reject(new Error('no server is started')),
      env: {},
      signal: new AbortController().signal,
    },
    timeouts: defaultTimeouts,
    logFolder: '/tmp/retest-doctor-unused',
  })
  const webkitChecks = checks.filter((check) => check.group === 'missing' || check.group === 'found')
  assert.deepEqual(webkitChecks.map(({ group, ok }) => [group, ok]), [['missing', false], ['found', false]])
  assert.match(webkitChecks[0]?.text ?? '', /^A WebKit target needs a build\./)
  assert.match(webkitChecks[1]?.text ?? '', /speaks another protocol than the one Retest's WebKit driver was written for/)
  assert.deepEqual(launched.browsers, [], 'doctor starts no browser for a WebKit target')
})
