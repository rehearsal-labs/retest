import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { parseNativeTree, redactNativeXml } from '../../src/native/locators.ts'
import { NativeOutputLines } from '../../src/native/output.ts'
import { OwnedProcess } from '../../src/native/processes.ts'
import { openFake, phoneSignIn } from './native-interaction-fake.ts'

const placeholder = '{{password}}'
const secretValue = (): string => `${randomBytes(20).toString('hex')}&private`

test('native output holds split values, removes abbreviated typing activities and redacts both streams before writing', async (t) => {
  const value = secretValue()
  const redact = (text: string): string => text.replaceAll(value, placeholder)
  const output: string[] = []
  const lines = new NativeOutputLines(redact, (line) => output.push(line))
  lines.push(`message ${value.slice(0, 9)}`)
  assert.deepEqual(output, [])
  lines.push(`${value.slice(9)}\n`)
  lines.push(`t = 1 Type '${value.slice(0, 12)}…'\n`)
  lines.push(`t = 2 Type key '${value[0]}'\n`)
  lines.end()
  assert.equal(JSON.stringify(output) === JSON.stringify([`message ${placeholder}\n`, 't = 1 Type {{native-input}}\n', 't = 2 Type {{native-input}}\n']), true, 'all output lines contain only the expected placeholders')
  const folder = await mkdtemp(join(tmpdir(), 'retest-native-secret-unit-'))
  t.after(() => rm(folder, { recursive: true, force: true }))
  const transient = join(folder, 'executor')
  await mkdir(transient)
  const echo = await OwnedProcess.start({ command: process.execPath, args: ['-e', "const value = process.env.RETEST_NATIVE_OUTPUT; process.stdout.write(value.slice(0, 8)); setTimeout(() => { process.stdout.write(value.slice(8) + '\\n'); process.stderr.write(value) }, 20)"], environment: { RETEST_NATIVE_OUTPUT: value }, logFile: join(folder, 'echo'), temporaryFolders: [transient], redact })
  assert.equal((await echo.exited).code, 0)
  const logged = await readFile(join(folder, 'echo'), 'utf8')
  assert.equal(logged === `${placeholder}\n${placeholder}`, true)
  assert.equal(await access(transient).then(() => true, () => false), false)
  assert.deepEqual(await echo.stop(0), [])
})

test('native XML decoding precedes redaction for named and numeric entities, without changing XML structure', () => {
  const value = secretValue()
  const xml = `<XCUIElementTypeWindow label="${value.replaceAll('&', '&amp;')}" title="${value.replaceAll('&', '&#38;')}" value="${value.replaceAll('&', '&#x26;')}" x="1" y="2" width="3" height="4"/>`
  const safe = redactNativeXml(xml, (text) => text.replaceAll(value, placeholder))
  assert.equal(safe.includes(value), false)
  const parsed = parseNativeTree(safe, 'macos')
  assert.equal(parsed.ok, true)
  if (!parsed.ok) return
  assert.equal(JSON.stringify(parsed.tree.root.attributes) === JSON.stringify({ label: placeholder, title: placeholder, value: placeholder, x: '1', y: '2', width: '3', height: '4' }), true, 'decoded attributes match the redacted tree exactly')
})

test('native session trees and tree alerts hide decoded text, while fill verifies the original field value', async (t) => {
  const value = secretValue()
  const { app, interaction, session } = await openFake(t, { platform: 'ios-simulator', screen: phoneSignIn, redact: (text) => text.replaceAll(value, placeholder) })
  const filled = await interaction.dispatch({ kind: 'fill', locator: { by: 'testId', value: 'account-field' }, value, secret: 'password' }, 3000)
  assert.equal(filled.result.ok, true)
  assert.equal(app.find('account-field').text === value, true)
  const source = await session.readSource(1000)
  assert.equal(source.ok, true)
  if (source.ok) assert.equal(source.tree.source.xml.includes(placeholder), true)
  const look = await interaction.observe({ by: 'testId', value: 'account-field' }, 1000)
  assert.equal(look.ok, true)
  if (look.ok) assert.equal(look.look.observation.value === placeholder, true)
  app.alert = { type: 'Alert', children: [{ type: 'StaticText', label: value }, { type: 'Button', label: value }] }
  assert.equal(JSON.stringify(await interaction.readAlert(1000)) === JSON.stringify({ ok: true, alert: { open: true, source: 'tree', text: placeholder, buttons: [placeholder] } }), true, 'decoded alert fields contain only placeholders')
})

