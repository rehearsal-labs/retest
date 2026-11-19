import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { runProject, tempProject } from '../support/project.ts'
import { eventsOfType } from '../support/run-harness.ts'

const config = `import { chromium, defineConfig } from 'retest'
export default defineConfig({ apps: { web: chromium({ baseUrl: 'http://127.0.0.1:4173', executablePath: '/fake/chromium' }) } })
`

// A test file whose first load, collection's, goes straight through, and whose second, the load that runs its test,
// waits until a mark named \`mark\` is in the project's folder.
function waitsToRun(name: string, mark: string): string {
  return `import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { expect, test } from 'retest'

const root = join(import.meta.dirname, '..')
const collected = join(root, 'collected-${name}')
if (existsSync(collected)) {
  while (!existsSync(join(root, ${JSON.stringify(mark)}))) await delay(10)
} else {
  writeFileSync(collected, '')
}

test('${name} runs', () => {
  expect(1).toBe(1)
})
`
}

const passing = (name: string): string => `import { expect, test } from 'retest'

test('${name} runs', () => {
  expect(1).toBe(1)
})
`

// The kinds of the run's start-up events, each run of the same kind once.
function startOrder(events: readonly { type: string }[]): string[] {
  const kinds = events.map((event) => event.type).filter((type) => ['run.started', 'collection.completed', 'browser.started', 'test.started'].includes(type))
  return kinds.filter((type, index) => type !== kinds[index - 1])
}

describe('browsers launched once the plan is known', () => {
  test('the browser starts launching while the first test file loads to run, and is told just before its test starts, as before', async () => {
    const root = tempProject({ 'retest.config.ts': config, 'tests/first.retest.ts': waitsToRun('first', 'launching') })
    // The file loads to run only once the launch has begun: a browser launched when the test first asks would never come.
    const record = await runProject(root, { files: ['tests/first.retest.ts'], fake: { holdLaunch: async () => writeFileSync(join(root, 'launching'), '') }, timeouts: { collection: 3000 } })
    assert.equal(record.result.exitCode, 0, JSON.stringify(record.result.files))
    assert.equal(record.browsers.length, 1)
    assert.deepEqual(startOrder(record.events), ['run.started', 'collection.completed', 'browser.started', 'test.started'])
  })

  test('the browsers of a run on two workers launch at the same time', async () => {
    const root = tempProject({ 'retest.config.ts': config, 'tests/one.retest.ts': passing('one'), 'tests/two.retest.ts': passing('two') })
    // Each launch waits until both have begun, which a launch that waits for the other to finish never sees.
    let begun = 0
    const both = Promise.withResolvers<void>()
    const record = await runProject(root, {
      files: ['tests/one.retest.ts', 'tests/two.retest.ts'],
      workers: 2,
      fake: { holdLaunch: async () => { begun += 1; if (begun === 2) both.resolve(); await both.promise } },
    })
    assert.equal(record.result.exitCode, 0, JSON.stringify(record.result.files))
    assert.equal(record.browsers.length, 2)
    assert.equal(eventsOfType(record.events, 'browser.started').length, 2)
  })

  test('a run stopped once its browser began launching, before any test asked for it, closes the browser and tells of none', async () => {
    const root = tempProject({ 'retest.config.ts': config, 'tests/first.retest.ts': waitsToRun('first', 'never') })
    const controller = new AbortController()
    const record = await runProject(root, { files: ['tests/first.retest.ts'], signal: controller.signal, fake: { holdLaunch: async () => controller.abort() } })
    assert.equal(record.result.status, 'interrupted')
    assert.deepEqual(record.browsers.map((browser) => browser.closed), [true], 'the browser the run launched is closed')
    assert.deepEqual(eventsOfType(record.events, 'browser.started'), [])
    assert.equal(record.result.browser, null)
  })
})
