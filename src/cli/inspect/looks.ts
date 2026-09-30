import type { ObservedRecord } from '../../protocol/observation-record.ts'
import type { EventOfType, TestEvent } from '../../reporters/run-record.ts'
import { isDeepStrictEqual } from 'node:util'
import { quoteRecorded } from '../../reporters/format.ts'

export type Look = EventOfType<'observation'>
type Assertion = EventOfType<'assertion.passed'> | EventOfType<'assertion.failed'>

/**
 * One line of a timeline: an event with the looks it rested on, which only a locator assertion has, or looks no
 * assertion claimed, such as those of a check the run stopped in the middle of.
 */
export type TimelineEntry = { kind: 'event'; event: Exclude<TestEvent, Look>; looks: Look[] } | { kind: 'looks'; looks: Look[]; last: Look }

/** How many matches a line lists by their text. */
const listedItems = 3

/**
 * A test's events as timeline entries, in order. Each locator assertion takes the looks of its app and locator
 * since that app's last action, and they are shown under it rather than one line each. Looks nobody claimed stay
 * where they happened, one line for each run of looks at the same locator.
 *
 * @example timelineEntries(record.events).filter((entry) => entry.kind === 'looks')
 */
export function timelineEntries(events: readonly TestEvent[]): TimelineEntry[] {
  const claims = claimLooks(events)
  const claimed = new Set([...claims.values()].flat())
  const entries: TimelineEntry[] = []
  for (const event of events) {
    if (event.type !== 'observation') {
      entries.push({ kind: 'event', event, looks: claims.get(event) ?? [] })
      continue
    }
    if (claimed.has(event)) continue
    const previous = entries.at(-1)
    if (previous?.kind === 'looks' && sameTarget(previous.last, event)) {
      previous.looks.push(event)
      previous.last = event
    } else {
      entries.push({ kind: 'looks', looks: [event], last: event })
    }
  }
  return entries
}

function claimLooks(events: readonly TestEvent[]): Map<TestEvent, Look[]> {
  const claims = new Map<TestEvent, Look[]>()
  let pending: Look[] = []
  for (const event of events) {
    if (event.type === 'observation') pending.push(event)
    else if (isLocatorAssertion(event)) {
      const looks = pending.filter((look) => isLookOf(look, event))
      claims.set(event, looks)
      pending = pending.filter((look) => !looks.includes(look))
    } else if (event.type === 'action.completed' || event.type === 'action.failed') {
      pending = pending.filter((look) => look.session !== event.session)
    }
  }
  return claims
}

function isLocatorAssertion(event: TestEvent): event is Assertion {
  return (event.type === 'assertion.passed' || event.type === 'assertion.failed') && event.locator !== undefined
}

function isLookOf(look: Look, assertion: Assertion): boolean {
  return (assertion.session === undefined || look.session === assertion.session) && isDeepStrictEqual(look.locator, assertion.locator)
}

function sameTarget(one: Look, other: Look): boolean {
  return one.session === other.session && isDeepStrictEqual(one.locator, other.locator)
}

/**
 * What a look saw, in a few words. Page text is quoted and cut, so it can never pass for Retest's own words.
 *
 * @example describeObserved(observed) // '1 match, text "Saved"'
 * @example describeObserved(observed) // '5 matches: "Buy milk", "Walk the dog", "Pay rent" and 2 more'
 */
export function describeObserved(observed: ObservedRecord): string {
  const { count } = observed
  if (count === 0) return 'no match'
  if (count > 1) return `${count} matches${listItems(observed.items, count)}`
  const facts = ['1 match']
  if (observed.visible === false) facts.push('hidden')
  if (observed.text !== null) facts.push(`text ${quoteRecorded(observed.text)}`)
  if (observed.value !== null) facts.push(`value ${quoteRecorded(observed.value)}`)
  return facts.join(', ')
}

function listItems(items: ObservedRecord['items'], count: number): string {
  const shown = items.slice(0, listedItems).map((item) => `${quoteRecorded(item.text)}${item.visible ? '' : ' (hidden)'}`)
  if (shown.length === 0) return ''
  const more = count - shown.length
  return `: ${shown.join(', ')}${more > 0 ? ` and ${more} more` : ''}`
}
