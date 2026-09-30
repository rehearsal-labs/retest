import type { LoadedConfig, LoadedTarget } from '../../src/config/loaded.ts'
import type { Timeouts } from '../../src/protocol/timeouts.ts'
import type { Reporter } from '../../src/reporters/reporter.ts'
import type { FindExecutable } from '../../src/runner/browser-pool.ts'
import type { ChildOutput, ResolvedSecret, Selection } from '../../src/runner/contract.ts'
import type { FakeOptions } from './fake-browser.ts'
import type { RunRecord } from './run-harness.ts'
import assert from 'node:assert/strict'
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { configFileName, loadConfig } from '../../src/config/load.ts'
import { runFiles } from '../../src/runner/run.ts'
import { resolveSecrets } from '../../src/runner/secrets.ts'
import { fakeLauncher } from './fake-browser.ts'
import { newRunFolder, quickTimeouts, readEvents, readResult, rootDir } from './run-harness.ts'
import { tempFolder } from './temp-folder.ts'

/**
 * A project outside the repository that imports Retest as a consumer does, through its own `node_modules`, with
 * these files written into it. Its runs keep `.retest/` to themselves.
 *
 * @example tempProject({ 'retest.config.ts': config, 'tests/a.retest.ts': tests })
 */
export function tempProject(files: Readonly<Record<string, string>>): string {
  const root = tempFolder('project-')
  const scope = join(root, 'node_modules', '@rehearsal-labs')
  mkdirSync(scope, { recursive: true })
  symlinkSync(rootDir, join(scope, 'retest'), 'dir')
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  return root
}

export type ProjectRunOptions = {
  files: readonly string[]
  /** The environment secrets are read from. */
  env?: Readonly<Record<string, string | undefined>>
  /** Secrets given ready, as a service that resolves its own passes them, in place of reading `env`. */
  secrets?: ReadonlyMap<string, ResolvedSecret>
  baseUrls?: Readonly<Record<string, string>>
  selection?: Selection
  fake?: FakeOptions
  timeouts?: Partial<Timeouts>
  reporters?: Reporter[]
  signal?: AbortSignal
  findExecutable?: FindExecutable
}

export type ProjectRecord = RunRecord & { root: string; config: LoadedConfig }

/** Loads the project's `retest.config.ts` and runs its files with the fake browser, reading back what the run wrote. */
export async function runProject(root: string, options: ProjectRunOptions): Promise<ProjectRecord> {
  const loaded = await loadConfig(join(root, configFileName))
  assert.ok(loaded.ok, `the config loads: ${loaded.ok ? '' : loaded.failure.message}`)
  const secrets = options.secrets === undefined ? resolveSecrets(loaded.config.secrets, options.env ?? {}) : { ok: true as const, secrets: options.secrets }
  assert.ok(secrets.ok, `the secrets resolve: ${secrets.ok ? '' : secrets.failure.message}`)
  const folder = newRunFolder()
  const { launch, browsers } = fakeLauncher(options.fake)
  const output: ChildOutput[] = []
  const baseUrls = options.baseUrls === undefined ? {} : { baseUrls: options.baseUrls }
  const result = await runFiles(
    {
      files: [...options.files],
      rootDir: root,
      apps: { kind: 'config', config: loaded.config, secrets: secrets.secrets, ...baseUrls },
      timeouts: { ...quickTimeouts, ...options.timeouts },
      outputDir: folder,
      headless: true,
      ...(options.selection === undefined ? {} : { selection: options.selection }),
      signal: options.signal ?? new AbortController().signal,
      onOutput: (chunk) => void output.push(chunk),
    },
    options.reporters ?? [],
    launch,
    options.findExecutable ?? fakeExecutable,
  )
  const { events, lines } = readEvents(folder)
  return { result, events, lines, folder, browsers, output, written: readResult(folder), root, config: loaded.config }
}

/** Resolves a target the way the real finder would name it, without looking at the machine. */
export const fakeExecutable: FindExecutable = async (target: LoadedTarget) => {
  if (target.browser === 'chromium') return { ok: true, path: target.executablePath ?? '/fake/chromium' }
  return { ok: true, path: `/fake/${target.browser}-${target.channel}` }
}
