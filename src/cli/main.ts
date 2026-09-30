#!/usr/bin/env node
import process from 'node:process'
import { collectFiles, runFiles } from '../runner/run.ts'
import { retestVersion } from '../version.ts'
import { createCli } from './cli.ts'
import { abortOnInterrupt } from './interrupt.ts'
import { exitCodeAfterOutput, messageTerminal, reportTerminal } from './terminal.ts'

const stdout = reportTerminal(process.stdout)
const stderr = messageTerminal(process.stderr)

const cli = createCli({
  runFiles,
  collectFiles,
  version: retestVersion,
  stdout: stdout.terminal,
  stderr,
  env: process.env,
  cwd: process.cwd(),
  signal: abortOnInterrupt({ source: process, stderr, exit: (code) => process.exit(code) }),
})
const exitCode = await cli(process.argv.slice(2))
await Promise.all([drain(process.stdout), drain(process.stderr)])
process.exit(exitCodeAfterOutput(exitCode, stdout.failure() !== undefined))

// Exiting before the last write settles would cut a piped report short and could miss a closed pipe,
// whose error arrives after the write returns.
function drain(stream: NodeJS.WriteStream): Promise<void> {
  return new Promise((resolve) => {
    if (stream.destroyed) resolve()
    else stream.write('', () => resolve())
  })
}
