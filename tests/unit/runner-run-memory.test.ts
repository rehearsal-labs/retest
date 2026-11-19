import type { RetestEvent } from '../../src/protocol/events.ts'
import type { Reporter } from '../../src/reporters/reporter.ts'
import type { Writer } from '../../src/reporters/style.ts'
import type { FakeBrowser } from '../support/fake-browser.ts'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { setFlagsFromString } from 'node:v8'
import { runInNewContext } from 'node:vm'
import { configFileName, loadConfig } from '../../src/config/load.ts'
import { createAgentReporter } from '../../src/reporters/agent.ts'
import { createHtmlReporter } from '../../src/reporters/html/reporter.ts'
import { createHumanReporter } from '../../src/reporters/human.ts'
import { createJsonlReporter } from '../../src/reporters/jsonl.ts'
import { runFiles } from '../../src/runner/run.ts'
import { fakeLauncher } from '../support/fake-browser.ts'
import { fakeExecutable, tempProject } from '../support/project.ts'
import { newRunFolder, quickTimeouts } from '../support/run-harness.ts'

// A long run's parent keeps, for each test that has finished, what the result says of it and little more: its memory,
// after a full collection, does not grow with every event of every test. Each built-in reporter a person can pick runs
// on the same fake-browser run of many short tests, each a goto, a fill, a click and a text check, as a run on a
// config's app does. The heap is read after a full collection every 50 tests once the run has warmed up, and the slope
// of those readings, per test, stays under what one test's result takes in memory with room to spare. A wait that
// leaves its result on the run's stop makes the slope here about 8 KB per test, and a reporter that keeps every event
// of every test about 20 KB.

setFlagsFromString('--expose-gc')
const gc: unknown = runInNewContext('gc')

const files = 12
const perFile = 50
const total = files * perFile
const warm = 100
const step = 50
// What the heap may gain for each test: a result of this run takes about 2 KB in memory, and the slope moves by about
// a kilobyte from run to run.
const allowedPerTest = 6 * 1024

function collectedHeap(): number {
  if (typeof gc !== 'function') throw new Error('No collector: v8 would not expose gc.')
  gc()
  gc()
  return process.memoryUsage().heapUsed
}

const discard: Writer = { write: () => true }

/**
 * Reads the heap after a full collection every `step` tests from `warm` to `last`. The fake browser's own record of every
 * page and command is emptied first: it is the test's bookkeeping, not the run's.
 */
function heapReader(browsers: readonly FakeBrowser[], last: number): Reporter & { readings: Map<number, number> } {
  const readings = new Map<number, number>()
  let finished = 0
  return {
    name: 'heap',
    readings,
    onEvent(event: RetestEvent) {
      if (event.type !== 'test.finished') return
      finished += 1
      if (finished < warm || finished > last || finished % step !== 0) return
      for (const browser of browsers) {
        browser.pages.length = 0
        browser.commands.length = 0
        browser.pageBudgets.length = 0
      }
      readings.set(finished, collectedHeap())
    },
    onRunEnd() {},
  }
}

function project(): string {
  const config = `import { chromium, defineConfig } from 'retest'
export default defineConfig({
  apps: { web: chromium({ baseUrl: 'http://127.0.0.1:4173', executablePath: '/fake/chromium' }) },
})
`
  const sources: Record<string, string> = { [configFileName]: config }
  for (let file = 1; file <= files; file += 1) {
    const tests: string[] = []
    for (let index = 1; index <= perFile; index += 1) {
      const text = `Release checklist ${file}-${index}`
      tests.push(`test('saves task ${index}', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('task-title').fill('${text}')
  await page.getByTestId('save-task').click()
  await expect(page.getByTestId('saved-task')).toHaveText('${text}')
})`)
    }
    sources[`tests/bench-${file}.retest.ts`] = `import { expect, test } from 'retest'\n\n${tests.join('\n\n')}\n`
  }
  return tempProject(sources)
}

type Reporters = (folder: string) => Reporter[]

type Gained = { perTest: number; readings: string }

async function gainedPerTest(root: string, reporters: Reporters): Promise<Gained> {
  const loaded = await loadConfig(join(root, configFileName))
  assert.ok(loaded.ok, `the config loads: ${loaded.ok ? '' : loaded.failure.message}`)
  const folder = newRunFolder()
  const { launch, browsers } = fakeLauncher()
  const reader = heapReader(browsers, total)
  const result = await runFiles(
    {
      files: Array.from({ length: files }, (_, index) => `tests/bench-${index + 1}.retest.ts`),
      rootDir: root,
      apps: { kind: 'config', config: loaded.config, secrets: new Map() },
      timeouts: quickTimeouts,
      outputDir: folder,
      headless: true,
      workers: 4,
      signal: new AbortController().signal,
    },
    [...reporters(folder), reader],
    launch,
    fakeExecutable,
  )
  assert.equal(result.exitCode, 0, JSON.stringify(result.failure ?? result.counts))
  assert.equal(result.counts.passed, total)
  assert.equal(reader.readings.size, (total - warm) / step + 1, 'the heap was read at every point')
  const readings = [...reader.readings]
  return { perTest: slope(readings), readings: readings.map(([finished, heap]) => `${finished}: ${(heap / 1e6).toFixed(1)} MB`).join(', ') }
}

// The least-squares slope of the heap against the tests finished, in bytes per test.
function slope(points: readonly (readonly [number, number])[]): number {
  const mean = (values: readonly number[]): number => values.reduce((sum, value) => sum + value, 0) / values.length
  const meanX = mean(points.map(([x]) => x))
  const meanY = mean(points.map(([, y]) => y))
  const covariance = points.reduce((sum, [x, y]) => sum + (x - meanX) * (y - meanY), 0)
  const variance = points.reduce((sum, [x]) => sum + (x - meanX) ** 2, 0)
  return covariance / variance
}

function human(folder: string): Reporter {
  return createHumanReporter({ stdout: discard, stderr: discard, color: false, runFolder: folder })
}

const reporters: Record<string, Reporters> = {
  human: (folder) => [human(folder)],
  jsonl: () => [createJsonlReporter({ stdout: discard })],
  agent: (folder) => [createAgentReporter({ stdout: discard, runFolder: folder })],
  html: (folder) => [createHtmlReporter({ terminal: human(folder), stdout: discard, runFolder: folder, directory: folder })],
}

describe('a long run keeps little in memory for each test that finished', () => {
  const root = project()
  for (const [name, chosen] of Object.entries(reporters)) {
    test(`with the ${name} reporter`, { timeout: 120_000 }, async (t) => {
      const gained = await gainedPerTest(root, chosen)
      t.diagnostic(`gained ${Math.round(gained.perTest)} bytes per test; ${gained.readings}`)
      assert.ok(gained.perTest < allowedPerTest, `the heap gained ${Math.round(gained.perTest)} bytes per test after a full collection, more than the ${allowedPerTest} a result needs; ${gained.readings}`)
    })
  }
})
