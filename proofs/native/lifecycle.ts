/**
 * Runs Retest's own native lifecycle, `src/native`, on the real targets once and keeps what it captured: the TaskPhone
 * fixture on a simulator the runtime creates, and the TaskDesk fixture through the desktop's macOS runner. For each it
 * starts the executor from the pinned build, installs where the platform installs, launches with the fixture service's
 * address, reads the state, captures with the session id, reads the scoped tree, terminates and closes, then checks
 * what is left. It also records the interfaces each executor listens on.
 *
 *   node --conditions=retest-source proofs/native/lifecycle.ts [--only ios|macos]
 *
 * The macOS half takes the desktop; run it under the heavy gate lock. Exit 0 when every step passed, 1 otherwise.
 * Artifacts go under ~/Library/Caches/retest-proofs/artifacts/lifecycle/<run>/.
 */
import type { ExecutorName } from '../../src/native/executors.ts'
import type { NativeAppSession, NativeCapture } from '../../src/native/session.ts'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { CLIENT_HEADER } from '../../fixtures/cross-platform/service/clients.ts'
import { startTaskService } from '../../fixtures/cross-platform/service/task-service.ts'
import { ensureExecutorBuild } from '../../src/native/executors.ts'
import { IosSimulatorRuntime, listSimulators } from '../../src/native/ios-simulator.ts'
import { MacosDesktop } from '../../src/native/macos-app.ts'
import { decodePng, distinctColours } from '../../src/native/png.ts'
import { listProcesses, runCommand, systemTools } from '../../src/native/processes.ts'
import { describeResetPolicy, iosSimulatorResetPolicy, macosResetPolicy } from '../../src/native/reset-policy.ts'
import { CACHE_ROOT, ProofRecord, StepStopped } from './shared/evidence.ts'

const { values } = parseArgs({ options: { only: { type: 'string' } } })
const stamp = new Date().toISOString().replace(/\.\d+Z$/, 'Z').replaceAll(':', '-')
const artifacts = join(CACHE_ROOT, 'artifacts', 'lifecycle', stamp)
const sources: Record<ExecutorName, string> = { webdriveragent: join(CACHE_ROOT, 'WebDriverAgent'), mac2: join(CACHE_ROOT, 'appium-mac2-driver') }
const taskPhone = join(CACHE_ROOT, 'derived', 'taskphone', 'Build', 'Products', 'Debug-iphonesimulator', 'TaskPhone.app')
const taskDesk = join(CACHE_ROOT, 'derived', 'taskdesk', 'Build', 'Products', 'Debug', 'TaskDesk.app')
await mkdir(artifacts, { recursive: true })
const logs = await mkdtemp(join(tmpdir(), 'retest-native-lifecycle-'))
const record = new ProofRecord("Retest's native lifecycle on the real simulator and the real macOS runner")
record.facts['artifacts'] = artifacts
record.facts['resetPolicy'] = { 'ios-simulator': describeResetPolicy(iosSimulatorResetPolicy), macos: describeResetPolicy(macosResetPolicy) }
const service = await startTaskService({ port: 0, syncDelayMs: 100 })
await fetch(new URL('/admin/reset', service.url), { method: 'POST', headers: { [CLIENT_HEADER]: 'test' } })

// What a process listens on, as lsof names it; `*` means every interface.
async function listening(pid: number): Promise<string[]> {
  const result = await runCommand('/usr/sbin/lsof', ['-nP', '-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN'], { timeoutMs: 10_000 })
  return result.stdout.split('\n').slice(1).flatMap((line) => /(\S+:\d+) \(LISTEN\)/.exec(line)?.slice(1, 2) ?? [])
}

async function keepCapture(session: NativeAppSession, source: 'executor-screen' | 'simulator-display', note: (fact: string) => void): Promise<void> {
  const shot = await session.capture(30_000, { source })
  if (!shot.ok) throw new Error(shot.failure.message)
  await saveCapture(shot.capture, note)
}

async function saveCapture(capture: NativeCapture, note: (fact: string) => void): Promise<void> {
  const { reference, source } = capture
  const path = join(artifacts, `${reference.sessionId.replace(':', '-')}-launch${reference.generation}-${reference.observationId}-${source}.png`)
  await writeFile(path, capture.png)
  record.artifact(path)
  note(`${source} ${capture.width}x${capture.height}, ${distinctColours(decodePng(capture.png))} colours, reference ${JSON.stringify(reference)}`)
}

