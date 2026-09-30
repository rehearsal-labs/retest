import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { TASK_APP_PASSWORD } from '../../fixtures/task-app/sign-in.ts'
import { openApp } from './browser-harness.ts'
import {
  assertSucceeded,
  compilers,
  filesHolding,
  repositoryRoot,
  resultOf,
  runProject,
  secondBrowserPath,
  typecheck,
  writeProject,
} from './cli-harness.ts'

// The example project in examples/tasks: its config registers its types, and its tests use every part of the
// milestone 2 API. It must type-check on both compilers and pass against the fixture app.

const example = join(repositoryRoot, 'examples/tasks')

function exampleFiles(): Record<string, string> {
  const paths = ['retest.config.ts', ...readdirSync(join(example, 'tests')).map((name) => `tests/${name}`)]
  return Object.fromEntries(paths.map((path) => [path, readFileSync(join(example, path), 'utf8')]))
}

for (const [name, compiler] of Object.entries(compilers)) {
  test(`the example project type-checks with ${name}`, async () => {
    assertSucceeded(await typecheck(compiler, example), `${name} on examples/tasks`)
  })
}

test('the example project passes against the task app, on two browsers and two emulated phones', async (t) => {
  const app = await openApp(t)
  // A copy outside the repository, so the run leaves nothing in the example folder.
  const root = await writeProject(t, exampleFiles())
  const run = await runProject(t, root, {
    env: { TASK_APP_URL: app.url, TASK_APP_PASSWORD, RETEST_CHROMIUM: secondBrowserPath() },
  })

  assert.equal(run.exit.code, 0, run.stderr)
  const tests = resultOf(run).files.flatMap((file) => file.tests)
  assert.deepEqual(
    tests.map((each) => [each.name, each.variantKey, each.status]),
    [
      ['saves a task in each desktop browser', 'desktop=chrome', 'passed'],
      ['saves a task in each desktop browser', 'desktop=chromium', 'passed'],
      ['taps a button on each phone', 'phone=pixel', 'passed'],
      ['taps a button on each phone', 'phone=iphone', 'passed'],
      ['the desktop clicks and the phone taps', 'desktop=chrome,phone=pixel', 'passed'],
      ['the desktop clicks and the phone taps', 'desktop=chromium,phone=iphone', 'passed'],
      ['each role has a session of its own', 'admin=chrome,web=chrome', 'passed'],
      ['a task one role saves stays in its own browser', 'admin=chrome,web=chrome', 'passed'],
      ['signed-in', 'web=chrome', 'passed'],
      ['starts signed in from the saved state', 'web=chrome', 'passed'],
      ['starts signed out without it', 'web=chrome', 'passed'],
      ['saves "Release checklist"', 'web=chrome', 'passed'],
      ['saves "Groceries"', 'web=chrome', 'passed'],
      ['the server counts one save for one click', 'web=chrome', 'passed'],
      ['lists the buttons whose names contain "save"', 'web=chrome', 'passed'],
      ['compares values', 'web=chrome', 'passed'],
    ],
  )
  assert.deepEqual(filesHolding(run.output, TASK_APP_PASSWORD), [])
})
