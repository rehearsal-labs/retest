import type { TestContext } from 'node:test'
import type { OwnedProcessIdentity } from '../../src/shared/process-ownership.ts'
import type { StandInConfig } from './firefox-stand-in.ts'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { ProcessLaunchError } from '../../src/browser/chromium-process.ts'
import { closeGraceMs, LaunchError } from '../../src/browser/contract.ts'
import { launchFirefox } from '../../src/browser/firefox/launch.ts'
import { FirefoxProcess, firefoxArguments } from '../../src/browser/firefox/process.ts'
import { isRunning, readProcessIdentity, readProcessTableAsync } from '../../src/browser/firefox/process-table.ts'
import { createFirefoxFolder, firefoxFolderPrefix, ownerRecordFile, readOwnerRecord } from '../../src/browser/firefox/profile.ts'
import { Deadline } from '../../src/protocol/deadline.ts'
import { sameProcessIdentity, unverifiedMembersProblem } from '../../src/shared/process-ownership.ts'
import { useMetadataWorkerModule } from '../../src/shared/metadata-process.ts'
import { endedInOrder, readCommands, readHelpers, readListening, readStart, warmUp, writeStandIn } from './firefox-stand-in.ts'

// Review F-4: the spawn route, the default way Retest starts Firefox, had never started a process anywhere. This Mac's
// host app may not read Firefox's data folder, so a real Firefox spawned here never starts, and no test called the
// route's process code. Here the real launch, ownership, close and failure paths spawn a stand-in executable that
// speaks enough WebDriver BiDi to be launched, owned and ended (`firefox-stand-in.ts`). Every process a stand-in
// starts names its case folder in its command line, so each case can show it left nothing, and the cleanup after each
// case ends whatever it did leave, by that mark, and says so.

type StandInCase = {
  /** The case's own folder, a fresh temporary one whose path no other process names. */
  folder: string
  executable: string
  reports: string
  /** The folder the launches are made in, `folderRoot`. */
  root: string
  logFile: string
}

const cases: StandInCase[] = []
const leftovers: string[] = []
const hiddenVariable = 'RETEST_STAND_IN_HIDDEN'
const keptVariable = 'RETEST_STAND_IN_KEPT'
const caseTimeout = { timeout: 30_000 }

async function standIn(t: TestContext, choices: Partial<Omit<StandInConfig, 'reports'>> & Pick<StandInConfig, 'behaviour'>): Promise<StandInCase> {
  const folder = await mkdtemp(join(await realpath(tmpdir()), 'retest-spawn-stand-in-'))
  const reports = join(folder, 'reports')
  const root = join(folder, 'launches')
  await mkdir(reports)
  await mkdir(root)
  const config: StandInConfig = { stdout: '', stderr: '', closeOutput: '', exitCode: 0, helpers: 0, watchedVariables: [], lifetimeMs: 60_000, ...choices, reports }
  const entry = { folder, executable: await writeStandIn(folder, config), reports, root, logFile: join(folder, 'browser.log') }
  cases.push(entry)
  t.after(() => endLeftovers(entry))
  return entry
}

/** The running processes of a case: those whose command line names its folder. */
async function processesOf(entry: StandInCase): Promise<OwnedProcessIdentity[]> {
  return (await readProcessTableAsync()).filter((listed) => isRunning(listed) && listed.command.includes(entry.folder))
}

/** Every pid the case's stand-in reported, the stand-in and its helpers. */
async function reportedPids(entry: StandInCase): Promise<number[]> {
  const start = await readStart(entry.reports).catch(() => undefined)
  return [...(start === undefined ? [] : [start.pid]), ...(await readHelpers(entry.reports)).map((helper) => helper.pid)]
}

/** Nothing of the case runs: no process names its folder, and no reported pid is running as one of them. */
async function assertNothingLeft(entry: StandInCase): Promise<void> {
  const running = await processesOf(entry)
  assert.deepEqual(running.map(describe), [], 'no process of the stand-in is left')
  const pids = await reportedPids(entry)
  assert.ok(pids.length > 0, 'the stand-in reported its pid')
  for (const pid of pids) assert.equal(running.some((listed) => listed.pid === pid), false, `${pid} is gone`)
}

