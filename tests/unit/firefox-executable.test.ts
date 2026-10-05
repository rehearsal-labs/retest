import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { findFirefoxExecutable, firefoxPlatformProblem, readFirefoxRelease, testedFirefox, untestedFirefox } from '../../src/browser/firefox/executable.ts'
import { createFirefoxFolder, readOwnerRecord, writeOwnerRecord } from '../../src/browser/firefox/profile.ts'

// Which Firefox a target launches and what its app says it is, read from files without starting anything, and the
// folder a launch owns: its profile with Retest's preferences, downloads inside it, and the owner record a later
// sweep reads.

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'retest-firefox-files-'))
})

afterEach(() => rm(root, { recursive: true, force: true }))

async function fakeApp(ini: string): Promise<string> {
  const app = join(root, 'Firefox.app', 'Contents')
  await mkdir(join(app, 'MacOS'), { recursive: true })
  await mkdir(join(app, 'Resources'), { recursive: true })
  await writeFile(join(app, 'Resources', 'application.ini'), ini)
  const executable = join(app, 'MacOS', 'firefox')
  await writeFile(executable, '')
  return executable
}

describe('the Firefox executable', () => {
  test('runs on macOS on Apple silicon only, and names the machine it refuses', () => {
    assert.equal(firefoxPlatformProblem('darwin', 'arm64'), undefined)
    assert.equal(firefoxPlatformProblem('linux', 'x64'), 'Retest runs Firefox on macOS on Apple silicon, and this machine is linux x64.')
    assert.match(firefoxPlatformProblem('darwin', 'x64') ?? '', /darwin x64/)
  })

  test("reads the version and build from the app's application.ini, and nothing from an app that is not Firefox", async () => {
    const executable = await fakeApp('[App]\nVendor=Mozilla\nName=Firefox\nVersion=133.0.3\nBuildID=20241209150345\n\n[Gecko]\nMinVersion=133.0.3\n')
    assert.deepEqual(await readFirefoxRelease(executable), { version: '133.0.3', buildId: '20241209150345' })
    await writeFile(join(root, 'Firefox.app', 'Contents', 'Resources', 'application.ini'), '[App]\nName=Thunderbird\nVersion=128.0\n')
    assert.equal(await readFirefoxRelease(executable), undefined)
    assert.equal(await readFirefoxRelease(join(root, 'nowhere', 'firefox')), undefined)
  })

  test('a target that names its executable launches that one, on the machine Retest runs Firefox on', { skip: firefoxPlatformProblem() }, async () => {
    const found = await findFirefoxExecutable({ name: 'firefox', browser: 'firefox', headless: true, executablePath: '/opt/firefox' }, 'web', {})
    assert.deepEqual(found, { ok: true, path: '/opt/firefox' })
  })
})

// Review F-5: with no pinned build in the cache, a run took whatever Firefox was in /Applications, at any version, while
// the driver encodes facts of the tested release alone.
describe('a Firefox found where macOS installs it', { skip: firefoxPlatformProblem() }, () => {
  const target = { name: 'firefox', browser: 'firefox' as const, headless: true }

  test('is used when its files say it is the tested release', async () => {
    const tested = testedFirefox()
    const executable = await fakeApp(`[App]\nName=Firefox\nVersion=${tested.version}\nBuildID=${tested.buildId ?? ''}\n`)
    assert.deepEqual(await findFirefoxExecutable(target, 'web', {}, { systemPath: executable }), { ok: true, path: executable })
  })

  test('of another release fails setup by name, saying what it found and the two ways forward', async () => {
    const executable = await fakeApp('[App]\nName=Firefox\nVersion=150.0\nBuildID=20260901000000\n')
    const found = await findFirefoxExecutable(target, 'web', {}, { systemPath: executable })
    assert.ok(!found.ok)
    assert.equal(found.failure.class, 'setup_failed')
    assert.equal(
      found.failure.message,
      `No tested Firefox for the target firefox of the app web: no pinned build is in Retest's cache, and the Firefox at ${executable} is 150.0 build 20260901000000, not the tested 133.0.3 build 20241209150345. Either name it with executablePath on the target to run it at that version, or install the tested Firefox 133.0.3 at ${executable}.`,
    )
    assert.deepEqual(found.failure.details, { app: 'web', target: 'firefox', found: '150.0', tested: '133.0.3' })
  })

  test('whose files name no release is refused the same way, and no Firefox at all names the ways forward', async () => {
    const executable = await fakeApp('[App]\nName=Thunderbird\nVersion=128.0\n')
    const unnamed = await findFirefoxExecutable(target, 'web', {}, { systemPath: executable })
    assert.ok(!unnamed.ok)
    assert.match(unnamed.failure.message, /the Firefox at .+ names no release in its files, not the tested 133\.0\.3 build 20241209150345/)
    const none = await findFirefoxExecutable(target, 'web', {}, { systemPath: join(root, 'nowhere', 'firefox') })
    assert.ok(!none.ok)
    assert.match(none.failure.message, /none is at .+\. Either install the tested Firefox 133\.0\.3 at .+, or give the target an executablePath\.$/)
  })

  test('named by the target runs at any release, and says when it is not the tested one', async () => {
    const executable = await fakeApp('[App]\nName=Firefox\nVersion=150.0\nBuildID=20260901000000\n')
    assert.deepEqual(await findFirefoxExecutable({ ...target, executablePath: executable }, 'web', {}), { ok: true, path: executable })
    assert.equal(untestedFirefox(await readFirefoxRelease(executable)), 'Firefox 150.0 build 20260901000000 is not the tested Firefox 133.0.3 build 20241209150345.')
    assert.equal(untestedFirefox({ version: '133.0.3', buildId: '20241209150345' }), undefined)
    assert.equal(untestedFirefox(undefined), 'A Firefox whose files name no release is not the tested Firefox 133.0.3 build 20241209150345.')
  })
})

