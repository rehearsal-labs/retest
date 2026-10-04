import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { randomUUID } from 'node:crypto'
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { isPlainObject, parse, s } from '../../src/protocol/schema.ts'
import { alive, readApps, readJsonFile, solidPng, startFakeExecutor, writeJson } from './native-fake-executor.ts'

// One program that plays every macOS tool the native driver runs, chosen by its first argument, with its state in the
// folder FAKE_NATIVE_ROOT names: `tools.json` says how a tool should misbehave, `calls.jsonl` records every call,
// `devices.json` holds the simulators, `processes.json` the runner apps, `apps.json`, shared with the fake executor,
// each app's process, and `signals.txt` every signal a runner app was sent.

const root = process.env['FAKE_NATIVE_ROOT'] ?? ''
const [tool = '', ...args] = process.argv.slice(2)

type Step = { delayMs?: number; fail?: string; hang?: boolean }
type ToolsConfig = {
  xcodeBuild?: string
  simctl?: Record<string, Step>
  executorStart?: 'fail' | 'hang' | 'automation' | 'runner-not-ready'
  // Creation succeeds but its answer never reaches the caller.
  createNeverAnswers?: boolean
  runtimes?: { version: string; build: string }[]
  automation?: string
  lsappinfoRunning?: string[]
  dirtySource?: boolean
  untrackedSource?: boolean
  psFails?: boolean
  lsappinfoFails?: boolean
  // A window in front of every other, owned by `pid` (1 by default).
  coveringWindow?: { layer: number; x: number; y: number; width: number; height: number; pid?: number }
  streamIgnoresHold?: boolean
  windowsChange?: boolean
  extraRunnerApp?: boolean
  // The runner app stays up when xcodebuild ends, so only Retest's own kill of the recorded runner app ends it.
  runnerSurvivesXcodebuild?: boolean
  // The runner app answers a shutdown and keeps running.
  runnerIgnoresShutdown?: boolean
  // A simulator's shutdown leaves its runner app running.
  shutdownLeavesProcesses?: boolean
  // xcodebuild replaces the desktop record with another holder's as it starts, so writing the record fails.
  xcodebuildReplacesRecord?: boolean
  // The window list is read this many times, and every later reading fails.
  windowListReadings?: number
}
const stepSchema = s.object({ delayMs: s.optional(s.number()), fail: s.optional(s.string()), hang: s.optional(s.boolean()) })
const configSchema = s.object({
  xcodeBuild: s.optional(s.string()),
  simctl: s.optional(s.record(stepSchema)),
  executorStart: s.optional(s.enum(['fail', 'hang', 'automation', 'runner-not-ready'])),
  createNeverAnswers: s.optional(s.boolean()),
  runtimes: s.optional(s.array(s.object({ version: s.string(), build: s.string() }))),
  automation: s.optional(s.string()),
  lsappinfoRunning: s.optional(s.array(s.string())),
  dirtySource: s.optional(s.boolean()),
  untrackedSource: s.optional(s.boolean()),
  psFails: s.optional(s.boolean()),
  lsappinfoFails: s.optional(s.boolean()),
  coveringWindow: s.optional(s.object({ layer: s.number(), x: s.number(), y: s.number(), width: s.number(), height: s.number(), pid: s.optional(s.number()) })),
  streamIgnoresHold: s.optional(s.boolean()),
  windowsChange: s.optional(s.boolean()),
  extraRunnerApp: s.optional(s.boolean()),
  runnerSurvivesXcodebuild: s.optional(s.boolean()),
  runnerIgnoresShutdown: s.optional(s.boolean()),
  shutdownLeavesProcesses: s.optional(s.boolean()),
  xcodebuildReplacesRecord: s.optional(s.boolean()),
  windowListReadings: s.optional(s.number()),
})
type Device = { udid: string; name: string; state: string; runtime: string }
const devicesSchema = s.array(s.object({ udid: s.string(), name: s.string(), state: s.string(), runtime: s.string() }))
type RunnerApp = { pid: number; command: string; udid?: string; port?: number }
const processesSchema = s.array(s.object({ pid: s.number(), command: s.string(), udid: s.optional(s.string()), port: s.optional(s.number()) }))