// Ends what a case left, by the folder its command line names, which only this case's processes name, and keeps a note
// of it so the file fails even when the case did not see it.
async function endLeftovers(entry: StandInCase): Promise<void> {
  for (const leftover of await processesOf(entry)) {
    leftovers.push(describe(leftover))
    const current = readProcessIdentity(leftover.pid)
    if (current === undefined || !isRunning(current) || !sameProcessIdentity(leftover, current)) continue
    try {
      process.kill(leftover.pid, 'SIGKILL')
    } catch {
      // Gone between the reading and the signal.
    }
  }
  for (let look = 0; look < 50 && (await processesOf(entry)).length > 0; look += 1) await delay(40)
  await rm(entry.folder, { recursive: true, force: true, maxRetries: 3 })
}

after(async () => {
  const survivors = (await Promise.all(cases.map(processesOf))).flat()
  assert.deepEqual(survivors.map(describe), [], 'no stand-in or helper outlives the file')
  assert.deepEqual(leftovers, [], 'every case ended what it started without the cleanup after it')
})

function describe(listed: OwnedProcessIdentity): string {
  return `${listed.pid} ${listed.command}`
}

/** The one launch folder in the case's root. */
async function launchFolder(entry: StandInCase): Promise<string> {
  const names = await readdir(entry.root)
  assert.equal(names.length, 1, `one launch folder: ${names.join(', ')}`)
  const [name = ''] = names
  assert.ok(name.startsWith(`${firefoxFolderPrefix}${process.pid}-`), `${name} is named after this process`)
  return join(entry.root, name)
}

async function failedLaunch(entry: StandInCase, choices: { timeoutMs?: number; redact?: (text: string) => string } = {}): Promise<unknown> {
  const options = { executablePath: entry.executable, logFile: entry.logFile, headless: true, folderRoot: entry.root, route: 'spawn' as const, ...(choices.redact === undefined ? {} : { redact: choices.redact }) }
  return (choices.timeoutMs === undefined ? launchFirefox(options) : launchFirefox(options, choices.timeoutMs)).then(
    async (browser) => {
      await browser.close(5000).catch(() => undefined)
      return undefined
    },
    (error: unknown) => error,
  )
}

/** Ends a helper the launch left alone, by its reported pid, once a fresh reading shows it still names the case folder. */
async function endHelper(entry: StandInCase, pid: number): Promise<void> {
  const recorded = (await processesOf(entry)).find((listed) => listed.pid === pid)
  if (recorded === undefined) return
  const current = readProcessIdentity(pid)
  if (current === undefined || !isRunning(current) || !sameProcessIdentity(recorded, current)) return
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // Gone between the reading and the signal.
  }
  for (let look = 0; look < 50 && (await processesOf(entry)).some((listed) => listed.pid === pid); look += 1) await delay(40)
}

test('cleanup of a reported stand-in helper refuses a changed pid-start identity before signalling', async (t) => {
  const worker = new URL('./firefox-reused-table-worker.ts', import.meta.url)
  const restore = useMetadataWorkerModule(worker)
  const signalling = t.mock.method(process, 'kill', () => true)
  try {
    await endHelper({ folder: '/fixture', executable: '/fixture/firefox', reports: '/fixture/reports', root: '/fixture/launches', logFile: '/fixture/log' }, 50_000_001)
    assert.equal(signalling.mock.callCount(), 0)
  } finally {
    restore()
    signalling.mock.restore()
  }
})

