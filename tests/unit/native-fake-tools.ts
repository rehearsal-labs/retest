import type { TestContext } from 'node:test'
import type { NativeTools } from '../../src/native/processes.ts'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { closeSync, constants, openSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isPlainObject, parse, s } from '../../src/protocol/schema.ts'
import { alive, readApps, readJsonFile } from './native-fake-executor.ts'

const toolMain = fileURLToPath(new URL('./native-fake-tool.ts', import.meta.url))
const names = { xcrun: 'xcrun', xcodebuild: 'xcodebuild', plutil: 'plutil', git: 'git', codesign: 'codesign', ps: 'ps', lsappinfo: 'lsappinfo', swVers: 'sw_vers', automationModeTool: 'automationmodetool', osascript: 'osascript', screencapture: 'screencapture', lsof: 'lsof' } as const

/** A folder of fake macOS tools and the state they share, removed after the test with everything they started. */
export type FakeTools = { readonly root: string; readonly tools: NativeTools; configure(config: Record<string, unknown>): Promise<void>; calls(): Promise<{ tool: string; args: string[] }[]> }

/**
 * Writes the fake tools into a new folder: each a shell wrapper that keeps its identity while Node runs `native-fake-tool.ts` as that tool.
 * After the test, every app process, runner app and hung child they started is ended and the folder removed.
 */
export async function fakeTools(t: TestContext): Promise<FakeTools> {
  const root = await mkdtemp(join(tmpdir(), 'retest-native-fake-'))
  await mkdir(join(root, 'bin'))
  for (const name of Object.values(names)) {
    const path = join(root, 'bin', name)
    const node = `${quoteShellArgument(process.execPath)} --conditions=retest-source ${quoteShellArgument(toolMain)}`
    await writeFile(path, `#!/bin/sh\nexport FAKE_NATIVE_ROOT=${quoteShellArgument(root)}\ntask_child=''\ntrap 'trap - TERM; if [ -n "$task_child" ]; then kill -TERM "$task_child" 2>/dev/null || :; wait "$task_child" 2>/dev/null || :; fi; exit 143' TERM\ncase "\${1-}" in\n  runner-app|runner-app-silent) ${node} "$@" & ;;\n  *) ${node} ${quoteShellArgument(name)} "$@" & ;;\nesac\ntask_child=$!\nwait "$task_child"\ntask_status=$?\ntask_child=''\nexit "$task_status"\n`)
    await chmod(path, 0o755)
  }
  const tools: NativeTools = {
    xcrun: join(root, 'bin', names.xcrun),
    xcodebuild: join(root, 'bin', names.xcodebuild),
    plutil: join(root, 'bin', names.plutil),
    git: join(root, 'bin', names.git),
    codesign: join(root, 'bin', names.codesign),
    ps: join(root, 'bin', names.ps),
    lsappinfo: join(root, 'bin', names.lsappinfo),
    swVers: join(root, 'bin', names.swVers),
    automationModeTool: join(root, 'bin', names.automationModeTool),
    osascript: join(root, 'bin', names.osascript),
    screencapture: join(root, 'bin', names.screencapture),
    lsof: join(root, 'bin', names.lsof),
    // The kernel lock is the system's own: its behaviour is what the desktop lock stands on.
    lockf: '/usr/bin/lockf',
  }
  t.after(async () => {
    for (const pid of await startedProcesses(root)) if (alive(pid)) process.kill(pid, 'SIGKILL')
    await rm(root, { recursive: true, force: true })
  })
  return {
    root,
    tools,
    configure: (config) => writeFile(join(root, 'tools.json'), JSON.stringify(config)),
    calls: async () => {
      const text = await readFile(join(root, 'calls.jsonl'), 'utf8').catch(() => '')
      const callSchema = s.object({ tool: s.string(), args: s.array(s.string()) })
      return text.trim().split('\n').filter((line) => line.length > 0).flatMap((line) => {
        const parsed = parse(callSchema, JSON.parse(line))
        return parsed.ok ? [parsed.value] : []
      })
    },
  }
}

/**
 * A live process's start as `ps` reads it in the C locale, one-spaced, as Retest records it.
 *
 * @example processStart(process.pid) // 'Mon Oct 5 11:18:31 2026'
 */
export function processStart(pid: number): string {
  const read = spawnSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', TZ: 'UTC0' } })
  const start = read.stdout.trim().replace(/\s+/g, ' ')
  if (read.status !== 0 || start === '') throw new Error(`ps could not read the start of pid ${pid}.`)
  return start
}

/** A pid no process has now: that of a process that started and ended. Node itself is the process, on every platform. */
export async function endedPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
  await once(child, 'exit')
  if (child.pid === undefined) throw new Error('The ended process had no pid.')
  return child.pid
}

/** Every process the fakes started and recorded: app processes, runner apps and hung children. */
export async function startedProcesses(root: string): Promise<number[]> {
  const apps = Object.values(readApps(root)).flatMap((app) => (app.pid === undefined ? [] : [app.pid]))
  const runners = readJsonFile(join(root, 'processes.json'))
  const runnerPids = Array.isArray(runners) ? runners.flatMap((entry) => (isPlainObject(entry) && typeof entry['pid'] === 'number' ? [entry['pid']] : [])) : []
  return [...apps, ...runnerPids, ...(await hungProcesses(root))]
}

