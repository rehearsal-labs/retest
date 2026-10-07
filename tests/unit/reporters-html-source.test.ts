import type { RetestEvent } from '../../src/protocol/events.ts'
import assert from 'node:assert/strict'
import { linkSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { buildReport } from '../../src/reporters/html/build-report.ts'
import { Redactor } from '../../src/runner/redactor.ts'
import { configFiles, configRun, writeFolder } from './reporters-html-fixtures.ts'
import { file, projectFolder, resultOf, temporaryFolder } from './reporters-fixtures.ts'

function relocated(events: RetestEvent[], path: string): RetestEvent[] {
  return events.map((event): RetestEvent => {
    if (event.type === 'assertion.failed') return { ...event, location: { file: path, line: 1, column: 1 } }
    if (event.type === 'test.finished' && event.failure !== undefined) return { ...event, failure: { ...event.failure, location: { file: path, line: 1, column: 1 } } }
    return event
  })
}

for (const kind of ['symlink', 'env'] as const) {
  test(`report source refuses the reviewer's ${kind} secret location`, async () => {
    const root = projectFolder()
    const outside = temporaryFolder()
    const secret = 'synthetic-source-private-value'
    const path = kind === 'symlink' ? 'linked.ts' : '.env'
    writeFileSync(join(outside, 'private.ts'), secret)
    if (kind === 'symlink') symlinkSync(join(outside, 'private.ts'), join(root, path))
    else writeFileSync(join(root, path), secret)
    const events = relocated(configRun(root), path)
    const result = resultOf(events)
    const directory = writeFolder(root, kind, { events, result, files: configFiles() })
    const input = { directory, shown: kind, source: 'run' as const, result, events, warnings: [], redactText: (text: string): string => text }
    const html = await buildReport(input)
    assert.ok(!html.includes(secret), 'source outside the loaded test bundle must never enter the report')
    assert.ok(html.includes(`${path}:1:1`), 'keep the recorded location')
  })
}

test('report source uses the run redactor on an approved loaded test file', async () => {
  const root = projectFolder()
  const secret = 'synthetic-loaded-source-value'
  writeFileSync(join(root, file), `const credential = '${secret}'\n`)
  const events = relocated(configRun(root), file)
  const result = resultOf(events)
  const directory = writeFolder(root, 'redacted', { events, result, files: configFiles() })
  const redactor = new Redactor()
  redactor.learn('credential', secret)
  const input = { directory, shown: 'redacted', source: 'run' as const, result, events, warnings: [], redactText: (text: string): string => redactor.redact(text) }
  const html = await buildReport(input)
  assert.ok(!html.includes(secret), 'redact before source enters markup')
  assert.ok(html.includes('{{credential}}'))
})

test('report source refuses a loaded test whose file itself is a symlink', async () => {
  const root = temporaryFolder()
  const outside = temporaryFolder()
  const secret = 'synthetic-loaded-link-value'
  mkdirSync(join(root, 'examples'))
  writeFileSync(join(outside, 'private.ts'), secret)
  symlinkSync(join(outside, 'private.ts'), join(root, file))
  const events = relocated(configRun(root), file)
  const result = resultOf(events)
  const directory = writeFolder(root, 'loaded-link', { events, result, files: configFiles() })
  const input = { directory, shown: 'loaded-link', source: 'run' as const, result, events, warnings: [], redactText: (text: string): string => text }
  assert.ok(!(await buildReport(input)).includes(secret))
})

for (const kind of ['hard-link', 'oversize', 'fifo', 'no-redactor', 'unbundled'] as const) {
  test(`report source withholds ${kind} test source while keeping its location`, async () => {
    const root = projectFolder()
    const outside = temporaryFolder()
    const secret = 'synthetic-bounded-source-value'
    const path = kind === 'hard-link' || kind === 'fifo' ? 'loaded.retest.ts' : file
    if (kind === 'hard-link') {
      writeFileSync(join(outside, 'private.ts'), secret)
      linkSync(join(outside, 'private.ts'), join(root, path))
    } else if (kind === 'fifo') {
      const made = spawnSync('mkfifo', [join(root, path)], { encoding: 'utf8' })
      assert.equal(made.status, 0, made.stderr)
    } else writeFileSync(join(root, path), `${secret}\n${kind === 'oversize' ? 'x'.repeat(1024 * 1024) : ''}`)
    const events = relocated(configRun(root), path).map((event): RetestEvent => {
      if (event.type !== 'test.started' || event.execution === undefined) return event
      return { ...event, file: path, execution: { ...event.execution, bundle: { sha256: 'b'.repeat(64), modules: kind === 'unbundled' ? [] : [{ path, sha256: 'a'.repeat(64) }] } } }
    })
    const result = resultOf(events)
    // The synthetic run selected this test file and recorded it in the bundle, except for the unbundled case.
    for (const selected of result.files) {
      selected.file = path
      for (const test of selected.tests) test.file = path
    }
    const directory = writeFolder(root, `bounded-${kind}`, { events, result, files: configFiles() })
    const input = { directory, shown: kind, source: 'run' as const, result, events, warnings: [], ...(kind === 'no-redactor' ? {} : { redactText: (text: string): string => text }) }
    const html = await buildReport(input)
    assert.ok(!html.includes(secret), 'refused source never enters markup')
    assert.ok(html.includes(`${path}:1:1`))
    assert.ok(!html.includes('class="code"'))
  })
}
