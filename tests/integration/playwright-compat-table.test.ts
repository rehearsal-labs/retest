import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { compatibilityCases } from '../../fixtures/playwright-compat/cases.ts'
import { comparePlaywright, pinnedPlaywright, renderTable, runProblems } from '../../scripts/compare-playwright.ts'
import { browserPath } from './browser-harness.ts'
import { scratchFolder } from './cli-harness.ts'

// The check behind docs/compatibility/playwright.md: the corpus in fixtures/playwright-compat runs under the pinned
// Playwright, packed into a folder outside the repository on first use, and under `retest run --playwright`, in the
// same Chrome against a fresh task app each, and every case comes out as fixtures/playwright-compat/cases.ts declares.
// It needs the registry the first time it installs Playwright, and fails, rather than passes, without it.

// The rows of a table's case list, which hold only what the corpus decides, not the versions or the machine.
function caseRows(table: string): string {
  const start = table.indexOf('\n## Cases\n')
  const end = table.indexOf('\n## ', start + 1)
  assert.ok(start !== -1 && end !== -1, 'the table has a case list')
  return table.slice(start, end)
}

test('every case the Playwright table declares supported runs under Retest as under the pinned Playwright, and every declared gap is still one', async (t) => {
  const comparison = await comparePlaywright({ browser: browserPath(), workFolder: await scratchFolder(t, 'retest-playwright-table-') })
  assert.equal(comparison.playwright.version, pinnedPlaywright.version)
  assert.deepEqual(
    comparison.playwright.packages.map((entry) => [entry.name, entry.integrity]),
    pinnedPlaywright.packages.map((entry) => [entry.name, entry.integrity]),
  )
  assert.equal(comparison.playwright.run.collected, compatibilityCases.length, 'Playwright collected every case')
  assert.equal(comparison.retest.run.collected, compatibilityCases.length, 'Retest collected every case')
  // Each case can match and the run still differ: Retest's run failing outside any test, or exiting otherwise.
  assert.deepEqual(runProblems(comparison), [], 'the two runs as wholes agree')
  assert.equal(comparison.retest.run.runFailure, undefined, "Retest's run did not fail outside a test")
  assert.equal(comparison.retest.run.exitCode, comparison.playwright.run.exitCode, 'Retest exits as Playwright does')
  for (const verdict of comparison.verdicts) {
    const { id, support } = verdict.testCase
    const why = verdict.problems.join(' ')
    assert.ok(verdict.playwrightAsDeclared, `${id}: Playwright did not do what the case declares, so the case is wrong. ${why}`)
    if (support.supported) assert.ok(verdict.equivalent, `${id} is declared supported, and the two runs differ. ${why}`)
    else assert.ok(!verdict.equivalent, `${id} is declared a gap, and the two runs now agree: update its declaration and the table.`)
  }
  const written = readFileSync(new URL('../../docs/compatibility/playwright.md', import.meta.url), 'utf8')
  assert.equal(caseRows(written), caseRows(renderTable(comparison)), 'docs/compatibility/playwright.md no longer says what the runs show: write it again with scripts/compare-playwright.ts --write')
})
