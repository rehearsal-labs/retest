import type { FinishedRun } from './cli-harness.ts'
import assert from 'node:assert/strict'
import { eventsOf, testNamed } from './cli-harness.ts'

/** Where and why a workflow case must fail: its step, its failure class, its line, and what its message names. */
export type Failed = { step: string; failureClass: string; line: number; message: RegExp }

/**
 * The number of the first line that holds `wanted` after the line that opens the step named `step`.
 *
 * @example lineOf(tests, "toHaveText('Release checklist')", 'the new task is listed with its title')
 */
export function lineOf(text: string, wanted: string, step: string): number {
  const lines = text.split('\n')
  const start = lines.findIndex((line) => line.includes(`test.step('${step}'`))
  const index = lines.findIndex((line, at) => at > start && line.includes(wanted))
  assert.ok(start >= 0 && index > start, `the step ${step} holds ${wanted}`)
  return index + 1
}

/**
 * A check that a test in `file` failed for the intended reason: in the named step, with this class, at this line,
 * and with a message that names what was expected and what the page showed.
 *
 * @example const assertFailedAt = failedAtIn('tests/create.retest.ts')
 */
export function failedAtIn(file: string): (run: FinishedRun, name: string, failed: Failed) => void {
  return (run, name, failed) => {
    const result = testNamed(run, name)
    assert.deepEqual(
      [result.status, result.failure?.class, result.failure?.location?.file, result.failure?.location?.line],
      ['failed', failed.failureClass, file, failed.line],
      `${name}: ${result.failure?.message}`,
    )
    assert.match(result.failure?.message ?? '', failed.message, name)
    const started = eventsOf(run.events, 'step.started').find((event) => event.testId === result.testId && event.name === failed.step)
    assert.ok(started !== undefined, `${name} started the step ${failed.step}`)
    const finished = eventsOf(run.events, 'step.finished').find((event) => event.testId === result.testId && event.stepId === started.stepId)
    assert.equal(finished?.status, 'failed', `${name}: the step ${failed.step} failed`)
  }
}
