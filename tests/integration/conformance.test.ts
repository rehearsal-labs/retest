import assert from 'node:assert/strict'
import { test } from 'node:test'
import { conformanceCases } from '../conformance/cases.ts'
import { engineNames, engines, engineSetup } from '../conformance/engines.ts'
import { runEngine } from '../conformance/execute.ts'

// The fixed conformance cases of tests/conformance/cases.ts on Chrome, Firefox and WebKit. Each case and each run must
// end exactly as declared; a declared outcome is never edited to make an engine pass. An engine that does not run
// fails, unless RETEST_CONFORMANCE_OPT_OUT names it or 0.1.0 does not support it on this platform: it is then skipped
// as not verified, by name, never passed. A run that refuses every test because no driver runs the engine is not
// "not available": every case differs. tests/conformance/run.ts runs the same cases and writes
// docs/compatibility/conformance.md. RETEST_CONFORMANCE_KEEP names a folder to keep each run folder in.

for (const engine of engines) {
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
      await t.test(`run ${group.group}`, () => assert.deepEqual(group.problems, [], `run ${group.group}`))
    }
    for (const each of report.cases) {
      const declared = conformanceCases.find((candidate) => candidate.id === each.id)
      const name = declared === undefined ? each.id : `${each.id} ${declared.kind === 'test' ? declared.test : declared.summary}`
      await t.test(name, () => assert.deepEqual(each.differences, [], `${name}: gave ${each.given}`))
    }
  })
}