test('the spawn route starts the executable as its child leading its own group, records it in the launch folder, and closes it in order', caseTimeout, async (t) => {
  const entry = await standIn(t, { behaviour: 'close-in-order', helpers: 1, stdout: 'stand-in: started\n', stderr: 'stand-in: warming up\n', closeOutput: 'stand-in: closing\n', watchedVariables: [hiddenVariable, keptVariable] })
  process.env[hiddenVariable] = 'present'
  process.env[keptVariable] = 'present'
  t.after(() => {
    delete process.env[hiddenVariable]
    delete process.env[keptVariable]
  })
  const browser = await launchFirefox({ executablePath: entry.executable, logFile: entry.logFile, headless: true, folderRoot: entry.root, route: 'spawn', hiddenVariables: [hiddenVariable] })
  t.after(() => browser.close(5000).catch(() => undefined))
  const start = await readStart(entry.reports)
  const [helper, ...otherHelpers] = await readHelpers(entry.reports)
  assert.ok(helper !== undefined)
  assert.deepEqual(otherHelpers, [])
  const listening = await readListening(entry.reports)
  const folder = await launchFolder(entry)
  const profile = join(folder, 'profile')

  // Started as Firefox is: with its arguments and its prepared profile, the crash reporter off, a hidden variable kept out.
  assert.deepEqual(start.arguments, firefoxArguments(profile, true))
  assert.equal(start.preferencesFound, true, 'the profile holds the preferences before the process starts')
  assert.equal(start.crashReporterDisabled, '1')
  assert.deepEqual(start.variablesSeen, { [hiddenVariable]: false, [keptVariable]: true })

  // The runtime drives the process it started, as the session named it.
  assert.equal(browser.pid, start.pid)
  assert.equal(browser.route, 'spawn')
  assert.equal(browser.version, '133.0.3')
  assert.equal(browser.buildId, '20241209150345')
  assert.equal(browser.executablePath, entry.executable)
  assert.deepEqual(browser.identity.processIds, [start.pid])
  assert.equal(browser.connected, true)

  // Claimed as this process's child and the leader of a group of its own, and recorded by pid, start and command line.
  const table = await readProcessTableAsync()
  const main = table.find((listed) => listed.pid === start.pid)
  const own = table.find((listed) => listed.pid === process.pid)
  const helperProcess = table.find((listed) => listed.pid === helper.pid)
  assert.ok(main !== undefined && own !== undefined && helperProcess !== undefined)
  assert.equal(start.parentPid, process.pid)
  assert.equal(main.parentPid, process.pid)
  assert.equal(main.groupId, start.pid, 'the stand-in leads its own process group')
  assert.equal(helperProcess.parentPid, start.pid)
  assert.equal(helperProcess.groupId, start.pid, 'the helper is in the stand-in group')
  assert.deepEqual(await readOwnerRecord(folder), {
    version: 1, startTimeVersion: 1,
    owner: { pid: process.pid, startedAt: own.startedAt, command: own.command },
    firefox: { pid: start.pid, startedAt: main.startedAt, command: main.command, route: 'spawn' },
    profile,
  })

  await browser.close(10_000)
  assert.deepEqual(await readCommands(entry.reports), ['session.new', 'browser.close'])
  assert.equal(endedInOrder(entry.reports), true, 'the stand-in answered browser.close and exited by itself')
  assert.equal(browser.connected, false)
  assert.equal(existsSync(folder), false, 'the launch folder is removed')
  await browser.gone
  await assertNothingLeft(entry)
  const log = await readFile(entry.logFile, 'utf8')
  for (const line of [`[retest] started Firefox ${start.pid} by the spawn route`, `[retest] Firefox 133.0.3 build 20241209150345 answered at ws://${listening.host}:${listening.port}`, 'stand-in: started', 'stand-in: warming up', 'stand-in helper-1 started', 'stand-in: closing']) {
    assert.ok(log.includes(`${line}\n`), `the log holds "${line}"`)
  }
})

test('a stand-in that never answers browser.close is ended after the grace, with the helper it started', caseTimeout, async (t) => {
  const entry = await standIn(t, { behaviour: 'ignore-close', helpers: 1 })
  const browser = await launchFirefox({ executablePath: entry.executable, logFile: entry.logFile, headless: true, folderRoot: entry.root, route: 'spawn' })
  t.after(() => browser.close(5000).catch(() => undefined))
  const start = await readStart(entry.reports)
  const [helper] = await readHelpers(entry.reports)
  assert.ok(helper !== undefined)
  const folder = await launchFolder(entry)
  const running = await processesOf(entry)
  assert.deepEqual(running.map((listed) => listed.pid).sort(), [start.pid, helper.pid].sort(), 'both run before the close')

  const closing = performance.now()
  await browser.close(10_000)
  const elapsed = performance.now() - closing
  assert.deepEqual(await readCommands(entry.reports), ['session.new', 'browser.close'])
  assert.equal(endedInOrder(entry.reports), false, 'the stand-in did not end by itself')
  assert.ok(elapsed >= closeGraceMs, `the close waited for an answer and the grace before ending the group: ${Math.round(elapsed)} ms`)
  assert.equal(existsSync(folder), false, 'the launch folder is removed')
  await browser.gone
  await assertNothingLeft(entry)
})

