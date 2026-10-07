import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, test } from 'node:test'
import { fakeCli, playing } from './cli-fixtures.ts'
import { failureScreenshot, png, writeFolder } from './reporters-html-fixtures.ts'
import { browserPath, failingRun, file, plain, projectFolder, resultOf } from './reporters-fixtures.ts'

// `retest report <folder>` and `retest run --reporter html`, through the command line with the runner faked: each
// writes report.html into the run folder, and both state the same outcome for the same run.

const root = projectFolder()

/** What a report marks about the run and each test, without where its result came from. */
function outcomeMarks(html: string): string[] {
  return [...html.matchAll(/data-(?:status|exit-code|complete|test-id|failure-class|evidence)="[^"]*"/g)].map(([mark]) => mark)
}

describe('retest report', () => {
  test('writes report.html into the run folder and prints where it is', async () => {
    const events = failingRun(root)
    const folder = writeFolder(root, 'report-finished', { events, result: resultOf(events), files: { [failureScreenshot]: png(8, 8) } })
    const fake = fakeCli({ cwd: root })
    const code = await fake.cli(['report', relative(root, folder)])
    assert.equal(code, 0, fake.stderr.text)
    assert.equal(fake.stdout.text, `${join(relative(root, folder), 'report.html')}\n`)
    assert.equal(fake.stderr.text, '')
    const html = readFileSync(join(folder, 'report.html'), 'utf8')
    assert.match(html, /^<!doctype html>/)
    assert.match(html, /data-status="failed" data-exit-code="1" data-complete="true" data-source="result\.json"/)
  })

  test('replaces an earlier report and leaves no temporary file behind', async () => {
    const events = failingRun(root)
    const folder = writeFolder(root, 'report-again', { events, result: resultOf(events) })
    writeFileSync(join(folder, 'report.html'), 'an earlier report')
    const fake = fakeCli({ cwd: root })
    assert.equal(await fake.cli(['report', folder]), 0, fake.stderr.text)
    assert.match(readFileSync(join(folder, 'report.html'), 'utf8'), /^<!doctype html>/)
    assert.deepEqual(readdirSync(folder).filter((name) => name.includes('.partial')), [])
  })

  test('warns that a run without result.json did not finish, and reports it as incomplete', async () => {
    const events = failingRun(root)
    const folder = writeFolder(root, 'report-cut', { events: events.slice(0, 6) })
    const fake = fakeCli({ cwd: root })
    assert.equal(await fake.cli(['report', folder]), 0, fake.stderr.text)
    assert.match(fake.stderr.text, /^warning: result\.json is missing, so the run did not finish\./)
    assert.match(readFileSync(join(folder, 'report.html'), 'utf8'), /data-status="error" data-exit-code="2" data-complete="false" data-source="events\.jsonl"/)
  })

  test('refuses a folder that is not a run folder, and a command line without one folder', async () => {
    mkdirSync(join(root, 'not-a-run'), { recursive: true })
    const empty = fakeCli({ cwd: root })
    assert.equal(await empty.cli(['report', 'not-a-run']), 2)
    assert.match(empty.stderr.text, /error: not-a-run has neither result\.json nor events\.jsonl, so it is not a run folder\./)
    assert.equal(existsSync(join(root, 'not-a-run', 'report.html')), false)
    const missing = fakeCli({ cwd: root })
    assert.equal(await missing.cli(['report']), 2)
    assert.match(missing.stderr.text, /Name the run folder to report on/)
    const two = fakeCli({ cwd: root })
    assert.equal(await two.cli(['report', 'a', 'b']), 2)
    assert.match(two.stderr.text, /report reads one run folder, received 2\./)
  })

  test('is listed in the help', async () => {
    const fake = fakeCli({ cwd: root })
    assert.equal(await fake.cli(['--help']), 0)
    assert.match(fake.stdout.text, /report <run-folder> +Write an HTML report of a run folder/)
    const own = fakeCli({ cwd: root })
    assert.equal(await own.cli(['help', 'report']), 0)
    assert.match(own.stdout.text, /retest report <run-folder>/)
  })
})

describe('retest run --reporter html', () => {
  test('prints the human report, writes report.html into the run folder, and says where', async () => {
    const events = failingRun(root)
    mkdirSync(join(root, 'html-run'), { recursive: true })
    const fake = fakeCli({ cwd: root, runFiles: playing(events) })
    const code = await fake.cli(['run', file, '--browser', browserPath, '--output', 'html-run', '--reporter', 'html'])
    assert.equal(code, 1, fake.stderr.text)
    const printed = plain(fake.stdout.text)
    assert.match(printed, /✗ saves a task {2}5\.6s/)
    assert.match(printed, /Exit {4}1\n\n {2}Report {2}html-run\/report\.html\n\n$/)
    const fromRun = readFileSync(join(root, 'html-run', 'report.html'), 'utf8')
    assert.match(fromRun, /data-source="run"/)

    // The same run's folder, reported afterwards, states the same outcome.
    const folder = writeFolder(root, 'html-run-folder', { events, result: resultOf(events) })
    const later = fakeCli({ cwd: root })
    assert.equal(await later.cli(['report', folder]), 0, later.stderr.text)
    assert.deepEqual(outcomeMarks(fromRun), outcomeMarks(readFileSync(join(folder, 'report.html'), 'utf8')))
  })

  test('is one of the reporters the run command names', async () => {
    const fake = fakeCli({ cwd: root })
    assert.equal(await fake.cli(['help', 'run']), 0)
    assert.match(fake.stdout.text, /human, jsonl, agent or html/)
    assert.match(fake.stdout.text, /html prints the human report and writes report\.html in the run folder/)
  })
})