// WebDriverAgent starts its screen stream on every interface and logs a refusal when the port is taken; so does this.
async function bindScreenStream(): Promise<void> {
  const port = Number(process.env['MJPEG_SERVER_PORT'] ?? process.env['TEST_RUNNER_MJPEG_SERVER_PORT'] ?? 0)
  if (port === 0) return
  // A stream that comes up on a port of its own whatever was asked, and logs nothing about the held one.
  if (config().streamIgnoresHold === true) return
  const server = createServer((socket) => socket.end())
  await new Promise<void>((resolve) => {
    server.once('error', () => {
      process.stdout.write(`Cannot init screenshots broadcaster service on port ${port}. Original error: address in use\n`)
      resolve()
    })
    server.listen({ port, host: '::', ipv6Only: false }, () => resolve())
  })
}

function config(): ToolsConfig {
  const parsed = parse(configSchema, readJsonFile(join(root, 'tools.json')) ?? {})
  return parsed.ok ? parsed.value : {}
}
function devices(): Device[] {
  const parsed = parse(devicesSchema, readJsonFile(join(root, 'devices.json')) ?? [])
  return parsed.ok ? parsed.value : []
}
function processes(): RunnerApp[] {
  const parsed = parse(processesSchema, readJsonFile(join(root, 'processes.json')) ?? [])
  return parsed.ok ? parsed.value : []
}
function option(name: string): string | undefined {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}
function plistValue(file: string, key: string): unknown {
  const value = readJsonFile(file)
  return isPlainObject(value) ? value[key] : undefined
}
function finish(code: number, stdout = '', stderr = ''): never {
  if (stdout.length > 0) process.stdout.write(stdout)
  if (stderr.length > 0) process.stderr.write(stderr)
  process.exit(code)
}
async function hangForever(): Promise<never> {
  // A grandchild in the same group, as xcodebuild's own children are, so a test sees whether the group was ended.
  const child = spawn('sleep', ['600'], { stdio: 'ignore' })
  appendFileSync(join(root, 'hung.txt'), `${child.pid}\n`)
  await new Promise(() => undefined)
  process.exit(0)
}

appendFileSync(join(root, 'calls.jsonl'), `${JSON.stringify({ tool, args })}\n`)