test('a stand-in that closes the connection instead of answering browser.close is closed, its folder removed and nothing left', caseTimeout, async (t) => {
  const entry = await standIn(t, { behaviour: 'close-without-answer', helpers: 1 })
  const browser = await launchFirefox({ executablePath: entry.executable, logFile: entry.logFile, headless: true, folderRoot: entry.root, route: 'spawn' })
  t.after(() => browser.close(5000).catch(() => undefined))
  const folder = await launchFolder(entry)
  await browser.close(10_000)
  assert.deepEqual(await readCommands(entry.reports), ['session.new', 'browser.close'])
  assert.equal(endedInOrder(entry.reports), true, 'the stand-in exited by itself')
  assert.equal(existsSync(folder), false, 'the launch folder is removed')
  await browser.gone
  await assertNothingLeft(entry)
})

test('a stand-in that ends on its own while connected is reported gone, and a close afterwards removes what is left', caseTimeout, async (t) => {
  const entry = await standIn(t, { behaviour: 'crash-after-session', helpers: 1 })
  const browser = await launchFirefox({ executablePath: entry.executable, logFile: entry.logFile, headless: true, folderRoot: entry.root, route: 'spawn' })
  t.after(() => browser.close(5000).catch(() => undefined))
  const folder = await launchFolder(entry)
  const reason = await new Promise<string>((resolve) => browser.onDisconnect(resolve))
  assert.ok(['the browser process ended with exit code 9', 'the WebSocket connection was lost (code 1006)'].includes(reason), reason)
  await browser.gone
  assert.equal(browser.connected, false)
  await assert.rejects(browser.newPage({}, 2000), /the browser is gone/)
  await browser.close(10_000)
  assert.deepEqual(await readCommands(entry.reports), ['session.new'], 'nothing is sent to a browser that is gone')
  assert.equal(existsSync(folder), false, 'the launch folder is removed')
  await assertNothingLeft(entry)
})

test('stop ends the process and every helper recorded beneath it by SIGKILL once the grace passes, a helper started during the grace included', caseTimeout, async (t) => {
  const entry = await standIn(t, { behaviour: 'ignore-close', helpers: 1, lateHelperMs: 200 })
  const { folder, profile } = await createFirefoxFolder(entry.root)
  const firefox = await FirefoxProcess.start({ executable: entry.executable, route: 'spawn', headless: true, folder, profile, logFile: entry.logFile, deadline: new Deadline(10_000) })
  t.after(() => firefox.stop(0))
  const address = await firefox.waitForAddress(new Deadline(10_000))
  const listening = await readListening(entry.reports)
  assert.equal(address, `ws://${listening.host}:${listening.port}`, 'the address is the one the stand-in wrote into its profile')
  const record = await readOwnerRecord(folder)
  assert.ok(record !== undefined, 'the launch folder holds its owner record')
  assert.equal(record.firefox.pid, firefox.pid)
  assert.equal(record.firefox.route, 'spawn')
  assert.equal(record.profile, profile)

  const graceMs = 600
  const stopping = performance.now()
  const problems = await firefox.stop(graceMs)
  const elapsed = performance.now() - stopping
  assert.deepEqual(problems, [])
  assert.deepEqual(firefox.exit, { code: null, signal: 'SIGKILL' }, 'ended by the kill, not by itself')
  assert.equal(firefox.mainGone, true)
  assert.ok(elapsed >= graceMs, `nothing was signalled before the grace passed: ${Math.round(elapsed)} ms`)
  assert.deepEqual((await readHelpers(entry.reports)).map((helper) => helper.name), ['helper-1', 'late-helper'])
  assert.equal(existsSync(folder), false, 'the launch folder is removed')
  await firefox.gone()
  await assertNothingLeft(entry)
})

