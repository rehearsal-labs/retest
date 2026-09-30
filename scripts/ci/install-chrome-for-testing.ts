// Installs the second browser Retest's integration tests need in CI: one pinned Chrome for Testing build, found
// through Google's Chrome for Testing JSON endpoint and downloaded from Google's own bucket, with no npm package.
// The archive must match the SHA-256 recorded when the version was pinned, and the unpacked browser must report
// that version. Prints the executable's path on stdout and everything else on stderr.
//
//   node scripts/ci/install-chrome-for-testing.ts <empty or absent folder>
//
// Chrome for Testing publishes no checksums. To pin another version, change `version`, run this once on each
// platform in `builds`, compare the unpacked browser with a copy obtained another way, then record the SHA-256
// the refusal names.

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

/** Chrome for Testing 153, the build Retest's checks were verified with on macOS (docs/guide.md). */
const version = '153.0.8010.12'
const endpoint = `https://googlechromelabs.github.io/chrome-for-testing/${version}.json`
const downloadOrigin = 'https://storage.googleapis.com/chrome-for-testing-public/'

type Build = { sha256: string; executable: string }

/** The platforms this installs, by Chrome for Testing's own platform names. */
const builds: Record<string, Build> = {
  'mac-arm64': {
    sha256: '930e2a2c15addbaca1fe9b07bfa520667bced556d7988707186819cb4279ef3b',
    executable: 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  },
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The archive's address for one platform, read from the endpoint's document for the pinned version. */
function downloadUrl(document: unknown, platform: string): string {
  if (!isRecord(document) || document['version'] !== version) throw new Error(`${endpoint} does not describe ${version}.`)
  const downloads = document['downloads']
  const chrome: unknown = isRecord(downloads) ? downloads['chrome'] : undefined
  if (!Array.isArray(chrome)) throw new Error(`${endpoint} lists no Chrome downloads.`)
  const entries: readonly unknown[] = chrome
  for (const entry of entries) {
    if (!isRecord(entry) || entry['platform'] !== platform) continue
    const url = entry['url']
    if (typeof url !== 'string' || !url.startsWith(downloadOrigin)) throw new Error(`${endpoint} gives ${platform} an address outside ${downloadOrigin}.`)
    return url
  }
  throw new Error(`Chrome for Testing ${version} has no download for ${platform}.`)
}

async function fetchOk(url: string): Promise<Response> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${url} answered ${response.status}.`)
  return response
}

/** Runs a program to its end and returns its standard output. Its errors go straight to stderr. */
function run(command: string, args: readonly string[]): string {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status ?? result.signal}.`)
  return result.stdout
}

async function install(target: string): Promise<string> {
  const platform = process.platform === 'darwin' ? `mac-${process.arch}` : `${process.platform}-${process.arch}`
  const build = builds[platform]
  if (build === undefined) throw new Error(`No Chrome for Testing build is pinned for ${platform}. Pinned: ${Object.keys(builds).join(', ')}.`)

  const folder = resolve(target)
  if (existsSync(folder) && readdirSync(folder).length > 0) throw new Error(`${folder} is not empty. Give an empty or absent folder.`)

  const url = downloadUrl(await (await fetchOk(endpoint)).json(), platform)
  process.stderr.write(`Downloading Chrome for Testing ${version} for ${platform} from ${url}\n`)
  const archive = new Uint8Array(await (await fetchOk(url)).arrayBuffer())
  const sha256 = createHash('sha256').update(archive).digest('hex')
  if (sha256 !== build.sha256) throw new Error(`The archive's SHA-256 is ${sha256}, not the pinned ${build.sha256}. Nothing was unpacked.`)
  process.stderr.write(`The archive matches the pinned SHA-256 ${sha256}\n`)

  await mkdir(folder, { recursive: true })
  const zip = join(folder, `chrome-${platform}.zip`)
  await writeFile(zip, archive)
  run('unzip', ['-q', zip, '-d', folder])
  await rm(zip)

  const executable = join(folder, build.executable)
  const reported = run(executable, ['--version']).trim()
  const expected = `Google Chrome for Testing ${version}`
  if (reported !== expected) throw new Error(`${executable} reports "${reported}", not "${expected}".`)
  process.stderr.write(`${reported} is ready\n`)
  return executable
}

const target = process.argv[2]
if (target === undefined || target === '') {
  process.stderr.write('Usage: node scripts/ci/install-chrome-for-testing.ts <empty or absent folder>\n')
  process.exit(2)
}
try {
  process.stdout.write(`${await install(target)}\n`)
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
}
