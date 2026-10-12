import type { RetestEvent } from '../../src/protocol/events.ts'
import type { Failure } from '../../src/protocol/failures.ts'
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { truncateText } from '../../src/protocol/failures.ts'
import { layoutCheck } from '../../src/protocol/layout-checks.ts'
import { createAgentReporter } from '../../src/reporters/agent.ts'
import { createHumanReporter } from '../../src/reporters/human.ts'
import { capture, failingRun, projectFolder, resultOf } from './reporters-fixtures.ts'

const root = projectFolder()
const runFolder = '.retest/runs/latest'
const help = { by: 'testId', value: 'help' } as const
const check = layoutCheck({ matcher: 'toOverlap', other: help, not: true })
const received = 'share 32 by 32 pixels at 768 pixels wide'

// The failing run of the fixtures, with its failed check replaced by a negated toOverlap that measured two buttons
// sharing 32 by 32 pixels at 768 pixels wide, as the parent writes it.
function overlapRun(): RetestEvent[] {
  return failingRun(root).map((event) => {
    if (event.type === 'assertion.failed') {
      const failure = overlapFailure(event.failure)
      const layout = { viewport: { width: 768, height: 1024 }, edge: 768, shared: { across: 32, down: 32 } }
      return { ...event, matcher: check.matcher, locator: { by: 'testId', value: 'save' }, expected: truncateText(check.expected), actual: truncateText(received), comparison: check.comparison, layout, failure }
    }
    if (event.type === 'test.finished' && event.failure !== undefined) return { ...event, failure: overlapFailure(event.failure) }
    return event
  })
}

function overlapFailure(original: Failure): Failure {
  const message = `getByTestId('save') and getByTestId('help') overlap: they share 32 by 32 pixels at 768 pixels wide. Looked 14 times in 5000 ms.`
  const details = { expected: truncateText(check.expected), received: truncateText(received), attempts: 14, timeoutMs: 5000, comparison: check.comparison }
  return { ...original, class: 'check_failed', message, details }
}

function reports(events: RetestEvent[]): { human: string; agent: string } {
  const humanOut = capture()
  const agentOut = capture()
  const human = createHumanReporter({ stdout: humanOut, stderr: capture(), color: false, runFolder })
  const agent = createAgentReporter({ stdout: agentOut, runFolder })
  for (const event of events) {
    human.onEvent(event)
    agent.onEvent(event)
  }
  const result = resultOf(events)
  human.onRunEnd(result)
  agent.onRunEnd(result)
  return { human: humanOut.text, agent: agentOut.text }
}

describe('a layout check in a failure card', () => {
  test('the human card names the matcher, the element, what was expected and the pixels measured at the width', () => {
    const { human } = reports(overlapRun())
    assert.match(human, /\n {4}Check failed {5}not\.toOverlap\n {4}Locator {10}getByTestId\('save'\)\n/)
    assert.ok(human.includes(`    - Expected       "share no more than 4 pixels across or down with getByTestId('help')"\n`), human)
    assert.ok(human.includes(`    + Received       "${received}"\n`), human)
    assert.ok(human.includes(`    Compared         ${check.comparison}\n`), human)
  })

  test('the agent block says the same in one line each', () => {
    const { agent } = reports(overlapRun())
    assert.match(agent, /\nfail examples\/task\.retest\.ts:7 saves a task\n {2}check_failed not\.toOverlap getByTestId\('save'\)\n/)
    assert.ok(agent.includes(`  expected "share no more than 4 pixels across or down with getByTestId('help')" received "${received}" waited 5003ms for not.toOverlap, looked 14 times, limit 5000ms\n`), agent)
  })
})
