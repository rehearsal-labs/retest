import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isRecord, readRecord, readString } from './json.ts'
import type { BenchmarkOptions } from './options.ts'
import { assertSucceeded, runProgram } from './programs.ts'

export type Project = {
  readonly folder: string
  /** The tool's command-line entry, run with Node. */
  readonly entry: string
  readonly version: string
}

export type Workspace = {
  readonly retest: Project
  readonly playwright: Project
  readonly install: {
    /** Installing the packed tarball, offline. */
    readonly retestMs: number
    /** Installing @playwright/test from the registry, or null when the workspace already had that version. */
    readonly playwrightMs: number | null
  }
}

/**
 * Packs this checkout and installs it, and Playwright, into two projects outside the repository, so each runs as
 * a user would run it. Playwright stays installed between runs while its version is the one asked for; Retest is
 * packed and installed every time.
 */
export async function prepareWorkspace(options: BenchmarkOptions, repositoryRoot: string, log: (line: string) => void): Promise<Workspace> {
  await mkdir(options.workspace, { recursive: true })
  const npmEnv = { ...process.env, npm_config_cache: join(options.workspace, 'npm-cache'), npm_config_update_notifier: 'false' }
  if (options.build) {
    log('building retest')
    assertSucceeded(await runProgram('npm', ['run', 'build'], { cwd: repositoryRoot, env: npmEnv }), 'npm run build')
  }
  const tarball = await pack(repositoryRoot, join(options.workspace, 'pack'), npmEnv)

  const retestFolder = join(options.workspace, 'retest-project')
  await rm(retestFolder, { recursive: true, force: true })
  await createProject(retestFolder, 'retest-benchmark')
  log('installing retest from the packed tarball')
  const retestInstall = await runProgram('npm', ['install', '--offline', '--no-audit', '--no-fund', tarball], { cwd: retestFolder, env: npmEnv })
  assertSucceeded(retestInstall, 'npm install (retest)')

  const playwrightFolder = join(options.workspace, 'playwright-project')
  const version = await resolvePlaywrightVersion(options.playwrightVersion, options.workspace, npmEnv)
  const installed = await installedPackage(playwrightFolder, '@playwright/test')
  let playwrightMs: number | null = null
  if (installed === undefined || installed.version !== version || options.reinstall) {
    if (installed !== undefined && installed.version !== version) log(`replacing @playwright/test ${installed.version} with ${version}`)
    await rm(playwrightFolder, { recursive: true, force: true })
    await createProject(playwrightFolder, 'playwright-benchmark')
    log(`installing @playwright/test@${version}`)
    const spec = `@playwright/test@${version}`
    const run = await runProgram('npm', ['install', '--no-audit', '--no-fund', spec], { cwd: playwrightFolder, env: npmEnv })
    assertSucceeded(run, `npm install ${spec}`)
    playwrightMs = run.endedAt - run.startedAt
  }

  return {
    retest: await project(retestFolder, '@rehearsal-labs/retest'),
    playwright: await project(playwrightFolder, '@playwright/test'),
    install: { retestMs: retestInstall.endedAt - retestInstall.startedAt, playwrightMs },
  }
}

// `latest` is asked of the registry on every run, so a workspace left over from an earlier run never stands in for
// a newer release without saying so.
async function resolvePlaywrightVersion(requested: string, cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
  if (requested !== 'latest') return requested
  const run = await runProgram('npm', ['view', '@playwright/test', 'version'], { cwd, env, timeoutMs: 60_000 })
  const version = run.stdout.trim()
  if (run.code !== 0 || version === '') {
    throw new Error(`Could not ask the registry which @playwright/test is latest:\n${run.stderr.trim()}\nPass --playwright-version <version> to name one.`)
  }
  return version
}

async function pack(repositoryRoot: string, folder: string, env: NodeJS.ProcessEnv): Promise<string> {
  await rm(folder, { recursive: true, force: true })
  await mkdir(folder, { recursive: true })
  assertSucceeded(await runProgram('npm', ['pack', '--pack-destination', folder], { cwd: repositoryRoot, env }), 'npm pack')
  const [tarball, ...others] = await readdir(folder)
  if (tarball === undefined || others.length > 0) throw new Error(`npm pack left ${others.length + (tarball === undefined ? 0 : 1)} files in ${folder}, not one tarball.`)
  return join(folder, tarball)
}

async function createProject(folder: string, name: string): Promise<void> {
  await mkdir(folder, { recursive: true })
  await writeFile(join(folder, 'package.json'), `${JSON.stringify({ name, version: '0.0.0', private: true, type: 'module' }, null, 2)}\n`)
}

type Installed = { readonly folder: string; readonly version: string; readonly bin: string }

/** The package as installed in the project, with its first bin entry, or undefined when it is not there. */
async function installedPackage(projectFolder: string, name: string): Promise<Installed | undefined> {
  const folder = join(projectFolder, 'node_modules', name)
  let text: string
  try {
    text = await readFile(join(folder, 'package.json'), 'utf8')
  } catch {
    return undefined
  }
  const parsed: unknown = JSON.parse(text)
  if (!isRecord(parsed)) return undefined
  const version = readString(parsed, 'version')
  const bin = readRecord(parsed, 'bin')
  const entry = bin === undefined ? undefined : readString(bin, Object.keys(bin)[0] ?? '')
  if (version === undefined || entry === undefined) return undefined
  return { folder, version, bin: entry }
}

async function project(folder: string, name: string): Promise<Project> {
  const installed = await installedPackage(folder, name)
  if (installed === undefined) throw new Error(`${name} is not installed in ${folder}.`)
  return { folder, entry: join(installed.folder, installed.bin), version: installed.version }
}
