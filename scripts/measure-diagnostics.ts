// Measures what console and network capture costs on the diagnostics fixture page: each test's duration with capture on
// and off, alternating, and the bytes an attempt's records held at most. Run once, by hand, on a quiet machine:
// node --conditions=retest-source scripts/measure-diagnostics.ts [rounds]
// It prints JSON. The numbers are one machine's, once; they support no claim.
import type { RunResult } from '../src/protocol/result.ts'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startTaskApp } from '../fixtures/task-app/server.ts'
import { configFileName, loadConfig } from '../src/config/load.ts'
import { capturedCounts } from '../src/protocol/diagnostics.ts'
import { defaultTimeouts } from '../src/protocol/timeouts.ts'
import { runFiles } from '../src/runner/run.ts'
import { resolveSecrets } from '../src/runner/secrets.ts'

const rounds = Number(process.argv[2] ?? '10')
const repository = fileURLToPath(new URL('../', import.meta.url))
const tests = ['main', 'flood'] as const
const testSource = `import { expect, test } from '@rehearsal-labs/retest'

test('main', async ({ page }) => {
  await page.goto('/diagnostics')
  await expect(page.getByTestId('status')).toHaveText('Done')
})

test('flood', async ({ page }) => {
  await page.goto('/diagnostics/flood?count=500&size=200&fetches=200')
  await expect(page.getByTestId('status')).toHaveText('Done')
})
`

type Sample = { capture: boolean; test: string; durationMs: number; heldBytes: number | undefined }

const app = await startTaskApp()
const root = mkdtempSync(join(tmpdir(), 'retest-measure-diagnostics-'))
try {
  mkdirSync(join(root, 'node_modules', '@rehearsal-labs'), { recursive: true })
  symlinkSync(repository, join(root, 'node_modules', '@rehearsal-labs', 'retest'), 'dir')
  mkdirSync(join(root, 'tests'))
  writeFileSync(join(root, 'tests', 'measure.retest.ts'), testSource)
  const samples: Sample[] = []
  const runs: { capture: boolean; durationMs: number }[] = []
  for (let round = 0; round < rounds; round += 1) {
    for (const capture of round % 2 === 0 ? [true, false] : [false, true]) {
      writeFileSync(
        join(root, configFileName),
        `import { chrome, defineConfig } from '@rehearsal-labs/retest'\nexport default defineConfig({ apps: { web: chrome({ baseUrl: ${JSON.stringify(app.url)} }) }, diagnostics: { capture: ${capture} } })\n`,
      )
      const loaded = await loadConfig(join(root, configFileName))
      if (!loaded.ok) throw new Error(loaded.failure.message)
      const secrets = resolveSecrets(loaded.config, {})
      if (!secrets.ok) throw new Error(secrets.failure.message)
      const result: RunResult = await runFiles(
        {
          files: ['tests/measure.retest.ts'],
          rootDir: root,
          apps: { kind: 'config', config: loaded.config, secrets: secrets.secrets },
          timeouts: defaultTimeouts,
          outputDir: join(root, 'runs', `${round}-${capture}`),
          headless: true,
          workers: 1,
          signal: new AbortController().signal,
          lastRunFile: false,
        },
        [],
      )
      if (result.exitCode !== 0) throw new Error(`a run exited ${result.exitCode}: ${result.failure?.message ?? ''}`)
      runs.push({ capture, durationMs: result.durationMs })
      for (const test of result.files.flatMap((file) => file.tests)) {
        const [summary] = test.diagnostics ?? []
        const consoleCounts = summary === undefined ? undefined : capturedCounts(summary.console)
        const networkCounts = summary === undefined ? undefined : capturedCounts(summary.network)
        const heldBytes = consoleCounts === undefined || networkCounts === undefined ? undefined : consoleCounts.bytes + networkCounts.bytes
        samples.push({ capture, test: test.name, durationMs: test.durationMs, heldBytes })
      }
    }
  }
  const summarize = (values: number[]): { median: number; min: number; max: number } => {
    const sorted = [...values].sort((first, second) => first - second)
    return { median: sorted[Math.floor(sorted.length / 2)] ?? 0, min: sorted[0] ?? 0, max: sorted.at(-1) ?? 0 }
  }
  const report = {
    rounds,
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    tests: Object.fromEntries(
      tests.map((name) => [
        name,
        {
          captureOnMs: summarize(samples.filter((sample) => sample.test === name && sample.capture).map((sample) => sample.durationMs)),
          captureOffMs: summarize(samples.filter((sample) => sample.test === name && !sample.capture).map((sample) => sample.durationMs)),
          heldBytes: summarize(samples.flatMap((sample) => (sample.test === name && sample.heldBytes !== undefined ? [sample.heldBytes] : []))),
        },
      ]),
    ),
    runOnMs: summarize(runs.filter((entry) => entry.capture).map((entry) => entry.durationMs)),
    runOffMs: summarize(runs.filter((entry) => !entry.capture).map((entry) => entry.durationMs)),
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
} finally {
  await app.close()
  rmSync(root, { recursive: true, force: true })
}
