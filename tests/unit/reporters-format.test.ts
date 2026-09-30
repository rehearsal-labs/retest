import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { truncateText } from '../../src/protocol/failures.ts'
import { defaultTimeouts } from '../../src/protocol/timeouts.ts'
import { codeFrame, readCodeFrame } from '../../src/reporters/code-frame.ts'
import { formatInspectCommand, formatRerunCommand, shellQuote } from '../../src/reporters/commands.ts'
import { diffLines } from '../../src/reporters/diff.ts'
import { countParts, formatDetail, formatDuration, plural, quoteRecorded } from '../../src/reporters/format.ts'
import { recordEvents } from '../../src/reporters/run-record.ts'
import {
  file,
  lostBrowserRun,
  projectFolder,
  runStarted,
  savesTask,
  showsCount,
  stamp,
  temporaryFolder,
} from './reporters-fixtures.ts'

describe('formatDuration', () => {
  test('uses milliseconds below a second, then seconds, then minutes', () => {
    assert.equal(formatDuration(0), '0 ms')
    assert.equal(formatDuration(812.4), '812 ms')
    assert.equal(formatDuration(999.6), '1s')
    assert.equal(formatDuration(5000), '5s')
    assert.equal(formatDuration(5600), '5.6s')
    assert.equal(formatDuration(59_940), '59.9s')
    assert.equal(formatDuration(65_000), '1m 5s')
  })
})

describe('counts', () => {
  test('lists non-zero counts, worst first', () => {
    assert.deepEqual(countParts({ passed: 2, failed: 1, error: 0, notRun: 3, inconclusive: 0 }), [
      '1 failed',
      '2 passed',
      '3 not run',
    ])
    assert.deepEqual(countParts({ passed: 0, failed: 0, error: 2, notRun: 0, inconclusive: 1 }), [
      '2 errors',
      '1 inconclusive',
    ])
    assert.deepEqual(countParts({ passed: 0, failed: 0, error: 0, notRun: 0, inconclusive: 0 }), [])
    assert.equal(plural(1, 'test'), '1 test')
    assert.equal(plural(0, 'test'), '0 tests')
  })
})

describe('quoteRecorded', () => {
  test('quotes with escapes', () => {
    assert.equal(quoteRecorded(truncateText('Saving…')), '"Saving…"')
    assert.equal(quoteRecorded(truncateText('a "b"\n\tc')), '"a \\"b\\"\\n\\tc"')
    assert.equal(quoteRecorded(truncateText('')), '""')
  })

  test('notes a value the runner truncated, with its recorded length', () => {
    assert.equal(quoteRecorded({ text: 'abc', truncated: true, length: 9000 }), '"abc"… (3 of 9000 characters)')
  })

  test('cuts a long value for the terminal', () => {
    const quoted = quoteRecorded(truncateText('z'.repeat(1000)))
    assert.equal(quoted, `"${'z'.repeat(300)}"… (300 of 1000 characters)`)
  })

  test('formats every kind of failure detail', () => {
    assert.equal(formatDetail('hit test'), '"hit test"')
    assert.equal(formatDetail(2), '2')
    assert.equal(formatDetail(false), 'false')
    assert.equal(formatDetail(null), 'null')
    assert.equal(formatDetail({ text: 'x', truncated: true, length: 5000 }), '"x"… (1 of 5000 characters)')
  })
})

describe('commands', () => {
  test('quotes for a shell only as much as needed', () => {
    assert.equal(shellQuote('examples/task.retest.ts'), 'examples/task.retest.ts')
    assert.equal(shellQuote('http://127.0.0.1:4173/app'), 'http://127.0.0.1:4173/app')
    assert.equal(shellQuote('examples/task.retest.ts > saves a task'), '"examples/task.retest.ts > saves a task"')
    assert.equal(shellQuote(''), '""')
    assert.equal(shellQuote('costs $5'), "'costs $5'")
    assert.equal(shellQuote(`it's "quoted" \\ !`), `'it'\\''s "quoted" \\ !'`)
  })

  test('rerun repeats the file, browser, base URL and changed timeouts', () => {
    const [started] = stamp([runStarted('/work', { timeouts: { ...defaultTimeouts, assertion: 1000 } })])
    assert.equal(started?.type, 'run.started')
    if (started?.type !== 'run.started') return
    assert.equal(
      formatRerunCommand(started, { file, line: 3 }),
      'npx retest run examples/task.retest.ts:3 --browser "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --base-url http://127.0.0.1:4173 --timeouts assertion=1000',
    )
    const { baseUrl: _, ...withoutBaseUrl } = started.options
    const plainRun = { ...started, options: { ...withoutBaseUrl, timeouts: defaultTimeouts } }
    assert.equal(
      formatRerunCommand(plainRun, { file }),
      'npx retest run examples/task.retest.ts --browser "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"',
    )
    assert.match(formatRerunCommand(plainRun, { file, line: 12, row: 2 }), /^npx retest run "examples\/task\.retest\.ts:12#2" --browser /)
  })

  // A config's own budgets are in the recorded timeouts too; only what the command line gave is repeated.
  test('rerun repeats the budgets the command line gave, and none of them when it gave none', () => {
    const [started] = stamp([runStarted('/work', { timeouts: { ...defaultTimeouts, action: 20_000, assertion: 1000 } })])
    assert.equal(started?.type, 'run.started')
    if (started?.type !== 'run.started') return
    const fromConfig = { ...started, options: { ...started.options, commandLineTimeouts: {} } }
    assert.doesNotMatch(formatRerunCommand(fromConfig, { file, line: 3 }), /--timeouts/)
    const given = { ...started, options: { ...started.options, commandLineTimeouts: { assertion: 1000 } } }
    assert.match(formatRerunCommand(given, { file, line: 3 }), / --timeouts assertion=1000$/)
  })

  test('inspect names the run folder, the ASCII test id and JSON output', () => {
    assert.equal(formatInspectCommand({ runFolder: '.retest/runs/a' }), 'npx retest inspect .retest/runs/a')
    assert.equal(
      formatInspectCommand({ runFolder: 'my runs/a', testId: savesTask, json: true }),
      'npx retest inspect "my runs/a" --test "examples/task.retest.ts > saves a task" --json',
    )
  })
})

