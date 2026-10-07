import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { describe, test } from 'node:test'
import { commands } from '../../src/cli/cli.ts'
import { fakeCli } from './cli-fixtures.ts'

const cwd = tmpdir()

async function call(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const fake = fakeCli({ cwd })
  const code = await fake.cli(args)
  return { code, stdout: fake.stdout.text, stderr: fake.stderr.text }
}

// The long option names a help text lists in its Options section.
function listedOptions(help: string): string[] {
  const section = help.slice(help.indexOf('\nOptions\n'))
  return [...section.matchAll(/^ {2}(?:-\w, )?--([\w-]+)/gm)].map((match) => match[1] ?? '')
}

describe('help', () => {
  test('--help, -h and help print the commands on stdout', async () => {
    for (const args of [['--help'], ['-h'], ['help']]) {
      const { code, stdout, stderr } = await call(args)
      assert.equal(code, 0)
      assert.equal(stderr, '')
      assert.match(stdout, /^retest 0\.0\.0\n/)
      for (const name of ['init [options]', 'doctor [options]', 'install <engine...>', 'licences [engine]', 'list [files...]', 'run [files...]', 'inspect <run-folder>', 'report <run-folder>', 'help [command]']) {
        assert.ok(stdout.includes(`  ${name}`), `${name} is missing from:\n${stdout}`)
      }
      assert.deepEqual(listedOptions(stdout), ['help', 'version'])
    }
  })

  test('each command documents exactly the options it takes', async () => {
    for (const command of commands) {
      for (const args of [
        ['help', command.name],
        [command.name, '--help'],
        [command.name, '-h'],
        ['--help', command.name],
      ]) {
        const { code, stdout, stderr } = await call(args)
        assert.equal(code, 0, args.join(' '))
        assert.equal(stderr, '')
        assert.match(stdout, new RegExp(`^Usage\\n  retest ${command.name} `))
        assert.deepEqual(listedOptions(stdout), [...Object.keys(command.options), 'help'])
      }
    }
  })

  test('the run help documents the flags that exist and nothing unbuilt', async () => {
    const { stdout } = await call(['help', 'run'])
    for (const option of [
      '--config <path>',
      '--browser <path>',
      '--base-url <url>',
      '--grep <text>',
      '--tag <expression>',
      '--target <app=name>',
      '--last-failed',
      '--reporter <name>',
      '--output <dir>',
      '--timeouts <list>',
      '--workers <n>',
      '--browsers <n>',
      '--headed',
      '--agent',
      '--no-agent',
    ]) {
      assert.ok(stdout.includes(option), option)
    }
    for (const unbuilt of ['--watch', '--retries', '--dry-run', '--repeat-each', 'github', 'junit', '--project']) {
      assert.ok(!stdout.includes(unbuilt), unbuilt)
    }
    assert.match(stdout, /--reporter <name> {9}Terminal output: human, jsonl, agent or html\./)
    assert.match(stdout, /Add :line to a file/)
    assert.match(
      stdout,
      /Defaults: collection=10000,setup=60000,action=10000,navigation=30000,assertion=5000,test=60000,cleanup=10000/,
    )
    assert.match(stdout, /Exit codes: 0 .*, 1 .*, 2 .*, 130 interrupted, 143 stopped by SIGTERM\./)
  })

  test('the init and doctor help list every question flag and the config', async () => {
    const init = (await call(['help', 'init'])).stdout
    for (const option of ['--app <name=url>', '--start <command>', '--browser <name>', '--ci <name>', '--yes']) {
      assert.ok(init.includes(option), option)
    }
    assert.match(init, /It installs nothing, and prints the install command\./)
    assert.deepEqual(listedOptions((await call(['help', 'doctor'])).stdout), ['config', 'help'])
    assert.match((await call(['help', 'inspect'])).stdout, /--target <app=name> {7}With --test, the target it ran on/)
  })

  test('help for an unknown command fails and suggests one', async () => {
    const { code, stdout, stderr } = await call(['help', 'rnu'])
    assert.equal(code, 2)
    assert.equal(stdout, '')
    assert.match(stderr, /Unknown command rnu\. Did you mean run\?/)
    assert.equal((await call(['help', 'run', 'list'])).code, 2)
  })
})

describe('version', () => {
  test('--version and -v print the version alone', async () => {
    for (const flag of ['--version', '-v']) {
      assert.deepEqual(await call([flag]), { code: 0, stdout: '0.0.0\n', stderr: '' })
    }
  })

  test('--version takes nothing after it', async () => {
    const { code, stdout, stderr } = await call(['--version', 'run'])
    assert.equal(code, 2)
    assert.equal(stdout, '')
    assert.match(stderr, /--version takes nothing after it\./)
  })
})

describe('commands', () => {
  test('no command prints the help on stderr and exits 2', async () => {
    const { code, stdout, stderr } = await call([])
    assert.equal(code, 2)
    assert.equal(stdout, '')
    assert.match(stderr, /Usage\n {2}retest <command> \[options\]/)
  })

  test('an unknown command fails with a suggestion when one is close', async () => {
    const close = await call(['rn', 'a.retest.ts'])
    assert.equal(close.code, 2)
    assert.equal(close.stdout, '')
    assert.equal(close.stderr, 'error: Unknown command rn. Did you mean run?\nSee retest --help.\n')
    const far = await call(['deploy'])
    assert.equal(
      far.stderr,
      'error: Unknown command deploy. The commands are init, doctor, install, licences, list, run, inspect or report.\nSee retest --help.\n',
    )
  })

  test('an option before any command fails and says so', async () => {
    const typo = await call(['--hepl'])
    assert.equal(typo.code, 2)
    assert.match(typo.stderr, /Unknown option --hepl\. Did you mean --help\?/)
    const other = await call(['--browser', '/bin/chrome'])
    assert.match(other.stderr, /Unknown option --browser\. Name a command first: init, doctor, install, licences, list, run, inspect or report\./)
    assert.equal(other.stdout, '')
  })

  test('usage errors inside a command point to its help', async () => {
    const { code, stdout, stderr } = await call(['list', '--jsn'])
    assert.equal(code, 2)
    assert.equal(stdout, '')
    assert.equal(stderr, 'error: Unknown option --jsn. Did you mean --json?\nSee retest help list.\n')
  })
})