async function simctl(command: string, rest: string[]): Promise<never> {
  const step = config().simctl?.[command] ?? {}
  if (step.delayMs !== undefined) await new Promise((resolve) => setTimeout(resolve, step.delayMs))
  if (step.hang === true) return hangForever()
  if (step.fail !== undefined) finish(1, '', `${step.fail}\n`)
  const runtimes = config().runtimes ?? [{ version: '26.5', build: '23F77' }]
  const list = devices()
  const save = (next: Device[]): void => writeJson(join(root, 'devices.json'), next)
  const [first = '', second = ''] = rest
  switch (command) {
    case 'list':
      if (first === 'runtimes') finish(0, JSON.stringify({ runtimes: runtimes.map((runtime) => ({ identifier: `com.apple.CoreSimulator.SimRuntime.iOS-${runtime.version.replace('.', '-')}`, name: `iOS ${runtime.version}`, version: runtime.version, buildversion: runtime.build, platform: 'iOS', isAvailable: true })) }))
      if (first === 'devicetypes') finish(0, JSON.stringify({ devicetypes: [{ identifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17', name: 'iPhone 17' }] }))
      finish(0, JSON.stringify({ devices: Object.fromEntries([...new Set(list.map((device) => device.runtime))].map((runtime) => [runtime, list.filter((device) => device.runtime === runtime).map(({ udid, name, state }) => ({ udid, name, state }))])) }))
      break
    case 'create': {
      const udid = randomUUID().toUpperCase()
      save([...list, { udid, name: first, state: 'Shutdown', runtime: rest[2] ?? '' }])
      if (config().createNeverAnswers === true) return hangForever()
      finish(0, `${udid}\n`)
      break
    }
    case 'boot':
      save(list.map((device) => (device.udid === first ? { ...device, state: 'Booted' } : device)))
      finish(0)
      break
    case 'bootstatus':
      finish(list.some((device) => device.udid === first && device.state === 'Booted') ? 0 : 1)
      break
    case 'install': {
      const bundleId = plistValue(join(second, 'Info.plist'), 'CFBundleIdentifier')
      if (typeof bundleId !== 'string') finish(1, '', 'not an app\n')
      // The device keeps a copy of its own, as a simulator's app container does.
      const container = join(root, 'containers', first, `${bundleId}.app`)
      rmSync(container, { recursive: true, force: true })
      mkdirSync(dirname(container), { recursive: true })
      cpSync(second, container, { recursive: true })
      writeJson(join(root, 'apps.json'), { ...readApps(root), [bundleId]: { ...readApps(root)[bundleId], installed: true } })
      finish(0)
      break
    }
    case 'get_app_container': {
      const container = join(root, 'containers', first, `${second}.app`)
      finish(existsSync(container) ? 0 : 2, existsSync(container) ? `${container}\n` : '', existsSync(container) ? '' : 'No such app\n')
      break
    }
    case 'spawn': {
      const lines = Object.entries(readApps(root)).filter(([key, app]) => !key.endsWith('.app') && alive(app.pid)).map(([key, app]) => `${app.pid}\t0\tUIKitApplication:${key}[0x1][rb-legacy]`)
      finish(0, `PID\tStatus\tLabel\n${lines.join('\n')}\n`)
      break
    }
    case 'terminate': {
      const pid = readApps(root)[second]?.pid
      if (pid !== undefined && alive(pid)) process.kill(pid, 'SIGTERM')
      finish(0)
      break
    }
    case 'io':
      writeFileSync(rest.at(-1) ?? '', solidPng(12, 26))
      finish(0)
      break
    case 'shutdown':
      if (config().shutdownLeavesProcesses !== true) for (const runner of processes()) if (runner.udid === first && alive(runner.pid)) process.kill(runner.pid, 'SIGKILL')
      save(list.map((device) => (device.udid === first ? { ...device, state: 'Shutdown' } : device)))
      finish(0)
      break
    case 'delete':
      save(list.filter((device) => device.udid !== first))
      finish(0)
      break
    default:
      finish(0)
  }
}

async function xcodebuild(): Promise<never> {
  if (args.includes('-version')) finish(0, `Xcode 26.5\nBuild version ${config().xcodeBuild ?? '17F42'}\n`)
  if (args[0] === 'build-for-testing') {
    const derived = option('-derivedDataPath') ?? ''
    const ios = (option('-destination') ?? '').includes('iOS')
    const products = join(derived, 'Build', 'Products')
    const folder = join(products, ios ? 'Debug-iphonesimulator' : 'Debug')
    const bundleInfo = ios ? join(folder, 'WebDriverAgentRunner-Runner.app', 'PlugIns', 'WebDriverAgentRunner.xctest', 'Info.plist') : join(folder, 'WebDriverAgentRunner-Runner.app', 'Contents', 'PlugIns', 'WebDriverAgentRunner.xctest', 'Contents', 'Info.plist')
    mkdirSync(dirname(bundleInfo), { recursive: true })
    writeFileSync(bundleInfo, JSON.stringify({ DTXcodeBuild: config().xcodeBuild ?? '17F42', DTSDKName: ios ? 'iphonesimulator26.5' : 'macosx26.5' }))
    writeFileSync(join(folder, 'WebDriverAgentRunner-Runner.app', 'runner'), 'fake runner binary')
    writeFileSync(join(products, ios ? 'WebDriverAgentRunner_iphonesimulator26.5-arm64-x86_64.xctestrun' : 'WebDriverAgentRunner_macosx26.5-arm64.xctestrun'), 'fake test run')
    finish(0, '** TEST BUILD SUCCEEDED **\n')
  }
  if (args[0] === 'test-without-building') {
    if (config().xcodebuildReplacesRecord === true) writeJson(join(root, 'desktop.json'), { pid: 1, startedAt: '2026-10-04T00:00:00.000Z', holderCommand: 'node other', runnerApps: [] })
    const mode = config().executorStart
    if (mode === 'fail') finish(65, '** TEST EXECUTE FAILED **\n')
    if (mode === 'automation') process.stdout.write('Timed out while enabling automation mode.\n')
    if (mode === 'hang' || mode === 'automation') return hangForever()
    const port = process.env['TEST_RUNNER_USE_PORT'] ?? ''
    const destination = option('-destination') ?? ''
    const udid = /id=([0-9A-F-]+)/.exec(destination)?.[1]
    const xctestrun = option('-xctestrun') ?? ''
    // Like the real runner app, it runs outside xcodebuild's process group: macOS or the simulator launches it.
    const runnerMode = mode === 'runner-not-ready' ? 'runner-app-silent' : 'runner-app'
    // The runner app writes to xcodebuild's log, as XCTest passes its output on.
    const runner = spawn(process.execPath, ['--conditions=retest-source', process.argv[1] ?? '', runnerMode, port], { detached: true, stdio: ['ignore', 'inherit', 'inherit'], env: process.env })
    const command = udid === undefined ? join(dirname(xctestrun), 'Debug', 'WebDriverAgentRunner-Runner.app', 'Contents', 'MacOS', 'WebDriverAgentRunner-Runner') : `/fake/CoreSimulator/Devices/${udid}/data/Containers/Bundle/Application/X/WebDriverAgentRunner-Runner.app/WebDriverAgentRunner-Runner`
    // xcodebuild is listed too, under a command line of its own, so a lock can record it and a later start match it.
    const self = { pid: process.pid, command: `xcodebuild ${args.join(' ')}` }
    // A second runner app of the same executable, as another start of the same build would bring up meanwhile.
    const extra = config().extraRunnerApp === true ? spawn(process.execPath, ['--conditions=retest-source', process.argv[1] ?? '', 'runner-app-silent', '0'], { detached: true, stdio: 'ignore', env: process.env }) : undefined
    const extraEntry = extra?.pid === undefined ? [] : [{ pid: extra.pid, command }]
    if (runner.pid !== undefined) writeJson(join(root, 'processes.json'), [...processes(), self, { pid: runner.pid, command, port: Number(port), ...(udid === undefined ? {} : { udid }) }, ...extraEntry])
    process.on('SIGTERM', () => {
      if (config().runnerSurvivesXcodebuild !== true && runner.pid !== undefined && alive(runner.pid)) process.kill(runner.pid, 'SIGKILL')
      process.exit(143)
    })
    runner.on('exit', (code) => process.exit(code === 0 ? 0 : 65))
    await new Promise(() => undefined)
  }
  finish(64, '', `unknown xcodebuild call ${args.join(' ')}\n`)
}

// A runner app notes each SIGTERM it is sent, so a test sees which process ended it.
function noteSignals(): void {
  process.on('SIGTERM', () => {
    appendFileSync(join(root, 'signals.txt'), `${process.pid} SIGTERM\n`)
    process.exit(143)
  })
}

async function main(): Promise<never> {
  switch (tool) {
    case 'xcrun':
      if (args[0] !== 'simctl') finish(64)
      return simctl(args[1] ?? '', args.slice(2).filter((arg) => arg !== '-j'))
    case 'xcodebuild':
      return xcodebuild()
    case 'runner-app':
      noteSignals()
      await bindScreenStream()
      await startFakeExecutor({ folder: root, port: Number(args[0]), onShutdown: () => {
          if (config().runnerIgnoresShutdown !== true) process.exit(0)
        },
      })
      return new Promise(() => undefined)
    case 'runner-app-silent':
      noteSignals()
      // Stays up and serves nothing, as a runner app that never comes ready.
      setInterval(() => undefined, 1000)
      return new Promise(() => undefined)
    case 'plutil': {
      const file = args.at(-1) ?? ''
      if (args[0] === '-extract') {
        const value = plistValue(file, args[1] ?? '')
        if (value === undefined) finish(1, '', 'No value at that key path\n')
        finish(0, `${String(value)}\n`)
      }
      finish(0, readFileSync(file, 'utf8'))
      break
    }
    case 'git': {
      const folder = option('-C') ?? ''
      const state = readJsonFile(join(folder, '.fake-git.json'))
      const head = isPlainObject(state) && typeof state['head'] === 'string' ? state['head'] : undefined
      if (head === undefined) finish(128, '', 'fatal: not a git repository\n')
      if (args.includes('rev-parse')) finish(0, `${head}\n`)
      const untracked = config().untrackedSource === true && args.includes('--untracked-files=all') ? '?? WebDriverAgentLib/Extra.m\n' : ''
      finish(0, `${config().dirtySource === true ? ' M WebDriverAgentLib/FBSession.m\n' : ''}${untracked}`)
      break
    }
    case 'codesign':
      finish(0, '', `Identifier=io.appium.WebDriverAgentRunner.xctrunner\nCDHash=${Buffer.from(basename(args.at(-1) ?? '')).toString('hex').slice(0, 40)}\nSignature=adhoc\n`)
      break
    case 'lsof': {
      const port = Number(/:(\d+)$/.exec(args.find((arg) => arg.startsWith('-iTCP')) ?? '')?.[1])
      const listener = processes().find((entry) => entry.port === port && alive(entry.pid))
      finish(listener === undefined ? 1 : 0, listener === undefined ? '' : `p${listener.pid}\n`)
      break
    }
    case 'osascript': {
      const readings = config().windowListReadings
      if (readings !== undefined) {
        appendFileSync(join(root, 'window-list-readings.txt'), 'x')
        if (readFileSync(join(root, 'window-list-readings.txt'), 'utf8').length > readings) finish(1, '', 'execution error: the window server did not answer (-1712)\n')
      }
      const executorConfig = readJsonFile(join(root, 'config.json'))
      const window = isPlainObject(executorConfig) && isPlainObject(executorConfig['window']) ? executorConfig['window'] : { x: 4, y: 3, width: 20, height: 10 }
      const own = Object.values(readApps(root)).filter((app) => app.command !== undefined && alive(app.pid)).map((app) => [app.pid ?? 0, 0, window['x'], window['y'], window['width'], window['height']])
      const covering = config().coveringWindow
      const front = covering === undefined ? [] : [[covering.pid ?? 1, covering.layer, covering.x, covering.y, covering.width, covering.height]]
      // A window that differs at each reading, as a notification banner coming in would.
      if (config().windowsChange === true) appendFileSync(join(root, 'osascript-calls.txt'), 'x')
      const changes = config().windowsChange === true ? [[3, 0, 3000, 3000, 10, readFileSync(join(root, 'osascript-calls.txt'), 'utf8').length]] : []
      finish(0, JSON.stringify([...front, ...own, ...changes, [2, 0, 0, 0, 4000, 4000]]))
      break
    }
    case 'ps': {
      if (config().psFails === true) finish(1, '', 'ps: could not run\n')
      const listed = [...processes().filter((entry) => alive(entry.pid)), ...Object.values(readApps(root)).flatMap((app) => (app.command !== undefined && app.pid !== undefined && alive(app.pid) ? [{ pid: app.pid, command: app.command }] : []))]
      // `-p` reads one pid, and ps answers 1 with nothing printed when no process has it; `-o args=` prints the command
      // line alone.
      const one = option('-p')
      const chosen = one === undefined ? listed : listed.filter((entry) => entry.pid === Number(one))
      // A fake tool that has not written itself down yet shows under the tool's name and its arguments, as the real
      // tool would.
      if (one !== undefined && chosen.length === 0) {
        const real = spawnSync('/bin/ps', ['-ww', '-o', 'args=', '-p', one], { encoding: 'utf8' }).stdout.trim()
        const fake = /native-fake-tool\.ts (\S+)(?: (.*))?$/.exec(real)
        if (fake?.[1] !== undefined) chosen.push({ pid: Number(one), command: `${fake[1]} ${fake[2] ?? ''}`.trim() })
        // A wrapper keeps its shell alive while Node runs the fake. Its stable command names the same tool even
        // before that child writes a process record, including the hang and automation-failure modes.
        const wrapperPrefix = `/bin/sh ${join(root, 'bin')}/`
        if (chosen.length === 0 && real.startsWith(wrapperPrefix)) {
          const invocation = real.slice(wrapperPrefix.length)
          const separator = invocation.indexOf(' ')
          const name = separator < 0 ? invocation : invocation.slice(0, separator)
          const argumentsText = separator < 0 ? '' : invocation.slice(separator + 1)
          if (name !== '' && !name.includes('/')) chosen.push({ pid: Number(one), command: `${name} ${argumentsText}`.trim() })
        }
      }
      if (one !== undefined && chosen.length === 0) finish(1)
      const commandOnly = option('-o') === 'args='
      finish(0, `${chosen.map((entry) => (commandOnly ? entry.command : `${entry.pid} ${entry.command}`)).join('\n')}\n`)
      break
    }
    case 'lsappinfo': {
      if (config().lsappinfoFails === true) finish(1, '', 'lsappinfo: could not run\n')
      // Launch Services knows each Mac app that runs by its bundle id, wherever it was launched from; a copy named in
      // `lsappinfoRunning` is one that runs elsewhere and whose process cannot be read.
      const running = Object.entries(readApps(root)).flatMap(([key, app]) => {
        if (!key.endsWith('.app') || app.pid === undefined || !alive(app.pid)) return []
        const bundleId = plistValue(join(key, 'Contents', 'Info.plist'), 'CFBundleIdentifier')
        return typeof bundleId === 'string' ? [{ pid: app.pid, bundleId }] : []
      })
      if (args[0] === 'find') {
        const wanted = (args[1] ?? '').replace('bundleid=', '')
        const own = running.filter((entry) => entry.bundleId === wanted).map((entry) => `ASN:0x0-0x${entry.pid.toString(16)}-"${wanted}":`)
        const elsewhere = (config().lsappinfoRunning ?? []).includes(wanted) ? [`ASN:0x0-0x1-"${wanted}":`] : []
        finish(0, [...own, ...elsewhere].map((line) => `${line}\n`).join(''))
      }
      if (args[0] === 'info') {
        const pid = Number.parseInt(/0x0-0x([0-9a-f]+)/.exec(args.at(-1) ?? '')?.[1] ?? '', 16)
        const app = running.find((entry) => entry.pid === pid)
        finish(0, app === undefined ? '' : `[ NULL ]  ASN:0x0-0x${pid.toString(16)}: \n    bundleID="${app.bundleId}"\n    pid = ${pid} type=[ NULL ]\n`)
      }
      finish(64)
      break
    }
    case 'sw_vers':
      finish(0, args[0] === '-productVersion' ? '27.0.1\n' : '26A434\n')
      break
    case 'automationmodetool':
      finish(0, `${config().automation ?? 'Automation Mode is disabled.\nThis device DOES NOT REQUIRE user authentication to enable Automation Mode.'}\n`)
      break
    default:
      finish(64, '', `unknown tool ${tool}\n`)
  }
}

await main()
