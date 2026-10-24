import { constants, existsSync } from 'node:fs'
import { appendFile, copyFile, mkdir, rm } from 'node:fs/promises'
import { release, version } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { buildFolder, buildPlatform, cacheFolders, describePin, installedExecutablePath } from '../../src/browser/builds.ts'
import { resolveExecutable, systemHost } from '../../src/browser/executables.ts'
import { downloadFile } from '../../src/cli/install/download.ts'
import { archivePath } from '../../src/cli/install/install-archive.ts'
import { systemUnpackTools } from '../../src/cli/install/unpack.ts'
import { archiveMatchesPin } from './macos-pins.ts'
import { windowsArchiveEngines, windowsArchivePin } from './windows-pins.ts'
import { mediaExecutableName, mediaTarget } from '../../src/cli/install/media-pins.ts'
import { mediaFolder } from '../../src/cli/install/media-record.ts'
import { findMediaTool } from '../../src/cli/install/media-tools.ts'

// The Windows twin of prepare-macos-integration.ts. The installer deletes successful downloads, while install.test.ts
// needs the real publisher archives as local fixtures. Fetch once through the product downloader, check the product
// pins, keep the fixtures and copy the same bytes to the installer's download cache. The workflow then runs the built
// product CLI to unpack and verify them. Given a cache folder, an archive already there is used when its size and
// SHA-256 match the pin, and every archive downloaded is left there for the workflow to save; one that does not match
// is downloaded again, as with no cache.
//
//   node scripts/ci/prepare-windows-integration.ts <absent absolute folder> [<absolute archive cache folder>]

async function prepare(folder: string, environmentFile: string, cache: string | undefined): Promise<void> {
  if (buildPlatform() !== 'win-x64') throw new Error('This setup requires Windows x64.')
  process.stdout.write(`Preparing pinned integration prerequisites on ${version()} ${release()} ${process.arch}\n`)
  if (!existsSync(systemUnpackTools.tar)) throw new Error(`The installer unpacks with Windows' own tar.exe, and there is none at ${systemUnpackTools.tar}.`)
  const folders = cacheFolders(process.env)
  if (folders === undefined) throw new Error('No absolute LOCALAPPDATA for the browser cache.')

  // mkdir refuses a reused fixture folder; exclusive copies never overwrite another install's archive.
  await mkdir(folder)
  // The browser files run on the runner's own Google Chrome, as macOS runs them on the Chrome in /Applications, found
  // where Windows installs it; the files that need a second Chromium build run on the pinned Chrome for Testing. The
  // windows-2025 image installs Chrome machine-wide from Google's enterprise installer, under Program Files.
  const chrome = resolveExecutable({ product: 'chrome' }, systemHost())
  if (!chrome.ok) throw new Error(chrome.failure.message)
  const environment: Record<string, string> = {
    RETEST_TEST_BROWSER_ARCHIVES: folder,
    RETEST_FIREFOX_ROUTE: 'spawn',
    RETEST_TEST_BROWSER: chrome.path,
  }
  const executableVariables = {
    chromium: 'RETEST_TEST_SECOND_BROWSER',
    firefox: 'RETEST_TEST_FIREFOX',
    electron: 'RETEST_TEST_ELECTRON',
  } as const
  // Recordings run on the pinned media process, built from the checked commit's source, and the runner's ffmpeg.
  const target = mediaTarget()
  const media = target === undefined ? undefined : mediaFolder(process.env, target)
  if (target === undefined || media === undefined) throw new Error('No media build target for this machine.')
  const ffmpeg = await findMediaTool('ffmpeg', process.env)
  const ffprobe = await findMediaTool('ffprobe', process.env)
  if (ffmpeg === undefined || ffprobe === undefined) throw new Error('Install ffmpeg and ffprobe on PATH before this setup.')
  environment['RETEST_TEST_MEDIA_BINARY'] = join(media, mediaExecutableName(target))
  environment['RETEST_MEDIA_BINARY'] = join(media, mediaExecutableName(target))
  environment['RETEST_TEST_FFMPEG'] = ffmpeg
  environment['RETEST_TEST_FFPROBE'] = ffprobe
  for (const engine of windowsArchiveEngines) {
    const pin = windowsArchivePin(engine)
    const size = pin.archive.size
    const sha256 = pin.archive.sha256
    if (size === undefined || sha256 === undefined) throw new Error(`No size and checksum for ${describePin(pin)}.`)
    const archiveName = basename(decodeURIComponent(new URL(pin.archive.url).pathname))
    const fixture = join(folder, `${engine}-win-x64-${archiveName}`)
    const kept = cache === undefined ? undefined : join(cache, basename(fixture))
    if (kept !== undefined && await archiveMatchesPin(kept, { size, sha256 })) {
      await copyFile(kept, fixture, constants.COPYFILE_EXCL)
      process.stdout.write(`Using the cached archive of ${describePin(pin)}: ${size} bytes, SHA-256 ${sha256}\n`)
    } else {
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
      if (kept !== undefined) {
        // What was there did not match the pin; remove it, a link included, rather than write through it.
        await rm(kept, { force: true, recursive: true })
        await mkdir(dirname(kept), { recursive: true })
        await copyFile(fixture, kept, constants.COPYFILE_EXCL)
      }
    }
    const cachedArchive = archivePath(folders, pin)
    await mkdir(dirname(cachedArchive), { recursive: true })
    await copyFile(fixture, cachedArchive, constants.COPYFILE_EXCL)
    environment[executableVariables[engine]] = installedExecutablePath(buildFolder(folders, pin), pin)
    if (engine === 'electron') environment['RETEST_TEST_ELECTRON_ARCHIVE'] = fixture
  }
  const lines = Object.entries(environment).map(([name, value]) => {
    if (/[\r\n]/.test(value)) throw new Error(`The CI path for ${name} contains a line break.`)
    return `${name}=${value}\n`
  }).join('')
  await appendFile(environmentFile, lines)
  process.stdout.write(lines)
}

const given = process.argv[2]
const cache = process.argv[3]
const environmentFile = process.env['GITHUB_ENV']
if (process.argv.length < 3 || process.argv.length > 4 || given === undefined || !isAbsolute(given) || (cache !== undefined && !isAbsolute(cache)) || environmentFile === undefined || !isAbsolute(environmentFile)) {
  process.stderr.write('Usage: node scripts/ci/prepare-windows-integration.ts <absent absolute folder> [<absolute archive cache folder>], with GITHUB_ENV set.\n')
  process.exit(2)
}
try {
  // A bash step hands paths over with forward slashes after the runner's backslashed temporary folder.
  await prepare(resolve(given), environmentFile, cache === undefined ? undefined : resolve(cache))
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