describe("a Firefox launch's folder", () => {
  test("holds a profile with Retest's preferences, its downloads inside the folder, and nothing else of the person's", async () => {
    const { folder, profile } = await createFirefoxFolder(root)
    assert.ok(folder.includes(`retest-firefox-${process.pid}-`))
    const preferences = await readFile(join(profile, 'user.js'), 'utf8')
    for (const line of [
      'user_pref("remote.active-protocols", 1);',
      'user_pref("focusmanager.testmode", true);',
      'user_pref("browser.sessionhistory.max_total_viewers", 0);',
      `user_pref("browser.download.dir", ${JSON.stringify(join(folder, 'downloads'))});`,
    ]) {
      assert.ok(preferences.includes(line), line)
    }
  })

  test('keeps an owner record whole, and reads back nothing from a record that is not one', async () => {
    const { folder } = await createFirefoxFolder(root)
    assert.equal(await readOwnerRecord(folder), undefined)
    const record = {
      version: 1 as const,
      owner: { pid: 100, startedAt: 'Mon Oct  5 01:00:00 2026', command: 'node retest run' },
      firefox: { pid: 200, startedAt: 'Mon Oct  5 01:00:01 2026', command: '/Applications/Firefox.app/Contents/MacOS/firefox --profile p', route: 'spawn' as const },
      profile: join(folder, 'profile'),
    }
    await writeOwnerRecord(folder, record)
    assert.deepEqual(await readOwnerRecord(folder), record)
    await writeFile(join(folder, 'retest-owner.json'), '{"version":2}')
    assert.equal(await readOwnerRecord(folder), undefined)
  })
})

test('a damaged pinned cache refuses setup and never falls back to a system Firefox, while an explicit binary still wins', { skip: firefoxPlatformProblem() }, async () => {
  const executable = await fakeApp(`[App]\nName=Firefox\nVersion=${testedFirefox().version}\nBuildID=${testedFirefox().buildId ?? ''}\n`)
  const env = { HOME: root }
  const { cacheFolders, buildFolder, findPin } = await import('../../src/browser/builds.ts')
  const pin = findPin('firefox', 'mac-arm64')
  const folders = cacheFolders(env)
  assert.ok(pin !== undefined && folders !== undefined)
  const damaged = buildFolder(folders, pin)
  await mkdir(damaged, { recursive: true })
  const target = { name: 'firefox', browser: 'firefox' as const, headless: true }
  const result = await findFirefoxExecutable(target, 'web', env, { systemPath: executable })
  assert.ok(!result.ok)
  assert.equal(result.failure.class, 'setup_failed')
  assert.ok(result.failure.message.includes(damaged))
  assert.deepEqual(await findFirefoxExecutable({ ...target, executablePath: executable }, 'web', env), { ok: true, path: executable })
})
