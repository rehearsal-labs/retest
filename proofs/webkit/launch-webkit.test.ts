import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { test } from 'node:test'
import { defaultBuildDirectory, findWebKitBuild, matchesPin, parseLaunchdServices, parseProcessListing, readRevision, webKitArguments, webKitEnvironment } from './launch-webkit.ts'

// Shortened from `launchctl print pid/<pid>` for a running build, 3 October 2026.
const LAUNCHD_OUTPUT = `pid/80054 = {
\ttype = pid
\toriginator = /Users/me/Library/Caches/ms-playwright/webkit-2359/Playwright.app
\tservices = {
\t\t   80058      - \tcom.apple.WebKit.WebContent.A39D827C-8EE3-479C-9943-02BC6A780948
\t\t       0      - \tcom.apple.WebKit.WebContent
\t\t       0      - \tcom.apple.WebKit.GPU
\t\t   80055      - \tcom.apple.WebKit.Networking.CE922850-A3E3-4D1D-9EFD-10D513EC2D0F
\t\t   80057      - \tcom.apple.SetStoreUpdateService
\t}

\tservice stubs = {
\t\tcom.apple.SafariServices
\t}
}`

test('passes the inspector pipe, headless and no startup window, as Playwright does without a profile', () => {
  assert.deepEqual(webKitArguments({ headless: true }), ['--inspector-pipe', '--headless', '--no-startup-window'])
  assert.deepEqual(webKitArguments({ headless: false }), ['--inspector-pipe', '--no-startup-window'])
})

test('gives the browser only its framework paths and a temporary home, nothing of the caller\'s environment', () => {
  const build = {
    directory: '/cache/webkit-2359',
    executable: '/cache/webkit-2359/Playwright.app/Contents/MacOS/Playwright',
    protocolFile: '/cache/webkit-2359/protocol.json',
    protocolSha256: '5962bc790bde7750ce127029962a6c1bd93aed884cbcf832da8393c2a12c106c',
    revision: '2359',
  }
  process.env['RETEST_WEBKIT_TEST_SECRET'] = 'never passed on'
  try {
    assert.deepEqual(webKitEnvironment(build, '/tmp/retest-webkit-1'), {
      PATH: '/usr/bin:/bin',
      HOME: '/tmp/retest-webkit-1',
      CFFIXED_USER_HOME: '/tmp/retest-webkit-1',
      TMPDIR: '/tmp/retest-webkit-1/tmp/',
      DYLD_FRAMEWORK_PATH: '/cache/webkit-2359',
      DYLD_LIBRARY_PATH: '/cache/webkit-2359',
    })
  } finally {
    delete process.env['RETEST_WEBKIT_TEST_SECRET']
  }
})

test('finds the build in the Playwright cache unless RETEST_WEBKIT_BUILD names one', () => {
  assert.equal(defaultBuildDirectory({ RETEST_WEBKIT_BUILD: '/elsewhere/webkit' }), '/elsewhere/webkit')
  assert.match(defaultBuildDirectory({}), /Library\/Caches\/ms-playwright\/webkit-2359$/)
})

test('reads the running services launchd started for the browser, and only those', () => {
  assert.deepEqual(parseLaunchdServices(LAUNCHD_OUTPUT), [
    { pid: 80058, label: 'com.apple.WebKit.WebContent.A39D827C-8EE3-479C-9943-02BC6A780948' },
    { pid: 80055, label: 'com.apple.WebKit.Networking.CE922850-A3E3-4D1D-9EFD-10D513EC2D0F' },
    { pid: 80057, label: 'com.apple.SetStoreUpdateService' },
  ])
})

test('refuses launchctl output without a services block instead of reading it as no helpers', () => {
  assert.throws(() => parseLaunchdServices('pid/1 = {\n\ttype = pid\n}'), /no services block/)
})

test('keeps only the processes that run from inside the build folder', () => {
  const listing = [
    '  812 /cache/webkit-2359/com.apple.WebKit.GPU.xpc/Contents/MacOS/com.apple.WebKit.GPU.Development',
    '  813 /cache/webkit-2359-other/Playwright.app/Contents/MacOS/Playwright',
    '  814 /System/Library/Frameworks/WebKit.framework/Versions/A/XPCServices/com.apple.WebKit.WebContent.xpc/Contents/MacOS/com.apple.WebKit.WebContent',
    '',
  ].join('\n')
  assert.deepEqual(parseProcessListing(listing, '/cache/webkit-2359'), [{ pid: 812, command: '/cache/webkit-2359/com.apple.WebKit.GPU.xpc/Contents/MacOS/com.apple.WebKit.GPU.Development' }])
})

test('reads the revision from a folder named the way the installer names it, and nothing from other names', () => {
  assert.equal(readRevision('/cache/ms-playwright/webkit-2359'), '2359')
  assert.equal(readRevision('/cache/my-webkit'), undefined)
})

test('names one folder however the path is written: trailing slash, relative or through a link', async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), 'retest-webkit-build-'))
  t.after(() => rm(scratch, { recursive: true, force: true }))
  const folder = join(scratch, 'webkit-2359')
  await mkdir(join(folder, 'Playwright.app', 'Contents', 'MacOS'), { recursive: true })
  await writeFile(join(folder, 'Playwright.app', 'Contents', 'MacOS', 'Playwright'), '')
  await chmod(join(folder, 'Playwright.app', 'Contents', 'MacOS', 'Playwright'), 0o755)
  await writeFile(join(folder, 'protocol.json'), '[]')
  const canonical = await realpath(folder)
  for (const written of [folder, `${folder}/`, relative(process.cwd(), folder)]) {
    const build = await findWebKitBuild(written)
    assert.equal(build.directory, canonical)
    assert.equal(build.revision, '2359')
  }
  // A folder named for the pinned revision whose protocol.json is another file is not the pinned build.
  assert.equal(matchesPin(await findWebKitBuild(folder)), false)
})

test('says where to get the build when it is missing', async () => {
  const missing = join(import.meta.dirname, 'no-such-build')
  await assert.rejects(findWebKitBuild(missing), (error: unknown) => {
    assert.ok(error instanceof Error)
    assert.match(error.message, /No WebKit build at .*no-such-build/)
    assert.match(error.message, /npx playwright@1\.63\.0 install webkit/)
    return true
  })
})
