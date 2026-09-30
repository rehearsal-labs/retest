import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { failureSchema, sourceLocationSchema } from '../../src/protocol/failures.ts'
import { s } from '../../src/protocol/schema.ts'
import { browserPath, openApp } from './browser-harness.ts'
import {
  assertReleased,
  budgets,
  eventsOf,
  exampleFile,
  finishRun,
  parseLine,
  repositoryRoot,
  RetestProcess,
  runRetest,
  scenario,
  scratchFolder,
} from './cli-harness.ts'

const listSchema = s.object({
  schemaVersion: s.literal(1),
  files: s.array(
    s.object({
      file: s.string(),
      collection: s.enum(['ok', 'failed']),
      failure: s.optional(failureSchema),
      tests: s.array(s.object({ testId: s.string(), name: s.string(), location: sourceLocationSchema })),
    }),
  ),
})

function packageVersion(): string {
  const manifest: unknown = JSON.parse(readFileSync(join(repositoryRoot, 'package.json'), 'utf8'))
  assert.ok(typeof manifest === 'object' && manifest !== null && 'version' in manifest && typeof manifest.version === 'string')
  return manifest.version
}

async function retestCommand(t: TestContext, args: readonly string[]) {
  const retest = await RetestProcess.start(t, { args })
  const exit = await retest.exited
  await assertReleased(retest, [])
  return { exit, stdout: retest.stdout, stderr: retest.stderr }
}

test('help lists the three commands, and --version prints the package version', async (t) => {
  const help = await retestCommand(t, ['--help'])
  assert.equal(help.exit.code, 0)
  for (const name of ['list', 'run', 'inspect']) assert.match(help.stdout, new RegExp(`^  ${name} `, 'm'))

  const version = await retestCommand(t, ['--version'])
  assert.deepEqual([version.exit.code, version.stdout], [0, `${packageVersion()}\n`])
})

test('an unknown option exits 2 before anything runs, and points to the help', async (t) => {
  const run = await retestCommand(t, ['run', exampleFile, '--retries', '2', '--browser', browserPath()])
  assert.equal(run.exit.code, 2)
  assert.match(run.stderr, /Unknown option --retries\./)
  assert.match(run.stderr, /See retest help run\./)
})

test('a run never writes over an earlier one: a folder that holds files is refused before anything runs', async (t) => {
  const output = await scratchFolder(t)
  await writeFile(join(output, 'notes.txt'), 'kept\n')
  const run = await retestCommand(t, ['run', exampleFile, '--browser', browserPath(), '--output', output])

  assert.equal(run.exit.code, 2)
  assert.match(run.stderr, /already holds files\. Retest never writes over a run/)
  assert.deepEqual(readdirSync(output), ['notes.txt'])
})

test('list --json reports each collected test with its source location, without a browser', async (t) => {
  const listed = await retestCommand(t, ['list', exampleFile, '--json'])
  assert.equal(listed.exit.code, 0)
  const { files } = parseLine(listSchema, listed.stdout, 'the list')
  assert.deepEqual(files, [
    {
      file: exampleFile,
      collection: 'ok',
      tests: [{ testId: `${exampleFile} > saves a task`, name: 'saves a task', location: { file: exampleFile, line: 3, column: 1 } }],
    },
  ])
})

test('list reports a file that throws once its tests were collected, keeps its tests and exits 2', async (t) => {
  const file = 'tests/support/files/after-collection-error.retest.ts'
  const listed = await retestCommand(t, ['list', file, '--json'])
  assert.equal(listed.exit.code, 2)
  const [collected, ...others] = parseLine(listSchema, listed.stdout, 'the list').files
  assert.equal(others.length, 0)
  assert.deepEqual([collected?.collection, collected?.failure?.class, collected?.tests.map((entry) => entry.name)], ['ok', 'test_error', ['is listed']])
  assert.match(listed.stderr, /^error: tests\/support\/files\/after-collection-error\.retest\.ts failed outside its tests \(.*:6:11\): .*thrown after the tests were collected\n$/)
})

test('a failed run prints one card, with a screenshot and an inspect command that reads it back', async (t) => {
  const app = await openApp(t, { mode: 'broken' })
  const run = await runRetest(t, { files: [exampleFile], baseUrl: app.url, reporter: 'human', timeouts: budgets({ assertion: 500 }) })

  assert.equal(run.exit.code, 1)
  for (const line of [/- Expected +"Release checklist"/, /\+ Received +"Release checklis"/, /Compared +whole text/, /› 7 │/]) {
    assert.match(run.stdout, line)
  }
  const screenshot = /Screenshot +(\S+\.png)/.exec(run.stdout)?.[1]
  assert.ok(screenshot !== undefined && existsSync(screenshot), 'the card names a screenshot that exists')
  const inspect = /Inspect +npx retest inspect (\S+) --test "([^"]+)"/.exec(run.stdout)
  assert.ok(inspect?.[1] !== undefined && inspect[2] !== undefined, 'the card names an inspect command')

  const shown = await retestCommand(t, ['inspect', inspect[1], '--test', inspect[2]])
  assert.equal(shown.exit.code, 0)
  assert.match(shown.stdout, /\+ Received +"Release checklis"/)
})

test('a coding agent gets the short report, ending in a next: line', async (t) => {
  const app = await openApp(t, { mode: 'broken' })
  const output = join(await scratchFolder(t), 'run')
  const args = ['run', exampleFile, '--browser', browserPath(), '--base-url', app.url, '--timeouts', budgets({ assertion: 500 }), '--output', output]
  const retest = await RetestProcess.start(t, { args, env: { CLAUDECODE: '1' } })
  const run = await finishRun({ retest, output })

  assert.equal(run.exit.code, 1)
  const lines = run.stdout.trimEnd().split('\n')
  assert.match(lines[0] ?? '', /^retest: 1 failed \(1\) in .+, exit 1$/)
  assert.ok(lines.includes(`fail ${exampleFile}:7 saves a task`), run.stdout)
  assert.equal(lines.at(-1), `next: npx retest inspect ${output} --test "${exampleFile} > saves a task" --json`)
})

test('test.step reports nested steps, and each action carries the step it ran in', async (t) => {
  const app = await openApp(t)
  const run = await runRetest(t, { files: [scenario('steps')], baseUrl: app.url })

  assert.equal(run.exit.code, 0)
  const steps = new Map(eventsOf(run.events, 'step.started').map((step) => [step.name, step]))
  assert.deepEqual([...steps.keys()], ['open the form', 'save a title', 'press save'])
  assert.equal(steps.get('press save')?.parentStepId, steps.get('save a title')?.stepId)
  assert.deepEqual(eventsOf(run.events, 'step.finished').map((step) => step.status), ['passed', 'passed', 'passed'])
  const actions = eventsOf(run.events, 'action.completed').map((action) => [action.command, action.stepId])
  assert.deepEqual(actions, [
    ['goto', steps.get('open the form')?.stepId],
    ['fill', steps.get('save a title')?.stepId],
    ['click', steps.get('press save')?.stepId],
  ])
  assert.equal(eventsOf(run.events, 'assertion.passed')[0]?.stepId, undefined)
})
