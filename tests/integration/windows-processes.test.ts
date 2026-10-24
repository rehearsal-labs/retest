import type { TestContext } from 'node:test'
import type { StartedRun } from './cli-harness.ts'
import type { SupervisedProcess, SupervisorProgram } from '../../src/shared/process-supervisor.ts'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { describe, test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { takeInstallLock } from '../../src/cli/install/lock.ts'
import { locateSupervisor } from '../../src/cli/install/supervisor-locate.ts'
import { consoleHost, Supervisor } from '../../src/shared/process-supervisor.ts'
import { heldLaunches, holdLaunch, prepareOwnedLaunch } from '../../src/shared/process-system.ts'
import { windowsOnly } from '../support/platform-skip.ts'
import { holdLockInChild } from '../unit/builds-fixtures.ts'
import { budgets, configSource, finishRun, freePort, readFinishedRun, sourceCommand, startRun, writeProject } from './cli-harness.ts'

// Retest's promise on Windows, kept by jobs: nothing a run starts outlives it, however it ends. The cases run the real
// CLI, `retest run`, on a project whose app has a server that starts a helper of its own, whose browser is a real
// Chromium, and whose test starts helpers of its own through child_process: one through a shell (`exec`), one detached.
// The harness holds the CLI in a job of its own (`cli-harness.ts`), so it reads every process the run started without
// asking the run, ends the CLI outright or with Ctrl+C, and reads each of them gone.

const jobs = windowsOnly('Windows jobs exist only on Windows; elsewhere process groups hold what Retest starts')
const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'

function browser(): string | undefined {
  const named = process.env['RETEST_TEST_BROWSER']
  if (named !== undefined && named !== '') return named
  return existsSync(edge) ? edge : undefined
}

const noBrowser = browser() === undefined ? 'no Chromium is named by RETEST_TEST_BROWSER and Edge is not installed' : false

// The reader that outlives the runner: a supervisor of this process, which only reads.
function reader(): Supervisor {
  const program: SupervisorProgram = locateSupervisor(process.env)
  return new Supervisor(program)
}

/** What a test leaves behind: processes to end and folders to remove once it is done, whatever failed. */
type Leftovers = { folder(prefix: string): string; process(end: () => void): void }

// Processes are ended first, since Windows keeps a folder while a running process uses it, and a folder is removed
// again a few times while processes just ended let go of it. One that still will not go stays in the system's
// temporary folder; that is no failure of the case.
function leftovers(t: TestContext): Leftovers {
  const ends: (() => void)[] = []
  const folders: string[] = []
  t.after(async () => {
    for (const end of ends) {
      try { end() } catch { /* it had already gone */ }
    }
    for (const folder of folders) await rm(folder, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }).catch(() => undefined)
  })
  return {
    folder: (prefix) => {
      const folder = mkdtempSync(join(tmpdir(), `retest-${prefix}`))
      folders.push(folder)
      return folder
    },
    process: (end) => { ends.push(end) },
  }
}

// Whether a process read earlier is still the one running under its pid.
function stillRunning(supervisor: Supervisor, entry: SupervisedProcess): boolean {
  return supervisor.process(entry.pid).process?.startedAt === entry.startedAt
}

async function settled(condition: () => boolean, timeoutMs: number): Promise<void> {
  const end = performance.now() + timeoutMs
  while (!condition() && performance.now() < end) await delay(100)
}

async function allGoneWithin(supervisor: Supervisor, processes: readonly SupervisedProcess[], timeoutMs: number): Promise<SupervisedProcess[]> {
  const end = performance.now() + timeoutMs
  for (;;) {
    const left = processes.filter((entry) => stillRunning(supervisor, entry))
    if (left.length === 0 || performance.now() > end) return left
    await delay(50)
  }
}

const named = (processes: readonly SupervisedProcess[]): string[] => processes.map((entry) => `${entry.pid} ${entry.image ?? '(unnamed)'}`)