test('reconcile sees input before its outstanding request settles and a cancel sends no second input', async (t) => {
  const { app, interaction } = await openFake(t, { platform: 'ios-simulator', screen: phoneSignIn })
  const route = 'POST /session/:session/element/:element/click'
  app.behaviours.set(route, { hang: true })
  const running = interaction.dispatch({ kind: 'tap', locator: { by: 'testId', value: 'sign-in-button' } }, 3000)
  for (let i = 0; i < 100 && app.on(route).length === 0; i++) await sleep(10)
  assert.equal(app.on(route).length, 1)
  assert.equal(interaction.inputs.length, 1)
  assert.equal(interaction.unknownOutcomes.length, 1)
  interaction.cancel({ class: 'interrupted', message: 'Stopped after dispatch.' })
  const reconciled = await interaction.reconcile(1000)
  assert.equal(reconciled.length, 1)
  assert.deepEqual(reconciled[0]?.source === 'input' && reconciled[0].outcome.reconciled, { ok: true, running: true, pids: [4242] })
  assert.equal((await running).input, 'unknown')
  assert.equal(app.on(route).length, 1)
  assert.equal(interaction.unknownOutcomes.length, 1)
})


test('executor errors are redacted in returned failures and the unknown-input ledger', async (t) => {
  const value = secretValue()
  const { app, interaction } = await openFake(t, { platform: 'ios-simulator', screen: phoneSignIn, redact: (text) => text.replaceAll(value, placeholder) })
  app.behaviours.set('POST /session/:session/element/:element/click', { error: `unknown error ${value}` })
  const read = await interaction.dispatch({ kind: 'tap', locator: { by: 'testId', value: 'sign-in-button' } }, 2000)
  assert.equal(read.result.ok, false)
  assert.equal(JSON.stringify(read).includes(value), false)
  assert.equal(JSON.stringify(read).includes(placeholder), true)
  assert.equal(JSON.stringify(interaction.unknownOutcomes).includes(value), false)
  assert.equal(JSON.stringify(interaction.unknownOutcomes).includes(placeholder), true)
})

test('a dispatched alert is already recorded while its executor answer is outstanding', async (t) => {
  const { app, interaction } = await openFake(t, { platform: 'ios-simulator', screen: phoneSignIn })
  app.systemAlert = { text: 'Continue?', buttons: ['Continue'] }
  const route = 'POST /session/:session/alert/accept'
  app.behaviours.set(route, { hang: true })
  const running = interaction.answerAlert({ button: 'Continue', route: 'accept' }, 3000)
  for (let i = 0; i < 100 && app.on(route).length === 0; i++) await sleep(10)
  assert.equal(app.on(route).length, 1)
  assert.equal(interaction.inputs.length, 1)
  assert.equal(interaction.inputs[0]?.kind, 'alert')
  const reconciled = await interaction.reconcile(1000)
  assert.equal(reconciled.length, 1)
  interaction.cancel({ class: 'interrupted', message: 'Stopped after alert dispatch.' })
  assert.equal((await running).input, 'unknown')
  assert.equal(app.on(route).length, 1)
})


test('oversized unfinished output discards the whole line without leaking a value split across the limit', () => {
  const value = secretValue()
  const output: string[] = []
  const problems: string[] = []
  const lines = new NativeOutputLines((text) => text.replaceAll(value, placeholder), (text) => output.push(text), (problem) => problems.push(problem))
  lines.push(`${'x'.repeat(65530)}${value.slice(0, 6)}`)
  lines.push(value.slice(6))
  assert.deepEqual(output, [], 'an unfinished oversized line emits neither its prefix nor the split value')
  lines.push(`\n${value}\n`)
  assert.deepEqual(output, ['{{native-output-line-discarded}}\n', `${placeholder}\n`])
  assert.equal(problems.length, 1)
  lines.push('y'.repeat(1_000_000))
  lines.end()
  assert.equal(output.at(-1), '{{native-output-line-discarded}}')
  assert.equal(problems.length, 1, 'the failure is reported once per stream')
})

test('a process with oversized output reports cleanup failure rather than silent log loss', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'retest-native-output-limit-'))
  t.after(() => rm(folder, { recursive: true, force: true }))
  const logFile = join(folder, 'process.log')
  const owned = await OwnedProcess.start({ command: process.execPath, args: ['-e', "process.stdout.write('x'.repeat(65537))"], logFile })
  assert.equal((await owned.exited).code, 0)
  assert.deepEqual(await owned.stop(0), ['Native process output exceeded the maximum line length of 65536 characters; oversized lines were discarded.'])
  assert.equal(await readFile(logFile, 'utf8'), '{{native-output-line-discarded}}')
})
