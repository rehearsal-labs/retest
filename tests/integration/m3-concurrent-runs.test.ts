import type { RetestEvent } from '../../src/protocol/events.ts'
import type { RunResult } from '../../src/protocol/result.ts'
import assert from 'node:assert/strict'
import { readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { retestEventSchema } from '../../src/protocol/events.ts'
import { lastRunFile } from '../../src/protocol/last-run.ts'
import { runResultSchema } from '../../src/protocol/result.ts'
import { eventsFile, resultFile } from '../../src/protocol/run-folder.ts'
import { openApp } from './browser-harness.ts'
import {
  assertJudged,
  assertReleased,
  completeLines,
  eventsOf,
  filesHolding,
  parseLine,
  readEvents,
  readResult,
  RetestProcess,
  scratchFolder,
  statesLeftIn,
  textHolds,
  writeProject,
} from './cli-harness.ts'

// Acceptance check 7: two runs at once in one process. A host's program calls runFiles twice without waiting for the
// first, each with its own root, config, secret, app and run folder. Both pass, each folder holds only its own run,
// and nothing either run started is left.

const runs = ['alpha', 'bravo'] as const
type Name = (typeof runs)[number]
const notes: Record<Name, string> = { alpha: 'alpha-note-4471', bravo: 'bravo-note-8823' }

const tests = `import { expect, secret, test } from '@rehearsal-labs/retest'

test('saves a note', async ({ page }) => {
  await page.goto('/')
  await page.getByLabel('Title').fill(secret('note'))
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByTestId('saved-task')).toHaveText('{{note}}')
})
`

// Each run's events go to stdout as JSON lines as they arrive, both runs mixed; each result goes to stderr.
const host = `import type { Reporter } from '@rehearsal-labs/retest/runner'
import { join } from 'node:path'
import { chrome, defineConfig } from '@rehearsal-labs/retest'
import { resolveSecrets, runFiles, validateConfig } from '@rehearsal-labs/retest/runner'

const [alphaUrl = '', bravoUrl = '', alphaOutput = '', bravoOutput = ''] = process.argv.slice(2)
const notes = ${JSON.stringify(notes)}

async function run(name: 'alpha' | 'bravo', baseUrl: string, outputDir: string) {
  const root = join(process.cwd(), name)
  const loaded = validateConfig(defineConfig({ apps: { web: chrome({ baseUrl }) }, secrets: { note: () => notes[name] } }), join(root, 'host.config.ts'))
  if (!loaded.ok) throw new Error(loaded.failure.message)
  const secrets = resolveSecrets(loaded.config, {})
  if (!secrets.ok) throw new Error(secrets.failure.message)
  const reporter: Reporter = { name, onEvent: (event) => void process.stdout.write(\`\${JSON.stringify(event)}\\n\`), onRunEnd: () => undefined }
  const result = await runFiles(
    {
      files: ['tasks.retest.ts'],
      rootDir: root,
      apps: { kind: 'config', config: loaded.config, secrets: secrets.secrets },
      timeouts: { collection: 5000, setup: 15000, action: 5000, navigation: 5000, assertion: 5000, test: 20000, cleanup: 5000 },
      outputDir,
      headless: true,
      signal: new AbortController().signal,
    },
    [reporter],
  )
  process.stderr.write(\`result \${name} \${JSON.stringify(result)}\\n\`)
  return result.exitCode
}

const codes = await Promise.all([run('alpha', alphaUrl, alphaOutput), run('bravo', bravoUrl, bravoOutput)])
process.exitCode = Math.max(...codes)
`

type Folder = { events: RetestEvent[]; result: RunResult; returned: RunResult }

test('two runs at once in one process both pass, each folder holds only its own run, and cleanup holds for both', async (t) => {
  const apps = { alpha: await openApp(t), bravo: await openApp(t) }
  const project = await writeProject(t, { 'package.json': '{ "type": "module" }\n', 'host.ts': host, 'alpha/tasks.retest.ts': tests, 'bravo/tasks.retest.ts': tests })
  const scratch = await scratchFolder(t)
  const outputs: Record<Name, string> = { alpha: join(scratch, 'alpha-run'), bravo: join(scratch, 'bravo-run') }
  const retest = await RetestProcess.start(t, {
    cwd: project,
    command: [process.execPath, '--conditions=retest-source', 'host.ts'],
    args: [apps.alpha.url, apps.bravo.url, outputs.alpha, outputs.bravo],
  })
  const exit = await retest.exited

  // Each run folder, validated, with the result the host printed for that run.
  const readFolder = (name: Name): Folder => {
    const events = readEvents(readFileSync(join(outputs[name], eventsFile), 'utf8'))
    for (const event of eventsOf(events, 'browser.started')) retest.ownGroup(event.pid)
    assertJudged(events)
    const printed = new RegExp(`^result ${name} (.+)$`, 'm').exec(retest.stderr)?.[1]
    assert.ok(printed !== undefined, `the host printed ${name}'s result. stderr:\n${retest.stderr}`)
    return { events, result: readResult(readFileSync(join(outputs[name], resultFile), 'utf8')), returned: parseLine(runResultSchema, printed, `${name}'s result`) }
  }
  const folders: Record<Name, Folder> = { alpha: readFolder('alpha'), bravo: readFolder('bravo') }
  await assertReleased(retest, [...folders.alpha.events, ...folders.bravo.events], outputs.alpha)
  assert.deepEqual(statesLeftIn(outputs.bravo), [], 'no saved sign-in state is left in the second run folder')

  assert.equal(exit.code, 0, retest.stderr)
  for (const name of runs) {
    const { events, result, returned } = folders[name]
    const other = name === 'alpha' ? 'bravo' : 'alpha'
    assert.deepEqual(returned, result, `${name}: the result runFiles returned is its result.json`)
    assert.deepEqual([result.status, result.exitCode, result.counts.passed], ['passed', 0, 1], `${name} passed`)

    // Every event of the folder is this run's: its own id, its own root, and its own app's pages only.
    assert.equal(events[0]?.type === 'run.started' ? events[0].rootDir : undefined, join(realpathSync(project), name))
    assert.ok(events.every((event) => event.runId === result.runId))
    assert.notEqual(result.runId, folders[other].result.runId)
    const addresses = eventsOf(events, 'navigation').map((event) => event.url)
    assert.deepEqual(addresses, [`${apps[name].url}/`], `${name} opened its own app once`)
    const text = readFileSync(join(outputs[name], eventsFile), 'utf8')
    assert.ok(!text.includes(apps[other].url), `${name}'s events never name ${other}'s app`)

    // Each run's secret was typed into its own app, and reads as its name in its own look; neither value is in either
    // folder or in the output.
    assert.equal(apps[name].submissions(), 1, `${name}'s app saved once`)
    assert.deepEqual(eventsOf(events, 'observation').at(-1)?.observed.text?.text, '{{note}}')
    for (const value of Object.values(notes)) {
      assert.deepEqual(filesHolding(outputs[name], value), [], `${name}'s folder holds no note`)
      assert.ok(!textHolds(retest.stdout, value) && !textHolds(retest.stderr, value))
    }

    // Each run kept its own record of what to run again, under its own root.
    const lastRun: unknown = JSON.parse(readFileSync(join(project, name, lastRunFile), 'utf8'))
    assert.deepEqual(lastRun, { schemaVersion: 1, runId: result.runId, finishedAt: result.finishedAt, tests: [] })
  }

  // The two ran at once: each started before the other finished, in two browsers.
  const span = (name: Name): [number, number] => [Date.parse(folders[name].result.startedAt), Date.parse(folders[name].result.finishedAt)]
  const [alphaStart, alphaEnd] = span('alpha')
  const [bravoStart, bravoEnd] = span('bravo')
  assert.ok(alphaStart < bravoEnd && bravoStart < alphaEnd, 'the two runs overlapped')
  const browsers = runs.map((name) => eventsOf(folders[name].events, 'browser.started').map((event) => event.pid))
  assert.equal(new Set(browsers.flat()).size, 2, 'each run started a browser of its own')

  // stdout is exactly both runs' events, each run's in its own order.
  const printed = completeLines(retest.stdout).map((line, index) => parseLine(retestEventSchema, line, `stdout line ${index + 1}`))
  for (const name of runs) {
    assert.deepEqual(printed.filter((event) => event.runId === folders[name].result.runId), folders[name].events, `stdout carries ${name}'s events in order`)
  }
  assert.equal(printed.length, folders.alpha.events.length + folders.bravo.events.length, 'and nothing else')
})
