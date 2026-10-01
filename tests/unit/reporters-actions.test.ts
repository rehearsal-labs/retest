import type { RetestEvent } from '../../src/protocol/events.ts'
import type { LocatorRecipe } from '../../src/protocol/locator.ts'
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { createAgentReporter } from '../../src/reporters/agent.ts'
import { createHumanReporter } from '../../src/reporters/human.ts'
import { checkIgnoredRun, preferencesProject, selectLostRun } from './reporters-action-fixtures.ts'
import { capture, failingRun, projectFolder, resultOf } from './reporters-fixtures.ts'
import { checkoutProject, hostCheckFailureRun, hostCheckResult } from './reporters-host-check-fixtures.ts'

const runFolder = '.retest/runs/latest'
const terms: LocatorRecipe = { by: 'testId', value: 'terms' }
const preferences = preferencesProject()

type Reports = { human: string; agent: string }

function reports(events: RetestEvent[], result = resultOf(events)): Reports {
  const humanOut = capture()
  const agentOut = capture()
  const human = createHumanReporter({ stdout: humanOut, stderr: capture(), color: false, runFolder })
  const agent = createAgentReporter({ stdout: agentOut, runFolder })
  for (const event of events) {
    human.onEvent(event)
    agent.onEvent(event)
  }
  human.onRunEnd(result)
  agent.onRunEnd(result)
  return { human: humanOut.text, agent: agentOut.text }
}

// Each action event changed as a recorded run could have it.
function editActions(events: RetestEvent[], change: (event: Extract<RetestEvent, { type: 'action.completed' | 'action.failed' }>) => RetestEvent): RetestEvent[] {
  return events.map((event) => (event.type === 'action.completed' || event.type === 'action.failed' ? change(event) : event))
}

describe('a check, uncheck, select or scroll in a failure card', () => {
  test('the human card writes a check as the test wrote it, says it went through the label, and shows the page by its title', () => {
    const { human } = reports(checkIgnoredRun(preferences))
    assert.match(
      human,
      /\n {4}Not actionable {3}getByLabel\('Remember me'\)\.check\(\), clicked its label\n {4}Retest clicked it once, and it stayed unchecked\. Retest does not click again\.\n {4}Page {13}"Preferences" at http:\/\/127\.0\.0\.1:4173\/preferences\n {4}Waited {11}5s for check\n {4}check {12}"state"\n {4}inputSent {8}true\n/,
    )
    assert.doesNotMatch(human, /Locator/)
  })

  test('the agent line names the call once, with how it reached the control', () => {
    const { agent } = reports(checkIgnoredRun(preferences))
    assert.match(
      agent,
      /\nfail tests\/preferences\.retest\.ts:8 saves preferences\n {2}not_actionable getByLabel\('Remember me'\)\.check\(\), clicked its label\n {2}Retest clicked it once, and it stayed unchecked\. Retest does not click again\.\n {2}waited 5003ms for check\n {2}check "state"\n {2}inputSent true\n/,
    )
  })

  test('on a touch screen the check says it tapped, through the label or not', () => {
    const tapped = editActions(checkIgnoredRun(preferences), (event) => (event.type === 'action.failed' ? { ...event, touch: true } : event))
    assert.match(reports(tapped).agent, /\n {2}not_actionable getByLabel\('Remember me'\)\.check\(\), tapped its label\n/)
    const direct = editActions(tapped, (event) => {
      if (event.type !== 'action.failed') return event
      const { via, ...fields } = event
      return fields
    })
    assert.match(reports(direct).human, /\n {4}Not actionable {3}getByLabel\('Remember me'\)\.check\(\), tapped\n/)
  })

  test('a select that was lost is marked as set by script, never as a click', () => {
    const { human, agent } = reports(selectLostRun(preferences))
    assert.match(human, /\n {4}Outcome unknown {2}getByLabel\('Country'\)\.select\('Canada'\), set by script\n {4}The browser closed after the choice was sent\.\n/)
    assert.match(agent, /\nerror tests\/preferences\.retest\.ts:5 saves preferences\n {2}outcome_unknown getByLabel\('Country'\)\.select\('Canada'\), set by script\n/)
    assert.doesNotMatch(`${human}${agent}`, /click/)
  })

  test('a select the test gave a list is written with its brackets, even a list of one', () => {
    const listed = editActions(selectLostRun(preferences), (event) => (event.type === 'action.failed' ? { ...event, multiple: true } : event))
    const { human, agent } = reports(listed)
    assert.match(human, /\n {4}Outcome unknown {2}getByLabel\('Country'\)\.select\(\['Canada'\]\), set by script\n/)
    assert.match(agent, /\n {2}outcome_unknown getByLabel\('Country'\)\.select\(\['Canada'\]\), set by script\n/)
  })

  test('a failed scroll reads as the test wrote it, on the page or on an element', () => {
    const scrolled = (locator?: LocatorRecipe): RetestEvent[] =>
      editActions(selectLostRun(preferences), (event) => {
        if (event.type !== 'action.failed') return event
        const { choices, input, changed, locator: selectLocator, ...fields } = event
        return { ...fields, command: 'scroll', scroll: { x: 0, y: 600 }, ...(locator === undefined ? {} : { locator }) }
      })
    assert.match(reports(scrolled()).agent, /\n {2}outcome_unknown page\.scroll\(\{ y: 600 \}\)\n/)
    assert.match(reports(scrolled(terms)).human, /\n {4}Outcome unknown {2}getByTestId\('terms'\)\.scroll\(\{ y: 600 \}\)\n/)
  })

  test('an event without what the call needs falls back to the kind and the locator', () => {
    const bare = editActions(selectLostRun(preferences), (event) => {
      if (event.type !== 'action.failed') return event
      const { choices, ...fields } = event
      return fields
    })
    const { human, agent } = reports(bare)
    assert.match(human, /\n {4}Outcome unknown {2}select, set by script\n[^]*\n {4}Locator {10}getByLabel\('Country'\)\n/)
    assert.match(agent, /\n {2}outcome_unknown select getByLabel\('Country'\), set by script\n/)
  })

  test("an option's label with control characters in it is written as escapes", () => {
    const hostile = editActions(selectLostRun(preferences), (event) => (event.type === 'action.failed' ? { ...event, choices: [{ label: 'Can\u001b[2Jada\u009b' }] } : event))
    const { human, agent } = reports(hostile)
    for (const report of [human, agent]) {
      assert.ok(report.includes(String.raw`getByLabel('Country').select('Can\u001b[2Jada\u009b')`), report)
      assert.doesNotMatch(report, /[\u001b\u009b]/)
    }
  })
})