/** The children a hanging fake step started, each noted once it runs: a step hangs only from then on. */
export async function hungProcesses(root: string): Promise<number[]> {
  return (await readFile(join(root, 'hung.txt'), 'utf8').catch(() => '')).split('\n').filter((line) => /^\d+$/.test(line)).map(Number)
}

/** An owned fake process for a window's owner, listed by fake ps and usable in the fake window list. */
export async function fakeWindowProcess(fake: FakeTools, command: string): Promise<number> {
  const child = spawn('/bin/sleep', ['600'], { stdio: 'ignore' })
  await once(child, 'spawn')
  if (child.pid === undefined) throw new Error('The fake window owner started without a pid.')
  const listed = parse(s.array(s.object({ pid: s.number(), command: s.string(), udid: s.optional(s.string()), port: s.optional(s.number()) })), readJsonFile(join(fake.root, 'processes.json')) ?? [])
  if (!listed.ok) {
    child.kill('SIGTERM')
    throw new Error('The fake process list could not be read.')
  }
  // fakeTools ends only the processes this test wrote down; the owner is kept alive through both window readings.
  await writeFile(join(fake.root, 'processes.json'), JSON.stringify([...listed.value, { pid: child.pid, command }]))
  return child.pid
}

/**
 * A fake app bundle: a folder whose Info.plist is JSON, which the fake plutil reads.
 *
 * @example await fakeAppBundle(root, { platform: 'macos', name: 'FakeApp', bundleId: 'dev.retest.fake' })
 */
export async function fakeAppBundle(root: string, options: { readonly platform: 'ios-simulator' | 'macos'; readonly name: string; readonly bundleId: string }): Promise<string> {
  const app = join(root, `${options.name}.app`)
  const plistFolder = options.platform === 'macos' ? join(app, 'Contents') : app
  await mkdir(join(plistFolder, options.platform === 'macos' ? 'MacOS' : '.'), { recursive: true })
  const info = { CFBundleIdentifier: options.bundleId, CFBundleExecutable: options.name, CFBundleName: options.name, CFBundleShortVersionString: '2.1', CFBundleVersion: '42', CFBundleSupportedPlatforms: [options.platform === 'macos' ? 'MacOSX' : 'iPhoneSimulator'] }
  await writeFile(join(plistFolder, 'Info.plist'), JSON.stringify(info))
  return app
}

/** A fake source checkout at a commit, as the fake git reads it, with a licence file. */
export async function fakeCheckout(root: string, options: { readonly name: string; readonly head: string; readonly licenses: Readonly<Record<string, string>> }): Promise<string> {
  const folder = join(root, options.name)
  await mkdir(folder, { recursive: true })
  await writeFile(join(folder, '.fake-git.json'), JSON.stringify({ head: options.head }))
  for (const [path, text] of Object.entries(options.licenses)) {
    await mkdir(join(folder, path, '..'), { recursive: true })
    await writeFile(join(folder, path), text)
  }
  return folder
}

/** A tool that never answers, and `ready`, which says whether a run of it got as far as saying so before its pipe closed. */
export type WaitingTool = { readonly path: string; ready(): Promise<boolean> }

/**
 * Writes a tool that ignores SIGTERM, as do the processes it starts, so only SIGKILL ends it. Each run says through a
 * named pipe once it has set its trap, since a signal that comes first ends it at once, and a loaded machine can make
 * the shell late to set it.
 */
export function stubbornTool(t: TestContext): Promise<WaitingTool> {
  return waitingTool(t, 'stubborn', (said) => `#!/bin/sh\ntrap '' TERM\necho ready > ${said}\nsleep 30\n`)
}

/**
 * Writes a tool that never answers until SIGTERM ends it, one shell and no process of its own: each run says through a
 * named pipe once it is running, then waits on a second pipe nothing writes to. A tool still starting when a signal or
 * a reading's end comes is not yet the process Retest recorded, which a loaded machine can make it.
 */
export function silentTool(t: TestContext): Promise<WaitingTool> {
  return waitingTool(t, 'silent', (said, folder) => `#!/bin/sh\necho ready > ${said}\nread line < ${quoteShellArgument(join(folder, 'never'))}\n`)
}

// A tool whose script says `ready` through the pipe `said` names, in a folder of its own with a pipe `never` beside it.
// A reader still waiting on `said` after the test, for a run that never said, is let go.
async function waitingTool(t: TestContext, name: string, script: (said: string, folder: string) => string): Promise<WaitingTool> {
  const folder = await mkdtemp(join(tmpdir(), `retest-native-${name}-`))
  const said = join(folder, 'said')
  for (const pipe of [said, join(folder, 'never')]) {
    const made = spawnSync('mkfifo', [pipe])
    if (made.status !== 0) throw new Error(`mkfifo could not make ${pipe}: ${made.stderr.toString()}`)
  }
  const path = join(folder, name)
  await writeFile(path, script(quoteShellArgument(said), folder))
  await chmod(path, 0o755)
  t.after(async () => {
    try {
      closeSync(openSync(said, constants.O_WRONLY | constants.O_NONBLOCK))
    } catch (error) {
      // No reader is waiting on the pipe.
      if (!(error instanceof Error && 'code' in error && error.code === 'ENXIO')) throw error
    }
    await rm(folder, { recursive: true, force: true })
  })
  return { path, ready: async () => (await readFile(said, 'utf8')) === 'ready\n' }
}

/** Quotes one literal shell argument; fixture paths can contain spaces or apostrophes. */
function quoteShellArgument(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}
