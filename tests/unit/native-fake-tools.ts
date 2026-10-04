import type { TestContext } from 'node:test'
import type { NativeTools } from '../../src/native/processes.ts'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isPlainObject, parse, s } from '../../src/protocol/schema.ts'
import { alive, readApps, readJsonFile } from './native-fake-executor.ts'

const toolMain = fileURLToPath(new URL('./native-fake-tool.ts', import.meta.url))
const names = { xcrun: 'xcrun', xcodebuild: 'xcodebuild', plutil: 'plutil', git: 'git', codesign: 'codesign', ps: 'ps', lsappinfo: 'lsappinfo', swVers: 'sw_vers', automationModeTool: 'automationmodetool', osascript: 'osascript', lsof: 'lsof' } as const

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

/** Every process the fakes started and recorded: app processes, runner apps and hung children. */
export async function startedProcesses(root: string): Promise<number[]> {
  const apps = Object.values(readApps(root)).flatMap((app) => (app.pid === undefined ? [] : [app.pid]))
  const runners = readJsonFile(join(root, 'processes.json'))
  const runnerPids = Array.isArray(runners) ? runners.flatMap((entry) => (isPlainObject(entry) && typeof entry['pid'] === 'number' ? [entry['pid']] : [])) : []
  const hung = (await readFile(join(root, 'hung.txt'), 'utf8').catch(() => '')).split('\n').filter((line) => /^\d+$/.test(line)).map(Number)
  return [...apps, ...runnerPids, ...hung]
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

/** Quotes one literal shell argument; fixture paths can contain spaces or apostrophes. */
function quoteShellArgument(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}
