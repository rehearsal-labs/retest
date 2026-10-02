import type { RunResult } from '../../src/protocol/result.ts'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { retestEventSchema } from '../../src/protocol/events.ts'
import { parse } from '../../src/protocol/schema.ts'
import { defaultTimeouts } from '../../src/protocol/timeouts.ts'
import { fakeCli, playing, type FakeOptions } from './cli-fixtures.ts'
import { browserPath, failingRun, file, passingRun, plain, projectFolder, resultOf } from './reporters-fixtures.ts'

const root = projectFolder()
writeFileSync(join(root, 'examples', 'notes.ts'), '')
writeFileSync(join(root, 'examples', 'other.retest.ts'), '')
mkdirSync(join(root, 'examples', 'nested.retest.ts'))
mkdirSync(join(root, 'taken'))
writeFileSync(join(root, 'taken', 'events.jsonl'), '')
mkdirSync(join(root, 'empty'))

const browser = ['--browser', browserPath]
async function run(args: string[], options: Partial<FakeOptions> = {}) {
  const fake = fakeCli({ cwd: root, runFiles: playing(failingRun(root)), ...options })
  const code = await fake.cli(['run', ...args])
  return { ...fake, code, stdout: fake.stdout.text, stderr: fake.stderr.text }
}

async function rejected(args: string[]): Promise<string> {
  const { code, stdout, stderr, runs } = await run(args)
  assert.equal(code, 2, stderr)
  assert.equal(stdout, '')
  assert.equal(runs.length, 0, 'a rejected command line started a run')
  return stderr
}

function resultWith(exitCode: RunResult['exitCode']): RunResult {
  return { ...resultOf(passingRun(root)), exitCode }
}

describe('run options', () => {
  test('passes the files, folders, browser, base URL and budgets to the runner', async () => {
    const { runs, code } = await run([
      `./${file}`,
      'examples/other.retest.ts',
      ...browser,
      '--base-url',
      'http://127.0.0.1:4173',
      '--output',
      'out/first',
      '--timeouts',
      'action=500,test=3000',
    ])
    assert.equal(code, 1)
    const options = runs[0]?.options
    assert.ok(options !== undefined)
    assert.deepEqual(options.files, [file, 'examples/other.retest.ts'])
    assert.equal(options.rootDir, root)
    assert.deepEqual(options.apps, { kind: 'browser', browserPath, baseUrl: 'http://127.0.0.1:4173' })
    assert.equal(options.outputDir, join(root, 'out/first'))
    assert.deepEqual(options.timeouts, { ...defaultTimeouts, action: 500, test: 3000 })
    assert.equal(options.headless, true)
    assert.equal(options.signal.aborted, false)
  })

  test('resolves a relative browser path, leaves out an absent base URL and shows the browser when headed', async () => {
    const { runs } = await run([file, '--browser', 'bin/chrome', '--headed'])
    const options = runs[0]?.options
    assert.deepEqual(options?.apps, { kind: 'browser', browserPath: join(root, 'bin/chrome') })
    assert.equal(options?.headless, false)
    assert.deepEqual(options?.timeouts, defaultTimeouts)
  })

  test('writes to a new timestamped folder under .retest/runs by default', async () => {
    const { runs } = await run([file, ...browser])
    const outputDir = runs[0]?.options.outputDir ?? ''
    assert.match(outputDir.slice(root.length), /^\/\.retest\/runs\/\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d\.\d{3}Z$/)
  })

  test('takes an empty existing folder', async () => {
    assert.equal((await run([file, ...browser, '--output', 'empty'])).runs.length, 1)
  })
})