describe("a page's title beside its address", () => {
  const tasks = projectFolder()

  test("a failed assertion's page line shows the title before the address, and the address alone without one", () => {
    const events = failingRun(tasks).map((event) => (event.type === 'assertion.failed' ? { ...event, pageTitle: 'Tasks' } : event))
    assert.match(reports(events).human, /\n {4}Page {13}"Tasks" at http:\/\/127\.0\.0\.1:4173\/\n/)
    assert.match(reports(failingRun(tasks)).human, /\n {4}Page {13}http:\/\/127\.0\.0\.1:4173\/\n/)
  })

  test('a title with control characters in it is quoted and written as escapes, and never replaces the address', () => {
    const events = editActions(checkIgnoredRun(preferences), (event) => (event.type === 'action.failed' ? { ...event, pageTitle: 'Pre\u001b[2Jfs\u009b' } : event))
    const { human } = reports(events)
    assert.ok(human.includes(String.raw`Page             "Pre\u001b[2Jfs\u009b" at http://127.0.0.1:4173/preferences`), human)
    assert.doesNotMatch(human, /[\u001b\u009b]/)
  })

  test("a host check's page names the title the check saw, in the card and in the agent line", () => {
    const checkout = checkoutProject()
    const events = hostCheckFailureRun(checkout).map((event) =>
      event.type === 'host_check.failed' ? { ...event, actual: { ...event.actual, title: 'Your cart' } } : event,
    )
    const { human, agent } = reports(events, hostCheckResult(events))
    assert.match(human, /\n {4}Page {13}"Your cart" at http:\/\/127\.0\.0\.1:4173\/cart\n/)
    assert.match(human, /\n {4}Page {13}"Your cart" at http:\/\/127\.0\.0\.1:4173\/cart, text not found\n/)
    assert.match(agent, /\n {2}host_check_failed address on web expected http:\/\/127\.0\.0\.1:4173\/thanks, page "Your cart" at http:\/\/127\.0\.0\.1:4173\/cart\n/)
  })
})
