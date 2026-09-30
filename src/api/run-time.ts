import type { Clock } from '../protocol/deadline.ts'
import { setTimeout } from 'node:timers/promises'
import { monotonicClock } from '../protocol/deadline.ts'

/**
 * The time a test run keeps: its clock, and waits measured on it. A wait that `signal` ends early rejects, as
 * Node's timers do.
 */
export type RunTime = { now: Clock; sleep: (ms: number, signal?: AbortSignal) => Promise<void> }

/** The host's monotonic clock and timers. */
export const hostTime: RunTime = { now: monotonicClock, sleep: (ms, signal) => setTimeout(ms, undefined, { signal }) }
