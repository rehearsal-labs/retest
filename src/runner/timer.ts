import { maxTimeout } from '../protocol/timeouts.ts'

/**
 * A wait as a timer can hold it. Node fires a timer set longer than it can count after one millisecond, so a budget
 * near the largest a run takes, with a grace added, is cut to the largest a timer holds.
 *
 * @example await bounded(page.dispose(cleanup), timerMs(cleanup + abortGraceMs))
 */
export function timerMs(milliseconds: number): number {
  return Math.min(milliseconds, maxTimeout)
}
