import type { CliDependencies } from '../../src/cli/command.ts'
import type { Environment } from '../../src/cli/terminal.ts'
import type { RetestEvent } from '../../src/protocol/events.ts'
import type { RunResult } from '../../src/protocol/result.ts'
import type { Reporter } from '../../src/reporters/reporter.ts'
import type { CollectOptions, CollectResult, RunOptions } from '../../src/runner/contract.ts'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createCli, type Cli } from '../../src/cli/cli.ts'
import { eventsFile, resultFile } from '../../src/protocol/run-folder.ts'
import { capture, resultOf, type Captured } from './reporters-fixtures.ts'

export type FakeCli = {
  cli: Cli
  stdout: Captured
  stderr: Captured
  runs: { options: RunOptions; reporters: Reporter[] }[]
  collects: CollectOptions[]
}

export type FakeOptions = {
  cwd: string
  env?: Environment
  isTTY?: boolean
  signal?: AbortSignal
  runFiles?: CliDependencies['runFiles']
  collectFiles?: CliDependencies['collectFiles']
}

/** The CLI with fakes for the runner, the streams and the environment. It records every call. */
export function fakeCli(options: FakeOptions): FakeCli {
  const stdout = capture(options.isTTY ?? false)
  const stderr = capture(options.isTTY ?? false)
  const runs: FakeCli['runs'] = []
  const collects: CollectOptions[] = []
  const cli = createCli({
    runFiles: async (runOptions, reporters) => {
      runs.push({ options: runOptions, reporters })
      if (options.runFiles === undefined) throw new Error('This test does not expect a run.')
      return options.runFiles(runOptions, reporters)
    },
    collectFiles: async (collectOptions) => {
      collects.push(collectOptions)
      if (options.collectFiles === undefined) throw new Error('This test does not expect collection.')
      return options.collectFiles(collectOptions)
    },
    version: '0.0.0',
    stdout,
    stderr,
    env: options.env ?? {},
    cwd: options.cwd,
    signal: options.signal ?? new AbortController().signal,
  })
  return { cli, stdout, stderr, runs, collects }
}

/** A runner that plays recorded events to the reporters and returns their result. */
export function playing(events: RetestEvent[], result: RunResult = resultOf(events)): CliDependencies['runFiles'] {
  return async (_options, reporters) => {
    for (const event of events) for (const reporter of reporters) await reporter.onEvent(event)
    for (const reporter of reporters) await reporter.onRunEnd(result)
    return result
  }
}

export function collecting(result: CollectResult): CliDependencies['collectFiles'] {
  return async () => result
}

export type FolderContents = { events?: RetestEvent[]; tail?: string; result?: RunResult | string }

/** Writes a run folder as the store would, or cut short, and returns its path. */
export function writeRunFolder(root: string, name: string, contents: FolderContents): string {
  const folder = join(root, name)
  mkdirSync(folder, { recursive: true })
  if (contents.events !== undefined || contents.tail !== undefined) {
    const lines = (contents.events ?? []).map((event) => `${JSON.stringify(event)}\n`).join('')
    writeFileSync(join(folder, eventsFile), `${lines}${contents.tail ?? ''}`)
  }
  if (contents.result !== undefined) {
    const text = typeof contents.result === 'string' ? contents.result : JSON.stringify(contents.result, null, 2)
    writeFileSync(join(folder, resultFile), text)
  }
  return folder
}
