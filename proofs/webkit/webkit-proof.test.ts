import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { inspectPng } from './png.ts'
import { runWebKitProof } from './proof.ts'

// Drives the real pinned WebKit build. Without the build this test fails and says how to install it; it is never
// skipped, since a proof that did not run proves nothing.
test('drives the real WebKit build from launch to a killed browser', { timeout: 180_000 }, async (t) => {
  const outputFolder = await mkdtemp(join(tmpdir(), 'retest-webkit-proof-'))
  t.after(() => rm(outputFolder, { recursive: true, force: true }))
  const report = await runWebKitProof({ outputFolder })
  for (const step of report.steps) t.diagnostic(`${step.ok ? 'pass' : 'FAIL'} ${step.name}${step.failure === undefined ? '' : `: ${step.failure}`}`)
  assert.deepEqual(report.steps.filter((step) => !step.ok).map((step) => `${step.name}: ${step.failure}`), [])
  assert.equal(report.steps.length, 11)
  assert.equal(report.build.matchesPin, true)
  const screenshot = report.artifacts.screenshot ?? ''
  assert.ok(existsSync(screenshot), 'the screenshot file exists')
  const png = inspectPng(await readFile(screenshot))
  assert.deepEqual([png.width, png.height], [1280, 720])
  assert.ok(report.protocol.commands.includes('page proxy: Input.dispatchMouseEvent'))
  assert.ok(report.protocol.commands.includes('page proxy: Input.dispatchKeyEvent'))
  assert.ok(report.protocol.events.includes('page target: Console.messageAdded'))
  assert.ok(report.protocol.events.includes('page target: Network.responseReceived'))
})
