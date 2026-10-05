import type { ChildProcess } from 'node:child_process'
import type { Schema } from '../../src/protocol/schema.ts'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { chmod, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { parse, s } from '../../src/protocol/schema.ts'
import { ownerRecordFile } from '../../src/browser/firefox/profile.ts'
import { ScriptedBidi } from './firefox-scripted-bidi.ts'

// A stand-in for the firefox executable, for the spawn route's process tests. `writeStandIn` writes an executable
// named `firefox` whose first line runs this Node and whose body calls `runStandIn` here, with `stand-in.json` beside
// it. Started with the arguments Retest gives Firefox, the stand-in reads `--profile`, serves a WebDriver BiDi WebSocket,
// writes the `WebDriverBiDiServer.json` Firefox writes into its profile once its Remote Agent listens, and answers
// `session.new` with its own pid and that profile, as Firefox does. What it saw and did goes into its reports folder,
// never into the profile, which the launch removes.

/**
 * What the stand-in does once started.
 *
 * - `close-in-order`: answers `browser.close`, ends its helpers, closes the connection and exits with code 0.
 * - `close-without-answer`: does the same without answering, as Firefox often does.
 * - `ignore-close`: never answers `browser.close` and never exits by itself.
 * - `exit-before-listening`: writes its output and exits with `exitCode` before it writes the server file, leaving
 *   running any helpers it started.
 * - `never-listen`: stays, and never writes the server file, as a Firefox stuck before its Remote Agent starts.
 * - `name-helper`: answers `session.new` naming its first helper's pid, as a wrapper whose browser is another process.
 * - `crash-after-session`: a moment after `session.new`, its helpers go and it exits with code 9, as a Firefox that
 *   crashed, whose content processes end once their parent is gone.
 */
export type StandInBehaviour = 'close-in-order' | 'close-without-answer' | 'ignore-close' | 'exit-before-listening' | 'never-listen' | 'name-helper' | 'crash-after-session'

export type StandInConfig = {
  behaviour: StandInBehaviour
  /** The folder the stand-in writes its reports into. */
  reports: string
  /** Written once at start, before anything listens. */
  stdout: string
  stderr: string
  /** Written to stderr once `browser.close` is answered, by `close-in-order`. */
  closeOutput: string
  exitCode: number
  /** Helpers started before the server file is written, as Firefox starts its content processes. */
  helpers: number
  /** A further helper started this long after the server file is written. */
  lateHelperMs?: number
  /** When set, the server file is first written cut short, and whole only this long after. */
  halfServerFileMs?: number
  /** Environment variables whose presence alone is reported, never their values. */
  watchedVariables: string[]
  /** How long any stand-in or helper lives at most, so a test that dies leaves nothing running for long. */
  lifetimeMs: number
}

/** What the stand-in reports once started, in `started.json`. */
export type StandInStart = {
  pid: number
  parentPid: number
  arguments: string[]
  crashReporterDisabled: string | null
  variablesSeen: Record<string, boolean>
  preferencesFound: boolean
}

/** One helper the stand-in started, a line of `helpers.jsonl`. */
export type StandInHelper = { name: string; pid: number }

/** Where the stand-in's WebSocket listens, in `listening.json`. */
export type StandInListening = { host: string; port: number }

const configSchema: Schema<StandInConfig> = s.object({
  behaviour: s.enum(['close-in-order', 'close-without-answer', 'ignore-close', 'exit-before-listening', 'never-listen', 'name-helper', 'crash-after-session']),
  reports: s.string(),
  stdout: s.string(),
  stderr: s.string(),
  closeOutput: s.string(),
  exitCode: s.number({ integer: true }),
  helpers: s.number({ integer: true, min: 0 }),
  lateHelperMs: s.optional(s.number({ integer: true, min: 0 })),
  halfServerFileMs: s.optional(s.number({ integer: true, min: 0 })),
  watchedVariables: s.array(s.string()),
  lifetimeMs: s.number({ integer: true, min: 1 }),
})
const startSchema: Schema<StandInStart> = s.object({
  pid: s.number({ integer: true }),
  parentPid: s.number({ integer: true }),
  arguments: s.array(s.string()),
  crashReporterDisabled: s.nullable(s.string()),
  variablesSeen: s.record(s.boolean()),
  preferencesFound: s.boolean(),
})
const helperSchema: Schema<StandInHelper> = s.object({ name: s.string(), pid: s.number({ integer: true }) })
const listeningSchema: Schema<StandInListening> = s.object({ host: s.string(), port: s.number({ integer: true, min: 1 }) })
const commandSchema: Schema<{ method: string }> = s.object({ method: s.string() })

const warmUpArgument = '--retest-stand-in-warm-up'

/**
 * Writes the stand-in executable, `firefox`, and its `stand-in.json` into `folder`, runs it once, and returns its path.
 * The first line names this Node by its absolute path, so the process Retest spawns is Node itself, with the same pid and
 * command line from the start, as a Firefox binary keeps.
 */
export async function writeStandIn(folder: string, config: StandInConfig): Promise<string> {
  if (/\s/.test(process.execPath)) throw new Error(`The stand-in's first line cannot name ${process.execPath}, which holds a space.`)
  const executable = join(folder, 'firefox')
  await writeFile(join(folder, 'stand-in.json'), JSON.stringify(config))
  await writeFile(executable, `#!${process.execPath}\nif (process.argv[2] !== ${JSON.stringify(warmUpArgument)}) import(${JSON.stringify(import.meta.url)}).then((standIn) => standIn.runStandIn())\n`)
  await chmod(executable, 0o755)
  await warmUp(executable)
  return executable
}

/**
 * Runs a freshly written executable once and waits for it to end, whatever its exit status. On macOS the first start of
 * a new executable file waits in the system, about a hundred milliseconds here and more under load, and a signal sent
 * meanwhile does not land until it ends; a Firefox build run before has had that wait already.
 */
export async function warmUp(executable: string): Promise<void> {
  await promisify(execFile)(executable, [warmUpArgument], { timeout: 30_000 }).catch(() => undefined)
}

/** The stand-in's start report. */
export async function readStart(reports: string): Promise<StandInStart> {
  return parsed(startSchema, JSON.parse(await readFile(join(reports, 'started.json'), 'utf8')), 'started.json')
}

/** Where the stand-in listens. */
export async function readListening(reports: string): Promise<StandInListening> {
  return parsed(listeningSchema, JSON.parse(await readFile(join(reports, 'listening.json'), 'utf8')), 'listening.json')
}

/** Every helper the stand-in started, in order; none when it started none. */
export async function readHelpers(reports: string): Promise<StandInHelper[]> {
  return (await readLines(join(reports, 'helpers.jsonl'))).map((line) => parsed(helperSchema, JSON.parse(line), 'helpers.jsonl'))
}

/** The BiDi methods the stand-in received, in order. */
export async function readCommands(reports: string): Promise<string[]> {
  return (await readLines(join(reports, 'commands.jsonl'))).map((line) => parsed(commandSchema, JSON.parse(line), 'commands.jsonl').method)
}

/** Whether the stand-in reached the end of an orderly close by itself. */
export function endedInOrder(reports: string): boolean {
  return existsSync(join(reports, 'ended.json'))
}

/** The stand-in's program, which the executable runs. */
export async function runStandIn(): Promise<void> {
  const executable = process.argv[1] ?? ''
  const config = parsed(configSchema, JSON.parse(readFileSync(join(dirname(executable), 'stand-in.json'), 'utf8')), 'stand-in.json')
  const firefoxArguments = process.argv.slice(2)
  const profile = firefoxArguments[firefoxArguments.indexOf('--profile') + 1] ?? ''
  const started: StandInStart = {
    pid: process.pid,
    parentPid: process.ppid,
    arguments: firefoxArguments,
    crashReporterDisabled: process.env['MOZ_CRASHREPORTER_DISABLE'] ?? null,
    variablesSeen: Object.fromEntries(config.watchedVariables.map((name) => [name, process.env[name] !== undefined])),
    preferencesFound: existsSync(join(profile, 'user.js')),
  }
  writeFileSync(join(config.reports, 'started.json'), JSON.stringify(started))
  process.stdout.write(config.stdout)
  process.stderr.write(config.stderr)
  if (config.behaviour === 'exit-before-listening') {
    // The record acknowledges that the launch claimed this process without helpers. A timer alone could let a
    // slower metadata reading observe and own the helper, which would no longer exercise an untraced process.
    if (config.helpers > 0) {
      const until = performance.now() + config.lifetimeMs
      while (!existsSync(join(dirname(profile), ownerRecordFile))) {
        if (performance.now() >= until) { process.exitCode = 75; return }
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
    }
    for (let index = 1; index <= config.helpers; index += 1) (await startHelper(config, `helper-${index}`)).unref()
    // A short life first, so the launch has claimed the process before it goes, as a Firefox that fails during startup.
    setTimeout(() => {
      process.exitCode = config.exitCode
    }, 200)
    return
  }
  await serve(config, firefoxArguments, profile)
}

async function serve(config: StandInConfig, firefoxArguments: readonly string[], profile: string): Promise<void> {
  const lifetime = setTimeout(() => process.exit(75), config.lifetimeMs)
  const helpers: ChildProcess[] = []
  for (let index = 1; index <= config.helpers; index += 1) helpers.push(await startHelper(config, `helper-${index}`))
  if (config.behaviour === 'never-listen') return
  const endpoint = await ScriptedBidi.start()
  const { hostname, port } = new URL(endpoint.url)
  endpoint.on('session.new', () => {
    note(config, 'session.new')
    const processId = config.behaviour === 'name-helper' ? (helpers[0]?.pid ?? 0) : process.pid
    const capabilities = {
      acceptInsecureCerts: false,
      browserName: 'firefox',
      browserVersion: '133.0.3',
      platformName: 'mac',
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:133.0) Gecko/20100101 Firefox/133.0',
      'moz:buildID': '20241209150345',
      'moz:headless': firefoxArguments.includes('--headless'),
      'moz:processID': processId,
      'moz:profile': profile,
    }
    if (config.behaviour === 'crash-after-session') setTimeout(() => void crash(helpers), 300)
    return { result: { sessionId: 'stand-in-session', capabilities } }
  })
  endpoint.on('browser.close', () => {
    note(config, 'browser.close')
    if (config.behaviour === 'ignore-close') return 'silent'
    // The answer is written once this handler returns; the connection and the process end after it, as in Firefox.
    setTimeout(() => void closeInOrder(config, endpoint, helpers, lifetime), 20)
    return config.behaviour === 'close-without-answer' ? 'silent' : { result: {} }
  })
  writeFileSync(join(config.reports, 'listening.json'), JSON.stringify({ host: hostname, port: Number(port) }))
  const serverFile = join(profile, 'WebDriverBiDiServer.json')
  const server = JSON.stringify({ ws_host: hostname, ws_port: Number(port) })
  const halfServerFileMs = config.halfServerFileMs
  if (halfServerFileMs === undefined) writeFileSync(serverFile, server)
  else {
    writeFileSync(serverFile, server.slice(0, server.length - 8))
    setTimeout(() => writeFileSync(serverFile, server), halfServerFileMs)
  }
  const lateHelperMs = config.lateHelperMs
  if (lateHelperMs !== undefined) setTimeout(() => void startHelper(config, 'late-helper').then((helper) => helpers.push(helper)), lateHelperMs)
}

async function closeInOrder(config: StandInConfig, endpoint: ScriptedBidi, helpers: readonly ChildProcess[], lifetime: NodeJS.Timeout): Promise<void> {
  process.stderr.write(config.closeOutput)
  await endHelpers(helpers, 'SIGTERM')
  await endpoint.close()
  clearTimeout(lifetime)
  writeFileSync(join(config.reports, 'ended.json'), JSON.stringify({ pid: process.pid }))
  process.exitCode = 0
}

async function crash(helpers: readonly ChildProcess[]): Promise<void> {
  await endHelpers(helpers, 'SIGKILL')
  process.exit(9)
}

async function endHelpers(helpers: readonly ChildProcess[], signal: NodeJS.Signals): Promise<void> {
  for (const helper of helpers) {
    if (helper.exitCode !== null || helper.signalCode !== null) continue
    const exited = once(helper, 'exit')
    helper.kill(signal)
    await exited
  }
}

// A helper shares the stand-in's process group, parent and output, as Firefox's content processes do, and names the
// reports folder in its command line so the test can tell it from every other process.
async function startHelper(config: StandInConfig, name: string): Promise<ChildProcess> {
  const script = `process.stderr.write('stand-in ' + process.argv[2] + ' started\\n'); setTimeout(() => {}, ${config.lifetimeMs})`
  const helper = spawn(process.execPath, ['-e', script, '--', config.reports, name], { stdio: ['ignore', 'inherit', 'inherit'] })
  await once(helper, 'spawn')
  const line: StandInHelper = { name, pid: helper.pid ?? 0 }
  appendFileSync(join(config.reports, 'helpers.jsonl'), `${JSON.stringify(line)}\n`)
  return helper
}

function note(config: StandInConfig, method: string): void {
  appendFileSync(join(config.reports, 'commands.jsonl'), `${JSON.stringify({ method })}\n`)
}

async function readLines(file: string): Promise<string[]> {
  const text = await readFile(file, 'utf8').catch(() => '')
  return text.split('\n').filter((line) => line !== '')
}

function parsed<T>(schema: Schema<T>, value: unknown, name: string): T {
  const result = parse(schema, value)
  if (!result.ok) throw new Error(`The stand-in's ${name} could not be read: ${result.issues.map((issue) => `${issue.path} ${issue.message}`).join('; ')}`)
  return result.value
}
