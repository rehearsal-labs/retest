import type { BenchmarkOptions } from '../../benchmarks/options.ts'
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { parseOptions } from '../../benchmarks/options.ts'

// Any file stands in for the browser: the parser only checks that it exists.
const browser = ['--browser', process.execPath]

function options(argv: readonly string[]): BenchmarkOptions {
  const parsed = parseOptions(argv, '/work')
  assert.equal(parsed.kind, 'run')
  if (parsed.kind !== 'run') throw new Error('unreachable')
  return parsed.options
}

describe('parseOptions', () => {
  test('defaults: both fixtures, three sizes, four runners, five runs, the latest Playwright, a build', () => {
    const parsed = options(browser)
    assert.deepEqual(parsed.fixtures, ['task-app', 'search-app'])
    assert.deepEqual(parsed.sizes, [
      { tests: 1, files: 1 },
      { tests: 20, files: 1 },
      { tests: 200, files: 10 },
    ])
    assert.deepEqual(parsed.runners, ['retest', 'retest-playwright', 'playwright', 'playwright-1-worker'])
    assert.equal(parsed.runs, 5)
    assert.equal(parsed.playwrightVersion, 'latest')
    assert.equal(parsed.build, true)
    assert.equal(parsed.reinstall, false)
    assert.match(parsed.output, /^\/work\/\.retest\/benchmarks\/\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}$/)
    assert.equal(parsed.runTimeoutMs, 900_000)
  })

  test('--help asks for the usage text instead of a run', () => {
    assert.deepEqual(parseOptions(['--help'], '/work'), { kind: 'help' })
    assert.deepEqual(parseOptions(['-h', ...browser], '/work'), { kind: 'help' })
  })

  test('reads sizes as tests with files after a slash', () => {
    assert.deepEqual(options([...browser, '--sizes', '5, 40/4']).sizes, [
      { tests: 5, files: 1 },
      { tests: 40, files: 4 },
    ])
  })

  test('reads a subset of fixtures and runners, and the other flags', () => {
    const parsed = options([
      ...browser,
      '--fixtures',
      'search-app',
      '--runners',
      'retest, playwright',
      '--runs',
      '2',
      '--no-build',
      '--reinstall',
      '--output',
      'out',
      '--playwright-version',
      '1.63.0',
    ])
    assert.deepEqual(parsed.fixtures, ['search-app'])
    assert.deepEqual(parsed.runners, ['retest', 'playwright'])
    assert.equal(parsed.runs, 2)
    assert.equal(parsed.build, false)
    assert.equal(parsed.reinstall, true)
    assert.equal(parsed.output, '/work/out')
    assert.equal(parsed.playwrightVersion, '1.63.0')
  })

  test('rejects what it cannot run, naming the flag', () => {
    assert.throws(() => parseOptions(['--browser', '/no/such/browser'], '/work'), /No browser at \/no\/such\/browser/)
    assert.throws(() => parseOptions([...browser, '--fixtures', 'vitest'], '/work'), /--fixtures takes task-app, search-app, not vitest/)
    assert.throws(() => parseOptions([...browser, '--runners', 'cypress'], '/work'), /--runners takes/)
    assert.throws(() => parseOptions([...browser, '--runners', 'retest,retest'], '/work'), /--runners names retest twice/)
    assert.throws(() => parseOptions([...browser, '--fixtures', 'task-app, task-app'], '/work'), /--fixtures names task-app twice/)
    assert.throws(() => parseOptions([...browser, '--sizes', '0'], '/work'), /--sizes takes a whole number from 1, not 0/)
    assert.throws(() => parseOptions([...browser, '--sizes', '2/3'], '/work'), /--sizes 2\/3 has more files than tests/)
    assert.throws(() => parseOptions([...browser, '--sizes', '1/2/3'], '/work'), /--sizes takes tests\[\/files\] entries/)
    assert.throws(() => parseOptions([...browser, '--runs', 'five'], '/work'), /--runs takes a whole number from 1, not five/)
  })
})