describe('run usage errors', () => {
  test('needs at least one file', async () => {
    assert.match(await rejected([...browser]), /Name at least one test file, such as examples\/task\.retest\.ts\./)
  })

  test('names a missing file and suggests a close one', async () => {
    assert.match(
      await rejected(['examples/tsak.retest.ts', ...browser]),
      /examples\/tsak\.retest\.ts does not exist\. Did you mean examples\/task\.retest\.ts\?/,
    )
    assert.match(await rejected(['nowhere/a.retest.ts', ...browser]), /nowhere\/a\.retest\.ts does not exist\.\n/)
  })

  test('takes files, not folders, and lists the test files inside', async () => {
    const stderr = await rejected(['examples', ...browser])
    assert.match(stderr, /examples is a folder\. Pass files, not folders/)
    assert.match(stderr, /Test files in it: examples\/other\.retest\.ts, examples\/task\.retest\.ts\./)
    assert.match(await rejected(['examples/nested.retest.ts', ...browser]), /is a folder\. Pass files, not folders/)
  })

  test('takes only files that end in .retest.ts', async () => {
    assert.match(
      await rejected(['examples/notes.ts', ...browser]),
      /examples\/notes\.ts is not a test file\. Test files end in \.retest\.ts\./,
    )
    assert.match(await rejected(['missing.test.ts', ...browser]), /is not a test file/)
  })

  test('rejects a file named twice, however it is spelt', async () => {
    assert.match(await rejected([file, `./${file}`, ...browser]), /\.\/examples\/task\.retest\.ts is named twice\./)
  })

  test('needs a config, or a browser without one', async () => {
    assert.match(
      await rejected([file]),
      /No retest\.config\.ts here\. Run npx retest init to write one, or pass --browser <path> to run without a config\./,
    )
    assert.match(await rejected([file, '--browser']), /--browser needs a value/)
  })

  test('needs a full http or https base URL', async () => {
    for (const url of ['localhost:3000', '/app', 'ftp://example.com', 'not a url']) {
      assert.match(
        await rejected([file, ...browser, '--base-url', url]),
        /--base-url must be a full http or https address/,
      )
    }
  })

  test('reports timeout mistakes with the timeout parser message', async () => {
    assert.match(
      await rejected([file, ...browser, '--timeouts', 'acton=5']),
      /--timeouts: Unknown timeout "acton"\. Use one of collection, setup/,
    )
    assert.match(
      await rejected([file, ...browser, '--timeouts', 'action=fast']),
      /--timeouts: The action timeout must be a whole number/,
    )
    assert.match(
      await rejected([file, ...browser, '--timeouts', 'action=5,action=6']),
      /--timeouts: The action timeout is given twice\./,
    )
    assert.match(
      await rejected([file, ...browser, '--timeouts', 'action']),
      /--timeouts: Write each timeout as name=milliseconds/,
    )
  })

  test('rejects an unknown reporter with a suggestion', async () => {
    assert.match(
      await rejected([file, ...browser, '--reporter', 'json']),
      /--reporter must be human, jsonl or agent, received "json"\. Did you mean jsonl\?/,
    )
  })

  test('rejects repeated and unknown options', async () => {
    assert.match(await rejected([file, ...browser, '--browser', '/other']), /--browser is given twice\./)
    assert.match(await rejected([file, ...browser, '--headless']), /Unknown option --headless\./)
    assert.match(await rejected([file, ...browser, '--base_url', 'http://x']), /Did you mean --base-url\?/)
  })

  test('never writes over another run', async () => {
    assert.match(
      await rejected([file, ...browser, '--output', 'taken']),
      /taken already holds files\. Retest never writes over a run/,
    )
    assert.match(
      await rejected([file, ...browser, '--output', 'examples/notes.ts']),
      /examples\/notes\.ts is a file\. Choose a new folder/,
    )
  })

  test('rejects contradicting report choices', async () => {
    assert.match(await rejected([file, ...browser, '--agent', '--no-agent']), /Use --agent or --no-agent, not both\./)
    assert.match(
      await rejected([file, ...browser, '--agent', '--reporter', 'human']),
      /--agent prints the agent report, so it cannot go with --reporter human\./,
    )
    assert.match(
      await rejected([file, ...browser, '--no-agent', '--reporter', 'agent']),
      /--no-agent turns the agent report off/,
    )
  })

  test('usage errors point to the run help', async () => {
    assert.match(await rejected([file, ...browser, '--jsn']), /\nSee retest help run\.\n$/)
  })
})

