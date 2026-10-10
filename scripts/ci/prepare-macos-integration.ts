import type { ArchiveEngine, ArchivePin } from '../../src/browser/builds.ts'
import { execFileSync } from 'node:child_process'
import { constants } from 'node:fs'
import { appendFile, copyFile, mkdir, rm } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { buildFolder, buildPlatform, cacheFolders, describePin, findPin, installedExecutablePath, pinRefusal, treeFolder } from '../../src/browser/builds.ts'
import { downloadFile } from '../../src/cli/install/download.ts'
import { archivePath } from '../../src/cli/install/install-archive.ts'
import { mediaTarget } from '../../src/cli/install/media-pins.ts'
import { mediaFolder } from '../../src/cli/install/media-record.ts'
import { findMediaTool } from '../../src/cli/install/media-tools.ts'

// The installer deletes successful downloads, while install.test.ts needs the real publisher archives as local
// fixtures. Fetch once through the product downloader, check the product pins, keep the fixtures and copy the same
// bytes to the installer's download cache. The workflow then runs the built product CLI to unpack and verify them.
//
//   node scripts/ci/prepare-macos-integration.ts <absent absolute folder>

function archivePin(engine: ArchiveEngine): ArchivePin {
  const pin = findPin(engine, 'mac-arm64')
  if (pin?.kind !== 'archive') throw new Error(`No macOS arm64 archive pin for ${engine}.`)
  const refusal = pinRefusal(pin)
  if (refusal !== undefined) throw new Error(refusal.message)
  return pin
}

async function prepare(folder: string, environmentFile: string): Promise<void> {
  if (buildPlatform() !== 'mac-arm64') throw new Error('This setup requires macOS arm64.')
  const version = execFileSync('/usr/bin/sw_vers', ['-productVersion'], { encoding: 'utf8', timeout: 5000 }).trim()
  const parts = /^(\d+)\.(\d+)(?:\.\d+)?$/.exec(version)
  if (parts === null || Number(parts[1]) < 26 || (Number(parts[1]) === 26 && Number(parts[2]) < 5)) {
    throw new Error(`WebKit build 2359 needs macOS 26.5 or later, and this runner is ${version}.`)
  }
  process.stdout.write(`Preparing pinned integration prerequisites on macOS ${version} ${process.arch}\n`)
  const folders = cacheFolders(process.env)
  const target = mediaTarget()
  const media = target === undefined ? undefined : mediaFolder(process.env, target)
  if (folders === undefined || media === undefined) throw new Error('No absolute HOME for the browser and media caches.')
  const ffmpeg = await findMediaTool('ffmpeg', process.env)
  const ffprobe = await findMediaTool('ffprobe', process.env)
  if (ffmpeg === undefined || ffprobe === undefined) throw new Error('Install ffmpeg and ffprobe on PATH before this setup.')

  // mkdir refuses a reused fixture folder; exclusive copies never overwrite another install's archive.
  await mkdir(folder)
  const environment: Record<string, string> = {
    RETEST_TEST_BROWSER_ARCHIVES: folder,
    RETEST_FIREFOX_ROUTE: 'spawn',
    RETEST_TEST_MEDIA_BINARY: join(media, 'retest-media'),
    RETEST_MEDIA_BINARY: join(media, 'retest-media'),
    RETEST_TEST_FFMPEG: ffmpeg,
    RETEST_FFMPEG: ffmpeg,
    RETEST_TEST_FFPROBE: ffprobe,
  }
  const executableVariables = {
    chromium: 'RETEST_TEST_SECOND_BROWSER',
    firefox: 'RETEST_TEST_FIREFOX',
    webkit: 'RETEST_TEST_WEBKIT',
    electron: 'RETEST_TEST_ELECTRON',
  } as const
  for (const engine of ['chromium', 'firefox', 'webkit', 'electron'] as const) {
    const pin = archivePin(engine)
    const size = pin.archive.size
    const sha256 = pin.archive.sha256
    if (size === undefined || sha256 === undefined) throw new Error(`No size and checksum for ${describePin(pin)}.`)
    const archiveName = basename(decodeURIComponent(new URL(pin.archive.url).pathname))
    const fixture = join(folder, `${engine}-mac-arm64-${archiveName}`)
    process.stdout.write(`Downloading ${describePin(pin)} from ${pin.archive.url}\n`)
    const downloaded = await downloadFile({
      url: pin.archive.url,
      to: fixture,
      expectedSize: size,
      maximumBytes: size,
      signal: new AbortController().signal,
      idleMs: 60_000,
      totalMs: 15 * 60_000,
      userAgent: 'retest-ci',
    })
    if (!downloaded.ok) throw new Error(downloaded.message)
    if (downloaded.sha256 !== sha256) {
      await rm(fixture)
      throw new Error(`${describePin(pin)} archive SHA-256 ${downloaded.sha256} differs from the pinned ${sha256}; nothing was unpacked.`)
    }
    process.stdout.write(`Verified ${describePin(pin)}: ${downloaded.size} bytes, SHA-256 ${sha256}\n`)
    const cachedArchive = archivePath(folders, pin)
    await mkdir(dirname(cachedArchive), { recursive: true })
    await copyFile(fixture, cachedArchive, constants.COPYFILE_EXCL)
    const build = buildFolder(folders, pin)
    environment[executableVariables[engine]] = engine === 'webkit' ? join(build, treeFolder) : installedExecutablePath(build, pin)
    if (engine === 'electron') environment['RETEST_TEST_ELECTRON_ARCHIVE'] = fixture
  }
  const lines = Object.entries(environment).map(([name, value]) => {
    if (/[\r\n]/.test(value)) throw new Error(`The CI path for ${name} contains a line break.`)
    return `${name}=${value}\n`
  }).join('')
  await appendFile(environmentFile, lines)
  process.stdout.write(lines)
}

const folder = process.argv[2]
const environmentFile = process.env['GITHUB_ENV']
if (process.argv.length !== 3 || folder === undefined || !isAbsolute(folder) || environmentFile === undefined || !isAbsolute(environmentFile)) {
  process.stderr.write('Usage: node scripts/ci/prepare-macos-integration.ts <absent absolute folder>, with GITHUB_ENV set.\n')
  process.exit(2)
}
try {
  await prepare(folder, environmentFile)
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
