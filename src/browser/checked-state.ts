import type { ActionIntent } from './element-queries.ts'
import type { IsolatedWorld } from './isolated-world.ts'
import type { Deadline } from '../protocol/deadline.ts'
import type { Failure } from '../protocol/failures.ts'
import type { LocatorRecipe } from '../protocol/locator.ts'
import { setTimeout as sleep } from 'node:timers/promises'
import { describeLocator } from '../protocol/locator.ts'
import { CdpTimeoutError } from './cdp/errors.ts'
import { readChecked } from './element-queries.ts'

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
 * fails `not_actionable`. Returns that failure, or undefined once the state is right.
 *
 * @example const failure = await awaitCheckedState({ world, locator, intent, via: undefined, deadline })
 */
export async function awaitCheckedState({ world, locator, intent, via, deadline }: CheckedStateOptions): Promise<Failure | undefined> {
  const wanted = intent.action === 'check'
  let last: boolean | null = null
  for (let attempt = 0; ; attempt += 1) {
    try {
      last = await readChecked(world, locator, deadline)
    } catch (error) {
      // The time ran out during a read, so the previous read is the latest there is.
      if (!(error instanceof CdpTimeoutError)) throw error
      return stayed({ locator, intent, via }, last)
    }
    if (last === wanted) return undefined
    if (deadline.expired) return stayed({ locator, intent, via }, last)
    await sleep(Math.min(firstPauseMs * 2 ** attempt, maxPauseMs, deadline.remainingMs), undefined, { signal: deadline.signal })
  }
}

function stayed({ locator, intent, via }: Omit<CheckedStateOptions, 'world' | 'deadline'>, last: boolean | null): Failure {
  const { action, pointer } = intent
  const done = pointer === 'tap' ? 'tapped' : 'clicked'
  const what = via === 'label' ? 'its label' : 'it'
  const unwanted = action === 'check' ? 'unchecked' : 'checked'
  const after = last === null ? `then no single control it matched showed whether it is ${action}ed` : `it stayed ${unwanted}`
  return {
    class: 'not_actionable',
    message: `Could not ${action} ${describeLocator(locator)}: Retest ${done} ${what} once, and ${after}. Retest does not ${pointer} again.`,
    details: { check: 'state', inputSent: true },
  }
}