describe('run exit codes', () => {
  test('returns the exit code the run result carries', async () => {
    for (const exitCode of [0, 1, 2, 130, 143] as const) {
      const { code } = await run([file, ...browser], { runFiles: async () => resultWith(exitCode) })
      assert.equal(code, exitCode)
    }
  })

  test('returns 130 once interrupted, whatever the result says', async () => {
    const controller = new AbortController()
    const runFiles = async () => {
      controller.abort()
      return resultWith(0)
    }
    assert.equal((await run([file, ...browser], { runFiles, signal: controller.signal })).code, 130)
  })

  test('returns 143 once stopped by SIGTERM, whatever the result says', async () => {
    const controller = new AbortController()
    const runFiles = async () => {
      controller.abort('SIGTERM')
      return resultWith(0)
    }
    assert.equal((await run([file, ...browser], { runFiles, signal: controller.signal })).code, 143)
  })

  test('a setup error from the runner prints its message and exits 2', async () => {
    const setup = Object.assign(new Error('/bin/chrome does not exist.'), {
      failure: { class: 'setup_failed', message: '/bin/chrome does not exist.' },
    })
    const { code, stdout, stderr } = await run([file, ...browser], { runFiles: async () => Promise.reject(setup) })
    assert.equal(code, 2)
    assert.equal(stdout, '')
    assert.equal(stderr, 'error: /bin/chrome does not exist.\n')
  })

  test('an unexpected error exits 2 with its stack', async () => {
    const { code, stderr } = await run([file, ...browser], { runFiles: async () => Promise.reject(new Error('boom')) })
    assert.equal(code, 2)
    assert.match(stderr, /^error: Error: boom\n {4}at /)
  })

  test('an error after an interrupt exits 130', async () => {
    const controller = new AbortController()
    const runFiles = async () => {
      controller.abort()
      throw new Error('stopped')
    }
    const { code, stderr } = await run([file, ...browser], { runFiles, signal: controller.signal })
    assert.equal(code, 130)
    assert.equal(stderr, 'Interrupted.\n')
  })

  test('an error after SIGTERM exits 143', async () => {
    const controller = new AbortController()
    const runFiles = async () => {
      controller.abort('SIGTERM')
      throw new Error('stopped')
    }
    assert.equal((await run([file, ...browser], { runFiles, signal: controller.signal })).code, 143)
  })
})

describe('run failures', () => {
  const lostResult = { class: 'reporting_failed', message: 'Retest could not write result.json: no space left on device' } as const

  test('a run failure that came after the report, such as a result.json not written, goes to stderr', async () => {
    const events = passingRun(root)
    const runFiles: FakeOptions['runFiles'] = async (options, reporters) => {
      const shown = await playing(events)(options, reporters)
      return { ...shown, status: 'error', exitCode: 2, failure: lostResult }
    }
    for (const reporter of ['human', 'jsonl', 'agent']) {
      const { code, stderr } = await run([file, ...browser, '--reporter', reporter], { runFiles })
      assert.equal(code, 2)
      assert.equal(stderr, `error: ${lostResult.message}\n`, reporter)
    }
  })

  test('a run failure the report already showed is not repeated on stderr', async () => {
    const shown: RunResult = { ...resultWith(2), status: 'error', failure: lostResult }
    const { code, stdout, stderr } = await run([file, ...browser], { runFiles: playing(passingRun(root), shown) })
    assert.equal(code, 2)
    assert.equal(stderr, '')
    assert.match(stdout, /\n {2}Run failed\n {4}Reporting failed\n {4}Retest could not write result\.json: no space left on device\n/)
  })
})