// The Win32 calls the console cases need, for PowerShell to compile.
const consoleCalls = `Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public static class RetestConsole {
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool FreeConsole();
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool AttachConsole(uint processId);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool SetConsoleCtrlHandler(IntPtr handler, bool add);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool GenerateConsoleCtrlEvent(uint ctrlEvent, uint processGroupId);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern uint GetConsoleProcessList(uint[] processIds, uint count);
}
"@`

/** The pids the project's test writes once its helpers run and its page is open. */
type Helpers = { testFile: number; viaShell: number; detached: number }

// What the test does once its helpers run and its page is open: wait to be ended, end its helpers and pass, or leave
// them running and pass.
type Mode = 'wait' | 'clean' | 'leave'

// The server starts a helper of its own; the test starts one through a shell, which is how `exec` runs a command, and
// one detached. Each helper writes its own pid, so the shell's pid is not taken for the helper's.
async function project(t: TestContext, folder: string, mode: Mode): Promise<{ root: string; report: string }> {
  const port = await freePort()
  const report = join(folder, 'helpers.json')
  const url = `http://127.0.0.1:${port}/`
  const root = await writeProject(t, {
    'retest.config.ts': configSource(`{ apps: { web: chromium({ executablePath: ${JSON.stringify(browser())}, baseUrl: ${JSON.stringify(url)}, start: { command: ${JSON.stringify(`node server.mjs ${port}`)}, ready: ${JSON.stringify(url)} } }) } }`),
    'server.mjs': `import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
createServer((request, response) => { response.setHeader('content-type', 'text/html'); response.end('<!doctype html><h1>held</h1>') }).listen(Number(process.argv[2]), '127.0.0.1')
`,
    'helper.cjs': "require('node:fs').writeFileSync(process.argv[2], String(process.pid))\nsetInterval(() => {}, 1000)\n",
    'tests/helpers.retest.ts': `import { exec, spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@rehearsal-labs/retest'

const folder = ${JSON.stringify(folder)}
const helper = fileURLToPath(new URL('../helper.cjs', import.meta.url))

async function pidOf(file: string): Promise<number> {
  while (!existsSync(file)) await delay(25)
  await delay(25)
  return Number(readFileSync(file, 'utf8'))
}

function running(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

test('starts helpers of its own and opens a page', async ({ page }) => {
  const shell = exec(\`"\${process.execPath}" "\${helper}" "\${join(folder, 'via-shell.pid')}"\`)
  const detached = spawn(process.execPath, [helper, join(folder, 'detached.pid')], { stdio: 'ignore', detached: true })
  detached.unref()
  const helpers = { testFile: process.pid, viaShell: await pidOf(join(folder, 'via-shell.pid')), detached: await pidOf(join(folder, 'detached.pid')) }
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'held' })).toBeVisible()
  writeFileSync(${JSON.stringify(report)}, JSON.stringify(helpers))
  if (${JSON.stringify(mode)} === 'wait') await new Promise(() => {})
  if (${JSON.stringify(mode)} === 'clean') {
    for (const pid of [helpers.viaShell, helpers.detached]) process.kill(pid)
    shell.kill()
    for (const pid of [helpers.viaShell, helpers.detached]) {
      while (running(pid)) await delay(25)
    }
  }
})
`,
  })
  return { root, report }
}

async function helpersOf(file: string, timeoutMs: number): Promise<Helpers> {
  const end = performance.now() + timeoutMs
  while (!existsSync(file)) {
    assert.ok(performance.now() < end, 'the test started its helpers and opened its page')
    await delay(50)
  }
  await delay(50)
  return JSON.parse(readFileSync(file, 'utf8'))
}

function startCli(t: TestContext, root: string, mode: Mode): Promise<StartedRun> {
  return startRun(t, { cwd: root, browser: false, files: ['tests/helpers.retest.ts'], timeouts: budgets({ test: mode === 'wait' ? 120_000 : 30_000 }) })
}