test('a server file read while it is still being written is read again until it is whole', caseTimeout, async (t) => {
  const entry = await standIn(t, { behaviour: 'close-in-order', halfServerFileMs: 300 })
  const browser = await launchFirefox({ executablePath: entry.executable, logFile: entry.logFile, headless: true, folderRoot: entry.root, route: 'spawn' })
  t.after(() => browser.close(5000).catch(() => undefined))
  const start = await readStart(entry.reports)
  assert.equal(browser.pid, start.pid)
  await browser.close(10_000)
  await assertNothingLeft(entry)
})

test('a launch that cannot write its owner record ends the process it started and fails by name', caseTimeout, async (t) => {
  const entry = await standIn(t, { behaviour: 'close-in-order' })
  const { folder, profile } = await createFirefoxFolder(entry.root)
  // A record half written by someone else stands in the way: the record is only ever created, never overwritten.
  await writeFile(join(folder, `${ownerRecordFile}.partial`), '')
  const failure = await FirefoxProcess.start({ executable: entry.executable, route: 'spawn', headless: true, folder, profile, logFile: entry.logFile, deadline: new Deadline(10_000) }).then(
    async (firefox) => {
      await firefox.stop(0)
      return undefined
    },
    (error: unknown) => error,
  )
  assert.ok(failure instanceof LaunchError, `a launch failure: ${String(failure)}`)
  assert.equal(failure.failure.class, 'setup_failed', failure.message)
  assert.ok(failure.message.startsWith(`Could not record the launched Firefox in ${folder}: `), failure.message)
  assert.equal(existsSync(folder), false, 'the launch folder is removed with the process')
  assert.deepEqual(await processesOf(entry), [])
})

test('a stand-in that exits before it listens fails the launch by name, its output in the log, and leaves nothing', caseTimeout, async (t) => {
  const entry = await standIn(t, { behaviour: 'exit-before-listening', exitCode: 3, stdout: 'stand-in: cannot start\n', stderr: 'stand-in: giving up\n' })
  const failure = await failedLaunch(entry)
  assert.ok(failure instanceof ProcessLaunchError, `a launch failure: ${String(failure)}`)
  assert.equal(failure.failure.class, 'setup_failed')
  assert.ok(failure.message.startsWith('Firefox started by the spawn route exited with exit code 3 before its Remote Agent listened.'), failure.message)
  assert.ok(failure.message.includes(` Its output is in ${entry.logFile}.`), failure.message)
  assert.deepEqual(await readdir(entry.root), [], 'the launch folder is removed')
  await failure.gone
  await failure.outputSettled
  await assertNothingLeft(entry)
  const start = await readStart(entry.reports)
  const log = await readFile(entry.logFile, 'utf8')
  for (const line of [`[retest] started Firefox ${start.pid} by the spawn route`, 'stand-in: cannot start', 'stand-in: giving up']) assert.ok(log.includes(`${line}\n`), `the log holds "${line}"`)
})

test('an executable the system cannot start fails the launch by name, and leaves no folder', caseTimeout, async (t) => {
  const entry = await standIn(t, { behaviour: 'exit-before-listening' })
  // An executable file whose first line names an interpreter that is not there, so starting it fails in the system.
  await writeFile(entry.executable, `#!${join(entry.folder, 'missing-interpreter')}\n`)
  await chmod(entry.executable, 0o755)
  const failure = await failedLaunch(entry)
  assert.ok(failure instanceof LaunchError, `a launch failure: ${String(failure)}`)
  assert.equal(failure.failure.class, 'setup_failed', failure.message)
  assert.ok(failure.message.startsWith(`Cannot start ${entry.executable}: `), failure.message)
  assert.deepEqual(await readdir(entry.root), [], 'the launch folder is removed')
  assert.deepEqual(await processesOf(entry), [])
})

