import type { ActionIntent } from './element-queries.ts'
import type { IsolatedWorld } from './isolated-world.ts'
import type { Deadline } from '../protocol/deadline.ts'
import type { Failure } from '../protocol/failures.ts'
import type { LocatorRecipe } from '../protocol/locator.ts'
import { waitBeforeRead } from '../assertions/wait-before-read.ts'
import { describeLocator } from '../protocol/locator.ts'
import { CdpTimeoutError } from './cdp/errors.ts'
import { pinnedKey, readChecked } from './element-queries.ts'

export type CheckedStateOptions = {
  world: IsolatedWorld
  locator: LocatorRecipe
  intent: Extract<ActionIntent, { action: 'check' | 'uncheck' }>
  /** `'label'` when the click went to the control's label. */
  via: 'label' | undefined
  deadline: Deadline
}

const firstPauseMs = 20
const maxPauseMs = 200

/**
 * After the one click or tap of a `check` or `uncheck`, reads the control's state until it is the one asked for,
 * or the action's time runs out. Retest never clicks again, so a control that took the click and stayed as it was
 * fails `not_actionable`. Returns that failure, or undefined once the state is right. A pinned action reads only the
 * node it clicked: another control in its place is never read for it, and the click then stays unconfirmed.
 *
 * @example const failure = await awaitCheckedState({ world, locator, intent, via: undefined, deadline })
 */
export async function awaitCheckedState({ world, locator, intent, via, deadline }: CheckedStateOptions): Promise<Failure | undefined> {
  const wanted = intent.action === 'check'
  let last: boolean | null = null
  for (let attempt = 0; ; attempt += 1) {
    const finalRead = deadline.reached
    try {
      last = await readChecked(world, locator, deadline)
    } catch (error) {
      // The time ran out during a read, so the previous read is the latest there is.
      if (!(error instanceof CdpTimeoutError)) throw error
      if (finalRead) return stayed({ locator, intent, via }, last)
    }
    if (last === wanted) return undefined
    if (finalRead) return stayed({ locator, intent, via }, last)
    await waitBeforeRead(deadline, Math.min(firstPauseMs * 2 ** attempt, maxPauseMs))
  }
}

function stayed({ locator, intent, via }: Omit<CheckedStateOptions, 'world' | 'deadline'>, last: boolean | null): Failure {
  const { action, pointer } = intent
  const done = pointer === 'tap' ? 'tapped' : 'clicked'
  const what = via === 'label' ? 'its label' : 'it'
  const unwanted = action === 'check' ? 'unchecked' : 'checked'
  const unread = pinnedKey() === undefined ? `then no single control it matched showed whether it is ${action}ed` : `then the locator no longer found the element it clicked, so Retest could not read whether it is ${action}ed`
  const after = last === null ? unread : `it stayed ${unwanted}`
  return {
    class: 'not_actionable',
    message: `Could not ${action} ${describeLocator(locator)}: Retest ${done} ${what} once, and ${after}. Retest does not ${pointer} again.`,
    details: { check: 'state', inputSent: true },
  }
}
