import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { flag, listWords, parseArguments, value } from '../../src/cli/arguments.ts'
import { UsageError } from '../../src/cli/errors.ts'
import { suggest } from '../../src/cli/suggest.ts'

const options = {
  browser: value({ placeholder: '<path>', description: 'Browser' }),
  'base-url': value({ placeholder: '<url>', description: 'Base URL' }),
  reporter: value({ placeholder: '<name>', description: 'Reporter', choices: ['human', 'jsonl', 'agent'] }),
  json: flag('JSON'),
  headed: flag('Headed'),
}

function usageMessage(args: string[]): string {
  try {
    parseArguments(options, args)
  } catch (error) {
    assert.ok(error instanceof UsageError, `expected a UsageError, received ${String(error)}`)
    return error.message
  }
  assert.fail(`expected ${JSON.stringify(args)} to be rejected`)
}

describe('parseArguments', () => {
  test('reads positionals, values in both spellings and flags', () => {
    const parsed = parseArguments(options, [
      'a.retest.ts',
      '--browser',
      '/bin/chrome',
      'b.retest.ts',
      '--base-url=http://x',
      '--json',
    ])
    assert.deepEqual(parsed.positionals, ['a.retest.ts', 'b.retest.ts'])
    assert.equal(parsed.value('browser'), '/bin/chrome')
    assert.equal(parsed.value('base-url'), 'http://x')
    assert.equal(parsed.flag('json'), true)
    assert.equal(parsed.flag('headed'), false)
    assert.equal(parsed.value('reporter'), undefined)
  })

  test('keeps everything after the first = as the value', () => {
    assert.equal(parseArguments(options, ['--base-url=http://x/?a=b&c=d']).value('base-url'), 'http://x/?a=b&c=d')
  })

  test('reads a lone dash as a positional', () => {
    assert.deepEqual(parseArguments(options, ['-']).positionals, ['-'])
  })

  test('names an unknown option and suggests a close one', () => {
    assert.equal(usageMessage(['--browsr', 'x']), 'Unknown option --browsr. Did you mean --browser?')
    assert.equal(usageMessage(['--baseurl=x']), 'Unknown option --baseurl. Did you mean --base-url?')
    assert.equal(usageMessage(['--BROWSER', 'x']), 'Unknown option --BROWSER. Did you mean --browser?')
    assert.equal(usageMessage(['-json']), 'Unknown option -json. Did you mean --json?')
    assert.equal(usageMessage(['--hlep']), 'Unknown option --hlep. Did you mean --help?')
    assert.equal(usageMessage(['--watch']), 'Unknown option --watch.')
    assert.equal(usageMessage(['-x']), 'Unknown option -x.')
    assert.equal(usageMessage(['--']), 'Unknown option --.')
  })

  test('never takes an option name from the object prototype', () => {
    for (const name of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      assert.match(usageMessage([`--${name}`, 'x']), /^Unknown option/)
    }
  })

  test('rejects an option given twice', () => {
    assert.equal(usageMessage(['--reporter', 'human', '--reporter', 'jsonl']), '--reporter is given twice.')
    assert.equal(usageMessage(['--reporter=human', '--reporter', 'human']), '--reporter is given twice.')
    assert.equal(usageMessage(['--json', '--json']), '--json is given twice.')
  })

  test('rejects a value on a flag', () => {
    assert.equal(usageMessage(['--json=true']), '--json takes no value.')
    assert.equal(usageMessage(['--headed=']), '--headed takes no value.')
  })

  test('rejects an option missing its value', () => {
    assert.equal(usageMessage(['--browser']), '--browser needs a value: --browser <path>.')
    assert.equal(usageMessage(['--browser', '--json']), '--browser needs a value: --browser <path>.')
    assert.equal(usageMessage(['--browser=']), '--browser needs a value: --browser <path>.')
    assert.equal(usageMessage(['--browser', '-x']), '--browser needs a value: --browser <path>.')
  })

  test('accepts a value that starts with a dash when written with =', () => {
    assert.equal(parseArguments(options, ['--browser=-odd']).value('browser'), '-odd')
  })

  test('rejects a value outside the choices and suggests a close one', () => {
    assert.equal(
      usageMessage(['--reporter', 'json']),
      '--reporter must be human, jsonl or agent, received "json". Did you mean jsonl?',
    )
    assert.equal(usageMessage(['--reporter', 'dot']), '--reporter must be human, jsonl or agent, received "dot".')
  })
})

describe('suggest', () => {
  test('finds typos: a missing, extra, changed or swapped character', () => {
    assert.equal(suggest('rn', ['list', 'run', 'inspect']), 'run')
    assert.equal(suggest('runn', ['list', 'run', 'inspect']), 'run')
    assert.equal(suggest('lsit', ['list', 'run', 'inspect']), 'list')
    assert.equal(suggest('inspct', ['list', 'run', 'inspect']), 'inspect')
    assert.equal(suggest('INSPECT', ['list', 'run', 'inspect']), 'inspect')
  })

  test('stays quiet when nothing is close', () => {
    assert.equal(suggest('x', ['list', 'run', 'inspect']), undefined)
    assert.equal(suggest('deploy', ['list', 'run', 'inspect']), undefined)
    assert.equal(suggest('anything', []), undefined)
  })

  test('prefers the closest candidate', () => {
    assert.equal(suggest('jsonl', ['json', 'jsonl']), 'jsonl')
  })
})

describe('listWords', () => {
  test('joins with commas and a final or', () => {
    assert.equal(listWords([]), '')
    assert.equal(listWords(['run']), 'run')
    assert.equal(listWords(['list', 'run']), 'list or run')
    assert.equal(listWords(['list', 'run', 'inspect']), 'list, run or inspect')
  })
})
