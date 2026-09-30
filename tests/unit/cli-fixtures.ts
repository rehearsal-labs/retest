import type { OwnedBrowser } from '../../src/browser/contract.ts'
import type { CliDependencies } from '../../src/cli/command.ts'
import type { Prompt } from '../../src/cli/prompt.ts'
import type { Environment } from '../../src/cli/terminal.ts'
import type { LoadedConfig } from '../../src/config/loaded.ts'
import type { RetestEvent } from '../../src/protocol/events.ts'
import type { RunResult } from '../../src/protocol/result.ts'
import type { Reporter } from '../../src/reporters/reporter.ts'
import type { CollectOptions, CollectResult, RunOptions } from '../../src/runner/contract.ts'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createCli, type Cli } from '../../src/cli/cli.ts'
import { validateConfig } from '../../src/config/validate.ts'
import { eventsFile, resultFile } from '../../src/protocol/run-folder.ts'
import { capture, resultOf, type Captured } from './reporters-fixtures.ts'

export type FakeCli = {
  cli: Cli
  stdout: Captured
  stderr: Captured
  runs: { options: RunOptions; reporters: Reporter[] }[]
  collects: CollectOptions[]
  /** Every config path loaded, absolute. */
  loads: string[]
}

export type FakeOptions = {
  cwd: string
  env?: Environment
  isTTY?: boolean
  signal?: AbortSignal
  runFiles?: CliDependencies['runFiles']
  collectFiles?: CliDependencies['collectFiles']
  /** The config every load returns. */
  config?: LoadedConfig
  loadConfig?: CliDependencies['loadConfig']
  resolveExecutable?: CliDependencies['resolveExecutable']
  launchBrowser?: CliDependencies['launchBrowser']
  probeReady?: CliDependencies['probeReady']
  startAppServer?: CliDependencies['startAppServer']
  prompt?: Prompt
}

/** The CLI with fakes for the runner, the browser, app servers, the streams and the environment. It records calls. */
export function fakeCli(options: FakeOptions): FakeCli {
  const stdout = capture(options.isTTY ?? false)
  const stderr = capture(options.isTTY ?? false)
  const runs: FakeCli['runs'] = []
  const collects: CollectOptions[] = []
  const loads: string[] = []
  const { config } = options
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
    loadConfig: async (path) => {
      loads.push(path)
      if (options.loadConfig !== undefined) return options.loadConfig(path)
      if (config === undefined) throw new Error('This test does not expect a config.')
      return { ok: true, config }
    },
    resolveExecutable: options.resolveExecutable ?? unexpected('an executable lookup'),
    launchBrowser: options.launchBrowser ?? unexpected('a browser launch'),
    probeReady: options.probeReady ?? unexpected('a probe'),
    startAppServer: options.startAppServer ?? unexpected('an app server'),
    version: '0.0.0',
    stdout,
    stderr,
    prompt: options.prompt ?? { isTTY: options.isTTY ?? false, ask: unexpected('a question') },
    env: options.env ?? {},
    cwd: options.cwd,
    signal: options.signal ?? new AbortController().signal,
  })
  return { cli, stdout, stderr, runs, collects, loads }
}

function unexpected(what: string): () => never {
  return () => {
    throw new Error(`This test does not expect ${what}.`)
  }
}

/** A config as the loader returns it, read from `value` as if it were in `root`. */
export function loadedConfig(root: string, value: unknown): LoadedConfig {
  const loaded = validateConfig(value, join(root, 'retest.config.ts'))
  if (!loaded.ok) throw new Error(loaded.failure.message)
  return loaded.config
}

/** Answers questions in order, and records each question asked. Past the last answer, the input has ended. */
export function answering(answers: readonly string[]): Prompt & { questions: string[] } {
  const questions: string[] = []
  const left = [...answers]
  return {
    isTTY: true,
    questions,
    ask: async (question) => {
      questions.push(question)
      return left.shift()
    },
  }
}

/** A browser that launches and closes, reporting the product and version given. */
export function fakeBrowser(executablePath: string, product = 'Chrome', version = '154.0.7195.41'): OwnedBrowser & { closed: number } {
  const browser = {
    product,
    version,
    userAgent: `Mozilla/5.0 ${product}/${version}`,
    pid: 4242,
    executablePath,
    connected: true,
    closed: 0,
    newPage: async () => {
      throw new Error('doctor never opens a page')
    },
    onDisconnect: () => () => {},
    close: async () => {
      browser.closed++
    },
  }
  return browser
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
