import type { TestContext } from 'node:test'
import type { ProgramRun } from './cli-harness.ts'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { describe, test } from 'node:test'
import { repositoryRoot, runProgram, scratchFolder, sourceCommand } from './cli-harness.ts'

// `npx @rehearsal-labs/retest init` runs Retest from npx's own folder, in a project that has no Retest. These cases run
// it from this checkout in an empty folder outside the repository, with stand-ins for npm, pnpm, yarn and bun first on
// PATH. Each stand-in writes how it was called to a record and to a file in the folder it ran in, prints a line, and
// exits with the code the case gives it, so no case reaches the registry or installs anything. On Windows a stand-in
// is a batch file, as npm.cmd is, which Retest starts through cmd.exe.

const managers = ['npm', 'pnpm', 'yarn', 'bun']
const recordVariable = 'RETEST_FAKE_INSTALL_RECORD'

type Setup = { project: string; record: string; env: NodeJS.ProcessEnv }

/** An empty project, a record and stand-ins exiting with `exitCode`, with an environment that puts them first on PATH. */
async function setUp(t: TestContext, exitCode: number, userAgent?: string): Promise<Setup> {
  const folder = await scratchFolder(t, 'retest-init-install-')
  const bin = join(folder, 'bin')
  const project = join(folder, 'project')
  const record = join(folder, 'record.txt')
  mkdirSync(bin)
  mkdirSync(project)
  for (const name of managers) writeStandIn(bin, name, exitCode)
  // The case says which manager started init, so the run of the tests does not.
  const inherited = Object.entries(process.env).filter(([name]) => name !== 'npm_config_user_agent')
  const env: NodeJS.ProcessEnv = { ...Object.fromEntries(inherited), NO_COLOR: '1', [recordVariable]: record, ...(userAgent === undefined ? {} : { npm_config_user_agent: userAgent }) }
  // Windows names it Path, and a second spelling beside it would leave which one a program reads to chance.
  const pathKey = Object.keys(env).find((name) => name.toUpperCase() === 'PATH') ?? 'PATH'
  env[pathKey] = `${bin}${delimiter}${env[pathKey] ?? ''}`
  return { project, record, env }
}

function writeStandIn(bin: string, name: string, exitCode: number): void {
  if (process.platform === 'win32') {
    const lines = ['@echo off', `>>"%${recordVariable}%" echo ${name} %*`, `>>install-calls.txt echo ${name} %*`, `echo stand-in ${name} output`, `exit /b ${exitCode}`]
    writeFileSync(join(bin, `${name}.cmd`), `${lines.join('\r\n')}\r\n`)
    return
  }
  const lines = ['#!/bin/sh', `printf '%s %s\\n' ${name} "$*" >> "$${recordVariable}"`, `printf '%s %s\\n' ${name} "$*" >> install-calls.txt`, `echo stand-in ${name} output`, `exit ${exitCode}`]
  writeFileSync(join(bin, name), `${lines.join('\n')}\n`)
  chmodSync(join(bin, name), 0o755)
}

function init(setup: Setup, args: readonly string[]): Promise<ProgramRun> {
  const [node = process.execPath, ...before] = sourceCommand
  return runProgram(node, [...before, 'init', ...args], setup.project, setup.env)
}

/** The lines of a stand-in's record, or none when no stand-in ran. */
function linesOf(path: string): string[] {
  return existsSync(path) ? readFileSync(path, 'utf8').split(/\r?\n/).filter((line) => line !== '') : []
}

function devDependencies(project: string): unknown {
  const data: unknown = JSON.parse(readFileSync(join(project, 'package.json'), 'utf8'))
  return typeof data === 'object' && data !== null && 'devDependencies' in data ? data.devDependencies : undefined
}

describe('init installs what the project needs', () => {
  test('in an empty folder, it adds the three packages and runs npm install once, in that folder, between its own lines', async (t) => {
    const setup = await setUp(t, 0)
    assert.ok(!setup.project.startsWith(repositoryRoot), 'the project lives outside the repository')
    const run = await init(setup, ['--yes'])
    assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
    // This checkout is 0.0.0, a version npm never had, so Retest is asked for at its latest.
    assert.deepEqual(devDependencies(setup.project), { '@rehearsal-labs/retest': 'latest', '@types/node': '^24.12.0', typescript: '^7.0.2' })
    assert.deepEqual(linesOf(setup.record), ['npm install'])
    assert.deepEqual(linesOf(join(setup.project, 'install-calls.txt')), ['npm install'], 'it ran in the project folder')
    const running = run.stdout.indexOf('  Running npm install\n')
    const output = run.stdout.indexOf('stand-in npm output')
    const installed = run.stdout.indexOf('  The packages are installed.')
    assert.ok(running >= 0 && output > running && installed > output, run.stdout)
    assert.ok(run.stdout.indexOf('  created  package.json   devDependencies: @rehearsal-labs/retest@latest, typescript@^7.0.2, @types/node@^24.12.0') < running, run.stdout)
  })

  test('a failed install exits 2 with the command to run by hand, and the files stay', async (t) => {
    const setup = await setUp(t, 1)
    const run = await init(setup, ['--yes'])
    assert.equal(run.code, 2, run.stdout)
    assert.ok(run.stderr.includes('npm install failed with exit code 1. The files are written; run npm install yourself to install the packages.'), run.stderr)
    assert.deepEqual(linesOf(setup.record), ['npm install'])
    for (const path of ['retest.config.ts', 'tests/example.retest.ts', 'tests/tsconfig.json', '.gitignore']) assert.ok(existsSync(join(setup.project, path)), path)
    assert.deepEqual(devDependencies(setup.project), { '@rehearsal-labs/retest': 'latest', '@types/node': '^24.12.0', typescript: '^7.0.2' })
    assert.match(run.stdout, /\n {4}npm install +install the packages in package\.json\n/)
  })

  test('--no-install calls no package manager', async (t) => {
    const setup = await setUp(t, 0)
    const run = await init(setup, ['--yes', '--no-install'])
    assert.equal(run.code, 0, run.stderr)
    assert.deepEqual(linesOf(setup.record), [])
    assert.ok(!run.stdout.includes('Running'), run.stdout)
    assert.deepEqual(devDependencies(setup.project), { '@rehearsal-labs/retest': 'latest', '@types/node': '^24.12.0', typescript: '^7.0.2' })
  })

  test('the package manager that started init installs, when nothing in the project names one', async (t) => {
    const setup = await setUp(t, 0, 'pnpm/10.4.0 npm/? node/v24.12.0')
    const run = await init(setup, ['--yes'])
    assert.equal(run.code, 0, run.stderr)
    assert.deepEqual(linesOf(setup.record), ['pnpm install'])
    assert.match(run.stdout, /\n {4}pnpm exec retest doctor /)
  })
})