async function keepTree(session: NativeAppSession, name: string, note: (fact: string) => void): Promise<void> {
  const tree = await session.readSource(30_000)
  if (!tree.ok) throw new Error(tree.failure.message)
  const path = join(artifacts, name)
  await writeFile(path, tree.tree.source.xml)
  record.artifact(path)
  note(`${tree.tree.source.elements} elements kept, ${tree.tree.source.hashedMenuElements} under a menu hashed, root ${tree.tree.source.xml.slice(0, tree.tree.source.xml.indexOf(' '))}`)
}

try {
  if (values.only !== 'macos') {
    const build = await record.step('find the pinned WebDriverAgent', async (note) => {
      const ensured = await ensureExecutorBuild({ executor: 'webdriveragent', sources, logFile: join(logs, 'wda-build.log'), timeoutMs: 30 * 60_000, tools: systemTools })
      if (!ensured.ok) throw new Error(ensured.failure.message)
      note(`${ensured.action}, ${ensured.build.origin}, products ${ensured.build.productsSha256.slice(0, 16)}`)
      return ensured.build
    })
    const runtime = await record.step('start an iOS simulator runtime for TaskPhone', async (note) => {
      const started = await IosSimulatorRuntime.start({ target: { appPath: taskPhone, device: 'iPhone 17', runtime: '26.5' }, build, tools: systemTools, logFolder: logs, timeoutMs: 600_000 })
      if (!started.ok) throw new Error(started.failure.message)
      record.facts['ios'] = { execution: started.runtime.execution, identity: { ...started.runtime.identity, processIds: [...started.runtime.identity.processIds] } }
      note(`simulator ${started.runtime.udid}, WebDriverAgent on 127.0.0.1:${started.runtime.port}`)
      return started.runtime
    })
    try {
      await record.step("read what WebDriverAgent's runner app listens on", async (note) => {
        const runnerApp = runtime.identity.processIds[1]
        if (runnerApp === undefined) throw new Error('no runner app pid')
        const addresses = await listening(runnerApp)
        record.facts['iosListening'] = addresses
        note(addresses.join(', '))
      })
      const opened = await record.step('open a session', async (note) => {
        const session = await runtime.openSession({ owner: { runId: stamp, testId: 'lifecycle', attemptId: 'proof', app: 'phone' }, launch: { arguments: ['-reset', '-serviceURL', service.url], environment: {} }, redact: (text) => text }, 30_000)
        if (!session.ok) throw new Error(session.failure.message)
        note(session.session.sessionId)
        return session.session
      })
      await record.step('install, launch and read the state', async (note) => {
        const installed = await opened.install({ appPath: taskPhone }, 120_000)
        const launched = await opened.launch(120_000)
        const state = await opened.appState(10_000)
        note(`install ${JSON.stringify(installed)}, launch ${JSON.stringify(launched)}, state ${JSON.stringify(state)}, pids ${opened.processIds.join(', ')}`)
        if (!installed.result.ok || !launched.result.ok || !state.ok || state.state !== 'foreground') throw new Error('the app is not in the foreground')
      })
      await record.step('capture through WebDriverAgent and through simctl', async (note) => {
        await keepCapture(opened, 'executor-screen', note)
        await keepCapture(opened, 'simulator-display', note)
      })
      await record.step('read the scoped tree', (note) => keepTree(opened, 'taskphone-tree.xml', note))
      await record.step('terminate and dispose', async (note) => {
        const terminated = await opened.terminate(60_000)
        const state = await opened.appState(10_000)
        await opened.dispose(30_000)
        note(`terminate ${JSON.stringify(terminated)}, state ${JSON.stringify(state)}`)
        if (!state.ok || state.state !== 'not_running') throw new Error('the app still runs')
      })
    } finally {
      await record.cleanup('close the runtime and check nothing is left', async (note) => {
        await runtime.close(180_000)
        const listed = await listSimulators(systemTools, { timeoutMs: 30_000 })
        const left = (await listProcesses(systemTools, 10_000)).filter((entry) => entry.command.includes(`/Devices/${runtime.udid}/`))
        note(`simulator ${Array.isArray(listed) && listed.some((device) => device.udid === runtime.udid) ? 'still listed' : 'deleted'}, ${left.length} process(es) of it left`)
        if (left.length > 0) throw new Error('something of the simulator is left')
      })
    }
  }
  if (values.only !== 'ios') {
    const build = await record.step('find the pinned macOS runner', async (note) => {
      const ensured = await ensureExecutorBuild({ executor: 'mac2', sources, adoptFrom: [join(CACHE_ROOT, 'derived', 'mac2')], logFile: join(logs, 'mac2-build.log'), timeoutMs: 30 * 60_000, tools: systemTools })
      if (!ensured.ok) throw new Error(ensured.failure.message)
      note(`${ensured.action}, ${ensured.build.origin}, code directory hash ${ensured.build.codeDirectoryHash ?? 'unread'}`)
      return ensured.build
    })
    const desktop = await record.step("start the desktop's macOS runner", async (note) => {
      const started = await MacosDesktop.start({ build, tools: systemTools, logFolder: logs, timeoutMs: 180_000 })
      if (!started.ok) throw new Error(started.failure.message)
      note(`runner on 127.0.0.1:${started.desktop.port}, pids ${started.desktop.processIds.join(', ')}, ${started.desktop.os.name} ${started.desktop.os.version} (${started.desktop.os.build})`)
      return started.desktop
    })
    try {
      await record.step('read what the runner app listens on', async (note) => {
        const runnerApp = desktop.processIds[1]
        if (runnerApp === undefined) throw new Error('no runner app pid')
        const addresses = await listening(runnerApp)
        record.facts['macosListening'] = addresses
        note(addresses.join(', '))
      })
      const opened = await record.step('open TaskDesk and a session', async (note) => {
        const app = await desktop.openApp(taskDesk)
        if (!app.ok) throw new Error(app.failure.message)
        record.facts['macos'] = { execution: app.runtime.execution, identity: { ...app.runtime.identity, processIds: [...app.runtime.identity.processIds] } }
        const session = await app.runtime.openSession({ owner: { runId: stamp, testId: 'lifecycle', attemptId: 'proof', app: 'desk' }, launch: { arguments: ['-reset', '-serviceURL', service.url], environment: {} }, redact: (text) => text }, 30_000)
        if (!session.ok) throw new Error(session.failure.message)
        note(session.session.sessionId)
        return session.session
      })
      await record.step('launch at its path, activate and read the state', async (note) => {
        const launched = await opened.launch(60_000)
        const activated = await opened.activate(10_000)
        const state = await opened.appState(10_000)
        note(`launch ${JSON.stringify(launched)}, activate ${JSON.stringify(activated)}, state ${JSON.stringify(state)}, pids ${opened.processIds.join(', ')}`)
        if (!launched.result.ok || !state.ok || state.state !== 'foreground') throw new Error('TaskDesk is not in the foreground')
      })
      await record.step('wait for the window in the scoped tree', async (note) => {
        let last = 'no look yet'
        for (let looks = 1; looks <= 50; looks += 1) {
          const tree = await opened.readSource(10_000)
          if (tree.ok && tree.tree.source.window !== undefined) {
            note(`window ${JSON.stringify(tree.tree.source.window)} after ${looks} look(s)`)
            return
          }
          last = tree.ok ? 'a tree with no window' : tree.failure.message
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
        const state = await opened.appState(10_000)
        throw new Error(`TaskDesk's window did not appear in its tree within 5 s; the last look said: ${last}; the state is ${JSON.stringify(state)}`)
      })
      // A capture is taken only while nothing of another process lies over the window; a refusal says so by name.
      await record.step("capture TaskDesk's window, or be refused by name", async (note) => {
        const shot = await opened.capture(30_000)
        if (shot.ok) return saveCapture(shot.capture, note)
        if (!/window\(s\) of other processes lie over the app's window/.test(shot.failure.message)) throw new Error(shot.failure.message)
        record.facts['macosCaptureRefused'] = shot.failure.message
        note(`refused: ${shot.failure.message}`)
      })
      await record.step('read the scoped tree', (note) => keepTree(opened, 'taskdesk-window.xml', note))
      await record.step('terminate and dispose', async (note) => {
        const terminated = await opened.terminate(60_000)
        const state = await opened.appState(10_000)
        await opened.dispose(30_000)
        note(`terminate ${JSON.stringify(terminated)}, state ${JSON.stringify(state)}`)
        if (!state.ok || state.state !== 'not_running') throw new Error('TaskDesk still runs')
      })
    } finally {
      await record.cleanup('close the runner and check nothing is left', async (note) => {
        await desktop.close(60_000)
        const left = (await listProcesses(systemTools, 10_000)).filter((entry) => entry.command.includes('WebDriverAgentRunner-Runner.app/Contents/MacOS') || entry.command.includes('/TaskDesk.app/Contents/MacOS/'))
        note(`${left.length} runner or TaskDesk process(es) left`)
        if (left.length > 0) throw new Error('something is left')
      })
    }
  }
} catch (error) {
  if (!(error instanceof StepStopped)) record.facts['unexpectedError'] = error instanceof Error ? error.message : String(error)
} finally {
  await service.close()
  await rm(logs, { recursive: true, force: true })
}
await record.finish(artifacts)
process.exitCode = record.exitCode