describe('run reporters', () => {
  test('prints the human report by default', async () => {
    const { stdout, runs } = await run([file, ...browser])
    assert.match(stdout, /✗ examples\/task\.retest\.ts › saves a task/)
    assert.match(stdout, /\n {2}Exit {4}1\n/)
    assert.equal(typeof runs[0]?.options.onOutput, 'function')
  })

  test('prints the agent report when a coding agent is detected', async () => {
    for (const variable of ['CLAUDECODE', 'CODEX_THREAD_ID', 'AGENT', 'AI_AGENT']) {
      const { stdout, runs } = await run([file, ...browser], { env: { [variable]: '1' } })
      assert.match(stdout, /^retest: 1 failed, 1 passed \(2\) in 6\.1s, exit 1\n/, variable)
      assert.match(stdout, /\nnext: npx retest inspect .* --json\n$/)
      assert.equal(runs[0]?.options.onOutput, undefined)
    }
  })

  test('--no-agent and an explicit reporter override detection; --agent forces the agent report', async () => {
    const agentEnv = { env: { CLAUDECODE: '1' } }
    assert.match((await run([file, ...browser, '--no-agent'], agentEnv)).stdout, /^\n {2}retest 0\.0\.0/)
    assert.match((await run([file, ...browser, '--reporter', 'human'], agentEnv)).stdout, /^\n {2}retest 0\.0\.0/)
    assert.match((await run([file, ...browser, '--reporter', 'jsonl'], agentEnv)).stdout, /^\{"schemaVersion":1/)
    assert.match((await run([file, ...browser, '--agent'])).stdout, /^retest: /)
    assert.match((await run([file, ...browser, '--agent', '--reporter', 'agent'])).stdout, /^retest: /)
    assert.match((await run([file, ...browser, '--reporter', 'agent'])).stdout, /^retest: /)
  })

  test('names the chosen reporter, so the run records which one printed', async () => {
    const cases: [string[], string][] = [
      [[], 'human'],
      [['--reporter', 'jsonl'], 'jsonl'],
      [['--agent'], 'agent'],
    ]
    for (const [args, name] of cases) {
      const { runs } = await run([file, ...browser, ...args])
      assert.equal(runs[0]?.reporters[0]?.name, name)
      assert.equal(runs[0]?.reporters.length, 1)
    }
  })

  test('jsonl prints only valid event lines on stdout and never echoes test output', async () => {
    const events = failingRun(root)
    const runFiles: FakeOptions['runFiles'] = async (options, reporters) => {
      options.onOutput?.({ file, stream: 'stdout', text: 'console.log from the test\n' })
      return playing(events)(options, reporters)
    }
    const { stdout, runs } = await run([file, ...browser, '--reporter', 'jsonl'], { runFiles })
    assert.equal(runs[0]?.options.onOutput, undefined)
    const lines = stdout.split('\n')
    assert.equal(lines.pop(), '')
    assert.equal(lines.length, events.length)
    for (const [index, line] of lines.entries()) {
      const parsed = parse(retestEventSchema, JSON.parse(line))
      assert.ok(parsed.ok, line)
      assert.deepEqual(parsed.value, events[index])
    }
  })

  test('the human report echoes test output, dimmed and prefixed with the file', async () => {
    const runFiles: FakeOptions['runFiles'] = async (options, reporters) => {
      options.onOutput?.({ file, stream: 'stdout', text: 'saved 1 task\n' })
      options.onOutput?.({ file, stream: 'stderr', text: 'a warning\n' })
      return playing(passingRun(root))(options, reporters)
    }
    const { stdout, stderr } = await run([file, ...browser], { runFiles, isTTY: true })
    assert.ok(stdout.includes('\u001b[2m  examples/task.retest.ts | saved 1 task\u001b[22m\n'))
    assert.ok(stderr.includes('\u001b[2m  examples/task.retest.ts | a warning\u001b[22m\n'))
  })
})

describe('run colour', () => {
  test('colours only a terminal, and never with NO_COLOR set', async () => {
    const cases: [boolean, Record<string, string>, boolean][] = [
      [true, {}, true],
      [true, { NO_COLOR: '' }, true],
      [true, { NO_COLOR: '1' }, false],
      [false, {}, false],
    ]
    for (const [isTTY, env, coloured] of cases) {
      const { stdout } = await run([file, ...browser], { isTTY, env })
      assert.equal(stdout.includes('\u001b['), coloured, JSON.stringify({ isTTY, env }))
      assert.equal(plain(stdout).includes('Check failed'), true)
    }
  })

  test('never colours the agent report', async () => {
    const { stdout } = await run([file, ...browser, '--agent'], { isTTY: true })
    assert.equal(stdout.includes('\u001b['), false)
  })
})

describe('retest run --workers', () => {
  test('rejects a worker count that is not a whole number from 1, before anything runs', async () => {
    assert.match(await rejected([file, ...browser, '--workers', '0']), /--workers takes a whole number from 1, not 0\./)
    assert.match(await rejected([file, ...browser, '--workers', 'two']), /--workers takes a whole number from 1, not two\./)
    assert.match(await rejected([file, ...browser, '--workers', '1.5']), /not 1\.5\./)
  })
})
