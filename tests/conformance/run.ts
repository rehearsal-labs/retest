import type { Engine } from './engines.ts'
import type { EngineReport } from './execute.ts'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { repositoryRoot } from '../integration/cli-harness.ts'
import { engineNames, engines } from './engines.ts'
import { runEngine } from './execute.ts'
import { engineDifferences, renderReport, reportPath } from './report.ts'

// Runs the fixed conformance cases on Chrome, Firefox and WebKit, writes the table to docs/compatibility/conformance.md,
// and then judges every engine in a test of its own, so one engine's differences never hide another's. An engine that
// did not run fails its test, unless a variable opted it out by name or 0.1.0 does not support it on this platform;
// then its test is skipped saying it is not verified. Real browsers run, so run it under the heavy-gate lock:
//
//   lockf -t 0 /tmp/retest-heavy-gate.lock node --conditions=retest-source tests/conformance/run.ts
//
// Each run folder is kept, with what the run printed, under RETEST_CONFORMANCE_KEEP, or /tmp/retest-conformance.

const keep = process.env['RETEST_CONFORMANCE_KEEP'] ?? join('/tmp', 'retest-conformance')
const reports = new Map<Engine, EngineReport>()

for (const engine of engines) {
  test(`runs the conformance cases on ${engineNames[engine]}`, async (t) => {
    try {
      const report = await runEngine(t, engine, { keep })
      reports.set(engine, report)
      if (!report.availability.available) t.diagnostic(`${engineNames[engine]} did not run: ${report.availability.reason}`)
    } catch (error) {
      reports.set(engine, { engine, availability: { available: true }, error: error instanceof Error ? error.message : String(error), browsers: [], groups: [], cases: [] })
      throw error
    }
  })
}

test(`writes the table to ${reportPath}`, () => {
  const path = join(repositoryRoot, reportPath)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, renderReport([...reports.values()], new Date()))
})

for (const engine of engines) {
  test(`every case and every run on ${engineNames[engine]} ended as declared`, (t) => {
    const report = reports.get(engine)
    assert.ok(report !== undefined, `${engineNames[engine]} has no report`)
    assert.equal(report.error, undefined, `the run on ${engineNames[engine]} failed: ${report.error}`)
    if (!report.availability.available) {
      assert.ok(report.availability.excused, `${engineNames[engine]} did not run: ${report.availability.reason}`)
      t.skip(`${engineNames[engine]} is not verified: ${report.availability.reason}`)
      return
    }
    assert.equal(engineDifferences(report), 0, `${engineDifferences(report)} cases or runs on ${engineNames[engine]} did not end as declared; see ${reportPath}`)
  })
}