test('an executable that ends at once fails the launch by name and leaves nothing', caseTimeout, async (t) => {
  const entry = await standIn(t, { behaviour: 'exit-before-listening' })
  // Replaced by one that ends as soon as it starts, as a binary that cannot run on this machine: usually before Retest
  // can claim it, sometimes just after, so either named failure stands.
  await writeFile(entry.executable, '#!/usr/bin/false\n')
  await chmod(entry.executable, 0o755)
  await warmUp(entry.executable)
  const failure = await failedLaunch(entry)
  assert.ok(failure instanceof LaunchError, `a launch failure: ${String(failure)}`)
  assert.equal(failure.failure.class, 'setup_failed', failure.message)
  const unclaimed = failure.message.startsWith("Could not record the launched Firefox's ownership: ")
  const exited = failure.message.startsWith('Firefox started by the spawn route exited with exit code 1 before its Remote Agent listened.')
  assert.ok(unclaimed || exited, failure.message)
  t.diagnostic(unclaimed ? 'ended before it was claimed' : 'claimed, then seen to exit')
  assert.deepEqual(await readdir(entry.root), [], 'the launch folder is removed')
  if (failure instanceof ProcessLaunchError) await failure.gone
  assert.deepEqual(await processesOf(entry), [])
})

// By design a process in the group that the launch never traced to itself is never signalled: here a helper the
// stand-in started after the launch's first reading and left running when it exited, before anything recorded it.
test('a helper the launch never traced to itself is left alone and named, and the launch folder kept while it runs', caseTimeout, async (t) => {
  const entry = await standIn(t, { behaviour: 'exit-before-listening', exitCode: 3, helpers: 1, lifetimeMs: 15_000 })
  const failure = await failedLaunch(entry)
  const start = await readStart(entry.reports)
  const [helper] = await readHelpers(entry.reports)
  assert.ok(helper !== undefined)
  const running = await processesOf(entry)
  await endHelper(entry, helper.pid)
  assert.ok(failure instanceof ProcessLaunchError, `a launch failure: ${String(failure)}`)
  assert.equal(failure.failure.class, 'cleanup_failed', failure.message)
  assert.ok(failure.message.startsWith('Firefox started by the spawn route exited with exit code 3 before its Remote Agent listened.'), failure.message)
  assert.ok(failure.message.includes(unverifiedMembersProblem(start.pid)), failure.message)
  assert.deepEqual(running.map((listed) => listed.pid), [helper.pid], 'the helper was left running, and only it')
  assert.equal((await readdir(entry.root)).length, 1, 'the launch folder is kept while a process of its group runs')
  await failure.gone
  await assertNothingLeft(entry)
})

// The same helper holds the stand-in's output when the launch redacts it, so that output never ends while it runs.
// Chromium and WebKit bound their wait for the output by closeGraceMs and say what was left; this route does not.
test('a helper the launch left alone, holding redacted output, does not hold the failed launch past its cleanup bound', caseTimeout, async (t) => {
  const entry = await standIn(t, { behaviour: 'exit-before-listening', exitCode: 3, helpers: 1, lifetimeMs: 15_000 })
  const launching = failedLaunch(entry, { redact: (text) => text })
  // No grace, then closeGraceMs for the group to go after SIGKILL and closeGraceMs for the output, with room to spare.
  const boundMs = 2 * closeGraceMs + 3000
  const startedAt = performance.now()
  const settled = await Promise.race([launching.then(() => true), delay(boundMs).then(() => false)])
  const elapsed = performance.now() - startedAt
  const [helper] = await readHelpers(entry.reports)
  assert.ok(helper !== undefined)
  await endHelper(entry, helper.pid)
  const failure = await launching
  assert.ok(failure instanceof ProcessLaunchError, `a launch failure: ${String(failure)}`)
  assert.equal(failure.failure.class, 'cleanup_failed', failure.message)
  await failure.gone
  await assertNothingLeft(entry)
  assert.ok(settled, `a failed launch returns within ${boundMs} ms while a helper holds its output; this one had not returned after ${Math.round(elapsed)} ms, and returned only once the test ended the helper`)
})