describe('diffLines', () => {
  test('marks lines only in one text and keeps the shared ones in order', () => {
    assert.deepEqual(diffLines('a\nb\nc', 'a\nx\nc'), [
      { kind: 'same', text: 'a' },
      { kind: 'expected', text: 'b' },
      { kind: 'received', text: 'x' },
      { kind: 'same', text: 'c' },
    ])
    assert.deepEqual(diffLines('a\nc', 'a\nb\nc'), [
      { kind: 'same', text: 'a' },
      { kind: 'received', text: 'b' },
      { kind: 'same', text: 'c' },
    ])
    assert.deepEqual(diffLines('a\nb', 'b'), [
      { kind: 'expected', text: 'a' },
      { kind: 'same', text: 'b' },
    ])
    assert.deepEqual(diffLines('same', 'same'), [{ kind: 'same', text: 'same' }])
    assert.deepEqual(diffLines('x\r\ny', 'x\ny'), [
      { kind: 'same', text: 'x' },
      { kind: 'same', text: 'y' },
    ])
  })

  test('shows both sides whole when they are too long to compare line by line', () => {
    const many = Array.from({ length: 600 }, (_, index) => `line ${index}`).join('\n')
    const lines = diffLines(many, `${many}\nextra`)
    assert.equal(lines.length, 1201)
    assert.equal(lines.filter((line) => line.kind === 'same').length, 0)
  })
})

describe('codeFrame', () => {
  const source = ['one', 'two', 'three', 'four', 'five'].join('\n')

  test('shows two lines before and one after, with the line marked', () => {
    const frame = codeFrame(source, 3)
    assert.deepEqual(frame, {
      ok: true,
      lines: [
        { number: 1, text: 'one', marked: false },
        { number: 2, text: 'two', marked: false },
        { number: 3, text: 'three', marked: true },
        { number: 4, text: 'four', marked: false },
      ],
    })
  })

  test('stays inside the file at its edges', () => {
    const first = codeFrame(source, 1)
    const last = codeFrame(source, 5)
    assert.deepEqual(first.ok ? first.lines.map((line) => line.number) : [], [1, 2])
    assert.deepEqual(last.ok ? last.lines.map((line) => line.number) : [], [3, 4, 5])
  })

  test('explains a line past the end or a missing file', () => {
    assert.deepEqual(codeFrame(source, 9), {
      ok: false,
      problem: 'line 9 is past the end of the file, which may have changed since the run',
    })
    const empty = temporaryFolder()
    assert.deepEqual(readCodeFrame(empty, { file, line: 1, column: 1 }), { ok: false, problem: 'the file is gone' })
    assert.equal(readCodeFrame(projectFolder(), { file, line: 7, column: 3 }).ok, true)
  })
})

describe('RunRecord', () => {
  test('files each test under its file and keeps its events in order', () => {
    const record = recordEvents(lostBrowserRun('/work'))
    assert.deepEqual([...record.files.keys()], [file])
    assert.deepEqual(
      record.files.get(file)?.tests.map((test) => test.testId),
      [savesTask, showsCount],
    )
    const saves = record.tests.get(savesTask)
    assert.deepEqual(
      saves?.events.map((event) => event.type),
      ['test.started', 'action.completed', 'navigation', 'action.completed', 'action.failed', 'test.finished'],
    )
    const count = record.tests.get(showsCount)
    assert.equal(count?.started, undefined)
    assert.equal(count?.finished?.status, 'not_run')
    assert.equal(record.finished?.exitCode, 2)
    assert.equal(record.last?.type, 'run.finished')
  })

  test('keeps events for a test nobody described apart', () => {
    const record = recordEvents(
      stamp([runStarted('/work'), { type: 'navigation', testId: 'ghost > test', attemptId: 'a', url: 'http://x/' }]),
    )
    assert.equal(record.tests.size, 0)
    assert.equal(record.strays.length, 1)
  })
})