describe('a Windows run', { skip: jobs || noBrowser }, () => {
  test('ended outright leaves nothing it started: no test file process, helper, server, shell, browser or supervisor', { timeout: 180_000 }, async (t) => {
    const left = leftovers(t)
    const folder = left.folder('windows-kill-')
    const supervisor = reader()
    const { root, report } = await project(t, folder, 'wait')
    const started = await startCli(t, root, 'wait')
    const helpers = await helpersOf(report, 90_000)
    const held = started.retest.heldNow()
    const pids = new Set(held.map((entry) => entry.pid))
    t.diagnostic(`the run held ${held.length} processes: ${named(held).join(', ')}`)
    for (const [what, pid] of Object.entries(helpers)) assert.ok(pids.has(pid), `the run holds the ${what} process ${pid}`)
    assert.ok(held.some((entry) => entry.image?.toLowerCase().endsWith('cmd.exe') === true), "the run holds the app server's shell")
    assert.ok(held.filter((entry) => entry.image?.toLowerCase().endsWith('node.exe') === true).length >= 6, 'the run holds the CLI, its test file process, the server, its helper and the test helpers')
    const exited = started.retest.exited
    // As `taskkill /F` does, Windows ends the CLI without letting it clean up after itself.
    execFileSync('taskkill.exe', ['/F', '/PID', String(started.retest.pid)], { stdio: 'ignore' })
    await exited
    assert.deepEqual(named(await allGoneWithin(supervisor, held, 10_000)), [], 'nothing the run started is still running')
  })

  test('a run whose test ends its own helpers names nothing, and leaves nothing', { timeout: 180_000 }, async (t) => {
    const left = leftovers(t)
    const folder = left.folder('windows-clean-')
    const { root, report } = await project(t, folder, 'clean')
    const started = await startCli(t, root, 'clean')
    const run = await finishRun(started)
    assert.ok(existsSync(report))
    assert.equal(run.result?.status, 'passed', JSON.stringify(run.result?.failure))
    assert.equal(run.result?.failure, undefined)
    const atRunEnd = started.retest.heldAtRunEnd
    t.diagnostic(`as the run printed its end the CLI was ${atRunEnd?.commandRunning === true ? 'still running' : 'already gone'}; it held ${atRunEnd === undefined ? 'nothing read' : named(atRunEnd.others).join(', ') || 'nothing else'}`)
    assert.equal(atRunEnd?.commandRunning, true, "the CLI's job was read before the CLI ended")
  })

  test('a helper a test leaves running is named as the run ends, and ended with the CLI', { timeout: 180_000 }, async (t) => {
    const left = leftovers(t)
    const folder = left.folder('windows-leave-')
    const supervisor = reader()
    const { root, report } = await project(t, folder, 'leave')
    const started = await startCli(t, root, 'leave')
    const helpers = await helpersOf(report, 90_000)
    const run = await readFinishedRun(started)
    const failure = JSON.stringify(run.result?.failure ?? null)
    t.diagnostic(`the run's failure: ${failure}`)
    assert.match(failure, new RegExp(`Process ${helpers.detached} \\(node\\.exe\\) is still running at the end of the run\\. Retest ends it when Retest exits\\.`), 'the detached helper is named')
    const viaShell = supervisor.process(helpers.viaShell).process
    t.diagnostic(`the helper started through a shell was ${viaShell === undefined ? 'gone' : 'still running'} once its test file process had ended; the run ${failure.includes(`Process ${helpers.viaShell} `) ? 'named' : 'did not name'} it`)
    await started.retest.exited
    const end = performance.now() + 10_000
    while (supervisor.process(helpers.detached).process !== undefined && performance.now() < end) await delay(50)
    assert.equal(supervisor.process(helpers.detached).process, undefined, 'the detached helper ended with the CLI')
    assert.deepEqual(named(started.retest.heldNow().filter((entry) => !consoleHost(entry))), [], 'nothing the run started is left')
  })

  test('given Ctrl+C stops as a person stopping it would, exits 130 and leaves nothing it started', { timeout: 180_000 }, async (t) => {
    const left = leftovers(t)
    const folder = left.folder('windows-ctrl-c-')
    const supervisor = reader()
    const { root, report } = await project(t, folder, 'wait')
    const output = join(folder, 'run')
    const events = join(folder, 'events.jsonl')
    const exitFile = join(folder, 'exit.txt')
    const [executable = process.execPath, ...leading] = sourceCommand
    const args = [...leading, 'run', 'tests/helpers.retest.ts', '--reporter', 'jsonl', '--output', output, '--timeouts', budgets({ test: 120_000 })]
    // The CLI needs a console of its own, so Ctrl+C reaches nothing of this test's, and Ctrl+C turned on: a process
    // started from a service, as an SSH session or a CI step is, inherits it turned off. A PowerShell turns it on for
    // itself and starts the CLI in a new console, which inherits that; this test holds the PowerShell in a job, and so
    // every process the CLI starts.
    const quoted = (text: string): string => `'"${text.replaceAll("'", "''")}"'`
    const launcher = `${consoleCalls}
[RetestConsole]::SetConsoleCtrlHandler([IntPtr]::Zero, $false) | Out-Null
$cli = Start-Process -FilePath ${quoted(executable)} -ArgumentList @(${args.map(quoted).join(', ')}) -WorkingDirectory '${root.replaceAll("'", "''")}' -RedirectStandardOutput '${events.replaceAll("'", "''")}' -PassThru
# A process object reads its exit code only through a handle it took while the process ran.
$null = $cli.Handle
$cli.WaitForExit()
Set-Content -LiteralPath '${exitFile.replaceAll("'", "''")}' -Value $cli.ExitCode`
    prepareOwnedLaunch()
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', launcher], { stdio: 'ignore' })
    await once(child, 'spawn')
    const launch = holdLaunch(child)
    assert.deepEqual(launch.capture(), [])
    const job = heldLaunches()?.launchOf(child.pid ?? 0)?.job
    assert.ok(job !== undefined)
    left.process(() => { launch.signal('SIGKILL') })
    const helpers = await helpersOf(report, 90_000)
    const held = supervisor.members(job)
    const cli = held.find((entry) => entry.parentPid === child.pid && entry.image?.toLowerCase().endsWith('node.exe') === true)
    assert.ok(cli !== undefined, `the PowerShell started the CLI: ${named(held).join(', ')}`)
    for (const [what, pid] of Object.entries(helpers)) assert.ok(held.some((entry) => entry.pid === pid), `the run holds the ${what} process ${pid}`)
    const sent = await sendCtrlC(cli.pid, new Set(held.map((entry) => entry.pid)))
    t.diagnostic(sent.output.trim())
    assert.equal(sent.code, 0, `Ctrl+C was sent to the CLI's console: ${sent.output}`)
    await settled(() => existsSync(exitFile), 60_000)
    assert.equal(readFileSync(exitFile, 'utf8').trim(), '130', 'the CLI exits 130, as an interrupted run does')
    assert.deepEqual(named(await allGoneWithin(supervisor, held.filter((entry) => entry.pid !== child.pid), 15_000)), [], 'nothing the run started is still running')
    const printed = readFileSync(events, 'utf8')
    assert.match(printed, /"type":"run\.finished"/, 'the CLI ended its run itself')
    writeFileSync(join(folder, 'seen.txt'), named(held).join('\n'))
  })

  test('holding an install lock and killed outright leaves the lock free for the next install', { timeout: 60_000 }, async (t) => {
    const lock = join(leftovers(t).folder('windows-lock-'), 'locks', 'stand-in-1.0.0-win-x64.lock')
    const holder = await holdLockInChild(lock)
    const refused = await takeInstallLock(lock)
    assert.match(refused.ok ? '' : refused.message, new RegExp(`^Another Retest process \\(pid ${holder.pid}, `))
    await holder.kill()
    const taken = await takeInstallLock(lock)
    assert.ok(taken.ok, taken.ok ? '' : taken.message)
    assert.equal(await taken.release(), undefined)
  })

  test('holds a browser and the helpers it starts before it is held, measured over ten launches', { timeout: 120_000, skip: browser() === undefined ? 'no Chromium is named by RETEST_TEST_BROWSER and Edge is not installed' : false }, async (t) => {
    const executable = browser() ?? assert.fail('a browser')
    const left = leftovers(t)
    const supervisor = new Supervisor(locateSupervisor(process.env))
    supervisor.hold()
    const windows: number[] = []
    const late: number[] = []
    const byParent: number[] = []
    for (let round = 0; round < 10; round += 1) {
      const folder = left.folder('windows-window-')
      const started = performance.now()
      const child = spawn(executable, ['--headless=new', '--remote-debugging-pipe', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${join(folder, 'profile')}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'], detached: true })
      await once(child, 'spawn')
      left.process(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') })
      const launch = supervisor.adopt(child.pid ?? 0)
      windows.push(Math.round(performance.now() - started))
      late.push(launch.late.length)
      byParent.push(launch.byParent.length)
      assert.deepEqual(launch.unheld, [], 'every helper born before the hold was held')
      assert.ok(launch.complete, 'the search for helpers born before the hold finished')
      await delay(500)
      const members = supervisor.members(launch.job)
      assert.ok(members.length > 1, 'the browser started helpers inside its job')
      for (const entry of launch.late) assert.ok(members.some((member) => member.pid === entry.pid) || !stillRunning(supervisor, entry), `the helper ${entry.pid}, born before the hold, is in the browser's job`)
      const exited = once(child, 'exit')
      supervisor.end(launch.job)
      await exited
      const end = performance.now() + 5000
      while (supervisor.members(launch.job).length > 0) {
        assert.ok(performance.now() < end, 'the job emptied after its end')
        await delay(25)
      }
      // A helper the browser had put in a job of its own ends with the browser's handle on that job.
      assert.deepEqual(await allGoneWithin(supervisor, launch.byParent, 5000), [], 'every helper held by its parent ended with the browser')
      supervisor.release(launch.job, launch.handle)
      assert.deepEqual(supervisor.strays().map((entry) => `${entry.pid} ${entry.image ?? ''}`), [], 'the runner job holds nothing the browser left')
    }
    const sorted = [...windows].sort((first, second) => first - second)
    t.diagnostic(`spawn to held, ms: ${windows.join(' ')}; median ${sorted[5]}, slowest ${sorted[9]}; helpers born before the hold, per launch: ${late.join(' ')}; held by their parent: ${byParent.join(' ')}`)
  })
})

// A PowerShell that leaves its own console, joins the runner's, ignores Ctrl+C itself and sends it to every process
// of that console, which is the runner and what it started attached. Ctrl+C reaches a whole console, so it is sent
// only once the console is shown to hold the runner and no process but those it started: never this test, nor
// anything it shares a console with.
async function sendCtrlC(pid: number, allowed: ReadonlySet<number>): Promise<{ code: number | null; output: string }> {
  const script = `${consoleCalls}
[RetestConsole]::FreeConsole() | Out-Null
if (-not [RetestConsole]::AttachConsole(${pid})) { exit 3 }
$ids = New-Object 'uint32[]' 256
$count = [RetestConsole]::GetConsoleProcessList($ids, 256)
$held = @($ids[0..($count - 1)])
Write-Output "console holds $($held -join ' ')"
if ($held -notcontains ${pid}) { exit 6 }
$allowed = @(${[...allowed].join(', ')}, $PID)
foreach ($id in $held) { if ($allowed -notcontains $id) { exit 5 } }
[RetestConsole]::SetConsoleCtrlHandler([IntPtr]::Zero, $true) | Out-Null
if (-not [RetestConsole]::GenerateConsoleCtrlEvent(0, 0)) { exit 4 }
Start-Sleep -Milliseconds 500
exit 0
`
  const sender = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  sender.stdout.setEncoding('utf8').on('data', (text: string) => { output += text })
  sender.stderr.setEncoding('utf8').on('data', (text: string) => { output += text })
  const [code] = await once(sender, 'exit')
  return { code: typeof code === 'number' ? code : null, output }
}
