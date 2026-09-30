import type { RetestEvent } from '../../src/protocol/events.ts'
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { createAgentReporter } from '../../src/reporters/agent.ts'
import { createHumanReporter } from '../../src/reporters/human.ts'
import { capture } from './reporters-fixtures.ts'
import { checkoutProject, hostCheckResult, keyboardPressLostRun, pressFailureRun } from './reporters-host-check-fixtures.ts'

const root = checkoutProject()
const runFolder = '.retest/runs/latest'

function reports(events: RetestEvent[]): { human: string; agent: string } {
  const humanOut = capture()
  const agentOut = capture()
  const human = createHumanReporter({ stdout: humanOut, stderr: capture(), color: false, runFolder })
  const agent = createAgentReporter({ stdout: agentOut, runFolder })
  for (const event of events) {
    human.onEvent(event)
    agent.onEvent(event)
  }
  const result = hostCheckResult(events)
  human.onRunEnd(result)
  agent.onRunEnd(result)
  return { human: humanOut.text, agent: agentOut.text }
}

// The press's key replaced by one with control characters in it, as an untrusted test file's process could send.
function withKey(events: RetestEvent[], key: string): RetestEvent[] {
  return events.map((event) => (event.type === 'action.failed' ? { ...event, key } : event))
}

describe('a press in a failure card', () => {
  test('the human card writes it as the test wrote it, with its key, and does not repeat the locator', () => {
    const { human } = reports(pressFailureRun(root))
    assert.match(
      human,
      /\n {4}Not actionable {3}getByLabel\('Coupon'\)\.press\('Enter'\)\n {4}getByLabel\('Coupon'\) did not get the key: div\.toast took it\.\n {4}Page {13}http:\/\/127\.0\.0\.1:4173\/cart\n {4}Waited {11}15 ms for press\n {4}check {12}"focus"\n {4}element {10}"div\.toast"\n/,
    )
    assert.doesNotMatch(human, /Locator/)
  })

  test("the page's keyboard reads as page.keyboard", () => {
    const { human, agent } = reports(keyboardPressLostRun(root))
    assert.match(human, /\n {4}Outcome unknown {2}page\.keyboard\.press\('Enter'\)\n {4}The browser closed after the key was sent\.\n/)
    assert.match(agent, /\nerror tests\/checkout\.retest\.ts:8 places an order\n {2}outcome_unknown page\.keyboard\.press\('Enter'\)\n {2}The browser closed after the key was sent\.\n {2}waited 15ms for press\n/)
  })

  test('the agent line names the call once, key and all', () => {
    const { agent } = reports(pressFailureRun(root))
    assert.match(agent, /\nfail tests\/checkout\.retest\.ts:6 places an order\n {2}not_actionable getByLabel\('Coupon'\)\.press\('Enter'\)\n {2}getByLabel/)
  })

  test('a key with control characters in it is written as escapes', () => {
    const { human, agent } = reports(withKey(pressFailureRun(root), 'a\u001b[2J\u009b'))
    for (const report of [human, agent]) {
      assert.ok(report.includes(String.raw`getByLabel('Coupon').press('a\u001b[2J\u009b')`), report)
      assert.doesNotMatch(report, /[\u001b\u009b]/)
    }
  })
})
