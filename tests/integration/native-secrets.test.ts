import type { TestContext } from 'node:test'
import type { NativeInteractionSession } from '../../src/native/interaction-session.ts'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { access, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { SEEDED_ACCOUNTS } from '../../fixtures/cross-platform/service/accounts.ts'
import { startTaskService } from '../../fixtures/cross-platform/service/task-service.ts'
import { NativeInteractionSession as Interaction } from '../../src/native/interaction-session.ts'
import { IosSimulatorRuntime, simulatorAppProcesses } from '../../src/native/ios-simulator.ts'
import { MacosDesktop, macosAppProcesses } from '../../src/native/macos-app.ts'
import { listProcesses, systemTools } from '../../src/native/processes.ts'
import { Redactor } from '../../src/runner/redactor.ts'
import { executorBuild, nativeSkipReason, proofsCache, taskDeskApp, taskPhoneApp } from './native-harness.ts'

const phoneSkip = await nativeSkipReason('ios-simulator')
const deskSkip = await nativeSkipReason('macos')

async function grepValues(paths: readonly string[], values: readonly string[]): Promise<{ readonly code: number | null; readonly matches: string[] }> {
  // Patterns enter through stdin. Neither the command line nor grep's output contains a value.
  const child = spawn('/opt/homebrew/bin/rg', ['--hidden', '--no-ignore', '-a', '-F', '-l', '-f', '-', ...paths], { stdio: ['pipe', 'pipe', 'pipe'] })
  let output = ''
  let failed = false
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => { output += chunk })
  child.stderr.on('data', () => { failed = true })
  const closed = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
  child.stdin.end(`${values.join('\n')}\n`)
  const code = await closed
  assert.equal(failed, false, 'grep could read every requested path')
  assert.ok(code === 0 || code === 1, 'grep completed its scan')
  return { code, matches: output.trim() === '' ? [] : output.trim().split('\n') }
}