test('a stand-in that never listens fails the launch at its deadline and is ended with its helper', caseTimeout, async (t) => {
  const entry = await standIn(t, { behaviour: 'never-listen', helpers: 1 })
  const failure = await failedLaunch(entry, { timeoutMs: 1500 })
  assert.ok(failure instanceof ProcessLaunchError, `a launch failure: ${String(failure)}`)
  assert.equal(failure.failure.class, 'setup_failed', failure.message)
  assert.ok(failure.message.startsWith('Firefox started by the spawn route did not start its Remote Agent within 1500 ms.'), failure.message)
  assert.deepEqual(await readdir(entry.root), [], 'the launch folder is removed')
  await failure.gone
  assert.equal((await readHelpers(entry.reports)).length, 1)
  await assertNothingLeft(entry)
})

test('a stand-in whose session names another process is refused, and ended with that process', caseTimeout, async (t) => {
  const entry = await standIn(t, { behaviour: 'name-helper', helpers: 1 })
  const failure = await failedLaunch(entry)
  const start = await readStart(entry.reports)
  const [helper] = await readHelpers(entry.reports)
  const listening = await readListening(entry.reports)
  assert.ok(helper !== undefined)
  assert.ok(failure instanceof ProcessLaunchError, `a launch failure: ${String(failure)}`)
  assert.equal(failure.failure.class, 'setup_failed', failure.message)
  const expected = `The Firefox at ws://${listening.host}:${listening.port} names process ${helper.pid}, not the launched ${start.pid}, so ending ${start.pid} would not end the browser it drives.`
  assert.ok(failure.message.startsWith(expected), failure.message)
  assert.deepEqual(await readdir(entry.root), [], 'the launch folder is removed')
  await failure.gone
  await assertNothingLeft(entry)
})

test("the stand-in's output reaches the log redacted when the launch is given redact", caseTimeout, async (t) => {
  const marker = `stand-in-marker-${randomUUID()}`
  const entry = await standIn(t, { behaviour: 'close-in-order', helpers: 1, stdout: `stand-in: token ${marker}\n`, stderr: `stand-in: warning ${marker}\n`, closeOutput: `stand-in: closing with ${marker}\n` })
  const browser = await launchFirefox({ executablePath: entry.executable, logFile: entry.logFile, headless: true, folderRoot: entry.root, route: 'spawn', redact: (text) => text.replaceAll(marker, '[redacted]') })
  t.after(() => browser.close(5000).catch(() => undefined))
  const start = await readStart(entry.reports)
  await browser.close(10_000)
  await browser.outputSettled
  await assertNothingLeft(entry)
  const log = await readFile(entry.logFile, 'utf8')
  assert.equal(log.includes(marker), false, 'the marker never reaches the log')
  for (const line of [`[retest] started Firefox ${start.pid} by the spawn route`, 'stand-in: token [redacted]', 'stand-in: warning [redacted]', 'stand-in: closing with [redacted]', 'stand-in helper-1 started']) {
    assert.ok(log.includes(`${line}\n`), `the log holds "${line}"`)
  }
})

test("the stand-in's output reaches the log through a fresh stream redactor for each stream when the launch is given redactStream", caseTimeout, async (t) => {
  const marker = `stand-in-marker-${randomUUID()}`
  const entry = await standIn(t, { behaviour: 'close-in-order', stdout: `stand-in: token ${marker}\n`, closeOutput: `stand-in: closing with ${marker}\n` })
  let redactors = 0
  const redactStream = () => {
    redactors += 1
    return { write: (text: string) => text.replaceAll(marker, '[streamed]'), end: () => '' }
  }
  const browser = await launchFirefox({ executablePath: entry.executable, logFile: entry.logFile, headless: true, folderRoot: entry.root, route: 'spawn', redactStream })
  t.after(() => browser.close(5000).catch(() => undefined))
  await browser.close(10_000)
  await browser.outputSettled
  await assertNothingLeft(entry)
  const log = await readFile(entry.logFile, 'utf8')
  assert.equal(log.includes(marker), false, 'the marker never reaches the log')
  assert.ok(log.includes('stand-in: token [streamed]\n') && log.includes('stand-in: closing with [streamed]\n'), log)
  assert.ok(redactors >= 2, `one redactor for stdout and one for stderr: ${redactors}`)
})
