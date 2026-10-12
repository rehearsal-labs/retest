import type { Engine } from './engines.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { conformanceCases } from './cases.ts'
import { engineNames, engineSetup } from './engines.ts'
import { runEngine } from './execute.ts'

// The test each tests/integration/conformance-<engine>.test.ts file registers for its one engine: the fixed cases of
// cases.ts, where each case and each run must end exactly as declared; a declared outcome is never edited to make an
// engine pass. An engine that does not run fails, unless RETEST_CONFORMANCE_OPT_OUT names it or 0.1.0 does not support
// it on this platform: it is then skipped as not verified, by name, never passed. A run that refuses every test because
// no driver runs the engine is not "not available": every case differs. One file per engine keeps each CI shard short
// and lets a failed engine be run again alone. tests/conformance/run.ts runs the same cases on every engine and writes
// docs/compatibility/conformance.md. RETEST_CONFORMANCE_KEEP names a folder to keep each run folder in.

/**
 * Registers the test that runs every conformance case on `engine` and holds each case and each run to its declared end.
 *
 * @example conformanceEngineTest('firefox') // in tests/integration/conformance-firefox.test.ts
 */
export function conformanceEngineTest(engine: Engine): void {
  test(`every conformance case ends as declared on ${engineNames[engine]}`, async (t) => {
    const setup = engineSetup(engine)
    if (!setup.available) {
      assert.ok(setup.excused, `${engineNames[engine]} did not run: ${setup.reason}`)
      t.skip(`${engineNames[engine]} is not verified: ${setup.reason}`)
      return
    }
    const keep = process.env['RETEST_CONFORMANCE_KEEP']
    const report = await runEngine(t, engine, keep === undefined || keep === '' ? {} : { keep })
    assert.ok(report.availability.available, `${engineNames[engine]} did not run: ${report.availability.available ? '' : report.availability.reason}`)
    for (const group of report.groups) {
      await t.test(`run ${group.group}`, (run) => {
        if (group.diagnostics !== undefined) run.diagnostic(JSON.stringify({ group: group.group, ...group.diagnostics }))
        assert.deepEqual(group.problems, [], `run ${group.group}`)
      })
    }
    for (const each of report.cases) {
      const declared = conformanceCases.find((candidate) => candidate.id === each.id)
      const name = declared === undefined ? each.id : `${each.id} ${declared.kind === 'test' ? declared.test : declared.summary}`
      await t.test(name, () => assert.deepEqual(each.differences, [], `${name}: gave ${each.given}`))
    }
  })
}