async function prove(t: TestContext, platform: 'ios-simulator' | 'macos'): Promise<void> {
  const account = SEEDED_ACCOUNTS.find((entry) => entry.id === 'ada')
  assert.ok(account !== undefined)
  const value = `${randomBytes(16).toString('hex')}&private`
  const redactor = new Redactor()
  redactor.learn('native-proof', value)
  redactor.learn('password', account.password)
  const redact = (text: string): string => redactor.redact(text)
  const folder = await mkdtemp(join(tmpdir(), `retest-native-secrets-${platform}-`))
  t.diagnostic(`artifacts: ${folder}`)
  const serviceLines: string[] = []
  const service = await startTaskService({ port: 0, printLine: (line) => { serviceLines.push(line) } })
  t.after(() => service.close())
  const build = await executorBuild(platform === 'macos' ? 'mac2' : 'webdriveragent', folder)
  const owner = { runId: 'native-secrets', testId: platform, attemptId: platform, app: platform === 'macos' ? 'desk' : 'phone' }
  const options = { owner, launch: { arguments: ['-reset', '-serviceURL', service.url, ...(platform === 'macos' ? ['-windowFrame', '20,60,700,480'] : [])], environment: {} }, redact }
  let interaction: NativeInteractionSession
  let close: () => Promise<void>
  let processes: readonly number[]
  if (platform === 'ios-simulator') {
    const started = await IosSimulatorRuntime.start({ target: { appPath: taskPhoneApp, device: 'iPhone 17', runtime: '26.5' }, build, tools: systemTools, logFolder: folder, redact, timeoutMs: 180_000 })
    assert.equal(started.ok, true, started.ok ? '' : redact(started.failure.message))
    if (!started.ok) return
    const runtime = started.runtime
    close = () => runtime.close(90_000)
    t.after(close)
    processes = runtime.identity.processIds
    const opened = await runtime.openSession(options, 30_000)
    assert.equal(opened.ok, true, opened.ok ? '' : redact(opened.failure.message))
    if (!opened.ok) return
    interaction = new Interaction({ ...opened, redact, processes: (bounds) => simulatorAppProcesses(systemTools, runtime.udid, runtime.bundle.bundleId, bounds) })
    assert.equal((await interaction.install({ appPath: taskPhoneApp }, 60_000)).result.ok, true)
  } else {
    const started = await MacosDesktop.start({ build, tools: systemTools, logFolder: folder, redact, timeoutMs: 180_000 })
    assert.equal(started.ok, true, started.ok ? '' : redact(started.failure.message))
    if (!started.ok) return
    close = () => started.desktop.close(60_000)
    t.after(close)
    processes = started.desktop.processIds
    const app = await started.desktop.openApp(taskDeskApp)
    assert.equal(app.ok, true)
    if (!app.ok) return
    const opened = await app.runtime.openSession(options, 30_000)
    assert.equal(opened.ok, true, opened.ok ? '' : redact(opened.failure.message))
    if (!opened.ok) return
    interaction = new Interaction({ ...opened, redact, tools: systemTools, processes: async (bounds) => {
      const read = await macosAppProcesses(systemTools, app.runtime.bundle.bundleId, bounds)
      return read.ok ? { ok: true, running: read.processes.length > 0, pids: read.processes.map((entry) => entry.pid) } : read
    } })
  }
  t.after(() => interaction.dispose(30_000))
  const command = (await listProcesses(systemTools, 10_000)).find((entry) => entry.pid === processes[0])?.command
  assert.ok(command !== undefined)
  const derived = /-derivedDataPath (\S+)/.exec(command)?.[1]
  assert.ok(derived !== undefined && derived.includes('/retest-executor-'))
  const bundle = /-resultBundlePath (\S+)/.exec(command)?.[1]
  assert.ok(bundle !== undefined && bundle.includes('/retest-executor-'))
  assert.equal((await interaction.launch(60_000)).result.ok, true)
  const fill = async (id: string, text: string, secret?: string): Promise<void> => {
    const read = await interaction.dispatch({ kind: 'fill', locator: { by: 'testId', value: id }, value: text, ...(secret === undefined ? {} : { secret }) }, 30_000)
    assert.equal(read.result.ok, true, read.result.ok ? '' : redact(read.result.failure.message))
  }
  await fill('account-field', account.id)
  await fill('password-field', account.password, 'password')
  assert.equal((await interaction.dispatch({ kind: platform === 'macos' ? 'click' : 'tap', locator: { by: 'testId', value: 'sign-in-button' } }, 30_000)).result.ok, true)
  assert.equal((await interaction.expect({ by: 'testId', value: 'signed-in-account' }, { matcher: 'toHaveText', text: account.id }, 10_000)).passed, true)
  const field = platform === 'macos' ? 'task-id-field' : 'new-task-title-field'
  await fill(field, value, 'native-proof')
  const looked = await interaction.observe({ by: 'testId', value: field }, 10_000)
  assert.equal(looked.ok, true)
  if (looked.ok) assert.equal(looked.look.observation.value === '{{native-proof}}', true, 'the observed field contains only the run placeholder')
  const source = await interaction.session.readSource(10_000)
  assert.equal(source.ok, true)
  if (source.ok) await writeFile(join(folder, 'tree.xml'), source.tree.source.xml, { mode: 0o600 })
  await writeFile(join(folder, 'runner.log'), `${redact(JSON.stringify(interaction.inputs))}\n${serviceLines.map(redact).join('\n')}\n`, { mode: 0o600 })
  await interaction.dispose(30_000)
  await close()
  assert.equal(await access(derived).then(() => true, () => false), false, 'temporary derived data was deleted')
  assert.equal(await access(bundle).then(() => true, () => false), false, 'the XCTest result bundle was deleted')
  const paths = [folder, build.derivedDataPath, join(proofsCache, 'derived'), join(proofsCache, '..', 'retest', 'native-executors')]
  const scan = await grepValues(paths, [value, value.slice(0, 12), value.replaceAll('&', '&amp;'), value.replaceAll('&', '&#38;')])
  assert.equal(scan.code, 1, 'the known typed value and its XCTest prefix appear nowhere')
  assert.deepEqual(scan.matches, [])
  const credentialScan = await grepValues([folder], [account.password, account.password.slice(0, 12), account.password.replaceAll('&', '&amp;')])
  assert.equal(credentialScan.code, 1, 'the sign-in credential and its XCTest prefix reached no retained run file')
  assert.deepEqual(credentialScan.matches, [])
  const logs = (await readdir(folder)).filter((name) => name.endsWith('.log'))
  const text = (await Promise.all(logs.map((name) => readFile(join(folder, name), 'utf8')))).join('\n')
  assert.equal(text.includes('{{native-input}}'), true, 'the executor typing activity has a placeholder')
  assert.equal(source.ok && source.tree.source.xml.includes('{{native-proof}}'), true, 'the saved decoded tree has the run placeholder')
  const record = { platform, paths, grep: 'rg --hidden --no-ignore -a -F -l -f - <paths>', secretMatches: scan.matches, grepExit: scan.code, credentialRunGrepExit: credentialScan.code, prefixChecked: true, executorTypingPlaceholder: '{{native-input}}', treePlaceholder: '{{native-proof}}', temporaryDerivedDataDeleted: true, resultBundleDeleted: true, executorProcesses: processes, executorCommand: command }
  await writeFile(join(folder, 'grep.json'), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
  t.diagnostic('grep: value, encoded value and XCTest prefix absent; typing and tree placeholders present; temporary XCTest output deleted')
}

test('TaskPhone secret fills leave only placeholders in executor logs and saved trees', { skip: phoneSkip }, (t) => prove(t, 'ios-simulator'))
test('TaskDesk secret fills leave only placeholders in executor logs and saved trees', { skip: deskSkip }, (t) => prove(t, 'macos'))
